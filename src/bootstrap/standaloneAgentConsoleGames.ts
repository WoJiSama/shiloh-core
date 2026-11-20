import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { TurtleSoupPuzzle, TurtleSoupPuzzleStatus } from '../contracts/turtleSoup.js'
import { canServePuzzle, puzzleFamilyId, puzzlePlayStats } from '../modules/games/domain/turtleSoup/turtleSoupRules.js'
import { hasCurrentPassingAudits, puzzleContentHash } from '../modules/games/domain/turtleSoup/turtleSoupQuality.js'
import { agentTurtleSoupDirectory } from '../modules/games/infrastructure/agentTurtleSoup.js'
import { TurtleSoupGenerator } from '../modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.js'
import { TurtleSoupStore, resolveTurtleSoupConfig } from '../modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import { createStandaloneTurtleSoupModel, type StandaloneGroupGamesOptions } from './standaloneGames.js'

const difficulties = ['easy', 'normal', 'hard'] as const
const feedbackCategories = ['logic', 'clues', 'hints', 'host', 'difficulty', 'taste', 'technical', 'other']
const reasons = ['solved', 'manual', 'idle_timeout', 'all_surrendered', 'switched']
const emptyJob = { id: '', running: false, total: 0, added: 0, failed: 0, skipped: 0, log: [] as string[] }
type Job = typeof emptyJob

function response(value: unknown, status = 200) {
  return { kind: 'json' as const, value: JSON.parse(JSON.stringify(value)) as AgentConsoleJson, status }
}

function body(request: AgentConsoleRequest): Readonly<Record<string, unknown>> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return {}
  return request.body as Readonly<Record<string, unknown>>
}

function targetId(request: AgentConsoleRequest) {
  const id = request.params.id
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new AgentConsoleError('invalid_request')
  return id
}

function transition(puzzle: TurtleSoupPuzzle, status: TurtleSoupPuzzleStatus, reason: string, actor: string): TurtleSoupPuzzle {
  return { ...puzzle, status, statusHistory: [...(puzzle.statusHistory ?? []), {
    from: puzzle.status, to: status, actor, reason, at: Date.now(), contentHash: puzzleContentHash(puzzle),
  }] }
}

