import type { SimMoodState, SimSessionState } from '../../../contracts/simulation.js'
import { randomUUID } from 'node:crypto'
import type { CharacterScope } from '../../../contracts/character.js'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import { characterKey } from '../domain/characterState.js'
import { agentConversationKey } from '../../runtime/domain/agentBindings.js'
import { createDefaultSimSession, dayKey, isSimulationUserId } from '../domain/simConfig.js'
import { stripSupersededItems, type PersonProfile } from '../domain/personProfile.js'
import type { PersonMemoryDraft, PersonMemoryEntry, PersonMemoryIdentity, PersonMemorySource } from '../../../contracts/personMemory.js'
import { createPersonMemoryStore } from '../../memory/infrastructure/personMemoryStore.js'
import { isPersonMemoryRedacted, validPersonMemorySource } from '../../memory/domain/personMemory.js'
import { decodeSimulationAddressKey, simulationAddressKey } from './simulationAddress.js'
import { SIM_INITIAL_PROMPT_MAX_CHARS, simulationInitialPromptKey } from './simInitialPrompt.js'
import { normalizeSimulationMessageFiles } from './simulationAgentFiles.js'
import { normalizeSimulationMessageVideo } from './simulationAgentVideo.js'

/** Redis 形状约束：TRSS 包装层支持 get/set/del/eval，Set 用 JSON 数组模拟（避免依赖 sadd 族）。 */
export interface SimRedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { PX?: number; NX?: boolean }): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  /** 控制台人物记忆页列出全部档案用（SCAN）；不可用时列表为空 */
  keys?(pattern: string): Promise<string[]>
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export interface SimSessionStorePorts {
  characterScope?: CharacterScope
  memoryScope?: AgentConversationScope
  redis: SimRedisLike
  logger?: { warn?(message: string): void; error?(message: string, error?: unknown): void }
  now?(): number
}

