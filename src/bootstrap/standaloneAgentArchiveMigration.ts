import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import type { AgentHistoryConfig } from '../contracts/agentHistory.js'
import { qqId, validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { agentConversationKey, agentPersonaScopeId, conversationAddressKey, decodeAgentConversationKey } from '../modules/runtime/domain/agentBindings.js'
import { agentHistoryId, createAgentHistoryStore, AGENT_HISTORY_CLEANUP_KEY, type AgentHistoryRow } from '../modules/memory/infrastructure/agentHistoryStore.js'
import { conversationCleanupAllows, parseConversationCleanup } from '../modules/memory/infrastructure/conversationMemoryCleanup.js'
import { parseSemanticCleanup, semanticCleanupAllows, SEMANTIC_CLEANUP_KEY } from '../modules/memory/infrastructure/agentSemanticMemoryCleanup.js'
import { createPersonMemoryStore } from '../modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../modules/memory/infrastructure/personMemoryContext.js'
import { isPersonMemoryRedacted } from '../modules/memory/domain/personMemory.js'
import { KEY } from '../modules/memory/infrastructure/engine/constants.js'
import { agentMemoryScope } from '../modules/memory/domain/memoryScope.js'

export type ArchiveMigrationCheck = { key: string; value: string | null; write?: string | null }
export interface StandaloneAgentArchiveMigrationOptions {
  readonly redis: { get(key: string): Promise<string | null> }
  readonly prefix: string
  readonly binding: AgentBindingSnapshot
  readonly sourceBinding?: AgentBindingSnapshot
  /** Implicit group origin proven by frozen role settings and the original Yunzai event identifier. */
  readonly legacyGroup?: {
    readonly originalRole: string
    readonly roleEffectiveAt: number
    readonly frozenAt: number
  }
  readonly previewWhileRunning?: boolean
  /** The resolved legacy messageArchive.baseDir, not a guessed data directory. */
  readonly sourceArchiveDir: string
  readonly history: AgentHistoryConfig
  readonly now: number
  readonly checks: Map<string, ArchiveMigrationCheck>
  isCurrent(): boolean
  allowsText(text: string): boolean
}
type RecordValue = Record<string, unknown>
type Location = { file: string; line: number; sha256: string }
type Original = { row: RecordValue; location: Location }
type Receipt = { messageId: string; fingerprint: string; source: Location }
const DAY = 86_400_000, MAX_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 100_000
const CATALOG = 'agent:history:v1:catalog'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const hash = (value: unknown) => sha(JSON.stringify(value))
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
const historyFields = (row: AgentHistoryRow) => [row.messageId, row.authorId, row.name, row.text, row.at, row.peerId ?? null]
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
}
function scopeKey(value: unknown): string | undefined {
  if (!object(value) || !object(value.target) || !object(value.target.account)) return
  const key = agentConversationKey(value as unknown as AgentBindingSnapshot)
  return decodeAgentConversationKey(key) ? key : undefined
}
const numeric = (value: unknown) => (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) && qqId(value) === String(value)
const messageId = (value: unknown): string | undefined => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof id === 'string' && id !== '0' && /^-?\d{1,30}$/u.test(id) ? id : undefined
}
function fail(reason: string): never { throw new Error(`旧原文归档迁移：${reason}`) }
function parse(raw: string, label: string): unknown {
  try { return JSON.parse(raw) as unknown } catch { return fail(`${label}损坏，未写入`) }
}

