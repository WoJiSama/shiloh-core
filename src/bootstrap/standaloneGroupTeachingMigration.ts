import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import type { GroupMemoryEntry, GroupMemoryMessage, GroupMemoryState } from '../contracts/groupMemory.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { KEY } from '../modules/memory/infrastructure/engine/constants.js'
import { createPersonMemoryStore } from '../modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../modules/memory/infrastructure/personMemoryContext.js'
import { isPersonMemoryRedacted } from '../modules/memory/domain/personMemory.js'
import { groupMemoryMessage } from '../modules/memory/domain/groupMemoryMessage.js'
import { groupMemoryId, stageGroupMemoryUpdate } from '../modules/memory/infrastructure/groupMemoryStore.js'
import { qqId } from '../adapters/qqIdentity.js'
import { decodeQqIncomingMessage, opaqueMessageId } from '../adapters/qqMessage.js'

type Check = { key: string; value: string | null; write?: string | null }
type RecordValue = Record<string, unknown>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const compact = (value: string) => value.replace(/\s+/gu, ' ').trim()
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s，,。；;：:！!？?、@"“”']/gu, '')
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value)
const text = (value: unknown, limit: number): value is string => validId(value) && value.length <= limit
const numeric = (value: unknown): value is string => typeof value === 'string' && qqId(value) === value
const ids = (value: unknown, maximum = 50): value is string[] => Array.isArray(value) && value.length <= maximum && value.every(numeric) && new Set(value).size === value.length
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime())
const messageId = (value: unknown) => {
  const id = opaqueMessageId(value)
  return id && validId(id) && id === String(value) ? id : undefined
}

/** An offline snapshot includes recall notices, not just the original message rows. */
function archiveSnapshot(directory: string) {
  const files = new Map<string, string>()
  const names = () => {
    if (!fs.existsSync(directory)) return []
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('群教学归档目录无效')
    const result = fs.readdirSync(directory).filter(name => name.endsWith('.ndjson')).sort()
    if (result.length > 1000 || result.some(name => !/^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))) throw new Error('群教学归档超出扫描范围或文件名无效')
    return result
  }
  const listed = names()
  const rows: RecordValue[] = []
  let size = 0
  for (const name of listed) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    size += stat.size
    if (!stat.isFile() || stat.isSymbolicLink() || size > 64 * 1024 * 1024) throw new Error('群教学归档超过64MiB或文件类型无效')
    const raw = fs.readFileSync(file, 'utf8')
    files.set(name, raw)
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { throw new Error('群教学归档含损坏记录，迁移未写入') }
      if (!object(row)) throw new Error('群教学归档含损坏记录，迁移未写入')
      rows.push(row)
    }
  }
  return { rows, isCurrent() {
    try {
      return JSON.stringify(names()) === JSON.stringify(listed) && listed.every(name => {
        const file = path.join(directory, name), stat = fs.lstatSync(file)
        return stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file, 'utf8') === files.get(name)
      })
    } catch { return false }
  } }
}

function sourceMessage(row: RecordValue, binding: AgentBindingSnapshot, now: number): GroupMemoryMessage | undefined {
  if (row.version !== 1 || row.archive_kind !== undefined || row.message_type !== 'group' || String(row.group_id) !== binding.target.id ||
      row.source_bot_id !== binding.target.account.id || row.source_persona_id !== agentPersonaScopeId(binding.agentId) ||
      !numeric(String(row.user_id)) || String(row.user_id) === binding.target.account.id || !object(row.sender) || String(row.sender.user_id) !== String(row.user_id) ||
      !messageId(row.message_id) || !timestamp(row.timestamp) || row.timestamp > now + 60_000 ||
      row.recalled !== undefined && row.recalled !== false ||
      row.raw_truncated !== false || typeof row.raw_message !== 'string' || row.source != null || row.personaSource != null || row.forwardCompleteness !== undefined ||
      !Array.isArray(row.message) || !row.message.length) return
  const parts = row.message
  if (parts.some(part => !object(part) || !['text', 'at', 'file'].includes(String(part.type)))) return
  let topText = ''
  for (const part of parts) {
    if (part.data !== undefined && !object(part.data)) return
    const data = object(part.data) ? part.data : {}
    if (part.type === 'text') {
      const value = part.text ?? data.text
      if (typeof value !== 'string') return
      topText += value
    } else if (part.type === 'file') {
      if (!text(part.name ?? data.name, 180)) return
      for (const key of ['url', 'file', 'file_id']) {
        const value = part[key] ?? data[key]
        if (value !== undefined && (typeof value !== 'string' || !value)) return
      }
    }
  }
  if ((row.raw_message || topText).replace(/\[CQ:(?:at|file),[^\]]*\]/gu, '') !== topText) return
  const incoming = decodeQqIncomingMessage({ self_id: row.source_bot_id, time: row.timestamp / 1000,
    message_type: row.message_type, group_id: row.group_id, user_id: row.user_id, sender: row.sender,
    message_id: row.message_id, raw_message: row.raw_message, message: row.message }, { binding, now })
  if (!incoming?.messageId || incoming.quote || !incoming.text.trim() || incoming.text.length > 4000 ||
      incoming.parts.some(part => !['text', 'mention', 'file'].includes(part.kind)) ||
      !ids(incoming.mentions.map(user => user.id)) || incoming.parts.filter(part => part.kind === 'file').length > 20 ||
      incoming.occurredAt !== row.timestamp) return
  return groupMemoryMessage({ ...incoming, messageId: incoming.messageId })
}

