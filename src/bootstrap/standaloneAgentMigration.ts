import fs from 'node:fs'
import path from 'node:path'
import { types } from 'node:util'
import YAML from 'yaml'
import type { CommitmentData } from '../contracts/commitments.js'
import type { AgentBindingSnapshot, ConversationAddress } from '../contracts/agentBinding.js'
import type { AgentDeferredActionGrant } from '../contracts/agentDeferredAction.js'
import type { ReminderData, ReminderPending } from '../contracts/reminder.js'
import type { SimulationSection, SimSessionState } from '../contracts/simulation.js'
import { qqId, validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { computeNextDailyRun } from '../modules/commitments/domain/commitments.js'
import { COMMITMENT_LOCK_KEY, COMMITMENT_PENDING_KEY, commitmentDetailKey, decodeCommitment, decodeCommitmentPendingList, encodeCommitment } from '../modules/commitments/infrastructure/commitmentStore.js'
import { sanitizeFinalReplyText } from '../modules/conversation/domain/replySanitizer.js'
import { normalizeDelegatedEntries } from '../modules/memory/domain/delegatedMemory.js'
import { delegatedMemoryStorageKey } from '../modules/memory/infrastructure/delegatedMemoryStore.js'
import { personMemoryAddress } from '../modules/memory/infrastructure/personMemoryContext.js'
import { stagePersonMemoryForScene } from '../modules/memory/infrastructure/personMemoryStore.js'
import { readTokenLedgerCost } from '../modules/models/infrastructure/tokenLedger.js'
import { REMINDER_LOCK_KEY, REMINDER_PENDING_KEY, decodeReminder, decodeReminderPendingList, reminderDetailKey, reminderText } from '../modules/qqTools/infrastructure/reminderLedger.js'
import { agentBindingIdentity, agentBindingToken, agentConversationKey, agentPersonaScopeId, conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { createAgentBindingConfig } from '../modules/runtime/infrastructure/agentBindingConfig.js'
import { agentRedisPrefix, connectAgentRedis } from '../modules/runtime/infrastructure/agentRedis.js'
import { stageLegacyDeferredReminders, type LegacyDeferredReminderSelection } from '../modules/runtime/infrastructure/agentDeferredActionMigration.js'
import { activeCharacterMemories, characterKey, characterMemoryVisibility, createEmptyCharacterState, validateCharacterState } from '../modules/simulation/domain/characterState.js'
import { projectCharacterTransfer } from '../modules/simulation/domain/characterTransfer.js'
import { characterReflectionKey, validateReflectionState } from '../modules/simulation/infrastructure/characterReflection.js'
import { characterWorkspaceKey, projectCharacterWorkspace, validateCharacterWorkspace } from '../modules/simulation/infrastructure/characterWorkspace.js'
import { createDefaultSimSession, dayKey, normalizeSimWakeConfig, SIM_WAKE_TIMES_LIMIT } from '../modules/simulation/domain/simConfig.js'
import { normalizeSimMemoryEntry } from '../modules/simulation/domain/simMemory.js'
import { decodeSimulationKnownGroups, decodeSimulationOverrides, decodeSimulationRhythm, decodeSimulationSession, encodeSimulationOverrides,
  SIMULATION_KNOWN_GROUPS_KEY, SIMULATION_OVERRIDES_KEY, simulationBudgetCarryoverKey, simulationBusyKey, simulationNotebookKey,
  simulationRhythmKey, simulationSessionKey } from '../modules/simulation/infrastructure/simSessionStore.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import { resolveSimulationGroupConfig, seedSimulationOverrides, simulationGroupOverride } from '../modules/simulation/infrastructure/simulationGroupPolicy.js'
import type { readStandaloneAgentConfig } from './standaloneAgentConfig.js'
import { stageInitialPromptTransfer } from './standaloneAgentPromptMigration.js'
import { stageStandaloneGroupTeaching } from './standaloneGroupTeachingMigration.js'
import { stageStandaloneAgentArchiveMigration } from './standaloneAgentArchiveMigration.js'
import type { AgentHistoryConfig } from '../contracts/agentHistory.js'
import { createForbiddenWordGuard } from '../modules/conversation/domain/forbiddenWordGuard.js'

type Redis = Pick<Awaited<ReturnType<typeof connectAgentRedis>>, 'get' | 'mGet' | 'exists' | 'eval'>
type Check = { key: string; value: string | null; write?: string | null }
type Skipped = { unscoped: number; binding: number; inFlight: number; unsupported: number; unavailable: number }

const deferredOptionsError = () => new Error('延期提醒迁移选择、工具映射或授权参数无效')
function deferredOptionRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw deferredOptionsError()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw deferredOptionsError()
    row[key] = field.value
  }
  return row
}
function deferredOptionToken(input: unknown, max = 256): string {
  if (typeof input !== 'string' || !input || input.length > max || input.trim() !== input || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(input)) throw deferredOptionsError()
  return input
}
function deferredOptionTime(input: unknown): number {
  if (typeof input !== 'number' || !validTimestamp(input)) throw deferredOptionsError()
  return input
}
function deferredOptionHash(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/u.test(input)) throw deferredOptionsError()
  return input
}
function deferredMigrationGrant(input: unknown): AgentDeferredActionGrant {
  const row = deferredOptionRecord(input, ['version', 'id', 'ruleId', 'ruleRevision', 'bindingIdentity', 'scopeKey', 'creator', 'actionHash', 'dueAt', 'source', 'issuedAt', 'expiresAt'])
  const creator = deferredOptionRecord(row.creator, ['platform', 'namespace', 'id'])
  const source = deferredOptionRecord(row.source, ['kind', 'id', 'sourceHash', 'authorizedBy', 'at', 'messageId'])
  if (row.version !== 1 || source.kind !== 'migration' && source.kind !== 'message' ||
      Object.keys(row).length !== 12 || Object.keys(creator).length !== 3 ||
      Object.keys(source).length !== (source.kind === 'migration' ? 5 : 3) ||
      source.kind === 'migration' && Object.hasOwn(source, 'messageId') ||
      source.kind === 'message' && ['id', 'sourceHash', 'authorizedBy'].some(key => Object.hasOwn(source, key))) throw deferredOptionsError()
  return Object.freeze({ version: 1, id: deferredOptionToken(row.id), ruleId: deferredOptionToken(row.ruleId, 128), ruleRevision: deferredOptionToken(row.ruleRevision),
    bindingIdentity: deferredOptionToken(row.bindingIdentity, 8192), scopeKey: deferredOptionToken(row.scopeKey, 8192),
    creator: Object.freeze({ platform: deferredOptionToken(creator.platform, 128), namespace: deferredOptionToken(creator.namespace, 128), id: deferredOptionToken(creator.id) }),
    actionHash: deferredOptionHash(row.actionHash), dueAt: deferredOptionTime(row.dueAt), issuedAt: deferredOptionTime(row.issuedAt), expiresAt: deferredOptionTime(row.expiresAt),
    source: Object.freeze(source.kind === 'migration' ? { kind: source.kind, id: deferredOptionToken(source.id), sourceHash: deferredOptionHash(source.sourceHash),
      authorizedBy: deferredOptionToken(source.authorizedBy), at: deferredOptionTime(source.at) } : { kind: source.kind, messageId: deferredOptionToken(source.messageId), at: deferredOptionTime(source.at) }),
  })
}
function deferredReminderSelections(options: object): readonly LegacyDeferredReminderSelection[] | undefined {
  if (!options || types.isProxy(options)) throw deferredOptionsError()
  const field = Object.getOwnPropertyDescriptor(options, 'deferredReminders')
  if (!field) return undefined
  if (!Object.hasOwn(field, 'value')) throw deferredOptionsError()
  const input: unknown = field.value
  if (input === undefined) return undefined
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 1000 || Reflect.ownKeys(input).length !== input.length + 1) throw deferredOptionsError()
  const seen = new Set<string>()
  return Object.freeze(Array.from({ length: input.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(input, String(index))
    if (!entry || !Object.hasOwn(entry, 'value')) throw deferredOptionsError()
    const row = deferredOptionRecord(entry.value, ['id', 'mapping', 'grant', 'freezeUncertain']), id = deferredOptionToken(row.id)
    if (seen.has(id) || row.freezeUncertain !== undefined && typeof row.freezeUncertain !== 'boolean') throw deferredOptionsError()
    seen.add(id)
    let mapping: LegacyDeferredReminderSelection['mapping']
    if (row.mapping !== undefined) {
      const selected = deferredOptionRecord(row.mapping, ['from', 'to', 'definitionId', 'executor'])
      if (Object.keys(selected).length !== 4 || selected.executor !== 'builtin' && selected.executor !== 'custom' && selected.executor !== 'mcp') throw deferredOptionsError()
      mapping = Object.freeze({ from: deferredOptionToken(selected.from, 128), to: deferredOptionToken(selected.to, 128), definitionId: deferredOptionToken(selected.definitionId, 512), executor: selected.executor })
    }
    const normalized: LegacyDeferredReminderSelection = Object.freeze({ id, ...(mapping ? { mapping } : {}),
      ...(row.grant === undefined ? {} : { grant: deferredMigrationGrant(row.grant) }), ...(row.freezeUncertain === undefined ? {} : { freezeUncertain: row.freezeUncertain }) })
    if (JSON.stringify(normalized).length > 32_768) throw deferredOptionsError()
    return normalized
  }))
}