/** Bounded, immutable offline evidence, including files which were absent. */
function diskSnapshot(archiveDir: string, kind: 'group' | 'private', conversationId: string) {
  const root = path.resolve(archiveDir), parent = path.dirname(root)
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) fail('归档父目录无效')
  const realParent = fs.realpathSync(parent), contents = new Map<string, string | null>()
  let bytes = 0, records = 0
  const safe = (file: string) => {
    if (fs.realpathSync(parent) !== realParent) fail('来源目录已改变')
    const relative = path.relative(parent, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('来源路径越界')
    let next = parent
    for (const piece of relative.split(path.sep)) {
      next = path.join(next, piece)
      if (!fs.existsSync(next)) {
        try { if (fs.lstatSync(next).isSymbolicLink()) fail('来源含符号链接') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        return
      }
      if (fs.lstatSync(next).isSymbolicLink()) fail('来源含符号链接')
    }
  }
  const readRaw = (file: string) => {
    safe(file)
    if (!fs.existsSync(file)) return null
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('来源文件类型或大小无效')
    return fs.readFileSync(file, 'utf8')
  }
  const capture = (file: string) => {
    if (contents.has(file)) return contents.get(file)!
    const raw = readRaw(file)
    bytes += raw === null ? 0 : Buffer.byteLength(raw)
    if (bytes > MAX_BYTES) fail('来源快照超过64MiB')
    contents.set(file, raw); return raw
  }
  const directory = path.join(root, kind, conversationId)
  const names = () => {
    safe(directory)
    if (!fs.existsSync(directory)) return []
    if (!fs.lstatSync(directory).isDirectory()) fail('归档会话目录无效')
    const listed = fs.readdirSync(directory).filter(name => name.endsWith('.ndjson')).sort()
    if (listed.length > 1000 || listed.some(name => !/^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))) fail('归档文件名或文件数量无效')
    return listed
  }
  const listed = names(), originals: Original[] = []
  const lines = (raw: string, label: string) => raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return []
    if (++records > MAX_RECORDS) fail('来源记录超过扫描上限')
    const row = parse(line, label)
    if (!object(row)) fail(`${label}记录无效`)
    return [{ row, line: index + 1, sha256: sha(line) }]
  })
  for (const name of listed) for (const item of lines(capture(path.join(directory, name))!, '归档')) {
    originals.push({ row: item.row, location: { file: `${kind}/${conversationId}/${name}`, line: item.line, sha256: item.sha256 } })
  }
  const forgotten = new Set<string>()
  let unresolved = false
  // The legacy semantic index is group-only. An equal numeric private peer is
  // a different scene and must not inherit that group's erasures or files.
  const tombstone = kind === 'group' ? capture(path.join(parent, 'semantic_memory', 'redactions', `${encodeURIComponent(conversationId)}.json`)) : null
  if (tombstone !== null) {
    const row = parse(tombstone, '语义遗忘记录')
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_RECORDS &&
      value.every(item => typeof item === 'string' && !!item && item.length <= 240) && new Set(value).size === value.length
    if (!object(row) || Object.keys(row).some(key => !['ids', 'messages'].includes(key)) || !ids(row.ids) || !ids(row.messages)) fail('语义遗忘记录格式无效')
    for (const id of row.messages) forgotten.add(id)
    if (row.ids.length) {
      const raw = capture(path.join(parent, 'semantic_memory', 'group', `${conversationId}.ndjson`))
      const chunks = new Map<string, RecordValue>()
      if (raw !== null) for (const { row: chunk } of lines(raw, '语义块')) if (typeof chunk.id === 'string') chunks.set(chunk.id, chunk)
      for (const id of row.ids) {
        const chunk = chunks.get(id)
        if (!chunk || !ids(chunk.message_ids) || !chunk.message_ids.length || chunk.message_ids.some(id => !forgotten.has(id))) unresolved = true
      }
    }
  }
  return { originals, forgotten, unresolved, isCurrent() {
    try { return JSON.stringify(names()) === JSON.stringify(listed) && [...contents].every(([file, raw]) => readRaw(file) === raw) }
    catch { return false }
  } }
}

function inConversation(row: RecordValue, binding: AgentBindingSnapshot): boolean {
  return row.message_type === binding.target.kind && (binding.target.kind === 'private'
    ? row.group_id === null && numeric(row.user_id) && String(row.user_id) === binding.target.id
    : String(row.group_id) === binding.target.id)
}