export function createStandaloneAgentConsoleGames(options: StandaloneGroupGamesOptions): readonly AgentConsoleService[] {
  const config = options.config.turtleSoup ?? resolveTurtleSoupConfig({ miniGames: { enabled: false } })
  const root = path.join(options.dataDir, 'games')
  const model = createStandaloneTurtleSoupModel(options)
  const jobs = new Map<string, Job>()
  type Selected = ReturnType<typeof selected>
  type Handler = (request: AgentConsoleRequest, context: AgentConsoleContext, scope: Selected) => Promise<ReturnType<typeof response>>

  function selected(context: AgentConsoleContext, write: boolean) {
    const binding = context.binding
    if (!binding || binding.target.kind !== 'group') throw new AgentConsoleError('forbidden')
    const directory = agentTurtleSoupDirectory(root, binding.target.account, binding.agentId)
    const guard = { signal: context.signal, async ensureCurrent() { context.ensureCurrent() }, isCurrent: () => context.isCurrent() }
    const store = new TurtleSoupStore({ baseDir: directory, guard, createDirectory: write })
    const generator = new TurtleSoupGenerator({ store, config: () => ({ ...config, baseDir: directory }),
      callModel: (messages, modelOptions = {}) => model(messages, modelOptions, { ...guard, binding }) })
    return { directory, store, generator }
  }

  function reason(request: AgentConsoleRequest, required = true) {
    const value = body(request).reason ?? ''
    if (typeof value !== 'string' || value.length > 1000 || required && !value.trim() || !options.allowsText(value)) {
      throw new AgentConsoleError('invalid_request')
    }
    return value.trim()
  }

  function overview(scope: Selected) {
    const { puzzles, plays, sessions } = scope.store.readState()
    const completed = plays.filter(play => play.endedAt)
    const ratings = completed.flatMap(play => play.ratings)
    const playCount = new Map<string, number>()
    for (const play of plays) playCount.set(play.puzzleId, (playCount.get(play.puzzleId) ?? 0) + 1)
    const availableFamilies = new Set(puzzles.filter(canServePuzzle).map(puzzleFamilyId))
    const exposure = puzzlePlayStats(plays, puzzles)
    const fresh = puzzles.filter(puzzle => puzzle.status === 'active' && !playCount.get(puzzle.id))
    const average = (values: number[]) => values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : 0
    return response({
      difficultyFresh: Object.fromEntries(difficulties.map(difficulty => [difficulty, fresh.filter(puzzle => puzzle.difficulty === difficulty).length])),
      difficultyTargets: { easy: config.freshEasy, normal: config.freshNormal, hard: config.freshHard },
      freshPoolTarget: config.freshPoolTarget,
      puzzles: puzzles.map(puzzle => ({
        ...puzzle, playable: canServePuzzle(puzzle), contentHash: puzzleContentHash(puzzle),
        eligible: hasCurrentPassingAudits(puzzle), plays: playCount.get(puzzle.id) ?? 0, audits: puzzle.audits ?? [],
        manualScore: puzzle.manualScore ?? null,
        ratingAverage: puzzle.ratingCount ? Number((puzzle.ratingSum / puzzle.ratingCount).toFixed(1)) : null,
        feedback: completed.filter(play => play.puzzleId === puzzle.id).flatMap(play => play.ratings)
          .filter(rating => rating.comment).slice(-20)
          .map(rating => ({ score: rating.score, comment: rating.comment, category: rating.category ?? 'other', at: rating.at })),
      })),
      sessions: Object.values(sessions).map(session => ({ groupId: session.groupId,
        phase: session.phase, puzzleId: session.puzzleId, players: session.players.length,
        startedAt: session.startedAt, lastActivityAt: session.lastActivityAt })),
      generating: jobs.get(scope.directory) ?? emptyJob,
      inventory: { fresh: [...availableFamilies].filter(id => !exposure.has(id)).length, available: availableFamilies.size,
        pending: puzzles.filter(puzzle => puzzle.status === 'pending').length,
        retired: puzzles.filter(puzzle => puzzle.status === 'retired').length,
        needsAudit: puzzles.filter(puzzle => puzzle.status === 'active' && !hasCurrentPassingAudits(puzzle)).length },
      diagnostics: { completed: completed.length, solved: completed.filter(play => play.solved).length,
        ratings: ratings.length, averageHints: average(completed.map(play => play.usedHints ?? 0)),
        averageQuestions: average(completed.map(play => play.qaCount)),
        feedbackCategories: Object.fromEntries(feedbackCategories.map(category =>
          [category, ratings.filter(rating => (rating.category ?? 'other') === category).length])),
        endedBy: Object.fromEntries(reasons.map(cause => [cause, completed.filter(play => play.endReason === cause).length])) },
    })
  }

  async function runJob(scope: Selected, context: AgentConsoleContext, count: number, action: () => Promise<TurtleSoupPuzzle>) {
    if (jobs.get(scope.directory)?.running) return response({ error: '已有生成或修复任务进行中' }, 409)
    const job: Job = { ...emptyJob, id: randomUUID(), running: true, total: count, log: [] }
    jobs.set(scope.directory, job)
    try {
      for (let index = 0; index < count; index++) {
        context.ensureCurrent()
        try {
          const result = await action()
          job.added++
          job.log.push('已进入待审池：' + result.title)
        } catch (error) {
          context.ensureCurrent()
          job.failed++
          job.log.push('本题未进入待审池，请查看候选记录')
          if (!error || typeof error !== 'object' || !('kind' in error) || error.kind !== 'content') {
            job.skipped = count - index - 1
            break
          }
        }
      }
      return response({ ok: job.failed === 0, generating: { ...job, running: false } })
    } finally {
      job.running = false
    }
  }

  const handlers: Record<string, Handler> = {
    'turtle-soup.read': async (_request, _context, scope) => overview(scope),
    'turtle-soup.candidates': async (_request, _context, { store }) =>
      response({ candidates: store.readCandidates().candidates.sort((left, right) => right.updatedAt - left.updatedAt) }),
    'turtle-soup.rejected': async (_request, _context, { directory }) => {
      const filename = path.join(directory, 'rejected.jsonl')
      const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
      const rejected = stat?.isFile() && stat.size <= 2 * 1024 * 1024
        ? fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean).slice(-30).flatMap(line => {
          try { return [JSON.parse(line)] } catch { return [] }
        }) : []
      return response({ rejected })
    },
    'turtle-soup.audit': async (request, context, { store, generator }) => {
      const id = targetId(request)
      const puzzle = store.readPuzzles().puzzles.find(row => row.id === id)
      if (!puzzle) throw new AgentConsoleError('not_found')
      const hash = puzzleContentHash(puzzle)
      const audits = await generator.auditPuzzle(puzzle)
      const updated = await store.updatePuzzle(id, current => {
        if (puzzleContentHash(current) !== hash) throw new AgentConsoleError('conflict')
        const reviewed = { ...current, contentHash: hash, audits: [...(current.audits ?? []), ...audits] }
        return reviewed.status === 'active' && !hasCurrentPassingAudits(reviewed)
          ? transition(reviewed, 'pending', '重新审核未通过，暂缓投放', context.principal.username ?? '控制台') : reviewed
      })
      return response({ ok: true, id, audits, status: updated.status, eligible: hasCurrentPassingAudits(updated) })
    },
    'turtle-soup.status': async (request, context, { store }) => {
      const id = targetId(request)
      const { status, contentHash } = body(request)
      if (status !== 'active' && status !== 'pending' && status !== 'retired') throw new AgentConsoleError('invalid_request')
      const explanation = reason(request)
      const actor = context.principal.username ?? '控制台'
      await store.transaction(state => {
        const index = state.puzzles.findIndex(row => row.id === id)
        if (index < 0) throw new AgentConsoleError('not_found')
        const current = state.puzzles[index]!
        if (contentHash !== puzzleContentHash(current)) throw new AgentConsoleError('conflict')
        if (status === 'active') {
          if (!hasCurrentPassingAudits(current)) throw new AgentConsoleError('conflict')
          const family = puzzleFamilyId(current)
          for (const [otherIndex, other] of state.puzzles.entries()) {
            if (otherIndex === index || other.status !== 'active' || puzzleFamilyId(other) !== family) continue
            if ((other.version ?? 1) > (current.version ?? 1)) throw new AgentConsoleError('conflict')
            state.puzzles[otherIndex] = transition(other, 'retired', explanation, actor)
          }
        }
        state.puzzles[index] = transition(current, status, explanation, actor)
      })
      return response({ ok: true, id, status })
    },
    'turtle-soup.generate': async (request, context, scope) => {
      const { count = 3, difficulty } = body(request)
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10 ||
        difficulty !== undefined && !difficulties.some(value => value === difficulty)) throw new AgentConsoleError('invalid_request')
      return runJob(scope, context, count, () => scope.generator.generateOne(difficulties.find(value => value === difficulty)))
    },
    'turtle-soup.repair': async (request, context, scope) => {
      const id = targetId(request)
      const explanation = reason(request)
      if (!scope.store.readPuzzles().puzzles.some(row => row.id === id)) throw new AgentConsoleError('not_found')
      return runJob(scope, context, 1, () => scope.generator.repairPuzzle(id, explanation))
    },
    'turtle-soup.recover': async (request, context, scope) => {
      const id = targetId(request)
      if (!scope.store.readCandidates().candidates.some(row => row.id === id)) throw new AgentConsoleError('not_found')
      return runJob(scope, context, 1, () => scope.generator.recoverCandidate(id))
    },
    'turtle-soup.score': async (request, _context, { store }) => {
      const id = targetId(request)
      const score = body(request).score
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) throw new AgentConsoleError('invalid_request')
      const explanation = reason(request, score <= 3)
      await store.updatePuzzle(id, current => ({ ...current, manualScore: score, manualScoreAt: Date.now(), manualScoreReason: explanation }))
      return response({ ok: true, id, manualScore: score })
    },
    'turtle-soup.score-clear': async (request, _context, { store }) => {
      const id = targetId(request)
      await store.updatePuzzle(id, current => {
        const { manualScore: _score, manualScoreAt: _at, manualScoreReason: _reason, ...puzzle } = current
        return puzzle
      })
      return response({ ok: true, id })
    },
    'turtle-soup.delete': async (request, _context, { store }) => {
      const id = targetId(request)
      await store.transaction(state => {
        if (!state.puzzles.some(row => row.id === id)) throw new AgentConsoleError('not_found')
        if (state.plays.some(play => play.puzzleId === id) || state.puzzles.some(row => row.parentPuzzleId === id) ||
          Object.values(state.sessions).some(session => session.puzzleId === id || session.choosing?.candidates.includes(id))) {
          throw new AgentConsoleError('conflict')
        }
        state.puzzles = state.puzzles.filter(row => row.id !== id)
      })
      return response({ ok: true, id })
    },
  }
  return AGENT_CONSOLE_SERVICES.flatMap(service => {
    const handle = handlers[service.operation]
    return handle ? [{ ...service, handle: (request: AgentConsoleRequest, context: AgentConsoleContext) =>
      handle(request, context, selected(context, request.method !== 'GET')) }] : []
  })
}
