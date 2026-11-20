import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext, AgentConsoleJson, AgentConsoleService } from '../contracts/agentConsole.js'
import type { AgentManagementBindings } from '../contracts/agentManagement.js'
import { createExpressionLearnerClass } from '../modules/memory/application/expressionLearner.js'
import { createGlobalStyleLearnerClass } from '../modules/memory/infrastructure/globalStyleLearner.js'
import { agentBindingToken, agentConversationKey } from '../modules/runtime/domain/agentBindings.js'
import { withFileLock, writeAtomicJson } from '../modules/games/infrastructure/gameFiles.js'

const groupId = /^[1-9][0-9]{0,19}$/u
const expressionPrefix = 'ytbot:expression:'
const readonlyWrite = async (): Promise<never> => { throw new AgentConsoleError('forbidden') }
const json = (value: AgentConsoleJson) => ({ kind: 'json' as const, value })

function readText(filename: string, maximum = 2 * 1024 * 1024): string | null {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isFile() || stat.size > maximum) throw new AgentConsoleError('unavailable')
  return fs.readFileSync(filename, 'utf8')
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentConsoleError('invalid_request')
  return value as Readonly<Record<string, unknown>>
}

export function createStandaloneAgentConsoleStyle(options: {
  readonly dataDir: string
  readonly bindings: AgentManagementBindings
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly allowsText: (text: string) => boolean
}): readonly AgentConsoleService[] {
  const archive = path.join(options.dataDir, 'legacy-console')
  const baseDir = path.join(archive, 'style')
  const preferences = path.join(options.dataDir, 'console', 'style')
  const GlobalStyle = createGlobalStyleLearnerClass({ botId: () => undefined, buildExpressionObservation: () => null })
  const global = new GlobalStyle()
  const GroupStyle = createExpressionLearnerClass({
    store: {
      async get(key) {
        const id = key.slice(expressionPrefix.length)
        return key.startsWith(expressionPrefix) && groupId.test(id) ? readText(path.join(baseDir, 'groups', id + '.json')) : null
      },
      set: readonlyWrite,
    },
    logger: { error() {}, info() {} },
    fetch: readonlyWrite,
  })
  const groups = new GroupStyle()

  function legacyAccount() {
    const text = readText(path.join(archive, 'manifest.json'))
    if (!text) return null
    const manifest = record(JSON.parse(text))
    const account = manifest.legacyAccount
    if (manifest.version !== 1 || typeof account !== 'string' || !groupId.test(account)) throw new AgentConsoleError('unavailable')
    return account
  }

  function scopeFile(scope: string) {
    const hash = createHash('sha256').update(scope).digest('hex')
    return path.join(preferences, hash + '.json')
  }

  function identifiers(filename: string) {
    const text = readText(filename, 512 * 1024)
    if (!text) return []
    const values: unknown = JSON.parse(text)
    if (!Array.isArray(values) || values.length > 2000 ||
      values.some(value => typeof value !== 'string' || !value || value.length > 256)) throw new AgentConsoleError('unavailable')
    return values as string[]
  }

  async function suppress(filename: string, value: string, context: AgentConsoleContext) {
    context.ensureCurrent()
    fs.mkdirSync(preferences, { recursive: true, mode: 0o700 })
    await withFileLock(filename + '.lock', () => {
      const existing = identifiers(filename)
      context.ensureCurrent()
      if (!existing.includes(value)) {
        if (existing.length >= 2000) throw new AgentConsoleError('unavailable')
        writeAtomicJson(filename, [...existing, value])
      }
    })
  }

  async function overview(context: AgentConsoleContext) {
    const origin = legacyAccount()
    const memory = global.readMemory({ baseDir })
    const removed = new Set(identifiers(path.join(preferences, 'removed-rules.json')))
    const rules = (kind: 'absorb' | 'avoid') => memory.aiRules[kind]
      .filter(row => !removed.has(kind + ':' + row.key) && options.allowsText(JSON.stringify(row)))
      .map(({ key, label, rule, confidence }) => ({ key, label, rule, confidence }))
    const result = []
    const groupNames: Record<string, string> = {}
    for (const binding of options.bindings.list()) {
      const { target } = binding
      const account = target.account
      if (account.platform !== 'qq' || account.namespace !== 'global' || account.id !== origin ||
        target.kind !== 'group' || !groupId.test(target.id)) continue
      if (await options.auth.authorize(context.principal, 'style.read', binding, context) !== 'allowed') continue
      context.ensureCurrent()
      if (!readText(path.join(baseDir, 'groups', target.id + '.json'))) continue
      const scopeKey = agentConversationKey(binding)
      const token = agentBindingToken(binding)
      const words = identifiers(scopeFile(scopeKey))
      const safe = (text: string) => options.allowsText(text) && !words.some(word => text.includes(word))
      const expressions = await groups.getGroupExpressionsSnapshot(target.id)
      context.ensureCurrent()
      const current = options.bindings.resolve(target)
      if (!current || agentBindingToken(current) !== token) throw new AgentConsoleError('conflict')
      groupNames[scopeKey] = '群 ' + target.id
      result.push({ groupId: scopeKey, scopeKey, bindingToken: token, expressions: {
        words: expressions.words.filter(row => safe(row.word)), patterns: expressions.patterns.filter(safe),
        styleExpressions: expressions.styleExpressions.filter(row => safe(row.situation)).map(row =>
          ({ situation: row.situation, expressions: row.expressions.filter(safe) })),
        rhythmPatterns: expressions.rhythmPatterns.filter(row => options.allowsText(row.layout)),
      } })
    }
    return json({
      enabled: true, archive: true, imported: origin !== null, autoSummaryEnabled: false,
      totalSamples: memory.totalSamples, lastSummaryAt: memory.aiSummary.lastAt || memory.aiSummary.lastAutoAt || '',
      memoryUpdatedAt: memory.updatedAt || '', aiRules: { absorb: rules('absorb'), avoid: rules('avoid') },
      promptPreview: '', groups: result, groupNames,
    })
  }

  const handlers: Readonly<Record<string, NonNullable<AgentConsoleService['handle']>>> = {
    'style.read': (_request, context) => overview(context),
    'style.remove-rule': async (request, context) => {
      const { kind, key } = record(request.body)
      if ((kind !== 'absorb' && kind !== 'avoid') || typeof key !== 'string' || !key || key.length > 240 ||
        !options.allowsText(key)) throw new AgentConsoleError('invalid_request')
      if (!global.readMemory({ baseDir }).aiRules[kind].some(rule => rule.key === key)) throw new AgentConsoleError('not_found')
      await suppress(path.join(preferences, 'removed-rules.json'), kind + ':' + key, context)
      return json({ ok: true })
    },
    'style.block-word': async (request, context) => {
      const binding = context.binding
      if (!binding || binding.target.kind !== 'group' || binding.target.account.id !== legacyAccount() ||
        binding.target.account.platform !== 'qq' || binding.target.account.namespace !== 'global') {
        throw new AgentConsoleError('forbidden')
      }
      const { word } = record(request.body)
      if (typeof word !== 'string' || !word.trim() || word.length > 20 || !options.allowsText(word)) {
        throw new AgentConsoleError('invalid_request')
      }
      await suppress(scopeFile(agentConversationKey(binding)), word.trim(), context)
      return json({ ok: true })
    },
  }

  return AGENT_CONSOLE_SERVICES.flatMap(service => {
    const handle = handlers[service.operation]
    return handle ? [{ ...service, handle }] : []
  })
}