function originalText(row: RecordValue, binding: AgentBindingSnapshot, now: number): AgentHistoryRow | undefined {
  if (row.version !== 1 || !inConversation(row, binding) ||
      row.archive_kind !== undefined || row.source != null || row.personaSource != null || row.forwardCompleteness !== undefined ||
      !numeric(row.user_id) || String(row.user_id) === binding.target.account.id || !object(row.sender) ||
      !numeric(row.sender.user_id) || String(row.sender.user_id) !== String(row.user_id) || !messageId(row.message_id) ||
      typeof row.timestamp !== 'number' || !Number.isSafeInteger(row.timestamp) || row.timestamp <= 0 || row.timestamp > now + 60_000 ||
      row.raw_truncated !== false || typeof row.raw_message !== 'string' || !row.raw_message.trim() || row.raw_message.length > 4000 ||
      !Array.isArray(row.message) || !row.message.length || row.recalled !== undefined && typeof row.recalled !== 'boolean') return
  let text = ''
  for (const part of row.message) {
    if (!object(part) || part.type !== 'text' || part.data !== undefined && !object(part.data)) return
    const value = part.text ?? (object(part.data) ? part.data.text : undefined)
    if (typeof value !== 'string' || part.text !== undefined && object(part.data) && part.data.text !== undefined && part.text !== part.data.text) return
    text += value
  }
  const name = row.sender.card || row.sender.nickname || ''
  if (text !== row.raw_message || typeof name !== 'string' || name.length > 24) return
  return { messageId: messageId(row.message_id)!, authorId: String(row.user_id), name, text, at: row.timestamp,
    ...(binding.target.kind === 'private' ? { peerId: binding.target.id } : {}) }
}

/** Stage only. The parent owns preview/apply, source/config rechecks and the final atomic CAS.
 * Run alongside the existing person-memory privacy handover in that same CAS.
 * Source files are never edited; no generated memories, embeddings or new portable facts are made.
 */
