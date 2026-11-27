import { createHash, randomUUID } from 'node:crypto'
import type { PersonMemoryDraft, PersonMemoryEntry, PersonMemoryIdentity, PersonMemoryQuery, PersonMemoryQueryResult, PersonMemoryRedactions, PersonMemoryScene, PersonMemorySceneRule, PersonMemorySource, PersonMemoryStore, PersonMemorySubject, PersonMemoryTombstone } from '../../../contracts/personMemory.js'
import { canUsePersonMemory, isPersonMemoryRedacted, isPortablePersonMemory, normalizePersonMemoryText, personMemoryDraftError, personMemorySceneKey, personMemorySourceKey, privateScenePeer, rankPersonMemories, samePersonMemoryScene, validPersonMemoryIdentity, validPersonMemoryScene, validPersonMemorySource } from '../domain/personMemory.js'
import type { PersonMemoryCommand } from '../domain/personMemoryCommands.js'

interface PersonMemoryRedis {
  get(key: string): Promise<unknown>
  getMany?(keys: string[]): Promise<(string | null)[]>
  set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<unknown>
  del(key: string): Promise<unknown>
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
interface PersonDocument {
  schemaVersion: 1
  identity: PersonMemoryIdentity
  subjectId: string
  revision: number
  enabled: boolean
  forgottenBefore: number
  scenes: PersonMemorySceneRule[]
  tombstones: PersonMemoryTombstone[]
  /** Metadata and short hooks only; source excerpts and full facts live in detail keys. */
  index: PersonMemoryEntry[]
  seen: { scene: PersonMemoryScene; at: number }[]
}
interface ScopeDocument {
  schemaVersion: 1
  identity: PersonMemoryIdentity
  revision: number
  invalidatedAt: number
  subjects: string[]
  scenes: PersonMemorySceneRule[]
  revokedSources: string[]
  /** Source-backed erasures must also filter recall through the original author's index. */
  tombstones: PersonMemoryTombstone[]
}
interface Transaction {
  get(key: string): Promise<unknown>
  set(key: string, value: string): void
  del(key: string): void
}
const PREFIX = 'shiloh:person-memory:v1'
const DIRECTORY = `${PREFIX}:identities`
const queues = new WeakMap<object, Map<string, Promise<unknown>>>()
const COMMIT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
for i = 2, #KEYS do
  if ARGV[2*i-2] == 'del' then
    redis.call('DEL', KEYS[i])
  elseif ARGV[2*i-2] == 'keepttl' then
    redis.call('SET', KEYS[i], ARGV[2*i-1], 'KEEPTTL')
  else
    redis.call('SET', KEYS[i], ARGV[2*i-1])
  end
end
redis.call('DEL', KEYS[1]); return 1`
// Atomically fence command effects on the pending receipt and an exact accepted command.
const COMMAND_COMMIT = `if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('GET', KEYS[3]) == '1'
  or redis.call('GET', KEYS[4]) == '1' or redis.call('LINDEX', KEYS[5], 0) ~= ARGV[3] then return 0 end
table.remove(KEYS, 5); table.remove(KEYS, 4); table.remove(KEYS, 3); table.remove(KEYS, 2)
table.remove(ARGV, 3); table.remove(ARGV, 2)
` + COMMIT
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`
const json = (raw: unknown): unknown => raw === null || raw === undefined ? undefined : JSON.parse(String(raw))
const sameIdentity = (a: PersonMemoryIdentity, b: PersonMemoryIdentity) => a.botId === b.botId && a.personaId === b.personaId
const finiteAt = (value: number) => Number.isSafeInteger(value) && value >= 0
const baseKey = (identity: PersonMemoryIdentity) => `${PREFIX}:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}`
const personKey = (identity: PersonMemoryIdentity, subjectId: string) => `${baseKey(identity)}:person:${encodeURIComponent(subjectId)}`
const detailKey = (identity: PersonMemoryIdentity, subjectId: string, id: string) => `${personKey(identity, subjectId)}:entry:${id}`
const scopeKey = (identity: PersonMemoryIdentity) => `${baseKey(identity)}:scope`

export interface PersonMemoryCommandReceipt {
  key: string
  pending: string
  applied: string
  recallKeys: readonly [string, string]
  queueKey: string
  entry: string
}

function requireIdentity(identity: PersonMemoryIdentity) {
  if (!validPersonMemoryIdentity(identity)) throw new Error('人物记忆缺少机器人或人设身份')
}
function requireSubject(input: PersonMemorySubject) {
  requireIdentity(input.identity)
  if (typeof input.subjectId !== 'string' || !input.subjectId.trim() || input.subjectId !== input.subjectId.trim() || input.subjectId.length > 160) throw new Error('人物记忆缺少有效人物身份')
}
function requireScene(scene: PersonMemoryScene) {
  if (!validPersonMemoryScene(scene)) throw new Error('人物记忆缺少有效场景')
}
function emptyPerson({ identity, subjectId }: PersonMemorySubject): PersonDocument {
  return { schemaVersion: 1, identity: { ...identity }, subjectId, revision: 0, enabled: true, forgottenBefore: 0, scenes: [], tombstones: [], index: [], seen: [] }
}
function emptyScope(identity: PersonMemoryIdentity): ScopeDocument {
  return { schemaVersion: 1, identity: { ...identity }, revision: 0, invalidatedAt: 0, subjects: [], scenes: [], revokedSources: [], tombstones: [] }
}
function validSceneRule(value: PersonMemorySceneRule): boolean {
  return Boolean(value && validPersonMemoryScene(value.scene) && finiteAt(value.forgottenBefore) && typeof value.disabled === 'boolean')
}
function parsePerson(raw: unknown, input: PersonMemorySubject): PersonDocument {
  if (raw === null || raw === undefined) return emptyPerson(input)
  const parsed = json(raw) as PersonDocument
  if (!parsed || parsed.schemaVersion !== 1 || !validPersonMemoryIdentity(parsed.identity) || !sameIdentity(parsed.identity, input.identity) || parsed.subjectId !== input.subjectId
    || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || typeof parsed.enabled !== 'boolean' || !finiteAt(parsed.forgottenBefore)
    || !Array.isArray(parsed.scenes) || !parsed.scenes.every(validSceneRule) || !Array.isArray(parsed.tombstones)
    || !parsed.tombstones.every(t => t && finiteAt(t.before) && [t.id, t.text, t.sourceKey, t.excerpt].every(v => v === undefined || typeof v === 'string'))
    || !Array.isArray(parsed.index) || !parsed.index.every(item => item && typeof item.id === 'string' && !personMemoryDraftError(item) && sameIdentity(item.identity, input.identity) && item.subjectId === input.subjectId)
    || !Array.isArray(parsed.seen) || !parsed.seen.every(item => item && validPersonMemoryScene(item.scene) && finiteAt(item.at))) throw new Error('人物记忆目录损坏，停止读取和覆盖')
  return parsed
}
function parseScope(raw: unknown, identity: PersonMemoryIdentity): ScopeDocument {
  if (raw === null || raw === undefined) return emptyScope(identity)
  const parsed = json(raw) as ScopeDocument
  if (!parsed || parsed.schemaVersion !== 1 || !validPersonMemoryIdentity(parsed.identity) || !sameIdentity(parsed.identity, identity)
    || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !finiteAt(parsed.invalidatedAt) || !Array.isArray(parsed.subjects) || !parsed.subjects.every(id => typeof id === 'string' && id)
    || !Array.isArray(parsed.scenes) || !parsed.scenes.every(validSceneRule) || !Array.isArray(parsed.revokedSources) || !parsed.revokedSources.every(value => typeof value === 'string')
    || !Array.isArray(parsed.tombstones) || !parsed.tombstones.every(t => t && finiteAt(t.before) && [t.id, t.text, t.sourceKey, t.excerpt].every(v => v === undefined || typeof v === 'string'))) throw new Error('人物记忆来源目录损坏，停止读取和覆盖')
  return parsed
}
function redactions(person: PersonDocument, scope: ScopeDocument): PersonMemoryRedactions {
  const rules = new Map<string, PersonMemorySceneRule>()
  for (const item of [...scope.scenes, ...person.scenes]) {
    const key = personMemorySceneKey(item.scene), prior = rules.get(key)
    rules.set(key, { scene: { ...item.scene }, forgottenBefore: Math.max(prior?.forgottenBefore || 0, item.forgottenBefore), disabled: Boolean(prior?.disabled || item.disabled) })
  }
  return {
    identity: { ...person.identity }, subjectId: person.subjectId, revision: `${scope.revision}:${person.revision}`,
    disabled: !person.enabled, forgottenBefore: person.forgottenBefore, scenes: [...rules.values()],
    revokedSources: [...scope.revokedSources], tombstones: [...scope.tombstones, ...person.tombstones].map(t => ({ ...t }))
  }
}
function updateSceneRule(rules: PersonMemorySceneRule[], scene: PersonMemoryScene, patch: Partial<Omit<PersonMemorySceneRule, 'scene'>>) {
  const existing = rules.find(item => samePersonMemoryScene(item.scene, scene))
  if (existing) Object.assign(existing, patch)
  else rules.push({ scene: { ...scene }, forgottenBefore: 0, disabled: false, ...patch })
}
function observedSource(person: PersonDocument, scope: ScopeDocument, source: PersonMemorySource): boolean {
  return scope.subjects.includes(person.subjectId) && person.seen.some(item => samePersonMemoryScene(item.scene, source.scene) && item.at >= source.at)
}
function observe(person: PersonDocument, scope: ScopeDocument, source: PersonMemorySource) {
  if (!scope.subjects.includes(person.subjectId)) scope.subjects.push(person.subjectId)
  const previous = person.seen.find(item => samePersonMemoryScene(item.scene, source.scene))
  if (previous) previous.at = Math.max(previous.at, source.at)
  else person.seen.push({ scene: { ...source.scene }, at: source.at })
}
function parseIdentities(raw: unknown): PersonMemoryIdentity[] {
  const values = raw === null || raw === undefined ? [] : json(raw)
  if (!Array.isArray(values) || !values.every(value => validPersonMemoryIdentity(value as PersonMemoryIdentity))) {
    throw new Error('人物记忆身份目录损坏')
  }
  return values as PersonMemoryIdentity[]
}

interface MemoryTransferSide {
  get(key: string): Promise<string | null>
  stage(key: string, value: string): void
}

function sameMemoryEvidence(source: PersonMemorySource, reference: PersonMemorySource, excerpt: string) {
  return personMemorySourceKey(source) === personMemorySourceKey(reference)
    && source.authorId === reference.authorId && source.at === reference.at && source.excerpt === excerpt
}

function memoryDetailMatches(index: PersonMemoryEntry, entry: PersonMemoryEntry): boolean {
  return entry.id === index.id && sameIdentity(entry.identity, index.identity) && entry.subjectId === index.subjectId
    && sameMemoryEvidence(index.source, entry.source, entry.source.excerpt.slice(0, 160))
    && index.text === entry.text.slice(0, 200) && index.category === entry.category && index.evidenceKind === entry.evidenceKind
    && index.portable === entry.portable && index.sensitivity === entry.sensitivity && index.confidence === entry.confidence
    && index.validUntil === entry.validUntil && index.eventAt === entry.eventAt && index.supersedes === entry.supersedes
    && Boolean(index.superseded) === Boolean(entry.superseded)
    && JSON.stringify(index.relatedUserIds ?? []) === JSON.stringify(entry.relatedUserIds ?? [])
}

function memoryParticipants(entry: Pick<PersonMemoryDraft, 'subjectId' | 'source' | 'relatedUserIds'>) {
  return new Set([entry.subjectId, entry.source.authorId, ...(entry.relatedUserIds ?? [])])
}

function entryIsRedacted(entry: PersonMemoryEntry, snapshot: PersonMemoryRedactions, ids: Set<string | undefined>) {
  return ids.has(entry.id) || isPersonMemoryRedacted(entry.source, entry.text, snapshot)
}

/** Stages one scene's durable facts, privacy rules and optional notebook for an atomic cutover. */
export async function stagePersonMemoryForScene<T extends {
  id: string; content: string; createdAt: number; aboutUser?: string; personMemoryId?: string; memorySource?: PersonMemorySource
}>({ identity, scene, notes, source, destination, now }: {
  identity: PersonMemoryIdentity
  scene: PersonMemoryScene
  notes: readonly T[]
  source: { get: MemoryTransferSide['get']; stage(key: string, value: string | null): void }
  destination: MemoryTransferSide
  now: number
}): Promise<{ notes: T[]; facts: number; invalidatedAt: number }> {
  requireIdentity(identity)
  requireScene(scene)
  for (const side of [source, destination]) {
    if (await side.get(`${baseKey(identity)}:lock`) !== null) throw new Error('人物记忆正在更新，迁移未写入')
  }
  const key = scopeKey(identity)
  const oldScope = parseScope(await source.get(key), identity)
  const nextScope = parseScope(await destination.get(key), identity)
  const firstScope = JSON.stringify(nextScope)
  const scenePrefix = `${personMemorySceneKey(scene).slice(0, -1)},`
  const sceneTombstones = (items: PersonMemoryTombstone[]) => items.filter(item =>
    item.sourceKey?.startsWith(scenePrefix) || (!item.sourceKey && item.text !== undefined))
  const mergeTombstones = (left: PersonMemoryTombstone[], right: PersonMemoryTombstone[]) =>
    [...new Map([...left, ...sceneTombstones(right)].map(item => [JSON.stringify(item), item])).values()]
  const mergeSceneRule = (into: PersonMemorySceneRule[], from: PersonMemorySceneRule[]) => {
    const prior = from.find(rule => samePersonMemoryScene(rule.scene, scene))
    if (!prior) return
    const current = into.find(rule => samePersonMemoryScene(rule.scene, scene))
    updateSceneRule(into, scene, {
      disabled: Boolean(current?.disabled || prior.disabled),
      forgottenBefore: Math.max(current?.forgottenBefore || 0, prior.forgottenBefore),
    })
  }
  mergeSceneRule(nextScope.scenes, oldScope.scenes)
  nextScope.revokedSources = [...new Set([...nextScope.revokedSources, ...oldScope.revokedSources.filter(value => value.startsWith(scenePrefix))])]
  nextScope.tombstones = mergeTombstones(nextScope.tombstones, oldScope.tombstones)
  nextScope.invalidatedAt = Math.max(nextScope.invalidatedAt, oldScope.invalidatedAt)

  const people = new Map<string, { old: PersonDocument; next: PersonDocument; first: string; moved: Map<string, PersonMemoryEntry> }>()
  async function person(subjectId: string) {
    const existing = people.get(subjectId)
    if (existing) return existing
    const input = { identity, subjectId }
    requireSubject(input)
    const name = personKey(identity, subjectId)
    const [oldRaw, nextRaw] = await Promise.all([source.get(name), destination.get(name)])
    const old = parsePerson(oldRaw, input)
    const next = parsePerson(nextRaw, input)
    const first = JSON.stringify(next)
    next.enabled &&= old.enabled
    next.forgottenBefore = Math.max(next.forgottenBefore, old.forgottenBefore)
    mergeSceneRule(next.scenes, old.scenes)
    next.tombstones = mergeTombstones(next.tombstones, old.tombstones)
    const row = { old, next, first, moved: new Map<string, PersonMemoryEntry>() }
    people.set(subjectId, row)
    return row
  }

  const subjectsToTransfer = scene.kind === 'private' ? [scene.id] : oldScope.subjects
  for (let offset = 0; offset < subjectsToTransfer.length; offset += 32) {
    const subjects = subjectsToTransfer.slice(offset, offset + 32)
    await Promise.all([...new Set(subjects)].map(person))
  }

  let facts = 0
  for (const { old, next, moved } of people.values()) {
    if (scene.kind === 'private' && old.subjectId !== scene.id) continue
    const local = old.index.filter(entry => samePersonMemoryScene(entry.source.scene, scene))
    const correctedIds = new Set<string>()
    for (const entry of local) {
      if (entry.superseded) correctedIds.add(entry.id)
      if (typeof entry.supersedes === 'string' && entry.supersedes) correctedIds.add(entry.supersedes)
    }
    const blockedIds = new Set([...oldScope.tombstones, ...nextScope.tombstones, ...old.tombstones, ...next.tombstones]
      .map(item => item.id).filter(Boolean))
    for (const id of correctedIds) {
      // Preserve the correction without copying the obsolete text or excerpt.
      if (next.index.some(item => item.id === id && !item.superseded)) throw new Error('目标仍有人物记忆的旧版本，迁移未覆盖')
      if (!next.tombstones.some(item => item.id === id)) next.tombstones.push({ id, before: now })
    }
    for (const index of local) {
      if (correctedIds.has(index.id) || blockedIds.has(index.id) || (index.validUntil !== undefined && index.validUntil <= now)) continue
      if (scene.kind === 'private' && index.evidenceKind !== 'self') continue
      const entryKey = detailKey(identity, old.subjectId, index.id)
      const raw = await source.get(entryKey)
      if (raw === null) continue
      const entry = json(raw) as PersonMemoryEntry
      if (!entry || personMemoryDraftError(entry) || !memoryDetailMatches(index, entry)) continue
      const participants = await Promise.all([...memoryParticipants(entry)].map(person))
      if (participants.some(({ next: participant }) => isPersonMemoryRedacted(entry.source, entry.text, redactions(participant, nextScope)))) continue
      if (next.index.some(item => item.id === entry.id) || await destination.get(entryKey) !== null) {
        throw new Error('目标已有相同的人物记忆详情，迁移未覆盖')
      }
      destination.stage(entryKey, raw)
      source.stage(entryKey, null)
      next.index.push(index)
      observe(next, nextScope, entry.source)
      moved.set(entry.id, entry)
      facts++
    }
  }

  const moved: T[] = []
  for (const note of notes) {
    const { aboutUser, personMemoryId, memorySource } = note
    if (!aboutUser) {
      const sceneRule = nextScope.scenes.find(rule => samePersonMemoryScene(rule.scene, scene))
      const cutoff = Math.max(nextScope.invalidatedAt, sceneRule?.forgottenBefore || 0)
      if (!memorySource && !personMemoryId && !sceneRule?.disabled && note.createdAt > cutoff) moved.push(note)
      continue
    }
    if (!memorySource || !personMemoryId || !validPersonMemorySource(memorySource)) continue
    const entry = people.get(aboutUser)?.moved.get(personMemoryId)
    if (entry && !entry.portable && !entry.supersedes && !entry.relatedUserIds?.length
        && sameMemoryEvidence(memorySource, entry.source, entry.source.excerpt)
        && normalizePersonMemoryText(entry.text) === normalizePersonMemoryText(note.content)) moved.push(note)
  }

  let sourceChanged = false
  for (const [subjectId, { old, next, first, moved: entries }] of people) {
    const name = personKey(identity, subjectId)
    if (entries.size) {
      old.index = old.index.filter(entry => !entries.has(entry.id))
      // Keep the identifiers only. Re-running source extraction cannot recreate them.
      for (const id of entries.keys()) old.tombstones.push({ id, before: now })
      old.revision++
      source.stage(name, JSON.stringify(old))
      sourceChanged = true
    }
    if (JSON.stringify(next) !== first) {
      next.revision++
      if (!nextScope.subjects.includes(subjectId)) nextScope.subjects.push(subjectId)
      destination.stage(name, JSON.stringify(next))
    }
  }
  if (sourceChanged) {
    oldScope.revision++
    source.stage(key, JSON.stringify(oldScope))
  }
  if (JSON.stringify(nextScope) !== firstScope) {
    nextScope.revision++
    destination.stage(key, JSON.stringify(nextScope))
  }
  if (facts || moved.length || JSON.stringify(nextScope) !== firstScope) await stagePersonMemoryIdentity(identity, destination)
  return { notes: moved, facts, invalidatedAt: nextScope.invalidatedAt }
}

async function stagePersonMemoryIdentity(identity: PersonMemoryIdentity, destination: MemoryTransferSide) {
  if (await destination.get(`${DIRECTORY}:lock`) !== null) throw new Error('目标人物记忆目录正在更新，迁移未写入')
  const directory = json(await destination.get(DIRECTORY)) ?? []
  if (!Array.isArray(directory) || !directory.every(value => validPersonMemoryIdentity(value as PersonMemoryIdentity))) {
    throw new Error('目标人物记忆身份目录损坏')
  }
  if (!(directory as PersonMemoryIdentity[]).some(value => sameIdentity(value, identity))) {
    destination.stage(DIRECTORY, JSON.stringify([...directory, identity]))
  }
}

/** Durable facts and audience-aware projections; read/write APIs never fall back to legacy unscoped profiles. */
export function createPersonMemoryStore({ redis, now = Date.now }: { redis: PersonMemoryRedis; now?: () => number }):
  PersonMemoryStore & {
    /** Exact-source management view; portable facts from other scenes are never hydrated. */
    listScene(input: PersonMemoryQuery): Promise<PersonMemoryQueryResult>
    applyPrivacyCommand(input: PersonMemorySubject & { command: PersonMemoryCommand; scene?: PersonMemoryScene },
      receipt: PersonMemoryCommandReceipt, isCurrent: () => boolean): Promise<void>
  } {
  async function transaction<T>(key: string, run: (tx: Transaction) => Promise<T>, isCurrent?:()=>boolean, command?: PersonMemoryCommandReceipt): Promise<T> {
    let queue = queues.get(redis)
    if (!queue) { queue = new Map(); queues.set(redis, queue) }
    const previous = queue.get(key) || Promise.resolve()
    const pending = previous.catch(() => undefined).then(async () => {
      const lock = `${key}:lock`, token = randomUUID(), changes = new Map<string, string | null>()
      let acquired = false
      if (redis.eval) {
        const deadline = Date.now() + 2500
        do {
          const result = await redis.set(lock, token, { NX: true, PX: 10_000 })
          acquired = result === 'OK' || result === true
          if (!acquired) await new Promise(resolve => setTimeout(resolve, 25))
        } while (!acquired && Date.now() < deadline)
        if (!acquired) throw new Error('人物记忆正在更新，请稍后重试')
      }
      try {
        const result = await run({
          get: async name => changes.has(name) ? changes.get(name) : redis.get(name),
          set: (name, value) => { changes.set(name, value) },
          del: name => { changes.set(name, null) }
        })
        if (isCurrent?.() === false) throw new Error('人物记忆写入期间会话绑定已改变')
        if (redis.eval) {
          const keys = [lock], args: string[] = [token]
          if (command) {
            keys.push(command.key, ...command.recallKeys, command.queueKey)
            args.push(command.pending, command.entry)
          }
          for (const [name, value] of changes) { keys.push(name); args.push(value === null ? 'del' : 'set', value || '') }
          if (command) { keys.push(command.key); args.push('keepttl', command.applied) }
          if (Number(await redis.eval(command ? COMMAND_COMMIT : COMMIT, { keys, arguments: args })) !== 1) throw new Error('人物记忆锁或指令凭据失效，未提交')
          acquired = false
        } else {
          // The application's single-process fallback serializes all stores sharing this Redis client.
          for (const [name, value] of changes) {
            if (value === null) await redis.del(name)
            else await redis.set(name, value)
          }
        }
        return result
      } finally {
        if (acquired) await redis.eval!(RELEASE, { keys: [lock], arguments: [token] })
      }
    })
    queue.set(key, pending)
    try { return await pending } finally { if (queue.get(key) === pending) queue.delete(key) }
  }

  async function identities(): Promise<PersonMemoryIdentity[]> {
    return parseIdentities(await redis.get(DIRECTORY))
  }
  async function registerIdentity(identity: PersonMemoryIdentity) {
    requireIdentity(identity)
    await transaction(DIRECTORY, async tx => {
      const values = parseIdentities(await tx.get(DIRECTORY))
      if (!values.some(value => sameIdentity(value, identity))) tx.set(DIRECTORY, JSON.stringify([...values, {botId:identity.botId,personaId:identity.personaId}]))
    })
  }
  async function load(input: PersonMemorySubject, reader: Pick<Transaction, 'get'> = redis) {
    requireSubject(input)
    const [personRaw, scopeRaw] = await Promise.all([reader.get(personKey(input.identity, input.subjectId)), reader.get(scopeKey(input.identity))])
    return { person: parsePerson(personRaw, input), scope: parseScope(scopeRaw, input.identity) }
  }
  function save(tx: Transaction, person: PersonDocument, scope: ScopeDocument) {
    person.revision++
    scope.revision++
    // In the no-eval fallback, write suppression/header state before deleting detail keys.
    tx.set(personKey(person.identity, person.subjectId), JSON.stringify(person))
    tx.set(scopeKey(scope.identity), JSON.stringify(scope))
  }
  async function getRedactions(input: PersonMemorySubject) {
    const { person, scope } = await load(input)
    return redactions(person, scope)
  }
  async function readRedactionsBatch(identity: PersonMemoryIdentity, subjects: readonly string[] | undefined, signal: AbortSignal) {
    const scopeName = scopeKey(identity)
    signal.throwIfAborted()
    let scopeRaw = subjects === undefined ? await redis.get(scopeName) : undefined
    signal.throwIfAborted()
    let scope = scopeRaw === undefined ? undefined : parseScope(scopeRaw, identity)
    const ids = [...new Set(subjects ?? scope!.subjects)]
    const result = new Map<string, PersonMemoryRedactions>()
    const batchSize = 32, concurrentBatches = 4
    for (let offset = 0; offset < ids.length; offset += batchSize * concurrentBatches) {
      signal.throwIfAborted()
      const batches = []
      for (let start = offset; start < Math.min(ids.length, offset + batchSize * concurrentBatches); start += batchSize) {
        const batch = ids.slice(start, start + batchSize).map(subjectId => ({ identity, subjectId }))
        batch.forEach(requireSubject)
        batches.push(batch)
      }
      // Keep each Redis read small while avoiding a round trip per 32 subjects.
      // Each response carries its own scope fence and must match the other batches.
      const snapshots = await Promise.all(batches.map(async batch =>
        redis.getMany!([scopeName, ...batch.map(subject => personKey(identity, subject.subjectId))])))
      signal.throwIfAborted()
      for (const [batchIndex, batch] of batches.entries()) {
        const [currentScope, ...people] = snapshots[batchIndex]!
        if (people.length !== batch.length) throw new Error('人物记忆批量读取结果无效')
        if (!scope || currentScope !== scopeRaw) {
          const next = parseScope(currentScope, identity)
          // Ordinary source registration may update the revision without changing privacy.
          if (scope && (next.invalidatedAt !== scope.invalidatedAt ||
              JSON.stringify([next.scenes, next.revokedSources, next.tombstones]) !==
              JSON.stringify([scope.scenes, scope.revokedSources, scope.tombstones]) ||
              subjects === undefined && JSON.stringify(next.subjects) !== JSON.stringify(scope.subjects))) return
          scopeRaw = currentScope
          scope = next
        }
        for (const [index, subject] of batch.entries()) {
          result.set(subject.subjectId, redactions(parsePerson(people[index], subject), scope))
        }
      }
    }
    return result
  }
  async function getRedactionsBatch(identity: PersonMemoryIdentity, subjects: readonly string[] | undefined, signal: AbortSignal) {
    requireIdentity(identity)
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await readRedactionsBatch(identity, subjects, signal)
      if (result) return result
    }
    // A privacy change invalidates earlier person documents. Never return the
    // mixed result, even when contention lasts for the entire retry window.
    throw new Error('人物记忆权限来源持续变化，无法完成批量核验')
  }
  async function participantsAllow(input: PersonMemoryDraft, scope: ScopeDocument, reader: Pick<Transaction, 'get'>,
    cache: Map<string, Promise<PersonMemoryRedactions>>): Promise<boolean> {
    const ids = memoryParticipants(input)
    ids.delete(input.subjectId)
    for (const subjectId of ids) {
      let snapshot = cache.get(subjectId)
      if (!snapshot) {
        const subject = { identity: input.identity, subjectId }
        snapshot = reader.get(personKey(input.identity, subjectId)).then(raw => redactions(parsePerson(raw, subject), scope))
        cache.set(subjectId, snapshot)
      }
      if (isPersonMemoryRedacted(input.source, input.text, await snapshot)) return false
    }
    return true
  }
  async function eraseRelatedSources(tx: Transaction, scope: ScopeDocument, subjectId: string, before: number, scene?: PersonMemoryScene) {
    for (const owner of scope.subjects.filter(value => value !== subjectId)) {
      const person = parsePerson(await tx.get(personKey(scope.identity, owner)), { identity: scope.identity, subjectId: owner })
      for (const index of person.index) {
        if (!memoryParticipants(index).has(subjectId) || index.source.at > before || (scene && !samePersonMemoryScene(index.source.scene, scene))) continue
        const raw = await tx.get(detailKey(scope.identity, owner, index.id))
        const entry = raw === null || raw === undefined ? index : json(raw) as PersonMemoryEntry
        scope.tombstones.push({ id: entry.id, text: entry.text, sourceKey: personMemorySourceKey(entry.source), excerpt: entry.source.excerpt, before })
      }
    }
  }
  async function getSceneRedactions(input: { identity: PersonMemoryIdentity; scene: PersonMemoryScene }) {
    requireIdentity(input.identity); requireScene(input.scene)
    const scope = parseScope(await redis.get(scopeKey(input.identity)), input.identity)
    return { revision: String(scope.revision), invalidatedAt: scope.invalidatedAt, forgottenBefore: scope.scenes.find(rule => samePersonMemoryScene(rule.scene, input.scene))?.forgottenBefore || 0 }
  }
  function invalidateAggregates(scope: ScopeDocument) { scope.invalidatedAt = Math.max(now(), scope.invalidatedAt + 1) }
  async function registerSource(input: PersonMemorySubject & { source: PersonMemorySource }, isCurrent?:()=>boolean) {
    requireSubject(input)
    if (!validPersonMemorySource(input.source) || input.source.authorId !== input.subjectId) return false
    let identityKnown = false
    if (redis.getMany) {
      // Conversation, semantic, history and group stores may register the same
      // source. Re-read current privacy and the watermark together before skipping a write.
      const values = await redis.getMany([DIRECTORY, personKey(input.identity, input.subjectId), scopeKey(input.identity)])
      if (values.length !== 3) throw new Error('人物记忆批量读取结果无效')
      const [directory, personRaw, scopeRaw] = values
      identityKnown = parseIdentities(directory).some(value => sameIdentity(value, input.identity))
      if (identityKnown) {
        const person = parsePerson(personRaw, input), scope = parseScope(scopeRaw, input.identity)
        if (observedSource(person, scope, input.source)) {
          if (isCurrent?.() === false) throw new Error('人物记忆写入期间会话绑定已改变')
          return !isPersonMemoryRedacted(input.source, input.source.excerpt, redactions(person, scope))
        }
      }
    }
    if (!identityKnown) await registerIdentity(input.identity)
    return transaction(baseKey(input.identity), async tx => {
      const { person, scope } = await load(input, tx)
      if (isPersonMemoryRedacted(input.source, input.source.excerpt, redactions(person, scope))) return false
      if (!observedSource(person, scope, input.source)) {
        observe(person, scope, input.source)
        save(tx, person, scope)
      }
      return true
    }, isCurrent)
  }