type Candidate = { raw: RecordValue; sourceKey: string; recordId: string; kind: GroupMemoryEntry['kind']; token: string }
export async function stageStandaloneGroupTeaching(options: {
  redis: { get(key: string): Promise<string | null> }
  prefix: string
  binding: AgentBindingSnapshot
  sourceDataDir: string
  now: number
  checks: Map<string, Check>
}) {
  const { redis, prefix, binding, checks, now } = options
  const report = { imported: 0, retained: 0, alreadyImported: 0,
    skipped: { disabled: 0, source: 0, authorization: 0, unsupported: 0, privacy: 0, revoked: 0 } }
  const read = async (key: string) => {
    let check = checks.get(key)
    if (!check) { check = { key, value: await redis.get(key) }; checks.set(key, check) }
    return check.write === undefined ? check.value : check.write
  }
  const stage = (key: string, write: string | null) => {
    const check = checks.get(key)
    if (!check) throw new Error('群教学迁移缺少比较快照')
    check.write = write
  }
  const json = async (key: string, fallback: unknown): Promise<unknown> => {
    const raw = await read(key)
    if (raw === null) return fallback
    if (raw.length > 4 * 1024 * 1024) throw new Error('群教学源分区过大')
    try { return JSON.parse(raw) as unknown } catch { throw new Error('群教学源分区损坏') }
  }
  const candidates: Candidate[] = []
  for (const category of ['knowledge', 'workflows', 'alias'] as const) {
    const key = KEY[category](binding.target.id), doc = await json(key, category === 'alias' ? {} : [])
    if (category === 'alias' ? !object(doc) : !Array.isArray(doc)) throw new Error('群教学源分区格式无效')
    const rows = category === 'alias' ? Object.entries(doc as RecordValue) : (doc as unknown[]).map((row, index) => [String(index), row] as const)
    if (rows.length > 1000) throw new Error('群教学源条目超过上限')
    const known = new Set<string>()
    for (const [name, value] of rows) {
      if (!object(value)) throw new Error('群教学源记录无效')
      if (category === 'alias' && value.authority !== 'teaching') continue
      const recordId = category === 'alias' ? name : value.id
      if (!validId(recordId) || known.has(recordId)) throw new Error('群教学源记录编号无效或重复')
      known.add(recordId)
      const kind = category === 'alias' ? 'alias' : category === 'workflows' ? 'workflow' : String(value.kind)
      candidates.push({ raw: value, sourceKey: key, recordId, kind: kind as GroupMemoryEntry['kind'],
        token: hash([key, recordId, value.sourceMessageId]) })
    }
  }
  if (candidates.length > 1000) throw new Error('群教学待迁记录超过上限')
  const meta = await json(KEY.meta(binding.target.id), {})
  if (!object(meta) || meta.disabled !== undefined && typeof meta.disabled !== 'boolean' || meta.optedOut !== undefined && !ids(meta.optedOut, 1000)) throw new Error('源群记忆隐私设置无效')
  const skip = (reason: keyof typeof report.skipped) => { report.retained++; report.skipped[reason]++ }
  if (meta.disabled === true) {
    for (const _candidate of candidates) skip('disabled')
    return { report, isCurrent: () => true }
  }
  const archive = archiveSnapshot(path.join(options.sourceDataDir, 'message_archive', 'group', binding.target.id))
  const messages = new Map<string, { source: GroupMemoryMessage; role: unknown; signature: string } | null>()
  const revoked = new Set<string>()
  for (const row of archive.rows) {
    const recall = row.archive_kind === 'notice' && (/^(?:group[._])?recall$/u.test(String(row.notice_type).trim()) ||
      row.notice_type === 'group' && row.sub_type === 'recall')
    if (recall) {
      const id = messageId(row.message_id)
      if (!id || row.version !== 1 || row.message_type !== 'group' || String(row.group_id) !== binding.target.id) throw new Error('群教学撤回归档无效，迁移未写入')
      revoked.add(id)
    }
    if (String(row.group_id) !== binding.target.id || row.archive_kind === 'notice') continue
    const id = messageId(row.message_id)
    if (row.recalled === true) {
      if (!id) throw new Error('群教学撤回归档无效，迁移未写入')
      revoked.add(id)
    }
    if (!id) continue
    const source = sourceMessage(row, binding, now)
    // Invalid copies are contradictory evidence too; never discard them before grouping.
    if (!source) { messages.set(id, null); continue }
    const signature = hash([source, (row.sender as RecordValue).role]), previous = messages.get(source.messageId)
    if (previous === null || previous && previous.signature !== signature) messages.set(source.messageId, null)
    else messages.set(source.messageId, { source, signature, role: (row.sender as RecordValue).role })
  }
  const markerKey = prefix + 'agent:migration:qq-group-teaching:' + hash(conversationAddressKey(binding.target))
  const marker = await json(markerKey, { version: 1, imported: [], privacyImported: [] })
  if (!object(marker) || marker.version !== 1 || Object.keys(marker).some(key => !['version', 'imported', 'privacyImported'].includes(key)) ||
      !Array.isArray(marker.imported) || marker.imported.length > 1000 || marker.imported.some(value => typeof value !== 'string' || !/^[a-f\d]{64}$/u.test(value)) ||
      new Set(marker.imported).size !== marker.imported.length || !Array.isArray(marker.privacyImported) || marker.privacyImported.length > 1000 ||
      marker.privacyImported.some(value => typeof value !== 'string' || !/^[a-f\d]{64}$/u.test(value)) ||
      new Set(marker.privacyImported).size !== marker.privacyImported.length) throw new Error('目标群教学交接记录损坏')
  const imported = new Set(marker.imported as string[]), privacyImported = new Set(marker.privacyImported as string[])
  const identity = { botId: personMemoryAddress(binding.target).botId, personaId: agentPersonaScopeId(binding.agentId) }
  const scene = personMemoryAddress(binding.target).scene
  const lock = `shiloh:person-memory:v1:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}:lock`
  for (const key of [lock, prefix + lock, prefix + 'shiloh:person-memory:v1:identities:lock']) if (await read(key) !== null) throw new Error('群教学人物隐私正在更新，迁移未写入')
  const memory = (base: string, writable: boolean) => createPersonMemoryStore({ now: () => now, redis: {
    get: key => read(base + key),
    async set(key, value) { if (!writable) throw new Error('源人物记忆只读'); await read(base + key); stage(base + key, value); return 'OK' },
    async del(key) { if (!writable) throw new Error('源人物记忆只读'); await read(base + key); stage(base + key, null); return 1 },
  } })
  const sourceMemory = memory('', false), targetMemory = memory(prefix, true)
  for (const subjectId of meta.optedOut as string[] ?? []) {
    const privacyToken = hash([identity, subjectId])
    if (privacyImported.has(privacyToken)) continue
    await targetMemory.setEnabled({ identity, subjectId, scene, enabled: false })
    privacyImported.add(privacyToken)
  }
  const side = { get: (key: string) => read(prefix + key), stage: (key: string, value: string | null) => stage(prefix + key, value) }
  const existing = await stageGroupMemoryUpdate(side, binding.target, state => state)
  const entries: GroupMemoryEntry[] = []
  const proposals = new Map<string, Set<string>>()
  for (const { raw } of candidates) if (validId(raw.proposalId) && validId(raw.sourceMessageId)) {
    const ids = proposals.get(raw.proposalId) ?? new Set<string>(); ids.add(raw.sourceMessageId); proposals.set(raw.proposalId, ids)
  }
  for (const candidate of candidates) {
    const { raw, sourceKey, recordId, kind, token } = candidate
    if (imported.has(token)) { report.alreadyImported++; continue }
    if (raw.enabled === false) { skip('disabled'); continue }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean' || raw.ownerQQ != null && raw.ownerQQ !== '' && !numeric(raw.ownerQQ)) { skip('unsupported'); continue }
    if (!['member_definition', 'member_set', 'group_file', 'alias', 'workflow'].includes(kind) ||
        kind === 'workflow' && raw.kind !== 'mention_members') { skip('unsupported'); continue }
    const verified = messages.get(String(raw.sourceMessageId ?? ''))
    if (!verified || !numeric(raw.createdBy) || raw.createdBy !== verified.source.authorId ||
        validId(raw.proposalId) && (proposals.get(raw.proposalId)?.size ?? 0) > 1) { skip('source'); continue }
    const { source } = verified
    if (revoked.has(source.messageId) || existing?.deletedSources.includes(source.messageId) ||
        existing?.teachingDeletedSources?.includes(source.messageId) || source.at <= (existing?.teachingClearedAt ?? 0)) { skip('revoked'); continue }
    if (kind === 'workflow' && !['owner', 'admin'].includes(String(verified.role))) { skip('authorization'); continue }
    const subject = kind === 'alias' ? raw.display : raw.subject
    const condition = kind === 'workflow' ? raw.condition : undefined
    const targets = kind === 'alias' ? [raw.qq] : raw.targetUserIds
    if (!ids(targets, kind === 'workflow' ? 20 : 50) || kind !== 'group_file' && !targets.length || targets.includes(binding.target.account.id) ||
        ['alias', 'member_definition'].includes(kind) && targets.length !== 1 ||
        (kind === 'workflow' ? !text(condition, 120) : !text(subject, 80))) { skip('unsupported'); continue }
    if (kind === 'alias' ? !normalize(source.text).includes(normalize(subject as string)) :
      typeof raw.sourceText !== 'string' || !raw.sourceText.trim() || !compact(source.text).startsWith(compact(raw.sourceText))) { skip('source'); continue }
    const ownerId = numeric(raw.ownerQQ) ? raw.ownerQQ : undefined
    const resource = object(raw.resource) ? raw.resource : undefined
    const file = kind === 'group_file' ? source.files.find(value => value.name === resource?.fileName &&
      (!resource.fileId || value.reference === resource.fileId)) : undefined
    if (kind === 'group_file' && !file) { skip('source'); continue }
    const key = JSON.stringify([kind, normalize((condition ?? subject) as string), ownerId ?? ''])
    const entry: GroupMemoryEntry = { id: hash(key), kind, key, source, excerpt: source.text,
      persona: { kind: 'legacy-qq-observation', ...identity, sourceKey, recordId, fingerprint: hash([raw, source]) },
      createdBy: source.authorId, createdAt: source.at, updatedAt: source.at,
      ...(kind === 'workflow' ? { condition: condition as string } : { subject: subject as string }),
      targetUserIds: targets, relatedUserIds: [], ...(ownerId ? { ownerId } : {}), ...(file ? { file } : {}), tags: [] }
    const origin = { scene, authorId: source.authorId, messageId: source.messageId, at: source.at, excerpt: source.text }
    let allowed = true
    for (const subjectId of new Set([source.authorId, ...targets, ...(ownerId ? [ownerId] : [])])) {
      for (const store of [sourceMemory, targetMemory]) if (isPersonMemoryRedacted(origin, source.text, await store.getRedactions({ identity, subjectId })) ||
          isPersonMemoryRedacted(origin, (condition ?? subject) as string, await store.getRedactions({ identity, subjectId }))) allowed = false
    }
    if (!allowed) { skip('privacy'); continue }
    const previous = [...(existing?.entries ?? []), ...entries].find(value => value.id === entry.id)
    if (previous) throw new Error('目标已有相同群教学编号，迁移未覆盖')
    if (!await targetMemory.registerSource({ identity, subjectId: source.authorId, source: origin })) { skip('privacy'); continue }
    entries.push(entry); imported.add(token); report.imported++
  }
  if (imported.size > 1000 || privacyImported.size > 1000) throw new Error('目标群教学交接记录超过上限')
  if (entries.length) await stageGroupMemoryUpdate(side, binding.target, saved => {
    const state: GroupMemoryState = saved ?? { version: 1, id: groupMemoryId(binding.target),
      target: structuredClone(binding.target), agents: [], entries: [], deletedSources: [] }
    if (!state.agents.some(agent => agent.agentId === binding.agentId)) state.agents.push({ agentId: binding.agentId, binding: structuredClone(binding),
      token: agentBindingToken(binding), records: [], jobs: [], entries: [], seen: [], consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0 })
    state.entries.push(...entries)
    return state
  })
  const nextMarker = JSON.stringify({ version: 1, imported: [...imported], privacyImported: [...privacyImported] })
  if (report.imported || privacyImported.size !== (marker.privacyImported as string[]).length) stage(markerKey, nextMarker)
  return { report, isCurrent: archive.isCurrent }
}
