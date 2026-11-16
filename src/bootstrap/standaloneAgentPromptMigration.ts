import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import { agentBindingIdentity, agentBindingToken, agentConversationKey, agentPersonaScopeId } from '../modules/runtime/domain/agentBindings.js'
import { isQqSimulationAddress, simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import { encodeInitialPromptApplication, simulationInitialPromptApplicationKey, simulationInitialPromptKey, SIM_INITIAL_PROMPT_MAX_CHARS } from '../modules/simulation/infrastructure/simInitialPrompt.js'
import { decodeSimulationSession, simulationBusyKey, simulationSessionKey } from '../modules/simulation/infrastructure/simSessionStore.js'

type Check = { key: string; value: string | null; write?: string | null }
type PromptTransferReport =
  | { status: 'copied'; firstModelCall: boolean }
  | { status: 'retained'; reason: 'ambiguousSource' | 'unprovenBinding' }
  | { status: 'alreadyCopied' }

export async function stageInitialPromptTransfer(
  redis: { mGet(keys: string[]): Promise<(string | null)[]> },
  prefix: string, binding: AgentBindingSnapshot, sourceBinding: AgentBindingSnapshot, now: number,
): Promise<{ checks: Check[]; report: PromptTransferReport } | null> {
  const identity = agentBindingIdentity(binding)
  if (binding.source !== 'configured' || sourceBinding.source !== 'configured' || !isQqSimulationAddress(binding.target) ||
      identity !== agentBindingIdentity(sourceBinding) || agentConversationKey(binding) !== agentConversationKey(sourceBinding)) {
    throw new Error('初始提示词需要同一 QQ 群角色绑定')
  }
  const { id: groupId, account } = binding.target
  const address = simulationAddressKey(binding.target)
  const sourceKeys = [simulationSessionKey(groupId), simulationSessionKey(address),
    simulationInitialPromptKey(groupId), simulationInitialPromptKey(address)]
  const targetPromptKey = prefix + simulationInitialPromptKey(address)
  const targetApplicationKey = prefix + simulationInitialPromptApplicationKey(address)
  const markerKey = prefix + `agent:migration:qq-init:${encodeURIComponent(agentConversationKey(binding))}`
  const [legacyRaw, scopedRaw, legacyPrompt, scopedPrompt, targetPrompt, targetApplication, marker] =
    await redis.mGet([...sourceKeys, targetPromptKey, targetApplicationKey, markerKey])
  if (marker === identity) return { checks: [], report: { status: 'alreadyCopied' } }
  if (marker != null) throw new Error('目标已有仿真初始提示词交接记录')
  if (!legacyPrompt?.trim() && !scopedPrompt?.trim()) return null

  const retained = (reason: 'ambiguousSource' | 'unprovenBinding') => ({ checks: [], report: { status: 'retained' as const, reason } })
  let legacy, scoped
  try {
    legacy = legacyRaw == null ? null : decodeSimulationSession(legacyRaw, now)
    scoped = scopedRaw == null ? null : decodeSimulationSession(scopedRaw, now)
  } catch { return retained('unprovenBinding') }
  const useLegacy = legacy?.botId === account.id
  if (useLegacy && scopedPrompt?.trim() && scopedPrompt !== legacyPrompt) return retained('ambiguousSource')
  const sourcePrompt = useLegacy ? legacyPrompt : scopedPrompt
  const sourceSession = useLegacy ? legacy : scoped
  const sourceRaw = useLegacy ? legacyRaw : scopedRaw
  if (!sourcePrompt?.trim() || sourceRaw == null || sourceSession?.botId !== account.id ||
      sourceSession.personaId !== agentPersonaScopeId(binding.agentId) ||
      sourceSession.bindingToken !== agentBindingToken(sourceBinding)) return retained('unprovenBinding')
  if (targetPrompt != null || targetApplication != null) throw new Error('目标已有仿真初始提示词，迁移未覆盖')

  // Old state does not record delivery. Only explicit empty-session facts prove it has never run.
  const original = JSON.parse(sourceRaw) as { bootstrapSent?: unknown; seq?: unknown; lastWakeAt?: unknown; wakeConfig?: { sleepUntil?: unknown } }
  const firstModelCall = original.bootstrapSent === false && original.seq === 0 && original.lastWakeAt === 0 &&
    original.wakeConfig?.sleepUntil === undefined && sourceSession.lastWakeReason === null && !sourceSession.queuedIngressWake &&
    sourceSession.wakeTimes.length === 0 && sourceSession.agentHistory.length === 0 && sourceSession.pendingWakeReasons.length === 0
  const values = [legacyRaw, scopedRaw, legacyPrompt, scopedPrompt]
  const checks: Check[] = [
    ...sourceKeys.map((key, index) => ({ key, value: values[index] ?? null })),
    { key: simulationBusyKey(useLegacy ? groupId : address), value: null },
    { key: prefix + simulationBusyKey(address), value: null },
    { key: targetPromptKey, value: null, write: sourcePrompt.slice(0, SIM_INITIAL_PROMPT_MAX_CHARS) },
    { key: targetApplicationKey, value: null, write: encodeInitialPromptApplication(binding, firstModelCall) },
    { key: markerKey, value: null, write: identity },
  ]
  return { checks, report: { status: 'copied', firstModelCall } }
}