function validateMigrationOptions(input: unknown): void {
  const row = deferredOptionRecord(input, ['sourceBindings', 'sourceConfig', 'sourceDataDir', 'moveAgentCommitments', 'moveCharacterState',
    'moveGroupTeaching', 'moveMessageArchive', 'sourceArchiveDir', 'deferredReminders', 'connectionId', 'kind', 'conversationId', 'apply'])
  if (typeof row.apply !== 'boolean' || row.kind !== 'group' && row.kind !== 'private') throw new Error('离线迁移参数无效')
  for (const key of ['sourceBindings', 'connectionId', 'conversationId']) deferredOptionToken(row[key], 4096)
  for (const key of ['sourceConfig', 'sourceDataDir', 'sourceArchiveDir']) if (row[key] !== undefined) deferredOptionToken(row[key], 4096)
  for (const key of ['moveAgentCommitments', 'moveCharacterState', 'moveGroupTeaching', 'moveMessageArchive']) if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error('离线迁移参数无效')
  if (row.sourceArchiveDir !== undefined && row.moveMessageArchive !== true) throw new Error('显式归档目录须同时启用原文归档接续')
}

function registerScheduledGroup(key: string, value: string | null, address: string): Check {
  const groups = decodeSimulationKnownGroups(value)
  return { key, value, ...(!groups.includes(address) ? { write: JSON.stringify([...groups, address]) } : {}) }
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value + 8 * 3_600_000).getTime())
}

const changeError = '迁移期间账本有变更，迁移未写入，请重新预览'

function appendTransferChecks(merged: Map<string, Check>, checks: readonly Check[]): void {
  for (const check of checks) {
    const previous = merged.get(check.key)
    if (previous && (previous.value !== check.value ||
        (previous.write !== undefined && check.write !== undefined && previous.write !== check.write))) throw new Error(changeError)
    if (!previous || check.write !== undefined) merged.set(check.key, check)
  }
}

/** A later stage reads prior planned writes, while the final CAS still checks the original Redis bytes. */
function appendSequentialTransferChecks(merged: Map<string, Check>, checks: readonly Check[]): void {
  for (const check of checks) {
    const previous = merged.get(check.key)
    if (!previous) { merged.set(check.key, check); continue }
    const planned = previous.write === undefined ? previous.value : previous.write
    if (planned !== check.value) throw new Error(changeError)
    if (check.write !== undefined) merged.set(check.key, { key: check.key, value: previous.value, write: check.write })
  }
}

function readSourceConfigRaw(file: string, optional: boolean): string | null {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('无法读取源插件的 message.yaml')
  }
}

function readSimulationConfig(file: string, optional: boolean): { raw: string | null; section: SimulationSection } {
  const raw = readSourceConfigRaw(file, optional)
  if (raw === null) return { raw: null, section: {} }
  const document = YAML.parseDocument(raw)
  if (document.errors.length) throw new Error('源插件的 message.yaml 格式无效')
  const settings = document.toJS() as { pluginSettings?: { simulation?: unknown } } | null
  const section = settings?.pluginSettings?.simulation
  if (section != null && (typeof section !== 'object' || Array.isArray(section))) throw new Error('源插件的 simulation 配置应为对象')
  return { raw, section: (section as SimulationSection | null | undefined) ?? {} }
}

