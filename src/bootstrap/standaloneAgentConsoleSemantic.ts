import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { createAgentSemanticMemory } from '../modules/memory/infrastructure/agentSemanticMemory.js'

const groupId = /^[1-9][0-9]{0,19}$/u
const json = (value: AgentConsoleJson) => ({ kind: 'json' as const, value })
const archivedChunkLimit = 128 * 1024 * 1024
const pageSize = 25
type MemoryAdmin = ReturnType<typeof createAgentSemanticMemory>['administration']

function checkedFile(filename: string, limit: number): boolean {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
  if (!stat) return false
  if (!stat.isFile() || stat.size > limit) throw new AgentConsoleError('unavailable')
  return true
}

function loadObject(filename: string): Record<string, unknown> | undefined {
  if (!checkedFile(filename, 2 * 1024 * 1024)) return undefined
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentConsoleError('unavailable')
  return value as Record<string, unknown>
}

function queryOptions(request: AgentConsoleRequest, allowsText: (text: string) => boolean) {
  const query = request.query.q?.trim() ?? ''
  const page = Number(request.query.page ?? 1)
  if (query.length > 2000 || !allowsText(query) || !Number.isSafeInteger(page) || page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / pageSize)) throw new AgentConsoleError('invalid_request')
  return { query, offset: (page - 1) * pageSize }
}

export function createStandaloneAgentConsoleSemantic(options: {
  readonly dataDir: string
  readonly enabled: boolean
  readonly admin: MemoryAdmin
  readonly allowsText: (text: string) => boolean
}): readonly AgentConsoleService[] {
  const root = path.join(options.dataDir, 'legacy-console')
  const archive = path.join(root, 'semantic')

  function binding(context: AgentConsoleContext) {
    const selected = context.binding
    if (!selected) throw new AgentConsoleError('forbidden')
    return selected
  }

  async function archived(request: AgentConsoleRequest, context: AgentConsoleContext) {
    const selected = binding(context)
    const target = selected.target
    const owner = loadObject(path.join(root, 'manifest.json'))
    if (target.account.platform !== 'qq' || target.account.namespace !== 'global' || target.kind !== 'group' ||
        !groupId.test(target.id) || owner?.version !== 1 || owner.legacyAccount !== target.account.id) {
      return json({ archived: false, total: 0, indexed: 0, rows: [] })
    }
    const filename = path.join(archive, 'group', target.id + '.ndjson')
    if (!checkedFile(filename, archivedChunkLimit)) return json({ archived: false, total: 0, indexed: 0, rows: [] })
    const { query, offset } = queryOptions(request, options.allowsText)
    const redactions = loadObject(path.join(archive, 'redactions', target.id + '.json'))
    if (redactions && (!Array.isArray(redactions.ids) || !Array.isArray(redactions.messages))) throw new AgentConsoleError('unavailable')
    const hiddenIds = new Set((redactions?.ids as unknown[] | undefined)?.map(String))
    const hiddenMessages = new Set((redactions?.messages as unknown[] | undefined)?.map(String))
    const cutoff = await options.admin.cutoff(selected, context.isCurrent)
    if (cutoff > 0) return json({ archived: true, privacyRestricted: true, total: 0, indexed: 0, rows: [] })
    const needle = query.toLocaleLowerCase()

    let total = 0
    let indexed = 0
    let read = 0
    const rows: { id: string; text: string; at: number; indexed: boolean }[] = []
    const input = fs.createReadStream(filename, { encoding: 'utf8', signal: context.signal })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (read++ % 128 === 0) context.ensureCurrent()
        if (!line.trim()) continue
        let row: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          row = value as Record<string, unknown>
        } catch {
          continue
        }
        if (typeof row.id !== 'string' || !row.id || row.id.length > 240 || String(row.group_id) !== target.id ||
          typeof row.text !== 'string' || row.text.length > 20_000 || !options.allowsText(row.text) ||
          typeof row.start_ts !== 'number' || !Number.isSafeInteger(row.start_ts) || row.start_ts <= 0 ||
          hiddenIds.has(row.id) || !Array.isArray(row.message_ids) ||
          row.message_ids.some(id => hiddenMessages.has(String(id))) || needle && !row.text.toLocaleLowerCase().includes(needle)) continue
        const hasIndex = Array.isArray(row.emb) && row.emb.length > 0 ||
          typeof row.emb === 'string' && row.emb.length > 0
        if (hasIndex) indexed++
        if (total >= offset && rows.length < pageSize) rows.push({ id: row.id, text: row.text, at: row.start_ts, indexed: hasIndex })
        total++
      }
    } finally {
      lines.close()
      input.destroy()
    }
    if (await options.admin.cutoff(selected, context.isCurrent) !== cutoff) throw new AgentConsoleError('conflict')
    context.ensureCurrent()
    return json({ archived: true, total, indexed, rows })
  }

  const handlers: Readonly<Record<string, NonNullable<AgentConsoleService['handle']>>> = {
    'semantic.read': async () => {
      const importReceipt = loadObject(path.join(root, 'manifest.json'))
      const historyFile = path.join(archive, 'eval-history.ndjson')
      const evaluations = checkedFile(historyFile, 4 * 1024 * 1024)
        ? fs.readFileSync(historyFile, 'utf8').split('\n').filter(line => line.trim()).slice(-30).flatMap(line => {
          try {
            const row = JSON.parse(line) as Record<string, unknown>
            const timestamp = typeof row.generatedAt === 'number' || typeof row.generatedAt === 'string'
              ? new Date(row.generatedAt).getTime() : NaN
            if (!Number.isFinite(timestamp)) return []
            const metric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
            return [{ at: timestamp, samples: metric(row.samples), vectorRecall: metric(row.recallAt5Vector),
              hybridRecall: metric(row.recallAt5Hybrid), rerankRecall: metric(row.recallAt5Rerank) }]
          } catch { return [] }
        }).reverse() : []
      return json({ enabled: options.enabled, legacyImported: importReceipt?.version === 1, evaluations })
    },
    'semantic.records': async (request, context) => {
      if (request.query.source === 'legacy') return archived(request, context)
      const { query, offset } = queryOptions(request, options.allowsText)
      try { return json(await options.admin.records(binding(context), context.isCurrent, query, offset, context.signal)) }
      catch {
        context.ensureCurrent()
        throw new AgentConsoleError('unavailable')
      }
    },
    'semantic.recall': async (request, context) => {
      const { query } = queryOptions(request, options.allowsText)
      if (!query) throw new AgentConsoleError('invalid_request')
      if (!options.enabled) throw new AgentConsoleError('unavailable')
      return json(await options.admin.recall(binding(context), query, context.isCurrent, context.signal))
    },
  }
  return AGENT_CONSOLE_SERVICES.flatMap(service => {
    const handle = handlers[service.operation]
    return handle ? [{ ...service, handle }] : []
  })
}