export async function stageStandaloneAgentArchiveMigration(options: StandaloneAgentArchiveMigrationOptions) {
  const { prefix, binding, sourceBinding, legacyGroup, now } = options
  const destinationKey = scopeKey(binding), sourceKey = sourceBinding ? scopeKey(sourceBinding) : destinationKey
  const supportedLegacy = legacyGroup && binding?.source === 'configured' && binding.target.kind === 'group' &&
    legacyGroup.originalRole === 'default' && binding.personaId === 'default' && binding.agentId === 'shiloh' &&
    Number.isSafeInteger(legacyGroup.roleEffectiveAt) && legacyGroup.roleEffectiveAt > 0 &&
    Number.isSafeInteger(legacyGroup.frozenAt) && legacyGroup.frozenAt >= legacyGroup.roleEffectiveAt &&
    legacyGroup.frozenAt <= now
  if (!/^bl-agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:$/u.test(prefix) || !Number.isSafeInteger(now) || now <= 0 ||
      !object(binding) || (legacyGroup ? !supportedLegacy || sourceBinding !== undefined : !object(sourceBinding)) ||
      !object(options.history) || options.history.enabled !== true ||
      !destinationKey || !sourceKey || binding.target.kind !== 'group' && binding.target.kind !== 'private' ||
      binding.target.account.platform !== 'qq' || binding.target.account.namespace !== 'global' ||
      sourceKey !== destinationKey || typeof binding.personaId !== 'string' || !binding.personaId ||
      sourceBinding !== undefined && sourceBinding.personaId !== binding.personaId ||
      typeof options.sourceArchiveDir !== 'string' || !path.isAbsolute(options.sourceArchiveDir)) fail('只接受已启用history且来源归属相同的QQ/global群或私聊绑定及明确归档目录')
  validateQqBindingAddress(binding.target)
  if (sourceBinding) validateQqBindingAddress(sourceBinding.target)
  const bounded = (value: unknown, fallback: number, min: number, max: number) => value === undefined ? fallback
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail('history保留期或容量无效')
  const retention = bounded(options.history.retentionDays, 30, 1, 90) * DAY
  const maximum = bounded(options.history.maxMessagesPerConversation, 1000, 50, 2000)
  const signature = JSON.stringify([binding, sourceBinding, legacyGroup, options.history])
  const current = () => {
    try { return options.isCurrent() === true && JSON.stringify([options.binding, options.sourceBinding, options.legacyGroup, options.history]) === signature }
    catch { return false }
  }
  const ensure = () => { if (!current()) fail('来源或目标绑定及配置已改变') }
  ensure()
  // Stage against a private overlay so an exception cannot leave partial parent writes.
  const checks = new Map([...options.checks].map(([key, value]) => [key, { ...value }]))
  const read = async (key: string) => {
    ensure()
    let check = checks.get(key)
    if (!check) { check = { key, value: await options.redis.get(key) }; checks.set(key, check) }
    if (check.value !== null && typeof check.value !== 'string') fail('Redis比较快照无效')
    ensure(); return check.write === undefined ? check.value : check.write
  }
  const stage = async (key: string, write: string | null) => {
    if (!key.startsWith(prefix)) fail('禁止修改旧来源分区')
    await read(key); checks.get(key)!.write = write
  }
  const { botId, scene } = personMemoryAddress(binding.target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
  const sourceIdentity = legacyGroup ? { botId, personaId: legacyGroup.originalRole } : identity
  const privateChat = binding.target.kind === 'private'
  const memoryBase = `shiloh:person-memory:v1:${encodeURIComponent(botId)}:${encodeURIComponent(identity.personaId)}`
  for (const key of [prefix + 'agent:host-lease', memoryBase + ':lock', prefix + memoryBase + ':lock',
    'shiloh:person-memory:v1:' + encodeURIComponent(botId) + ':' + encodeURIComponent(sourceIdentity.personaId) + ':lock',
    'shiloh:person-memory:v1:identities:lock', prefix + 'shiloh:person-memory:v1:identities:lock']) {
    if (key === prefix + 'agent:host-lease' && legacyGroup && options.previewWhileRunning) continue
    if (await read(key) !== null) fail('宿主或人物隐私仍在更新，须离线迁移')
  }
  if (privateChat) for (const base of ['', prefix]) {
    // Per-message receipts expire. The conversation epoch also fences a recall
    // that arrives after staging, including changes affecting pruned receipts.
    await read(base + 'agent:private-recall:' + conversationAddressKey(binding.target))
  }
  const disk = diskSnapshot(options.sourceArchiveDir, binding.target.kind, binding.target.id)
  const report = { scanned: disk.originals.length, imported: 0, alreadyImported: 0, removed: 0, retained: 0, duplicates: 0,
    skipped: { identity: 0, incomplete: 0, conflict: 0, recalled: 0, privacy: 0, expired: 0, capacity: 0, policy: 0, semanticDependency: 0 } }
  const skip = (reason: keyof typeof report.skipped) => { report.retained++; report.skipped[reason]++ }
  const memory = (base: string, writable: boolean) => createPersonMemoryStore({ now: () => now, redis: {
    get: key => read(base + key),
    async set(key, value) { if (!writable) fail('旧人物隐私只读'); await stage(base + key, value); return 'OK' },
    async del(key) { if (!writable) fail('旧人物隐私只读'); await stage(base + key, null); return 1 },
  } })
  const sourceMemory = memory('', false), targetMemory = memory(prefix, true)
  // Only complete private scopes may constrain this peer; the bare peer number
  // names a legacy group, never a private privacy document.
  const metaScopes = privateChat ? [agentMemoryScope(binding),
    `private:${encodeURIComponent(botId)}:${encodeURIComponent(identity.personaId)}:${encodeURIComponent(binding.target.id)}`] : [binding.target.id]
  const optedOut = new Set<string>()
  let disabled = false
  const metaKeys = metaScopes.map(scope => KEY.meta(scope))
  if (privateChat || legacyGroup) metaKeys.push(...metaScopes.map(scope => prefix + KEY.meta(scope)))
  if (legacyGroup) metaKeys.push(prefix + KEY.meta(agentMemoryScope(binding)))
  for (const key of metaKeys) {
    const raw = await read(key), meta = raw === null ? {} : parse(raw, '会话记忆隐私')
    if (!object(meta) || meta.disabled !== undefined && typeof meta.disabled !== 'boolean' ||
        meta.optedOut !== undefined && (!Array.isArray(meta.optedOut) || meta.optedOut.some(value => !numeric(value)))) fail('会话记忆隐私格式无效')
    disabled ||= meta.disabled === true
    for (const id of Array.isArray(meta.optedOut) ? meta.optedOut : []) optedOut.add(String(id))
  }
  const semanticCleanup = legacyGroup && parseSemanticCleanup(await read(prefix + SEMANTIC_CLEANUP_KEY))
  if (privateChat) for (const store of [sourceMemory, targetMemory]) {
    // Capture both documents even when the archive is empty, incomplete, or
    // already pruned; their original bytes remain final-CAS evidence.
    await store.getRedactions({ identity, subjectId: binding.target.id })
  }
  const id = agentHistoryId(binding), stateKey = `agent:history:v1:state:${id}`
  const historyCleanup = parseConversationCleanup(await read(prefix + AGENT_HISTORY_CLEANUP_KEY))
  const history = createAgentHistoryStore({ get: key => read(prefix + key),
    async eval(_script, args) {
      if (args.arguments.length || args.keys.length !== 3 || args.keys[0] !== CATALOG ||
          args.keys[1] !== stateKey || args.keys[2] !== AGENT_HISTORY_CLEANUP_KEY) fail('历史校验器不得执行写操作')
      return Promise.all(args.keys.map(key => read(prefix + key)))
    } })
  const existing = await history.read(id), catalog = await history.listScopes()
  const markerKey = prefix + 'agent:migration:qq-archive:v1:' + id
  const markerRaw = await read(markerKey), marker = markerRaw === null ? { version: 1, scope: { agentId: binding.agentId, target: binding.target }, imported: [] }
    : parse(markerRaw, '原文交接记录')
  if (!object(marker) || marker.version !== 1 || Object.keys(marker).some(key => !['version', 'scope', 'imported'].includes(key)) ||
      !object(marker.scope) || Object.keys(marker.scope).some(key => !['agentId', 'target'].includes(key)) || scopeKey(marker.scope) !== destinationKey ||
      !Array.isArray(marker.imported) || marker.imported.length > 2000) fail('原文交接记录无效')
  const receipts = new Map<string, Receipt>()
  const portableRows: AgentHistoryRow[] = []
  for (const entry of marker.imported) {
    if (!object(entry) || Object.keys(entry).some(key => !['messageId', 'fingerprint', 'source'].includes(key)) || messageId(entry.messageId) !== entry.messageId ||
        typeof entry.fingerprint !== 'string' || !/^[a-f\d]{64}$/u.test(entry.fingerprint) || receipts.has(entry.messageId as string) || !object(entry.source) ||
        Object.keys(entry.source).some(key => !['file', 'line', 'sha256'].includes(key)) ||
        typeof entry.source.file !== 'string' || !new RegExp(`^${binding.target.kind}/${binding.target.id}/\\d{4}-\\d{2}-\\d{2}\\.ndjson$`, 'u').test(entry.source.file) ||
        !Number.isSafeInteger(entry.source.line) || Number(entry.source.line) < 1 || typeof entry.source.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(entry.source.sha256)) fail('原文交接条目无效')
    receipts.set(entry.messageId as string, entry as unknown as Receipt)
  }
  const originals = new Map<string, Original[]>(), revoked = new Set(disk.forgotten)
  for (const original of disk.originals) {
    const { row } = original, mid = messageId(row.message_id)
    if (row.archive_kind === 'notice') {
      if (!privateChat && row.message_type === 'group' && String(row.group_id) === binding.target.id &&
          /^(?:group[._])?recall$/u.test(String(row.notice_type))) {
        if (row.version !== 1 || !mid) fail('撤回归档无效')
        revoked.add(mid)
      }
      continue
    }
    if (!mid) { skip('incomplete'); continue }
    const group = originals.get(mid) ?? []; group.push(original); originals.set(mid, group)
    if (row.recalled === true && (privateChat ? inConversation(row, binding) &&
      row.source_bot_id === binding.target.account.id && row.source_persona_id === identity.personaId : String(row.group_id) === binding.target.id)) revoked.add(mid)
  }
  const nextRows = new Map((existing?.rows ?? []).map(row => [row.messageId, row]))
  const fingerprint = (row: AgentHistoryRow) => hash([sourceKey, identity.personaId, historyFields(row)])
  const blockedReason = async (mid: string, row?: AgentHistoryRow) => {
    let blocked: 'recalled' | 'privacy' | undefined
    if (revoked.has(mid)) blocked = 'recalled'
    for (const kind of privateChat ? ['recall'] : ['recall', 'text-recall']) {
      const key = `agent:inbox:${kind === 'text-recall' ? 'text-recall-receipt' : 'receipt'}:${hash([kind, conversationAddressKey(binding.target), mid])}`
      for (const base of ['', prefix]) if (await read(base + key) === '1') blocked = 'recalled'
    }
    if (row) {
      if (disabled || optedOut.has(row.authorId) || !conversationCleanupAllows(binding, row, historyCleanup) ||
          semanticCleanup && !semanticCleanupAllows(binding, row, semanticCleanup)) blocked = 'privacy'
      const source = { scene, authorId: row.authorId, messageId: mid, at: row.at, excerpt: row.text }
      for (const [store, owner] of [[sourceMemory, sourceIdentity], [targetMemory, identity]] as const) {
        if (isPersonMemoryRedacted(source, row.text, await store.getRedactions({ identity: owner, subjectId: row.authorId }))) blocked = 'privacy'
      }
    }
    return disk.unresolved ? 'semanticDependency' as const : blocked
  }
  // Withdrawal must not depend on a surviving, complete or nonconflicting archive copy.
  // A receipt proves which target rows this migration owns, even after source pruning.
  for (const [mid, receipt] of receipts) {
    const saved = nextRows.get(mid)
    if (saved && receipt.fingerprint !== fingerprint(saved)) fail('目标原文与既有交接来源冲突')
    if (!await blockedReason(mid, saved)) continue
    await targetMemory.revokeSource({ identity, scene, messageId: mid, at: now })
    if (saved) { nextRows.delete(mid); report.removed++ }
  }
  const originalTimes = (copies: Original[]) => typeof copies[0]?.row.timestamp === 'number' ? copies[0].row.timestamp : 0
  const candidates = legacyGroup ? [...originals].sort((a, b) => originalTimes(b[1]) - originalTimes(a[1])) : originals
  for (const [mid, copies] of candidates) {
    const original = copies[0]!, raw = original.row
    const explicit = !legacyGroup && raw.source_bot_id === binding.target.account.id && raw.source_persona_id === identity.personaId
    const implicit = legacyGroup && raw.source_bot_id === undefined && raw.source_persona_id === undefined &&
      raw.event_id === ['v1', binding.target.account.id, 'message', 'group', binding.target.id, mid].join(':') &&
      typeof raw.timestamp === 'number' && raw.timestamp >= legacyGroup.roleEffectiveAt && raw.timestamp <= legacyGroup.frozenAt
    if ((!explicit && !implicit) || !inConversation(raw, binding)) { skip('identity'); continue }
    const row = originalText(raw, binding, now)
    if (!row) { skip('incomplete'); continue }
    if (copies.some(copy => hash(canonical(copy.row)) !== hash(canonical(raw)))) { skip('conflict'); continue }
    report.duplicates += copies.length - 1
    const source = { scene, authorId: row.authorId, messageId: mid, at: row.at, excerpt: row.text }
    const receipt = receipts.get(mid)
    const blocked = await blockedReason(mid, row)
    if (blocked) { skip(blocked); continue }
    if (row.at < now - retention) { skip('expired'); continue }
    if (!options.allowsText(row.text) || !options.allowsText(row.name)) { skip('policy'); continue }
    const sourceFingerprint = fingerprint(row)
    if (receipt) {
      if (receipt.fingerprint !== sourceFingerprint) fail('原文交接来源已改变')
      if (nextRows.has(mid)) portableRows.push(row)
      report.alreadyImported++; continue
    }
    const saved = nextRows.get(mid)
    if (saved && hash(historyFields(saved)) !== hash(historyFields(row))) fail('目标已有同编号的不同原文，未覆盖')
    if (receipts.size >= 2000 || !saved && nextRows.size >= maximum) { skip('capacity'); continue }
    if (!await targetMemory.registerSource({ identity, subjectId: row.authorId, source }, current)) { skip('privacy'); continue }
    receipts.set(mid, { messageId: mid, fingerprint: sourceFingerprint, source: original.location })
    nextRows.set(mid, row); portableRows.push(row); report.imported++
  }
  if (report.imported || report.removed) {
    const scope = { agentId: binding.agentId, target: structuredClone(binding.target) }
    const entries = catalog.some(entry => entry.id === id) ? catalog : [...catalog, { id, scope }]
    const rows = [...nextRows.values()]
    if (legacyGroup) rows.sort((a, b) => a.at - b.at)
    await stage(prefix + CATALOG, JSON.stringify({ version: 1, entries }))
    await stage(prefix + stateKey, JSON.stringify({ version: 1, id, scope, rows }))
    await history.read(id) // The canonical store validates the exact staged schema and all bounds.
    await stage(markerKey, JSON.stringify({ version: 1, scope, imported: [...receipts.values()] }))
  }
  ensure()
  if (!disk.isCurrent()) fail('归档或遗忘文件在预览期间改变')
  for (const [key, check] of checks) options.checks.set(key, check)
  return { report, portableRows, isCurrent: () => current() && disk.isCurrent() }
}