async function stageSimulationControls(
  redis: Redis, prefix: string, binding: AgentBindingSnapshot, previous: AgentBindingSnapshot,
  source: SimulationSection, destination: SimulationSection, sourceDataDir: string, now: number,
  targetUsesSimulation: boolean, includeCharacterState: boolean,
) {
  const address = simulationAddressKey(binding.target)
  const scene = binding.target.id
  const identity = { botId: binding.target.account.id, personaId: agentPersonaScopeId(binding.agentId), groupId: scene }
  const roleKey = characterKey(identity)
  const bindingIdentity = agentBindingIdentity(binding)
  const markerKey = prefix + `agent:migration:qq-controls:${encodeURIComponent(agentConversationKey(binding))}`
  const targetLegacySessionKey = prefix + simulationSessionKey(scene)
  const sourceKeys = [SIMULATION_OVERRIDES_KEY, simulationSessionKey(scene), simulationSessionKey(address), roleKey]
  const allKeys = [...sourceKeys, ...[SIMULATION_OVERRIDES_KEY, simulationSessionKey(address), roleKey,
    simulationBudgetCarryoverKey(address)].map(key => prefix + key)]
  const [sourceOverrides, legacyRaw, scopedRaw, sourceRole, targetOverrides, targetRaw, targetRole, targetBudget,
    targetLegacyRaw = null, marker = null] = await redis.mGet([...allKeys, targetLegacySessionKey, markerKey])
  if (marker !== null && marker !== bindingIdentity) throw new Error('目标已有仿真控制交接记录')
  const nextPolicies = targetOverrides == null ? seedSimulationOverrides(destination) : decodeSimulationOverrides(targetOverrides)
  let targetLegacy: SimSessionState | null = null
  try { if (targetLegacyRaw !== null) targetLegacy = decodeSimulationSession(targetLegacyRaw, now) }
  catch { /* Runtime ignores a damaged plain session and falls through to the scoped address. */ }
  // Runtime keeps using a plain QQ-group session only for its recorded owner.
  const targetId = targetLegacy?.botId === identity.botId ? scene : address
  const after = resolveSimulationGroupConfig(destination, nextPolicies, address)
  const targetEnabled = after.enabled && (simulationGroupOverride(nextPolicies, targetId) ?? after.allGroups)
  // The controls report may be absent while the policy still determines whether tasks can move.
  const eligibilityChecks: Check[] = [
    { key: markerKey, value: marker }, { key: prefix + SIMULATION_OVERRIDES_KEY, value: targetOverrides ?? null },
    { key: targetLegacySessionKey, value: targetLegacyRaw },
  ]
  if (marker === bindingIdentity) return { checks: eligibilityChecks, canMoveAgentCommitments: targetUsesSimulation && targetEnabled }

  const original = [sourceOverrides, legacyRaw, scopedRaw, sourceRole, targetOverrides, targetRaw, targetRole, targetBudget]
  eligibilityChecks.push(...sourceKeys.slice(0, 3).map((key, index) => ({ key, value: original[index] ?? null })))
  const oldPolicies = sourceOverrides == null ? seedSimulationOverrides(source) : decodeSimulationOverrides(sourceOverrides)
  const legacy = legacyRaw == null ? null : decodeSimulationSession(legacyRaw, now)
  const scoped = scopedRaw == null ? null : decodeSimulationSession(scopedRaw, now)
  const sourceId = legacy?.botId === identity.botId ? scene : address
  const session = sourceId === scene ? legacy : scoped
  if (scoped?.botId && scoped.botId !== identity.botId) throw new Error('源仿真会话的账号与地址不符')
  const before = resolveSimulationGroupConfig(source, oldPolicies, sourceId)
  const sourceOverride = simulationGroupOverride(oldPolicies, sourceId)
  const targetOverride = simulationGroupOverride(nextPolicies, targetId)
  const wasActive = before.enabled && (sourceOverride ?? before.allGroups)
  const sourceAtOnly = oldPolicies.atOnly?.includes(sourceId) === true
  const targetAtOnly = nextPolicies.atOnly?.includes(address) === true
  const sourceBoost = oldPolicies.playAlongUntil?.[sourceId] ?? 0
  const targetBoost = nextPolicies.playAlongUntil?.[address] ?? 0
  const currentRole = targetRole == null ? null : validateCharacterState(JSON.parse(targetRole), identity)
  const alreadyPaused = currentRole?.paused === true
  const sourcePaused = sourceRole != null && validateCharacterState(JSON.parse(sourceRole), identity).paused
  const targetBudgetCap = after.budget.groups[address] ?? after.budget.dailyCostCny
  const targetTurnCap = after.turn.groups[address] ?? after.turn.maxTurnsPerDay
  const budgetCap = stricterCap(before.budget.groups[sourceId] ?? before.budget.dailyCostCny, targetBudgetCap)
  const turnCap = stricterCap(before.turn.groups[sourceId] ?? before.turn.maxTurnsPerDay, targetTurnCap)
  if (!Number.isFinite(budgetCap) || !Number.isFinite(turnCap)) throw new Error('来源或目标的群预算配置无效')
  const atOnly = sourceAtOnly || targetAtOnly
  const boost = atOnly || !wasActive || !targetEnabled ? 0 : targetBoost > now ? targetBoost : sourceBoost > now ? sourceBoost : 0
  const copyPause = sourcePaused && !alreadyPaused
  const sourceTurns = session?.botId === identity.botId && session.budget.day === dayKey(now) ? session.budget.turns : 0
  if (!Number.isSafeInteger(sourceTurns) || sourceTurns < 0) throw new Error('源仿真会话的当日回合计数损坏')
  const costCny = readTokenLedgerCost(sourceDataDir, sourceId, now)
  if (!Number.isFinite(costCny)) throw new Error('源仿真会话的当日金额损坏')
  const recent = (times: number[]) => times.filter(at => Number.isSafeInteger(at) && at > now - 3_600_000 && at <= now).slice(-SIM_WAKE_TIMES_LIMIT)
  const sameBinding = session?.botId === identity.botId && session.bindingToken === agentBindingToken(previous)
  const wakeTimes = sameBinding ? recent(session.wakeTimes) : []
  const sendTimes = sameBinding ? recent(session.sendTimes) : []
  const fresh = createDefaultSimSession(now, after.agentPresetKeywords)
  const wakeConfig = sameBinding && targetUsesSimulation ? normalizeSimWakeConfig(session.wakeConfig) : undefined
  const nextWakeAt = wakeConfig?.sleepUntil
  if (nextWakeAt !== undefined && !validTimestamp(nextWakeAt)) throw new Error('源仿真会话的定时唤醒时间无效')
  const targetSession = targetRaw == null ? null : decodeSimulationSession(targetRaw, now)
  if (targetSession?.botId && targetSession.botId !== identity.botId) throw new Error('目标仿真会话的账号与地址不符')
  if (targetBudget != null || (targetSession && (wakeTimes.length || sendTimes.length || wakeConfig))) {
    throw new Error('目标已有仿真会话或预算，迁移未覆盖')
  }
  const seedSession = !targetSession && (sourceAtOnly || sourcePaused || wakeTimes.length > 0 || sendTimes.length > 0 || wakeConfig !== undefined ||
    (session?.botId === identity.botId && session.bootstrapSent))
  const paused = sourcePaused || alreadyPaused
  const enable = wasActive && targetEnabled
  const canMoveAgentCommitments = targetUsesSimulation && enable
  const disable = !wasActive && targetOverride !== false
  const pinEnabled = sourceOverride === true && enable && targetOverride === undefined
  const writeAtOnly = sourceAtOnly && !targetAtOnly
  const writeBoost = boost > now && boost !== targetBoost
  const writeCostCap = budgetCap !== targetBudgetCap
  const writeTurnCap = turnCap !== targetTurnCap
  const writePolicies = disable || pinEnabled || writeAtOnly || writeBoost || writeCostCap || writeTurnCap
  if (!writePolicies && !copyPause && !sourceTurns && !costCny && !seedSession) {
    return { checks: eligibilityChecks, canMoveAgentCommitments }
  }

  const checks = new Map<string, Check>(allKeys.map((key, i) => [key, { key, value: original[i] ?? null }]))
  checks.set(targetLegacySessionKey, { key: targetLegacySessionKey, value: targetLegacyRaw })
  const write = (key: string, value: string) => { checks.get(key)!.write = value }
  const idleKeys = [simulationBusyKey(sourceId), prefix + simulationBusyKey(address), `${roleKey}:lock`, prefix + `${roleKey}:lock`]
  for (const key of idleKeys) checks.set(key, { key, value: null })
  if (await redis.exists(idleKeys)) throw new Error('仿真群或角色仍有进行中的工作')
  checks.set(markerKey, { key: markerKey, value: null, write: bindingIdentity })
  if (writePolicies) {
    if (disable) {
      nextPolicies.explicitEnabled = nextPolicies.explicitEnabled.filter(id => id !== targetId)
      nextPolicies.disabled.push(targetId)
    } else if (pinEnabled) nextPolicies.explicitEnabled.push(targetId)
    if (writeAtOnly) nextPolicies.atOnly = [...(nextPolicies.atOnly ?? []), address]
    if (writeBoost) nextPolicies.playAlongUntil = { ...nextPolicies.playAlongUntil, [address]: boost }
    if (writeCostCap) nextPolicies.budgetCaps[address] = budgetCap
    if (writeTurnCap) nextPolicies.turnCaps[address] = turnCap
    write(prefix + SIMULATION_OVERRIDES_KEY, encodeSimulationOverrides(nextPolicies))
  }
  if (copyPause && !includeCharacterState) {
    const current = currentRole ?? createEmptyCharacterState(identity)
    write(prefix + roleKey, JSON.stringify({ ...current, revision: current.revision + 1, paused: true }))
  }
  if (sourceTurns || costCny) write(prefix + simulationBudgetCarryoverKey(address), JSON.stringify({ day: dayKey(now), turns: sourceTurns, costCny }))
  if (seedSession) {
    write(prefix + simulationSessionKey(address), JSON.stringify({ ...fresh, botId: identity.botId, personaId: identity.personaId,
      ...(wakeConfig ? { wakeConfig } : {}),
      bindingToken: agentBindingToken(binding), bootstrapSent: true, wakeTimes, sendTimes }))
  }
  const rawSourceSession = sourceId === scene ? legacyRaw : scopedRaw
  if (nextWakeAt !== undefined && rawSourceSession != null) {
    const originalSession = JSON.parse(rawSourceSession) as SimSessionState
    const { sleepUntil: _movedDeadline, ...settings } = originalSession.wakeConfig
    write(simulationSessionKey(sourceId), JSON.stringify({ ...originalSession, wakeConfig: { ...settings, mode: 'diving' } }))
    const knownKey = prefix + SIMULATION_KNOWN_GROUPS_KEY
    checks.set(knownKey, registerScheduledGroup(knownKey, await redis.get(knownKey), address))
  }
  return { checks: [...checks.values()], canMoveAgentCommitments, report: { enabled: enable, atOnly, activeUntil: boost || null, paused,
    dailyCostCny: budgetCap, maxTurnsPerDay: turnCap, carriedTurns: sourceTurns, carriedCostCny: costCny, recentWakeCount: wakeTimes.length, recentSendCount: sendTimes.length,
    ...(wakeConfig ? { wakeConfigTransferred: true, nextWakeAt: nextWakeAt ?? null } : {}) } }
}