export const simulationSessionKey = (groupId: string) => `shiloh:sim:g:${groupId}`
// Kept outside session snapshots: a second process can revoke an in-flight turn
// without a stale writer restoring the old version or overwriting unread input.
const ACTIVITY_VERSION_KEY = (groupId: string) => `${simulationSessionKey(groupId)}:activity-version`
/** One execution process may still have concurrent ingress, turn and background writers. */
const sessionWrites = new WeakMap<object, Map<string, Promise<void>>>()
/** agent 自管记忆与好感度：独立于会话状态（.仿真 重置只清历史/水位/预算，长期记忆保留） */
const MEMORIES_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:memories`
export function simulationNotebookKey(scope: AgentConversationScope): string {
  return `shiloh:sim:memories:v2:${encodeURIComponent(agentConversationKey(scope))}`
}
const AFFINITY_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:affinity`
const USER_STYLE_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:userStyle`
/** .仿真 开/关 的按群覆盖：explicitEnabled（显式启用，allGroups=false 时生效）+ disabled（显式退出） */
export const SIMULATION_OVERRIDES_KEY = 'shiloh:sim:overrides'
/** 收到过消息的群登记（sweep 遍历用；allGroups 模式下运行时无法枚举白名单群，靠 ingest 自报） */
export const SIMULATION_KNOWN_GROUPS_KEY = 'shiloh:sim:known'
const ADD_KNOWN = `
local raw = redis.call('GET', KEYS[1])
local ok, groups = pcall(cjson.decode, raw or '[]')
if not ok or type(groups) ~= 'table' or string.sub(raw or '[]', 1, 1) ~= '[' then groups = {} end
for _, id in ipairs(groups) do if tostring(id) == ARGV[1] then return 0 end end
table.insert(groups, ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(groups))
return 1`
export const simulationBusyKey = (groupId: string) => `shiloh:sim:busy:${groupId}`
export const simulationBudgetCarryoverKey = (groupId: string) => `shiloh:sim:g:${groupId}:budget-carryover`
/** 人物核心档案（跨群共享，按人一个 key）：称呼偏好 + 长期爱好 + 雷点，只放"到处都合适被知道"的身份级事实 */
const PERSON_KEY = (userId: string) => `shiloh:sim:person:${userId}`
/** 全局好感底分（跨群）：群内每次好感变动按 30% 权重镜像，作为关系的"本钱" */
const GLOBAL_AFFINITY_KEY = (userId: string) => `shiloh:sim:person:${userId}:affinity`
const PERSON_AFFINITY_KEY = (identity: PersonMemoryIdentity, userId: string) =>
  `shiloh:sim:person-affinity:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}:${encodeURIComponent(userId)}`
/** 全局作息（人物级，不分群）：AI 可用 simSetRhythm 自设睡眠窗口 */
const RHYTHM_KEY = 'shiloh:sim:rhythm'
export function simulationRhythmKey(scope?: CharacterScope): string {
  return scope ? `${characterKey(scope)}:legacy:rhythm` : RHYTHM_KEY
}

export function decodeSimulationRhythm(raw: string) {
  const parsed = record(JSON.parse(raw))
  const sleepFrom = Number(parsed.sleepFrom), sleepTo = Number(parsed.sleepTo)
  if (!Number.isFinite(sleepFrom) || !Number.isFinite(sleepTo) || sleepFrom < 0 || sleepFrom > 23 ||
      sleepTo < 1 || sleepTo > 24 || sleepTo <= sleepFrom) throw new Error('仿真作息状态无效')
  const updatedAt = typeof parsed.updatedAt === 'number' && Number.isSafeInteger(parsed.updatedAt) && parsed.updatedAt > 0
    ? parsed.updatedAt : undefined
  return { sleepFrom, sleepTo, ...(typeof parsed.setBy === 'string' ? { setBy: parsed.setBy } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }) }
}
/** 生活线（全局）：真实数据源的持续关注线（在追的番/在玩的游戏） */
const LIFE_THREADS_KEY = 'shiloh:sim:life-threads'
/** AI 自我记忆（跨群性格沉淀）：与群级 memories 同结构，但全局一份 */
const SELF_MEMORIES_KEY = 'shiloh:sim:self-memories'
/** 情绪四轴（跨群全局）：你自己此刻的状态，换群不重置 */
const MOOD_KEY = 'shiloh:sim:mood'
/** 回合忙租约：进程崩溃后最多这么久，别的唤醒可以接管。 */
/**
 * 回合忙租约：正常运行时 15 分钟（防并发回合），但进程重启后不应阻塞群这么久。
 * 修法（qq-bridge 176433a）：正常回合仍用完整租约，但 runtime 启动时主动清掉
 * 所有 busy 标记（重启=旧回合已死，不存在真并发），等效于"断线宽限≈启动时间"。
 */
export const SIM_TURN_BUSY_LEASE_MS = 15 * 60_000

/** 群级覆盖（.仿真 开/关 与控制台预算编辑都写这里）：budgetCaps 键=群号 值=每日金额上限；budgetDefaultCny 为空表示用 yaml 默认；atOnly=「仅被@才回」群清单（管理员设定，优先于 AI 自设触发器）；playAlongUntil=「活跃助推」到期表（epoch ms，助推窗口内系统兜底节奏，过期回落自主档、由 AI 自设配置接管） */
export interface SimGroupOverrides { explicitEnabled: string[]; disabled: string[]; budgetCaps: Record<string, number>; turnCaps: Record<string, number>; atOnly?: string[]; playAlongUntil?: Record<string, number>; budgetDefaultCny?: number }

interface SimulationBudgetCarryover { day: string; turns: number; costCny: number }

interface PersonProfileWritePatch { name?: string; interests?: string[]; taboos?: string[]; traits?: string[]; facts?: string[]; closedFacts?: string[]; memories?: Omit<PersonMemoryDraft, 'identity' | 'subjectId'>[] }
export interface SimSessionStore {
  load(groupId: string): Promise<SimSessionState>
  save(groupId: string, state: SimSessionState): Promise<void>
  reset(groupId: string, presetKeywords: string[]): Promise<SimSessionState>
  loadActivityVersion(groupId: string): Promise<string>
  invalidateActivity(groupId: string): Promise<void>
  /** null = 从未写过覆盖（首次运行，可从 yaml groups 种子） */
  loadOverrides(): Promise<SimGroupOverrides | null>
  saveOverrides(overrides: SimGroupOverrides): Promise<void>
  loadBudgetCarryover(groupId: string, at: number): Promise<SimulationBudgetCarryover | null>
  loadKnownGroups(): Promise<string[]>
  addKnownGroup(groupId: string): Promise<void>
  markBusy(groupId: string): Promise<void>
  clearBusy(groupId: string): Promise<void>
  /** 会话初始提示词模板。 */
  getInitPrompt(groupId: string): Promise<string>
  setInitPrompt(groupId: string, text: string): Promise<void>
  loadMemories(groupId: string): Promise<unknown[]>
  saveMemories(groupId: string, memories: unknown[], isCurrent?: () => boolean): Promise<void>
  loadAffinity(groupId: string): Promise<Record<string, unknown>>
  saveAffinity(groupId: string, affinity: Record<string, unknown>): Promise<void>
  /** 按人口头禅表：{ userId: string[], updatedAt } */
  loadUserStyle(groupId: string): Promise<{ users: Record<string, string[]>; updatedAt: number }>
  saveUserStyle(groupId: string, users: Record<string, string[]>, isCurrent?: () => boolean): Promise<void>
  /** 当前机器人/人设下、有本人来源且可跨群的档案投影；无scope仅供管理旧数据。 */
  loadPersonProfile(userId: string): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; updatedAt?: number }>
  mergePersonProfile(userId: string, patch: PersonProfileWritePatch, maxFields: number, isCurrent?: () => boolean): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[] }>
  registerPersonSource(userId: string, source: PersonMemorySource): Promise<boolean>
  rememberPersonMemory(input: Omit<PersonMemoryDraft, 'identity'>): Promise<{ saved: boolean; entry?: PersonMemoryEntry; reason?: string }>
  forgetPersonMemory(userId: string, input: { id?: string; text?: string; sourceMessageId?: string }): Promise<void>
  revokePersonSource(messageId: string): Promise<void>
  /** 同一机器人/人设的跨群熟悉度底分，具体互动理由不随分数迁移。 */
  loadGlobalAffinity(userIds: string[]): Promise<Record<string, number>>
  bumpGlobalAffinity(userId: string, delta: number, reason?: string): Promise<number>
  /** 兼容旧调用；跨群关系理由始终返回空。 */
  loadGlobalAffinityNotes(userIds: string[]): Promise<Record<string, string[]>>
  /** 控制台：列出全部人物档案（跨群数据透明化） */
  listPersonProfiles(): Promise<{ userId: string; name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; globalAffinity?: number; updatedAt?: number }[]>
  /** 控制台：整人删除（档案 + 全局好感） */
  deletePersonProfile(userId: string): Promise<boolean>
  /** 控制台：删单条字段（field: name|interests|taboos|traits|facts；value 省略=清空 name） */
  deletePersonProfileField(userId: string, field: string, value?: string): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[] }>
  /** 全局作息：load 返回 null=从未设过（用配置默认）；save 由 simSetRhythm 调用 */
  loadRhythm(): Promise<{ sleepFrom: number; sleepTo: number; setBy?: string } | null>
  saveRhythm(rhythm: { sleepFrom: number; sleepTo: number; setBy?: string }): Promise<void>
  /** 生活线：全局列表读写（真实数据源线程） */
  loadLifeThreads(): Promise<unknown[]>
  saveLifeThreads(threads: unknown[]): Promise<void>
  /** 当前机器人/人设/群的自我笔记，scope=self 的 simRemember 条目。 */
  loadSelfMemories(): Promise<unknown[]>
  saveSelfMemories(memories: unknown[]): Promise<void>
  /** 情绪四轴（跨群全局）：存最近一次写入的瞬时值，null=从未写过；衰减投影由读取侧做 */
  loadMood(): Promise<unknown>
  saveMood(mood: SimMoodState): Promise<void>
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(g => String(g)).filter(Boolean))] : []
}

export function decodeSimulationKnownGroups(raw: string | null): string[] {
  if (raw === null) return []
  const groups: unknown = JSON.parse(raw)
  if (!Array.isArray(groups)) throw new Error('仿真会话目录损坏')
  return parseStringList(groups)
}

export function decodeSimulationOverrides(raw: string): SimGroupOverrides {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('仿真群配置损坏')
  const parsed = record(value)
  const supportedKey = (key: string) => /^\d{5,12}$/.test(key) || !!decodeSimulationAddressKey(key)
  function normalizeCaps(input: unknown): Record<string, number> {
    const caps: Record<string, number> = {}
    for (const [key, value] of Object.entries(record(input))) {
      if (!supportedKey(key)) continue
      const cap = Number(value)
      if (cap === -1) caps[key] = -1
      else if (Number.isFinite(cap) && cap > 0) caps[key] = Math.min(10_000, cap)
    }
    return caps
  }
  const rawDefault = Number(parsed.budgetDefaultCny)
  const playAlongUntil: Record<string, number> = {}
  for (const [key, value] of Object.entries(record(parsed.playAlongUntil))) {
    const until = Number(value)
    if (supportedKey(key) && Number.isFinite(until) && until > 0) playAlongUntil[key] = Math.floor(until)
  }
  return { explicitEnabled: parseStringList(parsed.explicitEnabled), disabled: parseStringList(parsed.disabled),
    budgetCaps: normalizeCaps(parsed.budgetCaps), turnCaps: normalizeCaps(parsed.turnCaps), atOnly: parseStringList(parsed.atOnly), playAlongUntil,
    ...(Number.isFinite(rawDefault) && rawDefault > 0 ? { budgetDefaultCny: Math.min(10_000, rawDefault) } : {}) }
}

export function encodeSimulationOverrides(overrides: SimGroupOverrides): string {
  return JSON.stringify({
    explicitEnabled: [...new Set(overrides.explicitEnabled)],
    disabled: [...new Set(overrides.disabled)],
    budgetCaps: overrides.budgetCaps || {},
    turnCaps: overrides.turnCaps || {},
    atOnly: overrides.atOnly || [],
    playAlongUntil: overrides.playAlongUntil || {},
    ...(overrides.budgetDefaultCny !== undefined ? { budgetDefaultCny: overrides.budgetDefaultCny } : {}),
  })
}

export function decodeSimulationSession(raw: string, now: number): SimSessionState {
  const parsed = JSON.parse(raw) as SimSessionState
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.unread)) throw new Error('仿真会话状态损坏')
  return normalizeSession(parsed, now)
}

export function createSimSessionStore(ports: SimSessionStorePorts): SimSessionStore {
  const { redis } = ports
  const now = ports.now ?? Date.now
  const personMemory = createPersonMemoryStore({ redis, now })
  const identity: PersonMemoryIdentity | undefined = ports.characterScope ? { botId: ports.characterScope.botId, personaId: ports.characterScope.personaId } : undefined
  const personScene = ports.characterScope ? { kind: 'group' as const, id: ports.characterScope.groupId } : undefined
  const scopedAffinityKey = (userId: string) => identity ? PERSON_AFFINITY_KEY(identity, userId) : GLOBAL_AFFINITY_KEY(userId)
  const profileUserId = (userId: string) => identity ? (isSimulationUserId(userId) ? userId : '') : String(userId || '').replace(/[^0-9]/g, '')
  const groupAffinityKey = (groupId: string) => identity ? `${AFFINITY_KEY(groupId)}:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}` : AFFINITY_KEY(groupId)
  const memoryKey = (groupId: string) => {
    const scope = ports.memoryScope
    if (!scope) return MEMORIES_KEY(groupId)
    if (simulationAddressKey(scope.target) !== groupId && (scope.target.kind !== 'group' || scope.target.id !== groupId)) {
      throw new Error('仿真记忆会话与绑定不一致')
    }
    return simulationNotebookKey(scope)
  }
  const userStyleKey = (groupId: string) => ports.memoryScope ? `${memoryKey(groupId)}:user-style` : USER_STYLE_KEY(groupId)
  const legacyProfile = async (userId: string): Promise<PersonProfile & { updatedAt?: number }> => {
    try {
      const raw = await redis.get(PERSON_KEY(userId)), parsed = raw ? record(JSON.parse(raw)) : {}
      return {
        ...(typeof parsed.name === 'string' && parsed.name.trim() ? { name: parsed.name.trim().slice(0, 20) } : {}),
        interests: parseStringList(parsed.interests).slice(0, 12), taboos: parseStringList(parsed.taboos).slice(0, 12),
        ...(parseStringList(parsed.traits).length ? { traits: parseStringList(parsed.traits).slice(0, 12) } : {}),
        ...(parseStringList(parsed.facts).length ? { facts: parseStringList(parsed.facts).slice(0, 12) } : {}),
        ...(typeof parsed.updatedAt === 'number' ? { updatedAt: parsed.updatedAt } : {})
      }
    } catch { return { interests: [], taboos: [] } }
  }
  const profileFromEntries = (entries: PersonMemoryEntry[]): PersonProfile & { updatedAt?: number } => {
    const ordered = [...entries].sort((a, b) => b.source.at - a.source.at)
    const names = ordered.filter(entry => entry.category === 'name')
    return { ...(names[0] ? { name: names[0].text } : {}),
      interests: [...new Set(ordered.filter(entry => entry.category === 'interest').map(entry => entry.text))].slice(0, 12),
      taboos: [...new Set(ordered.filter(entry => entry.category === 'preference').map(entry => entry.text))].slice(0, 12),
      ...(ordered[0] ? { updatedAt: ordered[0].updatedAt } : {}) }
  }
  const scopedProfile = async (userId: string) => {
    if (!identity || !personScene) return { interests: [], taboos: [] }
    return profileFromEntries((await personMemory.query({ identity, subjectId: userId, scene: personScene, viewerUserId: userId, portableOnly: true, limit: 40 })).items)
  }
  const allowedMemories = async (memories: unknown[]) => {
    if (!identity || !personScene) return memories
    const sceneState = await personMemory.getSceneRedactions({ identity, scene: personScene })
    const snapshots = new Map<string, Awaited<ReturnType<typeof personMemory.getRedactions>>>()
    const out: unknown[] = []
    for (const raw of memories) {
      const memory = record(raw), provenance = record(memory.memorySource)
      // Self notes may carry a real source without an aboutUser label. Their
      // author's revocation still applies to that copied or derived content.
      const userId = String(memory.aboutUser || provenance.authorId || '')
      if (!memory.memorySource && sceneState.invalidatedAt > 0 && (Number(memory.createdAt) || 0) <= sceneState.invalidatedAt) continue
      const memoryIdentity = record(memory.memoryIdentity)
      if (memoryIdentity.botId && (memoryIdentity.botId !== identity.botId || memoryIdentity.personaId !== identity.personaId)) continue
      if (!userId) { out.push(raw); continue }
      let snapshot = snapshots.get(userId)
      if (!snapshot) { snapshot = await personMemory.getRedactions({ identity, subjectId: userId }); snapshots.set(userId, snapshot) }
      const source = record(memory.memorySource), sourceScene = record(source.scene)
      const checkSource: PersonMemorySource = {
        scene: { kind: sourceScene.kind === 'private' ? 'private' : 'group', id: String(sourceScene.id || personScene.id) },
        authorId: String(source.authorId || userId), messageId: String(source.messageId || `legacy:${String(memory.id || '')}`),
        at: Number(source.at ?? memory.createdAt) || 1, excerpt: String(source.excerpt || memory.content || '')
      }
      const content = String(memory.content || '')
      if (isPersonMemoryRedacted(checkSource, content, snapshot) ||
          (memory.personMemoryId && snapshot.tombstones.some(item => item.id === memory.personMemoryId))) continue
      if (validPersonMemorySource(checkSource) && checkSource.authorId !== userId) {
        let author = snapshots.get(checkSource.authorId)
        if (!author) {
          author = await personMemory.getRedactions({ identity, subjectId: checkSource.authorId })
          snapshots.set(checkSource.authorId, author)
        }
        if (isPersonMemoryRedacted(checkSource, content, author)) continue
      }
      out.push(raw)
    }
    return out
  }

  const selfKey = (legacy: string): string => ports.characterScope ? `${characterKey(ports.characterScope)}:legacy:${legacy.split(':').pop()}` : legacy
  const logWarn = (message: string) => { try { ports.logger?.warn?.(message) } catch { /* 日志不可用不阻塞 */ } }
  const queueWrite = async (key: string, write: () => Promise<void>): Promise<void> => {
    let writes = sessionWrites.get(redis)
    if (!writes) { writes = new Map(); sessionWrites.set(redis, writes) }
    const previous = writes.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(write)
    writes.set(key, operation)
    try { await operation } finally { if (writes.get(key) === operation) writes.delete(key) }
  }
  const saveSession = (groupId: string, state: SimSessionState): Promise<void> => {
    const key = simulationSessionKey(groupId), snapshot = JSON.stringify(state)
    return queueWrite(key, async () => { await redis.set(key, snapshot) })
  }

  return {
    async loadActivityVersion(groupId) {
      return (await redis.get(ACTIVITY_VERSION_KEY(groupId))) ?? ''
    },
    async invalidateActivity(groupId) {
      await redis.set(ACTIVITY_VERSION_KEY(groupId), randomUUID())
    },
    async load(groupId) {
      // A released live state may still have its last snapshot queued for persistence.
      for (;;) {
        const pending = sessionWrites.get(redis)?.get(simulationSessionKey(groupId))
        if (!pending) break
        await pending
        if (sessionWrites.get(redis)?.get(simulationSessionKey(groupId)) === pending) break
      }
      try {
        const raw = await redis.get(simulationSessionKey(groupId))
        return raw ? decodeSimulationSession(raw, now()) : createDefaultSimSession(now())
      } catch (error) {
        // 损坏隔离：不让一次坏数据把后续保存也变成写坏库（qq-bridge 教训：catch{return 默认}会让下次保存清掉整库）。
        logWarn(`[仿真] 群 ${groupId} 会话状态损坏，已重建：${error instanceof Error ? error.message : String(error)}`)
        return createDefaultSimSession(now())
      }
    },
    async save(groupId, state) {
      await saveSession(groupId, state)
    },
    async reset(groupId, presetKeywords) {
      const state = createDefaultSimSession(now(), presetKeywords)
      state.bootstrapSent = true // 重置视为已引导过，不再补发初始提示词
      await saveSession(groupId, state)
      return state
    },
    async loadOverrides() {
      const raw = await redis.get(SIMULATION_OVERRIDES_KEY)
      if (raw === null || raw === undefined) return null
      try {
        return decodeSimulationOverrides(raw)
      } catch {
        return { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }
      }
    },
    async saveOverrides(overrides) {
      await redis.set(SIMULATION_OVERRIDES_KEY, encodeSimulationOverrides(overrides))
    },
    async loadBudgetCarryover(groupId, at) {
      const raw = await redis.get(simulationBudgetCarryoverKey(groupId))
      if (raw === null) return null
      const value = JSON.parse(raw) as SimulationBudgetCarryover
      if (!value || typeof value.day !== 'string' || !Number.isSafeInteger(value.turns) || value.turns < 0 ||
          !Number.isFinite(value.costCny) || value.costCny < 0) throw new Error('群迁移预算记录损坏')
      return value.day === dayKey(at) ? value : null
    },
    async loadKnownGroups() {
      const raw = await redis.get(SIMULATION_KNOWN_GROUPS_KEY)
      try {
        return decodeSimulationKnownGroups(raw)
      } catch {
        return []
      }
    },
    async addKnownGroup(groupId) {
      if (typeof redis.eval === 'function') {
        await redis.eval(ADD_KNOWN, { keys: [SIMULATION_KNOWN_GROUPS_KEY], arguments: [groupId] })
        return
      }
      await queueWrite(SIMULATION_KNOWN_GROUPS_KEY, async () => {
        const known = await this.loadKnownGroups()
        if (!known.includes(groupId)) await redis.set(SIMULATION_KNOWN_GROUPS_KEY, JSON.stringify([...known, groupId]))
      })
    },
    async markBusy(groupId) {
      await redis.set(simulationBusyKey(groupId), String(now()), { PX: SIM_TURN_BUSY_LEASE_MS })
    },
    async clearBusy(groupId) {
      await redis.del(simulationBusyKey(groupId))
    },
    async getInitPrompt(groupId) {
      const raw = await redis.get(simulationInitialPromptKey(groupId))
      return raw === null || raw === undefined ? '' : String(raw).slice(0, SIM_INITIAL_PROMPT_MAX_CHARS)
    },
    async setInitPrompt(groupId, text) {
      const value = String(text || '').trim().slice(0, SIM_INITIAL_PROMPT_MAX_CHARS)
      if (value) await redis.set(simulationInitialPromptKey(groupId), value)
      else await redis.del(simulationInitialPromptKey(groupId))
    },
    async loadMemories(groupId) {
      const key = memoryKey(groupId)
      try {
        const raw = await redis.get(key)
        return await allowedMemories(raw ? (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) as unknown[] : []) : [])
      } catch {
        logWarn(`[仿真] 群 ${groupId} 记忆库损坏，按空处理（不回写覆盖，等下一次保存重建）`)
        return []
      }
    },
    async saveMemories(groupId, memories, isCurrent) {
      const key = memoryKey(groupId)
      const snapshot = JSON.stringify(await allowedMemories(memories))
      if (isCurrent?.() === false) throw new Error('角色绑定已改变，仿真记忆未保存')
      await redis.set(key, snapshot)
    },
    async loadAffinity(groupId) {
      try {
        const raw = await redis.get(groupAffinityKey(groupId))
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const cutoff = identity && personScene ? (await personMemory.getSceneRedactions({ identity, scene: personScene })).invalidatedAt : 0
        // Legacy reason strings lack individual evidence/time. Keep familiarity,
        // but never reuse a reason after any source has been invalidated.
        return Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, cutoff ? { ...record(value), reasons: [] } : value]))
      } catch {
        logWarn(`[仿真] 群 ${groupId} 好感度数据损坏，按空处理`)
        return {}
      }
    },
    async saveAffinity(groupId, affinity) {
      await redis.set(groupAffinityKey(groupId), JSON.stringify(affinity))
    },
    async loadUserStyle(groupId) {
      try {
        const raw = await redis.get(userStyleKey(groupId))
        const parsed = raw ? record(JSON.parse(raw)) : {}
        const users: Record<string, string[]> = {}
        for (const [userId, words] of Object.entries(record(parsed.users))) {
          if (Array.isArray(words)) users[userId] = words.map(String).filter(Boolean).slice(0, 6)
        }
        return { users, updatedAt: Number(parsed.updatedAt) || 0 }
      } catch {
        return { users: {}, updatedAt: 0 }
      }
    },
    async saveUserStyle(groupId, users, isCurrent) {
      const key = userStyleKey(groupId), snapshot = JSON.stringify({ users, updatedAt: now() })
      if (isCurrent?.() === false) throw new Error('角色绑定已改变，口头禅未保存')
      await redis.set(key, snapshot)
    },
    async loadPersonProfile(userId) {
      const id = String(userId || '').trim()
      if (!(identity ? isSimulationUserId(id) : /^\d+$/.test(id))) return { interests: [], taboos: [] }
      // Unscoped callers are administrative only; no legacy string may enter a live projection.
      return identity ? scopedProfile(id) : legacyProfile(id)
    },
    async mergePersonProfile(userId, patch, maxFields, isCurrent) {
      const id = profileUserId(userId)
      if (!id) return { interests: [], taboos: [] }
      if (identity && personScene) {
        for (const memory of patch.memories || []) {
          if (isCurrent?.() === false) throw new Error('人物事实提取范围已改变')
          if (memory.source.scene.kind !== 'group' || memory.source.scene.id !== personScene.id || memory.source.authorId !== id) continue
          await personMemory.remember({ ...memory, identity, subjectId: id }, isCurrent)
        }
        return scopedProfile(id)
      }
      // Retain the legacy administrative editing surface without promoting unproven strings.
      const current = await this.loadPersonProfile(id)
      const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 20) : current.name
      const uniq = (list: string[]) => {
        const seen = new Set<string>()
        const out: string[] = []
        for (const item of list) {
          const value = String(item || '').trim().slice(0, 30)
          if (!value || seen.has(value)) continue
          seen.add(value); out.push(value)
        }
        return out
      }
      // 新陈代谢：closedFacts 先剔除存量（facts/interests/traits 都可能被结束），新事实再并入
      const closed = patch.closedFacts
      const merged = {
        ...(name ? { name } : {}),
        interests: uniq([...(patch.interests || []), ...stripSupersededItems(current.interests, closed)]).slice(0, maxFields),
        taboos: uniq([...(patch.taboos || []), ...current.taboos]).slice(0, maxFields),
        ...(uniq([...(patch.traits || []), ...stripSupersededItems(current.traits, closed)]).length ? { traits: uniq([...(patch.traits || []), ...stripSupersededItems(current.traits, closed)]).slice(0, 4) } : {}),
        ...(uniq([...(patch.facts || []), ...stripSupersededItems(current.facts, closed)]).length ? { facts: uniq([...(patch.facts || []), ...stripSupersededItems(current.facts, closed)]).slice(0, maxFields) } : {}),
        updatedAt: now()
      }
      if (isCurrent?.() === false) throw new Error('人物事实提取范围已改变')
      await redis.set(PERSON_KEY(id), JSON.stringify(merged))
      return merged
    },
    async registerPersonSource(userId, source) {
      if (!identity || !personScene || source.scene.kind !== 'group' || source.scene.id !== personScene.id || source.authorId !== userId) return false
      return personMemory.registerSource({ identity, subjectId: userId, source })
    },
    async rememberPersonMemory(input) {
      if (!identity || !personScene || input.source.scene.kind !== 'group' || input.source.scene.id !== personScene.id) return { saved: false, reason: 'missing_scene' }
      return personMemory.remember({ ...input, identity, portable: false })
    },
    async forgetPersonMemory(userId, input) {
      if (!identity || !personScene) return
      await personMemory.forget({ ...input, identity, subjectId: userId, scene: personScene })
    },
    async revokePersonSource(messageId) {
      if (identity && personScene) await personMemory.revokeSource({ identity, scene: personScene, messageId })
    },
    async loadGlobalAffinity(userIds) {
      const out: Record<string, number> = Object.create(null)
      for (const raw of userIds) {
        const id = profileUserId(raw)
        if (!id) continue
        try {
          const parsed = record(JSON.parse(String(await redis.get(scopedAffinityKey(id)) || 'null')))
          const score = Number(parsed.score)
          if (Number.isFinite(score) && score >= 0 && score <= 100) out[id] = Math.round(score)
        } catch { /* 单人失败不影响整批 */ }
      }
      return out
    },
    async bumpGlobalAffinity(userId, delta, reason) {
      const id = profileUserId(userId)
      if (!id) return 50
      let existing: { score?: number; reasons?: unknown[] } = {}
      try {
        existing = record(JSON.parse(String(await redis.get(scopedAffinityKey(id)) || 'null')))
      } catch { existing = {} }
      const current = Number(existing.score)
      const base = Number.isFinite(current) && current >= 0 && current <= 100 ? current : 50
      const next = Math.max(0, Math.min(100, Math.round(base + (Number(delta) || 0) * 0.3)))
      void reason
      await redis.set(scopedAffinityKey(id), JSON.stringify({ score: next, updatedAt: now() }))
      return next
    },
    async loadGlobalAffinityNotes(_userIds) {
      // A relationship score is not permission to disclose why it changed elsewhere.
      return {}
    },
    async listPersonProfiles() {
      const rows = new Map<string, PersonProfile & { userId: string; updatedAt?: number; unverified?: boolean }>()
      // Legacy profiles are visible to administrators only and explicitly marked unverified.
      if (!identity && typeof redis.keys === 'function') {
        for (const key of (await redis.keys('shiloh:sim:person:*')).slice(0, 1000)) {
          const match = /^shiloh:sim:person:(\d+)$/.exec(key)
          if (!match) continue
          const profile = await legacyProfile(match[1]!)
          rows.set(match[1]!, { ...profile, userId: match[1]!, unverified: true })
        }
      }
      for (const subject of (await personMemory.listSubjects(identity)).slice(0, 1000)) {
        const entries = (await personMemory.query({ ...subject, scene: { kind: 'private', id: subject.subjectId }, viewerUserId: subject.subjectId, portableOnly: true, limit: 40 })).items
        if (!entries.length) continue
        const profile = profileFromEntries(entries), prior = rows.get(subject.subjectId)
        // Do not mix an unverified legacy string into a verified cross-scene profile.
        const previous = prior?.unverified ? undefined : prior
        rows.set(subject.subjectId, { ...profile, userId: subject.subjectId,
          interests: [...new Set([...(previous?.interests || []), ...profile.interests])],
          taboos: [...new Set([...(previous?.taboos || []), ...profile.taboos])] })
      }
      return [...rows.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    },
    async deletePersonProfile(userId) {
      const id = userId.trim()
      if (!isSimulationUserId(id)) return false
      const subjects = await personMemory.listSubjects(identity)
      for (const subject of subjects.filter(item => item.subjectId === id)) {
        await personMemory.forget(subject)
        await redis.del(PERSON_AFFINITY_KEY(subject.identity, id))
      }
      if (identity && !subjects.some(item => item.subjectId === id)) await personMemory.forget({ identity, subjectId: id })
      if (identity) await redis.del(scopedAffinityKey(id))
      else if (/^\d+$/.test(id)) await redis.del(PERSON_KEY(id), GLOBAL_AFFINITY_KEY(id))
      return true
    },
    async loadRhythm() {
      try {
        const raw = await redis.get(simulationRhythmKey(ports.characterScope))
        if (!raw) return null
        const { updatedAt: _at, ...rhythm } = decodeSimulationRhythm(raw)
        return rhythm
      } catch { return null }
    },
    async saveRhythm(rhythm) {
      await redis.set(simulationRhythmKey(ports.characterScope), JSON.stringify({ sleepFrom: rhythm.sleepFrom, sleepTo: rhythm.sleepTo, setBy: rhythm.setBy || 'agent', updatedAt: now() }))
    },
    async loadLifeThreads() {
      try {
        const raw = await redis.get(selfKey(LIFE_THREADS_KEY))
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed : []
      } catch { return [] }
    },
    async saveLifeThreads(threads) {
      await redis.set(selfKey(LIFE_THREADS_KEY), JSON.stringify(Array.isArray(threads) ? threads : []))
    },
    async loadSelfMemories() {
      try {
        const raw = await redis.get(selfKey(SELF_MEMORIES_KEY))
        const parsed = raw ? JSON.parse(raw) : []
        return await allowedMemories(Array.isArray(parsed) ? parsed : [])
      } catch { return [] }
    },
    async saveSelfMemories(memories) {
      await redis.set(selfKey(SELF_MEMORIES_KEY), JSON.stringify(await allowedMemories(Array.isArray(memories) ? memories : [])))
    },
    async loadMood() {
      try {
        const raw = await redis.get(selfKey(MOOD_KEY))
        return raw ? JSON.parse(raw) : null
      } catch { return null }
    },
    async saveMood(mood) {
      await redis.set(selfKey(MOOD_KEY), JSON.stringify(mood))
    },
    async deletePersonProfileField(userId, field, value) {
      const id = userId.trim()
      if (!isSimulationUserId(id)) return { interests: [], taboos: [] }
      const categories: Record<string, string[]> = { name: ['name'], interests: ['interest'], taboos: ['preference'], traits: ['impression'], facts: ['fact', 'event', 'relationship'] }
      for (const subject of (await personMemory.listSubjects(identity)).filter(item => item.subjectId === id)) {
        let offset = 0
        const matching: string[] = []
        for (;;) {
          const page = await personMemory.query({ ...subject, scene: { kind: 'private', id }, viewerUserId: id, limit: 100, offset })
          for (const entry of page.items) if (categories[field]?.includes(entry.category) && (value === undefined || entry.text === value)) matching.push(entry.id)
          if (!page.hasMore || page.nextOffset === undefined) break
          offset = page.nextOffset
        }
        for (const entryId of matching) await personMemory.forget({ ...subject, id: entryId })
      }
      if (identity) return scopedProfile(id)
      if (!/^\d+$/.test(id)) return { interests: [], taboos: [] }
      const current = await this.loadPersonProfile(id)
      const name = field === 'name' ? undefined : current.name
      const filter = (list: string[] | undefined) => value === undefined ? [] : (list || []).filter(item => item !== value)
      const merged = {
        ...(name ? { name } : {}),
        interests: field === 'interests' ? filter(current.interests) : current.interests,
        taboos: field === 'taboos' ? filter(current.taboos) : current.taboos,
        ...(field === 'traits' || current.traits?.length ? { traits: field === 'traits' ? filter(current.traits) : current.traits } : {}),
        ...(field === 'facts' || current.facts?.length ? { facts: field === 'facts' ? filter(current.facts) : current.facts } : {}),
        updatedAt: now()
      }
      await redis.set(PERSON_KEY(id), JSON.stringify(merged))
      return merged
    },
  }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** 状态解码防御：缺字段补默认，未知字段忽略（旧版本数据升级不炸）。 */
function normalizeSession(parsed: Partial<SimSessionState>, now: number): SimSessionState {
  const base = createDefaultSimSession(now)
  const state: SimSessionState = {
    ...base,
    ...parsed,
    unread: Array.isArray(parsed.unread) ? parsed.unread.map(message => normalizeSimulationMessageVideo(normalizeSimulationMessageFiles(message))) : [],
    recent: Array.isArray(parsed.recent) ? parsed.recent.map(message => normalizeSimulationMessageVideo(normalizeSimulationMessageFiles(message))) : [],
    modelSeenSeqs: Array.isArray(parsed.modelSeenSeqs) ? parsed.modelSeenSeqs : [],
    pendingWakeReasons: Array.isArray(parsed.pendingWakeReasons) ? parsed.pendingWakeReasons : [],
    wakeTimes: Array.isArray(parsed.wakeTimes) ? parsed.wakeTimes : [],
    sendTimes: Array.isArray(parsed.sendTimes) ? parsed.sendTimes : [],
    agentHistory: Array.isArray(parsed.agentHistory) ? parsed.agentHistory : [],
    preSleepWait: parsed.preSleepWait && typeof parsed.preSleepWait === 'object' ? parsed.preSleepWait : { accumMs: 0 },
    budget: parsed.budget && typeof parsed.budget === 'object' ? parsed.budget : base.budget,
    wakeConfig: parsed.wakeConfig && typeof parsed.wakeConfig === 'object' ? parsed.wakeConfig : base.wakeConfig,
    conversation: parsed.conversation && typeof parsed.conversation === 'object'
      ? {
          activeUntil: Number(parsed.conversation.activeUntil) || 0,
          interlocutorIds: Array.isArray(parsed.conversation.interlocutorIds) ? parsed.conversation.interlocutorIds.map(String).slice(0, 5) : [],
          ...(parsed.conversation.lastTriggerUserId !== undefined ? { lastTriggerUserId: String(parsed.conversation.lastTriggerUserId) } : {}),
        }
      : base.conversation,
  }
  return state
}