  async function remember(input: PersonMemoryDraft, isCurrent?:()=>boolean) {
    const error = personMemoryDraftError(input)
    if (error) return { saved: false, reason: error }
    if (input.source.at > now() + 300_000) return { saved: false, reason: 'future_source' }
    await registerIdentity(input.identity)
    return transaction(baseKey(input.identity), async tx => {
      const { person, scope } = await load(input, tx)
      if (isPersonMemoryRedacted(input.source, input.text, redactions(person, scope))) return { saved: false, reason: 'redacted' }
      if (!await participantsAllow(input, scope, tx, new Map())) return { saved: false, reason: 'related_person_redacted' }
      const id = createHash('sha256').update(JSON.stringify([input.subjectId, personMemorySourceKey(input.source), input.category, normalizePersonMemoryText(input.text), normalizePersonMemoryText(input.source.excerpt)])).digest('hex').slice(0, 24)
      if (person.tombstones.some(item => item.id === id) || scope.tombstones.some(item => item.id === id)) return { saved: false, reason: 'redacted' }
      const existing = person.index.find(item => item.id === id)
      if (existing?.superseded) return { saved: false, reason: 'superseded_source' }
      if (existing) {
        const raw = await tx.get(detailKey(input.identity, input.subjectId, id))
        if (raw === null || raw === undefined) throw new Error('人物记忆详情缺失')
        const entry = json(raw) as PersonMemoryEntry
        if (personMemoryDraftError(entry)) throw new Error('人物记忆详情损坏')
        // A retry cannot increase authority, portability, expiration, or audience.
        return { saved: true, entry }
      }
      let previous: PersonMemoryEntry | undefined
      if (input.supersedes) {
        previous = person.index.find(item => item.id === input.supersedes)
        if (!previous || previous.superseded || !samePersonMemoryScene(previous.source.scene, input.source.scene) || previous.source.authorId !== input.source.authorId) return { saved: false, reason: 'invalid_supersedes' }
        if (input.source.at < previous.source.at) return { saved: false, reason: 'older_correction' }
      }
      const entry: PersonMemoryEntry = {
        ...structuredClone(input), text: input.text.trim(), id,
        sensitivity: input.sensitivity || 'personal', portable: isPortablePersonMemory(input),
        confidence: input.confidence ?? 0.7, relatedUserIds: [...new Set(input.relatedUserIds || [])],
        createdAt: now(), updatedAt: now()
      }
      if (previous) {
        previous.superseded = true
        invalidateAggregates(scope)
        // Keep the historical record unreachable by ordinary recall; deletion never reactivates it.
      }
      observe(person, scope, input.source)
      person.index.push({ ...entry, text: entry.text.slice(0, 200), source: { ...entry.source, excerpt: entry.source.excerpt.slice(0, 160) } })
      tx.set(detailKey(input.identity, input.subjectId, id), JSON.stringify(entry))
      save(tx, person, scope)
      return { saved: true, entry }
    }, isCurrent)
  }