function stricterCap(source: number, target: number): number {
  if (source <= 0) return target
  return target <= 0 ? source : Math.min(source, target)
}

async function stageCharacterTransfer(redis: Redis, prefix: string, binding: AgentBindingSnapshot,
  controls: Awaited<ReturnType<typeof stageSimulationControls>> | null, destination: SimulationSection, now: number) {
  const address = simulationAddressKey(binding.target)
  const { botId, scene } = personMemoryAddress(binding.target)
  const scope = { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id }
  const key = characterKey(scope)
  const destinationKey = prefix + key
  const markerKey = prefix + `agent:migration:qq-character:${encodeURIComponent(agentConversationKey(binding))}`
  const identity = agentBindingIdentity(binding)
  const locks = [simulationBusyKey(scene.id), simulationBusyKey(address), `${key}:lock`, `${destinationKey}:lock`]
  const sessionKey = prefix + simulationSessionKey(address)
  const knownKey = prefix + SIMULATION_KNOWN_GROUPS_KEY
  const [marker = null, source = null, target = null, session = null, known = null] =
    await redis.mGet([markerKey, key, destinationKey, sessionKey, knownKey])
  if (marker === identity) return null
  if (marker !== null) throw new Error('目标已有角色状态交接记录')
  if (source === null) return null
  if (await redis.exists(locks)) throw new Error('仿真群或角色仍有进行中的工作')
  const original = validateCharacterState(JSON.parse(source), scope)
  const next = projectCharacterTransfer(original, now)
  const already = target === null ? createEmptyCharacterState(scope) : validateCharacterState(JSON.parse(target), scope)
  const hasProjection = !!(next.memories.length || next.goals.length || next.receipts.length)
  if (!hasProjection && (!original.paused || already.paused)) {
    return { checks: [], report: { memories: 0, goals: 0, receipts: 0,
      retainedMemories: original.memories.length, retainedGoals: original.goals.length, pausedGoals: 0 } }
  }
  if (hasProjection && (already.memories.length || already.goals.length || already.receipts.length || already.decision)) {
    throw new Error('目标已有角色状态，迁移未覆盖')
  }
  const movedGoals = new Set(next.goals.map(goal => goal.id))
  const remaining = original.goals.map(goal => movedGoals.has(goal.id) && (goal.status === 'active' || goal.status === 'waiting' || goal.status === 'paused')
    ? { ...goal, status: 'abandoned' as const, revision: goal.revision + 1, updatedAt: Math.max(goal.updatedAt, now), lastOutcome: '目标已交接给独立宿主' }
    : goal)
  const targetWrite = validateCharacterState({ ...(hasProjection ? next : already), paused: already.paused || original.paused,
    revision: already.revision + 1 }, scope)
  const sourceCheck: Check = { key, value: source }
  if (remaining.some((goal, index) => goal !== original.goals[index])) {
    sourceCheck.write = JSON.stringify(validateCharacterState({ ...original, goals: remaining, revision: original.revision + 1 }, scope))
  }
  const checks: Check[] = [{ key: markerKey, value: null, write: identity }, sourceCheck,
    { key: destinationKey, value: target, write: JSON.stringify(targetWrite) }, ...locks.map(key => ({ key, value: null }))]
  if (next.goals.some(goal => ['active', 'waiting', 'paused'].includes(goal.status))) {
    const current = controls?.checks.find(check => check.key === sessionKey)?.write ?? session
    const token = agentBindingToken(binding)
    const sessionCheck: Check = { key: sessionKey, value: session }
    if (current === null) {
      const { agentPresetKeywords } = resolveSimulationGroupConfig(destination, null)
      const fresh = createDefaultSimSession(now, agentPresetKeywords)
      sessionCheck.write = JSON.stringify({ ...fresh, botId, personaId: scope.personaId, bindingToken: token, bootstrapSent: true })
    } else {
      const state = decodeSimulationSession(current, now)
      if (state.botId !== botId || state.bindingToken !== token || (state.personaId && state.personaId !== scope.personaId)) {
        throw new Error('目标仿真会话与迁移角色绑定不一致')
      }
    }
    checks.push(sessionCheck)
    checks.push(registerScheduledGroup(knownKey, known, address))
  }
  const memories = activeCharacterMemories(next).length
  return { checks, report: { memories, goals: next.goals.length, receipts: next.receipts.length,
    retainedMemories: original.memories.length - memories, retainedGoals: original.goals.length - next.goals.length,
    pausedGoals: next.goals.filter(goal => goal.status === 'paused').length } }
}

async function stageCharacterSchedule(
  redis: Redis, prefix: string, binding: AgentBindingSnapshot, now: number,
  controls: Awaited<ReturnType<typeof stageSimulationControls>> | null,
  character: Awaited<ReturnType<typeof stageCharacterTransfer>>,
  destination: SimulationSection,
) {
  const address = simulationAddressKey(binding.target)
  const { botId, scene } = personMemoryAddress(binding.target)
  const scope = { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id }
  const identity = agentBindingIdentity(binding)
  const marker = prefix + `agent:migration:qq-character-schedule:${encodeURIComponent(agentConversationKey(binding))}`
  const rhythmKey = simulationRhythmKey(scope)
  const reflectionKey = characterReflectionKey(scope)
  const sessionKey = prefix + simulationSessionKey(address)
  const knownKey = prefix + SIMULATION_KNOWN_GROUPS_KEY
  const [prior = null, rhythmRaw = null, reflectionRaw = null, targetRhythm = null, targetReflection = null] =
    await redis.mGet([marker, rhythmKey, reflectionKey, prefix + rhythmKey, prefix + reflectionKey])
  if (prior === identity) return null
  if (prior !== null) throw new Error('目标已有角色排期交接记录')
  let rhythm: ReturnType<typeof decodeSimulationRhythm> | undefined
  let reflection: ReturnType<typeof validateReflectionState> | undefined
  try {
    rhythm = rhythmRaw === null ? undefined : decodeSimulationRhythm(rhythmRaw)
    reflection = reflectionRaw === null ? undefined : validateReflectionState(JSON.parse(reflectionRaw))
  } catch { throw new Error('来源角色作息或反思排期无效，迁移未写入') }
  if (!rhythm && !reflection) return null
  if ((rhythm && targetRhythm !== null) || (reflection && targetReflection !== null)) {
    throw new Error('目标已有角色作息或反思排期，迁移未覆盖')
  }
  const roleKey = characterKey(scope)
  const locks = [simulationBusyKey(scene.id), simulationBusyKey(address), prefix + simulationBusyKey(address),
    `${roleKey}:lock`, `${prefix + roleKey}:lock`, `${reflectionKey}:lock`, `${prefix + reflectionKey}:lock`]
  if (await redis.exists(locks)) throw new Error('仿真群或角色仍有进行中的工作')
  const checks: Check[] = [{ key: marker, value: null, write: identity }, ...locks.map(key => ({ key, value: null }))]
  if (rhythm) {
    checks.push({ key: rhythmKey, value: rhythmRaw }, { key: prefix + rhythmKey, value: targetRhythm, write: JSON.stringify(rhythm) })
  }
  if (reflection) {
    checks.push({ key: reflectionKey, value: reflectionRaw }, { key: prefix + reflectionKey, value: targetReflection,
      write: JSON.stringify({ ...reflection, lastOutcome: '已接续原角色的反思排期' }) })
    const [rawSession = null, known = null] = await redis.mGet([sessionKey, knownKey])
    const prepared = character?.checks.find(check => check.key === sessionKey)?.write ??
      controls?.checks.find(check => check.key === sessionKey)?.write ?? rawSession
    const token = agentBindingToken(binding)
    if (prepared !== null) {
      const state = decodeSimulationSession(prepared, now)
      if (state.botId !== botId || state.bindingToken !== token || (state.personaId && state.personaId !== scope.personaId)) {
        throw new Error('目标仿真会话与迁移角色绑定不一致')
      }
      checks.push({ key: sessionKey, value: rawSession })
    } else {
      const { agentPresetKeywords } = resolveSimulationGroupConfig(destination, null, address)
      const fresh = createDefaultSimSession(now, agentPresetKeywords)
      checks.push({ key: sessionKey, value: rawSession,
        write: JSON.stringify({ ...fresh, botId, personaId: scope.personaId, bindingToken: token, bootstrapSent: true }) })
    }
    checks.push(registerScheduledGroup(knownKey, known, address))
  }
  return { checks, report: {
    ...(rhythm ? { rhythmTransferred: true } : {}),
    ...(reflection ? { reflectionTransferred: true, nextReflectionAt: reflection.nextRunAt,
      reflectionRunsToday: reflection.day === new Date(now).toISOString().slice(0, 10) ? reflection.runsToday : 0 } : {}),
  } }
}

async function stageCharacterWorkspaceTransfer(
  redis: Redis, prefix: string, binding: AgentBindingSnapshot, now: number, invalidatedAt: number, staged: ReadonlyMap<string, Check>,
) {
  const { botId, scene } = personMemoryAddress(binding.target)
  const scope = { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id }
  const workspaceKey = characterWorkspaceKey(scope)
  const destinationKey = prefix + workspaceKey
  const markerKey = prefix + `agent:migration:qq-workspace:${encodeURIComponent(agentConversationKey(binding))}`
  const identity = agentBindingIdentity(binding)
  const [marker = null, raw = null, target = null] = await redis.mGet([markerKey, workspaceKey, destinationKey])
  if (marker === identity) return null
  if (marker !== null) throw new Error('目标已有角色作品交接记录')
  if (raw === null) return null
  let source: ReturnType<typeof validateCharacterWorkspace>
  try { source = validateCharacterWorkspace(JSON.parse(raw), scope) }
  catch { throw new Error('来源角色作品空间无效，迁移未写入') }
  if (!source.works.length) return null

  const roleKey = characterKey(scope)
  const destinationRoleKey = prefix + roleKey
  const priorSourceRole = staged.get(roleKey)
  const sourceRole = priorSourceRole ? priorSourceRole.value : await redis.get(roleKey)
  const priorTargetRole = staged.get(destinationRoleKey)
  const targetRole = priorTargetRole ? priorTargetRole.value : await redis.get(destinationRoleKey)
  const targetRoleWrite = priorTargetRole?.write ?? targetRole
  let evidence: ReadonlySet<string> = new Set()
  if (sourceRole !== null && targetRoleWrite !== null) {
    const original = validateCharacterState(JSON.parse(sourceRole), scope)
    const sourceView = characterMemoryVisibility(original, invalidatedAt)
    const targetView = characterMemoryVisibility(validateCharacterState(JSON.parse(targetRoleWrite), scope), invalidatedAt)
    // If a previous deployment already moved the role, the target's
    // matching durable sources must still agree with its transfer projection.
    const projectedView = priorTargetRole?.write === undefined
      ? characterMemoryVisibility(projectCharacterTransfer(original, now), invalidatedAt)
      : targetView
    const memories = new Map(projectedView.memories.map(memory => [memory.id, JSON.stringify(memory)]))
    const activeMemoryIds = new Set(sourceView.memories.map(memory => memory.id))
    const receipts = new Map(projectedView.receipts.map(receipt => [receipt.id, JSON.stringify(receipt)]))
    const visibleReceiptIds = new Set(sourceView.receipts.filter(receipt => receipt.status !== 'pending').map(receipt => receipt.id))
    evidence = new Set([
      ...targetView.memories.filter(memory => activeMemoryIds.has(memory.id) && memories.get(memory.id) === JSON.stringify(memory))
        .map(memory => `memory:${memory.id}`),
      ...targetView.receipts.filter(receipt => visibleReceiptIds.has(receipt.id) && receipts.get(receipt.id) === JSON.stringify(receipt))
        .map(receipt => `receipt:${receipt.id}`),
    ])
  }
  const next = projectCharacterWorkspace(source, evidence)
  const versions = next.works.reduce((count, item) => count + item.versions.length, 0)
  const report = { works: next.works.length, versions, retainedWorks: source.works.length - next.works.length,
    retainedVersions: source.works.reduce((count, item) => count + item.versions.length, 0) - versions }
  if (!versions) return { checks: [], report }
  if (target !== null) throw new Error('目标已有角色作品，迁移未覆盖')
  const address = simulationAddressKey(binding.target)
  const locks = [simulationBusyKey(scene.id), simulationBusyKey(address), prefix + simulationBusyKey(address),
    `${roleKey}:lock`, `${destinationRoleKey}:lock`, `${workspaceKey}:lock`, `${destinationKey}:lock`]
  if (await redis.exists(locks)) throw new Error('仿真群、角色或作品仍有进行中的工作')

  const checks: Check[] = [
    { key: roleKey, value: sourceRole }, { key: destinationRoleKey, value: targetRole },
    { key: workspaceKey, value: raw }, { key: destinationKey, value: null, write: JSON.stringify(validateCharacterWorkspace(next, scope)) },
    { key: markerKey, value: null, write: identity },
    ...locks.map(key => ({ key, value: null })),
  ]
  return { checks, report }
}

async function stageConversationMemories(redis: Redis, prefix: string, binding: AgentBindingSnapshot, now: number) {
  const key = simulationNotebookKey(binding)
  const group = binding.target.kind === 'group'
  const [original, existing] = group ? await Promise.all([redis.get(key), redis.get(prefix + key)]) : [null, null]
  const checks = new Map<string, Check>()
  let entries: unknown
  try { entries = original === null ? [] : JSON.parse(original) } catch { throw new Error('源仿真群笔记分区损坏') }
  if (!Array.isArray(entries)) throw new Error('源仿真群笔记分区损坏')
  const { botId, scene } = personMemoryAddress(binding.target)
  const identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
  const seen = new Set<string>()
  const candidates = entries.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
        !validTimestamp(entry.createdAt) || typeof entry.content !== 'string' || !entry.content.trim() ||
        !['note', 'meme', 'impression', 'pendingEvent', 'activeTopic', 'interaction'].includes(entry.kind)) {
      throw new Error('源仿真群笔记含无效或重复记录')
    }
    seen.add(entry.id)
    const note = normalizeSimMemoryEntry(entry, now)
    if (!note || (entry.kind === 'pendingEvent' && (!note.dueAt || (entry.proactiveSourceSeq && !note.memorySource))) ||
        (entry.kind === 'activeTopic' && (!entry.expiresAt || entry.expiresAt <= now)) ||
        ((entry.memorySource || entry.memoryIdentity || entry.personMemoryId || entry.aboutUser) &&
          (!note.memorySource || !note.personMemoryId || note.aboutUser !== entry.aboutUser ||
           note.memoryIdentity?.botId !== identity.botId || note.memoryIdentity?.personaId !== identity.personaId))) return []
    // Old ingress sequence numbers cannot authorize follow-ups in a new session.
    delete note.proactiveSourceSeq
    return [note]
  })
  if (group) {
    checks.set(key, { key, value: original })
    checks.set(prefix + key, { key: prefix + key, value: existing })
  }
  const lookup = async (name: string) => {
    const prior = checks.get(name)
    if (prior) return prior.value
    const value = await redis.get(name)
    checks.set(name, { key: name, value })
    return value
  }
  const side = (base: string) => ({
    get: (name: string) => lookup(base + name),
    stage(name: string, write: string | null) {
      const check = checks.get(base + name)
      if (!check) throw new Error('人物记忆迁移缺少目标快照')
      check.write = write
    },
  })
  const { notes: moved, facts, invalidatedAt } = await stagePersonMemoryForScene({ identity, scene,
    notes: candidates, now, source: side(''), destination: side(prefix) })
  if (moved.length) {
    if (existing !== null) throw new Error('目标已有仿真群笔记分区，迁移未覆盖')
    const ids = new Set(moved.map(note => note.id))
    const remaining = entries.filter(entry => !ids.has(entry.id))
    checks.set(prefix + key, { key: prefix + key, value: existing, write: JSON.stringify(moved) })
    checks.set(key, { key, value: original, write: remaining.length ? JSON.stringify(remaining) : null })
  }
  return { moved: moved.length, retained: entries.length - moved.length, facts, invalidatedAt, checks }
}