  async function query(input: PersonMemoryQuery, requestedIds?: string[], exactScene = false): Promise<PersonMemoryQueryResult> {
    requireSubject(input)
    requireScene(input.scene)
    const at = input.now !== undefined && finiteAt(input.now) ? input.now : now(), offset = Math.max(0, Math.floor(input.offset || 0)), limit = Math.min(50, Math.max(1, Math.floor(input.limit || 12)))
    const { person, scope } = await load(input)
    const initial = redactions(person, scope)
    const initialTombstones = new Set(initial.tombstones.map(item => item.id))
    let candidates = person.index.filter(entry => (!exactScene || samePersonMemoryScene(entry.source.scene, input.scene))
      && (!requestedIds || requestedIds.includes(entry.id))
      && canUsePersonMemory(entry, input, at) && !entryIsRedacted(entry, initial, initialTombstones))
    const initialPeople = new Map<string, Promise<PersonMemoryRedactions>>()
    const allowed = await Promise.all(candidates.map(entry => participantsAllow(entry, scope, redis, initialPeople)))
    candidates = candidates.filter((_entry, index) => allowed[index])
    candidates = rankPersonMemories(candidates, input.query || '')
    const selected = candidates.slice(offset, offset + limit)
    const detail = await Promise.all(selected.map(async index => {
      const raw = await redis.get(detailKey(input.identity, input.subjectId, index.id))
      if (raw === null || raw === undefined) return undefined
      const entry = json(raw) as PersonMemoryEntry
      if (!entry || entry.id !== index.id || personMemoryDraftError(entry) || !sameIdentity(entry.identity, input.identity) || entry.subjectId !== input.subjectId) throw new Error('人物记忆详情损坏')
      if (exactScene && !memoryDetailMatches(index, entry)) throw new Error('人物记忆索引与详情来源不一致')
      return entry
    }))
    // Deletions and revocations during hydration must also affect the returned projection.
    const fresh = await load(input)
    const snapshot = redactions(fresh.person, fresh.scope)
    const freshTombstones = new Set(snapshot.tombstones.map(item => item.id))
    const activeIds = new Set(fresh.person.index.filter(item => !item.superseded).map(item => item.id))
    const active = detail.filter((item): item is PersonMemoryEntry => Boolean(item && activeIds.has(item.id)
      && (!exactScene || samePersonMemoryScene(item.source.scene, input.scene))
      && canUsePersonMemory(item, input, at) && !entryIsRedacted(item, snapshot, freshTombstones)))
    const freshPeople = new Map<string, Promise<PersonMemoryRedactions>>()
    const stillAllowed = await Promise.all(active.map(entry => participantsAllow(entry, fresh.scope, redis, freshPeople)))
    const items = active.filter((_entry, index) => stillAllowed[index])
    const hasMore = offset + limit < candidates.length
    return {
      items,
      index: items.map(item => ({ id: item.id, summary: item.text.slice(0, 150), category: item.category, at: item.source.at, ...(item.eventAt !== undefined ? { eventAt: item.eventAt } : {}) })),
      hasMore, ...(hasMore ? { nextOffset: offset + limit } : {}), revision: snapshot.revision, truncated: hasMore
    }
  }