function convertReminder(raw: string, item: ReminderPending, binding: AgentBindingSnapshot, skipped: Skipped): CommitmentData | undefined {
  let reminder: ReminderData
  let persisted: Record<string, unknown>
  try {
    reminder = decodeReminder(raw)
    persisted = JSON.parse(raw) as Record<string, unknown>
  } catch { skipped.unavailable++; return }

  const { target } = binding
  const groupId = target.kind === 'group' ? target.id : null
  if (reminder.group_id !== groupId || (groupId === null && reminder.user_id !== target.id)) return
  if (reminder.bot_id && reminder.bot_id !== target.account.id) return
  if (!reminder.bot_id || !reminder.bindingIdentity) { skipped.unscoped++; return }
  if (reminder.bindingIdentity !== agentBindingIdentity(binding)) { skipped.binding++; return }
  if (reminder.status === 'sending' || reminder.status === 'unknown' || reminder.extra_attempted ||
      (persisted.delivery != null && reminder.delivery?.state !== 'failed')) { skipped.inFlight++; return }
  if (persisted.extra_action != null) { skipped.unsupported++; return }
  if (reminder.id !== item.id || reminder.status !== 'pending' || reminder.trigger_time !== item.trigger_time ||
      !validTimestamp(item.trigger_time) || qqId(reminder.user_id) !== reminder.user_id ||
      !Number.isInteger(reminder.retry_count) || reminder.retry_count < 0 || reminder.retry_count >= 3) {
    skipped.unavailable++
    return
  }
  const text = reminderText(reminder)
  if (!sanitizeFinalReplyText(text)) { skipped.unsupported++; return }
  return {
    id: reminder.id, scope: binding, bindingIdentity: reminder.bindingIdentity, group_id: groupId ?? '', bot_id: target.account.id,
    creator_id: reminder.user_id, creator_name: reminder.user_id, intent: reminder.content, static_message: text, importedReminder: true,
    schedule: { kind: 'once', time: item.trigger_time }, deliver: 'static', expiry_at: 0, next_run_at: item.trigger_time,
    status: 'active', last_run_at: 0, last_result: '', retry_count: reminder.retry_count, created_at: reminder.created_at, revision: 1,
  }
}

// Check both ledgers and every source/destination value before doing any writes.
const transfer = `
if redis.acl_check_cmd then
  for i, key in ipairs(KEYS) do
    local j = (i - 1) * 4
    if ARGV[j+3] == 'delete' and not redis.acl_check_cmd('DEL', key) then return -1 end
    if ARGV[j+3] == 'set' and not redis.acl_check_cmd('SET', key, ARGV[j+4]) then return -1 end
  end
end
for i, key in ipairs(KEYS) do
  local j = (i - 1) * 4
  if ARGV[j+1] == 'missing' then
    if redis.call('EXISTS', key) ~= 0 then return 0 end
  elseif redis.call('GET', key) ~= ARGV[j+2] then return 0 end
end
for i, key in ipairs(KEYS) do
  local j = (i - 1) * 4
  if ARGV[j+3] == 'delete' then redis.call('DEL', key)
  elseif ARGV[j+3] == 'set' then redis.call('SET', key, ARGV[j+4]) end
end
return 1`