  async function forget(input: Parameters<PersonMemoryStore['forget']>[0], isCurrent?:()=>boolean, command?: PersonMemoryCommandReceipt): Promise<number> {
    requireSubject(input)
    const before = input.before ?? now()
    if (!finiteAt(before)) throw new Error('无效遗忘时间')
    if (input.scene) requireScene(input.scene)
    await registerIdentity(input.identity)
    return transaction(baseKey(input.identity), async tx => {
      const { person, scope } = await load(input, tx)
      const selective = Boolean(input.id || input.text || input.sourceMessageId)
      const selected = person.index.filter(entry => {
        if (!selective && entry.source.at > before) return false
        if (input.scene && !samePersonMemoryScene(input.scene, entry.source.scene)) return false
        if (input.id && entry.id !== input.id) return false
        if (input.sourceMessageId && entry.source.messageId !== input.sourceMessageId) return false
        if (input.text && normalizePersonMemoryText(entry.text) !== normalizePersonMemoryText(input.text).slice(0, 200)) return false
        return true
      })
      if (!selective) {
        if (input.scene) {
          const previous = person.scenes.find(rule => samePersonMemoryScene(rule.scene, input.scene!))
          updateSceneRule(person.scenes, input.scene, { forgottenBefore: Math.max(previous?.forgottenBefore || 0, before) })
        } else person.forgottenBefore = Math.max(person.forgottenBefore, before)
        await eraseRelatedSources(tx, scope, input.subjectId, before, input.scene)
      }
      // Record selectors even before extraction finishes, so a late writer cannot recreate them.
      if (selective && !selected.length) person.tombstones.push({
        ...(input.id ? { id: input.id } : {}), ...(input.text ? { text: input.text } : {}),
        ...(input.sourceMessageId && input.scene ? { sourceKey: personMemorySourceKey({ scene: input.scene, messageId: input.sourceMessageId }) } : {}), before
      })
      for (const index of selected) {
        const raw = await tx.get(detailKey(input.identity, input.subjectId, index.id))
        const entry = raw === null || raw === undefined ? index : json(raw) as PersonMemoryEntry
        const tombstone = { id: index.id, text: entry.text, sourceKey: personMemorySourceKey(entry.source), excerpt: entry.source.excerpt, before: Math.max(before, entry.source.at) }
        person.tombstones.push(tombstone)
        scope.tombstones.push({ ...tombstone })
      }
      const removed = new Set(selected.map(entry => entry.id))
      person.index = person.index.filter(entry => !removed.has(entry.id))
      invalidateAggregates(scope)
      save(tx, person, scope)
      for (const entry of selected) tx.del(detailKey(input.identity, input.subjectId, entry.id))
      return selected.length
    }, isCurrent, command)
  }