async function migrateStandaloneQqState(options: {
  redis: Redis
  instance: string
  binding: AgentBindingSnapshot
  sourceBinding: AgentBindingSnapshot
  sourceSimulation: SimulationSection
  destinationSimulation: SimulationSection
  sourceDataDir: string
  isCurrent(): boolean
  allowsReminders: boolean
  targetUsesSimulation: boolean
  moveAgentCommitments: boolean
  moveCharacterState: boolean
  moveGroupTeaching?: boolean
  archive?: { sourceArchiveDir: string; history: AgentHistoryConfig; allowsText(text: string): boolean }
  deferredReminders?: readonly LegacyDeferredReminderSelection[]
  apply: boolean
}) {
  const { redis, binding } = options
  const group = binding.target.kind === 'group'
  if (options.moveGroupTeaching && !group) throw new Error('群教学迁移只用于群会话')
  const prefix = agentRedisPrefix(options.instance)
  const scopeKey = agentConversationKey(binding)
  const addressKey = conversationAddressKey(binding.target)
  const identity = agentBindingIdentity(binding)
  const memoryKey = delegatedMemoryStorageKey(binding)
  const lease = `${prefix}agent:host-lease`
  const idleKeys = [lease, REMINDER_LOCK_KEY, prefix + COMMITMENT_LOCK_KEY, ...(group ? [COMMITMENT_LOCK_KEY] : [])]
  if (await redis.exists(idleKeys)) throw new Error('迁移要求停止独立宿主并等待承诺账本解锁')
  const destinationPendingKey = prefix + COMMITMENT_PENDING_KEY
  const [sourceMemory, destinationMemory, sourceIndex, destinationIndex, reminderIndex] = await Promise.all([
    group ? redis.get(memoryKey) : null, group ? redis.get(prefix + memoryKey) : null,
    group ? redis.get(COMMITMENT_PENDING_KEY) : null, redis.get(destinationPendingKey), redis.get(REMINDER_PENDING_KEY),
  ])
  if (!options.isCurrent()) throw new Error('来源或目标的迁移配置及角色绑定已改变')
  const now = Date.now()
  const controls = group ? await stageSimulationControls(redis, prefix, binding, options.sourceBinding, options.sourceSimulation,
    options.destinationSimulation, options.sourceDataDir, now, options.targetUsesSimulation, options.moveCharacterState) : null
  const character = options.moveCharacterState ? await stageCharacterTransfer(redis, prefix, binding, controls, options.destinationSimulation, now) : null
  const characterSchedule = options.moveCharacterState
    ? await stageCharacterSchedule(redis, prefix, binding, now, controls, character, options.destinationSimulation) : null
  const initialPrompt = options.moveCharacterState
    ? await stageInitialPromptTransfer(redis, prefix, binding, options.sourceBinding, now) : null
  const memory = await stageConversationMemories(redis, prefix, binding, now)
  const staged = new Map<string, Check>()
  appendTransferChecks(staged, idleKeys.map(key => ({ key, value: null })))
  if (controls) appendTransferChecks(staged, controls.checks)
  if (character) appendTransferChecks(staged, character.checks)
  if (characterSchedule) appendTransferChecks(staged, characterSchedule.checks)
  if (initialPrompt) appendTransferChecks(staged, initialPrompt.checks)
  const characterWorkspace = options.moveCharacterState
    ? await stageCharacterWorkspaceTransfer(redis, prefix, binding, now, memory.invalidatedAt, staged) : null
  if (characterWorkspace) appendTransferChecks(staged, characterWorkspace.checks)
  const report = { delegatedMemories: 0, commitments: 0, agentCommitments: 0, reminders: 0, groupNotes: 0, retainedGroupNotes: 0, personFacts: 0,
    ...(controls?.report ? { simulationControls: controls.report } : {}),
    ...(character ? { characterState: character.report } : {}),
    ...(characterSchedule ? { characterSchedule: characterSchedule.report } : {}),
    ...(initialPrompt ? { initialPrompt: initialPrompt.report } : {}),
    ...(characterWorkspace ? { characterWorkspace: characterWorkspace.report } : {}),
    skipped: { unscoped: 0, binding: 0, inFlight: 0, unsupported: 0, unavailable: 0 } }
  const checks: Check[] = []
  const sourceRemovals: Check[] = []
  if (sourceMemory !== null) {
    if (destinationMemory !== null) throw new Error('目标已有委托记忆分区，迁移未覆盖')
    let entries: unknown
    try { entries = JSON.parse(sourceMemory) } catch { throw new Error('源委托记忆分区损坏') }
    const normalized = Array.isArray(entries) ? normalizeDelegatedEntries(entries, now) : []
    if (!Array.isArray(entries) || normalized.length !== entries.length || normalized.some(entry => qqId(entry.owner) !== entry.owner) ||
        new Set(normalized.map(entry => entry.id)).size !== normalized.length) throw new Error('源委托记忆分区损坏')
    report.delegatedMemories = entries.length
    checks.push({ key: prefix + memoryKey, value: null, write: sourceMemory })
    sourceRemovals.push({ key: memoryKey, value: sourceMemory, write: null })
  }

  report.groupNotes = memory.moved
  report.retainedGroupNotes = memory.retained
  report.personFacts = memory.facts
  for (const check of memory.checks.values()) {
    if (check.write !== undefined && !check.key.startsWith(prefix)) sourceRemovals.push(check)
    else checks.push(check)
  }

  let pending: ReturnType<typeof decodeCommitmentPendingList>
  let destinationPending: typeof pending
  let reminders: ReminderPending[]
  try {
    pending = decodeCommitmentPendingList(sourceIndex)
    destinationPending = decodeCommitmentPendingList(destinationIndex)
    if (options.deferredReminders !== undefined && destinationIndex !== null) destinationPending = JSON.parse(destinationIndex) as typeof pending
    reminders = decodeReminderPendingList(reminderIndex)
  } catch { throw new Error('来源或目标的提醒或承诺索引损坏') }
  if (new Set(pending.map(item => item.id)).size !== pending.length ||
      new Set(destinationPending.map(item => item.id)).size !== destinationPending.length ||
      new Set(reminders.map(item => item.id)).size !== reminders.length) throw new Error('提醒或承诺索引含有重复记录')
  const destinationIds = new Set(destinationPending.map(item => item.id))
  async function moveTask(id: string, due: number, sourceKey: string, before: string, after: string): Promise<void> {
    const destinationKey = prefix + commitmentDetailKey(id)
    if (destinationIds.has(id) || await redis.exists(destinationKey)) throw new Error('目标已有相同承诺或提醒编号，迁移未覆盖')
    checks.push({ key: destinationKey, value: null, write: after })
    sourceRemovals.push({ key: sourceKey, value: before, write: null })
    destinationIds.add(id)
    destinationPending.push({ id, next_run_at: due })
  }
  const moved = new Set<string>()
  const detailValues = pending.length ? await redis.mGet(pending.map(item => commitmentDetailKey(item.id))) : []
  for (const [index, item] of pending.entries()) {
    const detail = commitmentDetailKey(item.id)
    const raw = detailValues[index]
    if (!raw) { report.skipped.unavailable++; continue }
    let task: CommitmentData
    let delivery: unknown
    try { task = decodeCommitment(raw); delivery = JSON.parse(raw).deliver } catch { report.skipped.unavailable++; continue }
    if (!task.scope) {
      if (task.group_id === binding.target.id && (!task.bot_id || task.bot_id === binding.target.account.id)) report.skipped.unscoped++
      continue
    }
    if (conversationAddressKey(task.scope.target) !== addressKey) continue
    if (agentConversationKey(task.scope) !== scopeKey || task.bindingIdentity !== identity) { report.skipped.binding++; continue }
    if (task.run_id || task.execution_state) { report.skipped.inFlight++; continue }
    const due = task.next_run_at
    const validSchedule = task.schedule.kind === 'daily' ? computeNextDailyRun(task.schedule.time, now) !== null : validTimestamp(task.schedule.time)
    if (task.status !== 'active' || task.id !== item.id || !validTimestamp(due) ||
        due !== item.next_run_at || !validSchedule || qqId(task.creator_id) !== task.creator_id ||
        (task.expiry_at !== 0 && (!validTimestamp(task.expiry_at) || task.expiry_at <= now))) { report.skipped.unavailable++; continue }
    const eligibleAgent = options.moveAgentCommitments && controls?.canMoveAgentCommitments === true && delivery === 'agent' && !!task.intent.trim()
    const eligibleStatic = task.deliver === 'static' && !!task.static_message?.trim()
    if (!options.allowsReminders || (!eligibleAgent && !eligibleStatic)) {
      report.skipped.unsupported++
      continue
    }
    await moveTask(task.id, item.next_run_at, detail, raw, raw)
    if (eligibleAgent) report.agentCommitments++
    moved.add(task.id)
  }
  report.commitments = moved.size
  if (moved.size > 0) {
    checks.push({ key: COMMITMENT_PENDING_KEY, value: sourceIndex, write: JSON.stringify(pending.filter(item => !moved.has(item.id))) })
  }

  const movedReminders = new Set<string>()
  const deferredIds = new Set(options.deferredReminders?.map(item => item.id))
  const reminderValues = reminders.length ? await redis.mGet(reminders.map(item => reminderDetailKey(item.id))) : []
  for (const [index, item] of reminders.entries()) {
    // Explicit extra-action selections cannot fall through into ordinary reminder conversion.
    if (deferredIds.has(item.id)) continue
    const raw = reminderValues[index]
    if (!raw) { report.skipped.unavailable++; continue }
    const task = convertReminder(raw, item, binding, report.skipped)
    if (!task) continue
    if (!options.allowsReminders) { report.skipped.unsupported++; continue }
    await moveTask(task.id, task.next_run_at, reminderDetailKey(task.id), raw, encodeCommitment(task))
    movedReminders.add(task.id)
  }
  report.reminders = movedReminders.size
  if (movedReminders.size > 0) {
    const original = options.deferredReminders !== undefined && reminderIndex !== null ? JSON.parse(reminderIndex) as ReminderPending[] : reminders
    checks.push({ key: REMINDER_PENDING_KEY, value: reminderIndex, write: JSON.stringify(original.filter(item => !movedReminders.has(item.id))) })
  }
  if (moved.size || movedReminders.size) {
    destinationPending.sort((a, b) => a.next_run_at - b.next_run_at)
    checks.push({ key: destinationPendingKey, value: destinationIndex, write: JSON.stringify(destinationPending) })
  }

  if (!options.isCurrent()) throw new Error('来源或目标的迁移配置及角色绑定已改变')
  checks.push(...sourceRemovals)
  appendTransferChecks(staged, checks)
  const deferred = options.deferredReminders === undefined ? undefined : await stageLegacyDeferredReminders({
    async read(key) {
      const previous = staged.get(key)
      return previous ? previous.write === undefined ? previous.value : previous.write : redis.get(key)
    }, sourceIndexKey: REMINDER_PENDING_KEY, destinationIndexKey: destinationPendingKey,
    sourceDetailKey: reminderDetailKey, destinationDetailKey: id => prefix + commitmentDetailKey(id),
    sourceBinding: options.sourceBinding, binding,
    // Disabled or text/private destinations can archive terminal/frozen records, but cannot activate extra actions.
    destinationMode: !group ? 'private' : options.targetUsesSimulation && options.allowsReminders && controls?.canMoveAgentCommitments === true ? 'simulation' : 'text',
    selections: options.deferredReminders, idleKeys, now, isCurrent: options.isCurrent,
  })
  if (deferred) appendSequentialTransferChecks(staged, deferred.checks)
  const teaching = options.moveGroupTeaching ? await stageStandaloneGroupTeaching({ redis, prefix, binding,
    sourceDataDir: options.sourceDataDir, now, checks: staged }) : undefined
  const archive = options.archive ? await stageStandaloneAgentArchiveMigration({ redis, prefix, binding, sourceBinding: options.sourceBinding,
    sourceArchiveDir: options.archive.sourceArchiveDir, history: options.archive.history, now, checks: staged,
    isCurrent: options.isCurrent, allowsText: options.archive.allowsText }) : undefined
  if (!options.isCurrent() || teaching?.isCurrent() === false || archive?.isCurrent() === false) throw new Error('迁移期间来源配置或归档有变更，迁移未写入')
  const transferChecks = [...staged.values()]
  if (options.apply && transferChecks.some(check => check.write !== undefined)) {
    if (controls && dayKey(Date.now()) !== dayKey(now)) throw new Error('迁移期间跨过预算日期，请重新预览')
    const args = transferChecks.flatMap(({ value, write }) => [value === null ? 'missing' : 'value', value ?? '',
      write === undefined ? 'keep' : write === null ? 'delete' : 'set', write ?? ''])
    const result = Number(await redis.eval(transfer, { keys: transferChecks.map(check => check.key), arguments: args }))
    if (result === -1) throw new Error('Redis 账号缺少迁移所需的账本写入权限')
    if (result !== 1) throw new Error(changeError)
  }
  return { ...report, ...(teaching ? { groupTeaching: teaching.report } : {}), ...(deferred ? { deferredReminders: deferred.report } : {}),
    ...(archive ? { messageArchive: archive.report } : {}) }
}