  async function revokeSource(input: Parameters<PersonMemoryStore['revokeSource']>[0]) {
    requireIdentity(input.identity); requireScene(input.scene)
    if (!input.messageId || typeof input.messageId !== 'string') throw new Error('撤回缺少真实消息ID')
    await registerIdentity(input.identity)
    await transaction(baseKey(input.identity), async tx => {
      const scope = parseScope(await tx.get(scopeKey(input.identity)), input.identity)
      const key = personMemorySourceKey({ scene: input.scene, messageId: input.messageId })
      if (scope.revokedSources.includes(key)) return
      scope.revokedSources.push(key)
      invalidateAggregates(scope)
      scope.revision++
      tx.set(scopeKey(input.identity), JSON.stringify(scope))
    })
  }
  async function forgetScene(input: Parameters<PersonMemoryStore['forgetScene']>[0], isCurrent?:()=>boolean) {
    requireIdentity(input.identity); requireScene(input.scene)
    const before = input.before ?? now()
    if (!finiteAt(before)) throw new Error('无效遗忘时间')
    await registerIdentity(input.identity)
    await transaction(baseKey(input.identity), async tx => {
      const scope = parseScope(await tx.get(scopeKey(input.identity)), input.identity)
      const previous = scope.scenes.find(rule => samePersonMemoryScene(rule.scene, input.scene))
      if (previous && before <= previous.forgottenBefore) return
      updateSceneRule(scope.scenes, input.scene, { forgottenBefore: Math.max(previous?.forgottenBefore || 0, before) })
      invalidateAggregates(scope)
      scope.revision++
      tx.set(scopeKey(input.identity), JSON.stringify(scope))
    }, isCurrent)
  }
  async function setEnabled(input: Parameters<PersonMemoryStore['setEnabled']>[0], isCurrent?:()=>boolean, command?: PersonMemoryCommandReceipt) {
    requireSubject(input)
    if (input.scene) requireScene(input.scene)
    await registerIdentity(input.identity)
    await transaction(baseKey(input.identity), async tx => {
      const { person, scope } = await load(input, tx)
      if (input.scene) {
        const previous = person.scenes.find(rule => samePersonMemoryScene(rule.scene, input.scene!))
        if ((previous?.disabled === true) === !input.enabled) return
        updateSceneRule(person.scenes, input.scene, { disabled: !input.enabled, forgottenBefore: Math.max(previous?.forgottenBefore || 0, now()) })
      } else {
        if (person.enabled === input.enabled) return
        person.enabled = input.enabled
        // Re-enabling starts fresh, including messages heard while recording was disabled.
        person.forgottenBefore = Math.max(person.forgottenBefore, now())
      }
      if (!input.enabled) {
        await eraseRelatedSources(tx, scope, input.subjectId, now(), input.scene)
        for (const index of person.index.filter(entry => !input.scene || samePersonMemoryScene(input.scene, entry.source.scene))) {
          const raw = await tx.get(detailKey(input.identity, input.subjectId, index.id))
          const entry = raw === null || raw === undefined ? index : json(raw) as PersonMemoryEntry
          scope.tombstones.push({ id: entry.id, text: entry.text, sourceKey: personMemorySourceKey(entry.source), excerpt: entry.source.excerpt, before: Math.max(now(), entry.source.at) })
        }
      }
      if (!scope.subjects.includes(input.subjectId)) scope.subjects.push(input.subjectId)
      invalidateAggregates(scope)
      save(tx, person, scope)
    }, isCurrent, command)
  }
  async function applyPrivacyCommand(
    input: PersonMemorySubject & { command: PersonMemoryCommand; scene?: PersonMemoryScene },
    receipt: PersonMemoryCommandReceipt,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!redis.eval) throw new Error('隐私指令提交需要原子存储')
    const { command, ...subject } = input
    if (command === 'forget') await forget(subject, isCurrent, receipt)
    else await setEnabled({ ...subject, enabled: command === 'enable' }, isCurrent, receipt)
  }
  async function scenes(input: PersonMemoryQuery): Promise<PersonMemoryScene[]> {
    requireSubject(input); requireScene(input.scene)
    const { person, scope } = await load(input), snapshot = redactions(person, scope)
    if (snapshot.disabled || input.scene.kind !== 'private' || input.viewerUserId !== input.subjectId || privateScenePeer(input.scene) !== input.subjectId) return []
    return person.seen.filter(item => (item.scene.kind !== 'private' || samePersonMemoryScene(item.scene, input.scene))
      && item.at > snapshot.forgottenBefore
      && !snapshot.scenes.some(rule => samePersonMemoryScene(rule.scene, item.scene) && (rule.disabled || item.at <= rule.forgottenBefore))).map(item => ({ ...item.scene }))
  }
  async function listSubjects(identity?: PersonMemoryIdentity): Promise<PersonMemorySubject[]> {
    const values = identity ? [identity] : await identities()
    const out: PersonMemorySubject[] = []
    for (const value of values) {
      requireIdentity(value)
      const scope = parseScope(await redis.get(scopeKey(value)), value)
      for (const subjectId of scope.subjects) out.push({ identity: { ...value }, subjectId })
    }
    return out
  }
  return {
    remember, registerSource, query, list: query, listScene: input => query(input, undefined, true),
    read: input => query(input, input.ids), getRedactions, getSceneRedactions,
    ...(redis.getMany ? { getRedactionsBatch } : {}),
    forget, revokeSource, forgetScene, setEnabled, scenes, identities, listSubjects, applyPrivacyCommand,
  }
}