export async function runStandaloneQqMigration(config: ReturnType<typeof readStandaloneAgentConfig>, options: {
  sourceBindings: string
  sourceConfig?: string
  sourceDataDir?: string
  moveAgentCommitments?: boolean
  moveCharacterState?: boolean
  moveGroupTeaching?: boolean
  moveMessageArchive?: boolean
  sourceArchiveDir?: string
  /** Explicit per-record tool mapping and host-issued migration grant; omitted records remain in the old ledger. */
  deferredReminders?: readonly LegacyDeferredReminderSelection[]
  connectionId: string
  kind: 'group' | 'private'
  conversationId: string
  apply: boolean
}) {
  validateMigrationOptions(options)
  const deferredReminders = deferredReminderSelections(options)
  const deferredSelectionSnapshot = JSON.stringify(deferredReminders)
  const { connectionId, kind, conversationId, apply } = options
  const connection = config.connections.find(({ connection }) => connection.id === connectionId)?.connection
  if (!connection || qqId(conversationId) !== conversationId) throw new Error('迁移需要当前宿主的连接 ID 和有效群号或好友 QQ 号')
  if (kind === 'private' && !config.privateChatEnabled) throw new Error('迁移好友会话前须启用目标宿主的 privateChat')
  const target: ConversationAddress = { account: connection.account, kind, id: conversationId }
  const targetUsesSimulation = kind === 'group'
  if (options.moveGroupTeaching && (kind !== 'group' || config.groupMemory.enabled !== true)) {
    throw new Error('群教学迁移只用于已启用 groupMemory 的群会话')
  }
  if (options.moveMessageArchive && config.history.enabled !== true) throw new Error('旧原文归档接续需要目标 history.enabled=true')
  if (options.moveAgentCommitments && !targetUsesSimulation) {
    throw new Error('仿真承诺只能迁到使用仿真模式的群')
  }
  if (options.moveCharacterState && !targetUsesSimulation) {
    throw new Error('角色状态只能迁到使用仿真模式的群')
  }
  const source = createAgentBindingConfig(path.resolve(options.sourceBindings), validateQqBindingAddress)
  const old = source()?.resolve(target)
  const binding = config.resolvePersona(target)?.binding
  if (!old || !binding || old.connectionId !== connectionId || agentBindingIdentity(old) !== agentBindingIdentity(binding)) {
    throw new Error('来源和目标必须显式绑定到同一 QQ 账号、会话、连接、角色及人设')
  }
  const sourceToken = agentBindingToken(old)
  const destinationToken = agentBindingToken(binding)
  const sourceConfigPath = path.resolve(options.sourceConfig ?? path.join(path.dirname(options.sourceBindings), 'message.yaml'))
  const sourceSimulation = kind === 'group' ? readSimulationConfig(sourceConfigPath, options.sourceConfig === undefined) : { raw: null, section: {} }
  const sourceArchiveConfigRaw = options.moveMessageArchive
    ? kind === 'group' ? sourceSimulation.raw : readSourceConfigRaw(sourceConfigPath, options.sourceConfig === undefined) : undefined
  const sourceDataDir = path.resolve(options.sourceDataDir ?? path.join(path.dirname(sourceConfigPath), '..', 'data'))
  let sourceArchiveDir: string | undefined
  if (options.moveMessageArchive) {
    const document: unknown = sourceArchiveConfigRaw == null ? {} : YAML.parse(sourceArchiveConfigRaw)
    const settings = document && typeof document === 'object' && !Array.isArray(document) ? (document as Record<string, unknown>).pluginSettings : undefined
    const archive = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>).messageArchive : undefined
    if (archive !== undefined && (!archive || typeof archive !== 'object' || Array.isArray(archive))) throw new Error('旧原文归档配置无效')
    const directory = archive === undefined ? undefined : (archive as Record<string, unknown>).baseDir
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim() || /[\u0000-\u001f\u007f]/u.test(directory))) throw new Error('旧原文归档目录配置无效')
    sourceArchiveDir = options.sourceArchiveDir === undefined ? path.resolve(path.dirname(sourceConfigPath), '..', directory as string ?? 'data/message_archive')
      : path.resolve(options.sourceArchiveDir)
  }
  const words = createForbiddenWordGuard({ warn() {} })
  const redis = await connectAgentRedis(config.redisUrl)
  try {
    const report = await migrateStandaloneQqState({
      redis, instance: config.instance, binding, sourceBinding: old,
      sourceSimulation: sourceSimulation.section, destinationSimulation: config.simulation, sourceDataDir,
      apply, targetUsesSimulation, allowsReminders: config.simulation.enabled !== false, moveAgentCommitments: options.moveAgentCommitments === true,
      moveCharacterState: options.moveCharacterState === true,
      moveGroupTeaching: options.moveGroupTeaching === true,
      ...(sourceArchiveDir ? { archive: { sourceArchiveDir, history: config.history, allowsText: (text: string) => !words.findForbiddenWord(text, config.forbiddenWords) } } : {}),
      ...(deferredReminders === undefined ? {} : { deferredReminders }),
      isCurrent() {
        const from = source()?.resolve(target)
        const to = config.resolvePersona(target)?.binding
        return config.isConfigCurrent() && !!from && !!to && agentBindingToken(from) === sourceToken && agentBindingToken(to) === destinationToken &&
          JSON.stringify(deferredReminderSelections(options)) === deferredSelectionSnapshot &&
          (kind === 'group' ? readSimulationConfig(sourceConfigPath, options.sourceConfig === undefined).raw === sourceSimulation.raw
            : sourceArchiveConfigRaw === undefined || readSourceConfigRaw(sourceConfigPath, options.sourceConfig === undefined) === sourceArchiveConfigRaw)
      },
    })
    return { mode: apply ? 'applied' : 'preview', instance: config.instance, connectionId,
      ...(kind === 'group' ? { groupId: conversationId } : { friendId: conversationId }), ...report }
  } finally {
    await redis.close()
  }
}
