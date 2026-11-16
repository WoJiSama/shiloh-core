import { createHash } from 'node:crypto'
import type { AgentFileBytes, AgentFileListing, AgentFileRequest } from '../contracts/agentFiles.js'
import type { AgentFileUpload, FileDeliveryReceipt } from '../contracts/agentFileDelivery.js'
import type { AgentAudioBytes, AgentVideoBytes, SendMediaAction } from '../contracts/agentMedia.js'
import type { AgentMusicCard } from '../contracts/agentMusic.js'
import type { AgentAudioAttachment, AgentMusicExtractionConfig } from '../contracts/agentMusicExtraction.js'
import type { AgentMediaRelayConfig, AgentMediaRelayProvider, AgentMediaShare } from '../contracts/agentMediaRelayWorkflow.js'
import type { AgentMediaRelayPlan } from '../contracts/agentMediaRelay.js'
import type { AgentTorrentConfig, AgentTorrentProvider, SendRequesterArchiveAction } from '../contracts/agentTorrent.js'
import { validateAgentTorrentArchive, validateAgentTorrentConfig } from '../modules/media/domain/agentTorrent.js'
import { createAgentTorrentWorkflow, type AgentTorrentWorkflowContext, type AgentTorrentSource } from '../modules/media/infrastructure/agentTorrentWorkflow.js'
import { validateAgentMediaRelayPlan } from '../modules/media/domain/agentMediaRelayPlan.js'
import { validateAgentMediaRelayConfig } from '../modules/media/domain/agentMediaRelayConfig.js'
import { validateAgentMediaShare } from '../modules/media/infrastructure/agentMediaRelayReference.js'
import { sanitizeAgentXiaohongshuShareText } from '../modules/media/infrastructure/agentXiaohongshuRelayReference.js'
import { createAgentMediaOutbox, type AgentMediaOutboxContext } from '../modules/media/infrastructure/agentMediaOutbox.js'
import type { AgentMediaOutboxRecord } from '../modules/media/infrastructure/agentMediaOutboxLedger.js'
import { validateAgentAudioAttachment } from '../modules/media/infrastructure/agentAudioAttachment.js'
import { createAgentMusicExtraction, type MusicExtractionProvider } from '../modules/media/infrastructure/agentMusicExtraction.js'
import { isPersonMemoryRedacted } from '../modules/memory/domain/personMemory.js'
import { validateAgentMusicCard } from '../modules/media/infrastructure/agentMusicCard.js'
import type { AgentToolContext } from '../contracts/agentTool.js'
import { validateAgentMedia } from '../modules/media/infrastructure/agentMediaBytes.js'
import { validateAgentFileUpload, normalizeFileDeliveryReceipt, agentFileUploadText } from '../modules/messaging/infrastructure/agentFileDelivery.js'
import { readAgentPublicFile } from '../modules/tools/infrastructure/agentPublicWeb.js'
import { validateAgentFileBytes } from '../modules/content/infrastructure/agentFileBytes.js'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../contracts/agentBinding.js'
import type { ConversationMember, ConversationMemberSnapshot, ConversationMembersSnapshot, PlatformConnectionAdapter, PlatformConversationEvent } from '../contracts/platformConnection.js'
import type { IncomingMessage, MessageActionPort, MessageBundleItem } from '../contracts/platformMessage.js'
import type { AgentToolRegistry, AgentToolMessage, AgentToolRequest } from '../contracts/agentTool.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import { normalizeDeliveryReceipt } from '../modules/messaging/domain/deliveryReceipt.js'
import type { TextPersonMemoryConfig } from '../contracts/textPersonMemory.js'
import type { ConversationSummaryModel, MidtermMemoryConfig, EpisodicMemoryConfig } from '../contracts/conversationMemory.js'
import type { GroupMemoryConfig, GroupMemoryModel } from '../contracts/groupMemory.js'
import type { AgentSemanticMemoryConfig, AgentSemanticMemoryBackend } from '../contracts/semanticMemory.js'
import type { AgentHistoryConfig, AgentHistoryRequestSource } from '../contracts/agentHistory.js'
import { createAgentHistory } from '../modules/memory/infrastructure/agentHistory.js'
import { createAgentHistoryTool } from '../modules/tools/infrastructure/agentHistoryTool.js'
import type { AgentBindingTurn } from '../contracts/agentBinding.js'
import { createAgentTools } from '../modules/tools/infrastructure/agentTools.js'
import { createAgentMemberTools } from '../modules/tools/infrastructure/agentMemberTools.js'
import { validateMessageBundle } from '../modules/messaging/infrastructure/messageBundle.js'
import { createCommitmentRuntime } from '../modules/commitments/infrastructure/commitmentTool.js'
import { createTextConversation } from '../modules/conversation/infrastructure/textConversation.js'
import { createGroupTextTools, type GroupTextToolName } from '../modules/conversation/infrastructure/groupTextTools.js'
import { createDelegateMemoryRuntime } from '../modules/memory/infrastructure/delegateMemoryTool.js'
import { matchPersonMemoryCommand, personMemoryCommand, personMemoryCommandText, type PersonMemoryCommand } from '../modules/memory/domain/personMemoryCommands.js'
import { personMemoryAddress, revokePersonMemorySourceForAccount } from '../modules/memory/infrastructure/personMemoryContext.js'
import { createPersonMemoryStore } from '../modules/memory/infrastructure/personMemoryStore.js'
import { createTextPersonMemory } from '../modules/memory/infrastructure/textPersonMemory.js'
import { createConversationMemory } from '../modules/memory/infrastructure/conversationMemory.js'
import { createAgentSemanticMemory } from '../modules/memory/infrastructure/agentSemanticMemory.js'
import { createGroupMemory } from '../modules/memory/infrastructure/groupMemory.js'
import { createGroupMemoryManagement } from '../modules/memory/infrastructure/groupMemoryManagement.js'
import { createGroupKnowledgeTool } from '../modules/memory/infrastructure/groupKnowledgeTool.js'
import { createPersonaSnapshot } from '../modules/conversation/infrastructure/personaSnapshot.js'
import { sanitizeFinalReplyText } from '../modules/conversation/domain/replySanitizer.js'
import { createSimulationRuntime, type SimulationRuntimePorts } from '../modules/simulation/infrastructure/simulationRuntime.js'
import { dayKey } from '../modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import {
  agentBindingToken, agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformAccount,
  isPlatformIdentifier, platformAccountKey, samePlatformNamespace,
} from '../modules/runtime/domain/agentBindings.js'
import { createAgentInbox, inboxEventTarget, textConversationSeconds, type AgentInboxQueue, type AgentInboxRedis, type TextInbox } from '../modules/runtime/infrastructure/agentInbox.js'

type ResolvePersona = NonNullable<ReturnType<SimulationRuntimePorts['getPersona']>> & { binding: AgentBindingSnapshot }
type RuntimePorts = Pick<SimulationRuntimePorts, 'logger' | 'getSection' | 'getExecutionConfig' | 'YTapi' | 'recordTokens' | 'getTodaySpendCny' | 'reflectCharacter' | 'reviewCharacter' | 'judgeSocialPermission' | 'describeImages' | 'personProfileExtract' | 'now'>

export interface AgentRuntimeOptions extends RuntimePorts {
  storage: SimulationRuntimePorts['redis'] & AgentInboxRedis
  adapters: readonly PlatformConnectionAdapter[]
  resolvePersona(target: ConversationAddress): ResolvePersona | undefined
  isExecutionCurrent?(): boolean
  signal?: AbortSignal
  allowsText?(text: string, direction: 'incoming' | 'outgoing'): boolean
  /** Host credentials, including newly refreshed values, cannot become model-selected tool inputs. */
  allowsToolInput?(input: string): boolean
  privateChatEnabled?: boolean
  useTextGroup?(target: ConversationAddress): boolean
  textGroupRevision?: string
  groupTextTools?(target: ConversationAddress): readonly GroupTextToolName[]
  toolRegistry?: AgentToolRegistry
  memorySystem?: TextPersonMemoryConfig
  midtermMemory?: MidtermMemoryConfig
  episodicMemory?: EpisodicMemoryConfig
  summarizeConversation?: ConversationSummaryModel
  groupMemory?: GroupMemoryConfig
  groupMemoryModel?: GroupMemoryModel
  semanticMemory?: AgentSemanticMemoryConfig
  semanticMemoryBackend?: AgentSemanticMemoryBackend
  history?: AgentHistoryConfig
  musicExtraction?: AgentMusicExtractionConfig
  /** A trusted host may inject its bounded music resolver; model arguments cannot select a provider. */
  musicExtractionProvider?: MusicExtractionProvider
  /** Revokes this deterministic service when its host authorization snapshot changes. */
  isMusicExtractionCurrent?(): boolean
  mediaRelay?: AgentMediaRelayConfig
  mediaRelayProvider?: AgentMediaRelayProvider
  isMediaRelayCurrent?(): boolean
  torrentDownload?: AgentTorrentConfig
  torrentProvider?: AgentTorrentProvider
  isTorrentDownloadCurrent?(): boolean
  /** Optional neutral card renderer. Core retains the complete text fallback. */
  renderTorrentListing?(text: string, context: import('../contracts/agentMediaRelay.js').AgentMediaResourceContext): Promise<{ readonly mime: string; readonly base64: string }>
}

function isMessageId(value: unknown): value is string {
  return isPlatformIdentifier(value) && value !== '0'
}

/** Strip ephemeral share access before persistence or model-facing source reads. */
function mediaSafeMessage(message: IncomingMessage): IncomingMessage {
  const parts = (values: IncomingMessage['parts']) => values.map(part => part.kind === 'text'
    ? { ...part, text: sanitizeAgentXiaohongshuShareText(part.text) } : part)
  return { ...message, text: sanitizeAgentXiaohongshuShareText(message.text), parts: parts(message.parts),
    ...(message.senderName === undefined ? {} : { senderName: sanitizeAgentXiaohongshuShareText(message.senderName) }),
    ...(message.quote ? { quote: { ...message.quote, parts: parts(message.quote.parts),
      ...(message.quote.authorName === undefined ? {} : { authorName: sanitizeAgentXiaohongshuShareText(message.quote.authorName) }),
      ...(message.quote.text === undefined ? {} : { text: sanitizeAgentXiaohongshuShareText(message.quote.text) }) } } : {}) }
}

function isSameBinding(candidate: AgentBindingSnapshot, expected: AgentBindingSnapshot): boolean {
  return isConversationAddress(candidate.target) && conversationAddressKey(candidate.target) === expected.id &&
    agentBindingToken(candidate) === agentBindingToken(expected)
}

function isInboundUser(value: PlatformAccountRef, adapter: PlatformConnectionAdapter): boolean {
  return isPlatformAccount(value) && samePlatformNamespace(value, adapter.account) && value.id !== adapter.botUserId
}

function quoteReference(quote: IncomingMessage['quote']): Pick<IncomingMessage, 'quote'> {
  return isMessageId(quote?.messageId) ? { quote: { messageId: quote.messageId, parts: [] } } : {}
}

function hasValidInboundEvent(event: PlatformConversationEvent, adapter: PlatformConnectionAdapter): boolean {
  if (event.kind === 'recall') return isMessageId(event.messageId)
  if (event.kind === 'nudge') return isInboundUser(event.sender, adapter) &&
    Number.isSafeInteger(event.occurredAt) && event.occurredAt > 0
  const message = event.message
  return message.version === 1 && isMessageId(message.messageId) &&
    isInboundUser(message.sender, adapter) && Number.isSafeInteger(message.occurredAt) && message.occurredAt > 0 &&
    typeof message.text === 'string' && Array.isArray(message.parts) && Array.isArray(message.mentions) &&
    typeof message.directedToAccount === 'boolean'
}

const privacyConfirmations: Record<PersonMemoryCommand, { group: string; private: string }> = {
  forget: { group: '已清空你在本群的记忆，已删除的资料不会恢复。',
    private: '已清空此账号下当前角色对你的记忆，已删除的资料不会恢复。' },
  disable: { group: '已禁用你在本群的人物记忆。', private: '已禁用此账号下当前角色对你的记忆。' },
  enable: { group: '已启用你在本群的人物记忆权限。私聊中设置的全场景禁用仍然有效，旧资料不会恢复。',
    private: '已启用此账号下当前角色对你的记忆，旧资料不会恢复。' },
}
const privacyCommandMaxAgeMs = textConversationSeconds * 1000
const privacyCommandClockSkewMs = 60_000

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const torrentConfig = validateAgentTorrentConfig(options.torrentDownload)
  if (torrentConfig.enabled && typeof options.torrentProvider?.prepare !== 'function') throw new TypeError('启用磁链下载必须配置 Core 磁链提供器')
  const mediaRelayConfig = validateAgentMediaRelayConfig(options.mediaRelay)
  if (mediaRelayConfig.enabled && typeof options.mediaRelayProvider?.prepare !== 'function') {
    throw new TypeError('启用媒体搬运必须配置 Core 媒体提供器')
  }
  const { storage, logger, resolvePersona } = options
  if (options.history !== undefined) {
    const history = options.history
    if (!history || typeof history !== 'object' || Object.keys(history).some(key => !['enabled', 'retentionDays', 'maxMessagesPerConversation', 'timeoutMs'].includes(key)) ||
        history.enabled !== undefined && typeof history.enabled !== 'boolean' ||
        (['retentionDays', 'maxMessagesPerConversation', 'timeoutMs'] as const).some((key, i) => history[key] !== undefined &&
          (!Number.isSafeInteger(history[key]) || history[key]! < [1, 50, 100][i]! || history[key]! > [90, 2000, 30000][i]!))) {
      throw new Error('history 需要显式开关及有界的保留期、数量和读取时限')
    }
  }
  if (options.semanticMemory?.enabled === true && (!options.semanticMemoryBackend || !/^[a-f0-9]{64}$/u.test(options.semanticMemoryBackend.id))) {
    throw new Error('启用独立语义记忆需要显式后端和有效的向量空间标识')
  }
  const connectionIds = new Set(options.adapters.map(adapter => adapter.id))
  if (connectionIds.size !== options.adapters.length ||
      options.adapters.some(adapter => !isPlatformIdentifier(adapter.id) || !isPlatformAccount(adapter.account) ||
        !isPlatformIdentifier(adapter.botUserId))) {
    throw new Error('独立宿主连接需要有效账号和唯一连接 ID')
  }
  const adapters = new Map(options.adapters.map(adapter => [platformAccountKey(adapter.account), adapter]))
  if (adapters.size === 0 || adapters.size !== options.adapters.length) throw new Error('独立宿主需要至少一个不重复的平台账号')
  const inbox = createAgentInbox(storage)
  const toolLogger = { info() {}, warn: (message: string) => logger.warn(message), error: (message: string) => logger.error(message) }
  const memories = createDelegateMemoryRuntime({ redis: storage, logger: toolLogger, loadConfig: () => ({}), ...(options.now ? { now: options.now } : {}) })
  const personMemory = createPersonMemoryStore({ redis: storage, ...(options.now ? { now: options.now } : {}) })
  const pendingSends = new Map<string, Set<() => void>>()
  const pendingTools = new Map<string, Set<() => void>>()
  const memoryTurns = new Map<string, Map<() => void, string>>()
  const privacyAdmissions = new Map<string, number>()
  const privacyBacklog = new Set<string>()
  const privacyWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  let stopping = false
  const toolCancellation = new AbortController()

  function adapterFor(target: ConversationAddress) { return adapters.get(platformAccountKey(target.account)) }
  function privatePeerFor(target: ConversationAddress, adapter = adapterFor(target)): string | undefined {
    if (target.kind !== 'private' || !adapter?.isReady()) return undefined
    try {
      const peer = adapter.resolvePrivatePeer ? adapter.resolvePrivatePeer(target) : { ...target.account, id: target.id }
      if (!peer || !samePlatformNamespace(target.account, peer) || peer.id === adapter.botUserId || !isPlatformIdentifier(peer.id)) return undefined
      return peer.id
    } catch { return undefined }
  }
  function isRunning(): boolean {
    return !stopping && !options.signal?.aborted && options.isExecutionCurrent?.() !== false
  }
  function conversationEnabled(target: ConversationAddress): boolean {
    return options.getSection().enabled !== false && (target.kind !== 'private' || options.privateChatEnabled === true)
  }
  function textInboxFor(target: ConversationAddress): TextInbox | undefined {
    if (target.kind === 'private' || (target.kind === 'group' && options.useTextGroup?.(target))) {
      return { account: target.account, kind: target.kind }
    }
  }
  function bindingFor(target: ConversationAddress): ResolvePersona | undefined {
    if (!isConversationAddress(target)) return undefined
    const connection = adapterFor(target)
    if (!connection) return undefined
    const persona = resolvePersona(target)
    const binding = persona?.binding
    if (binding?.source !== 'configured' || binding.connectionId !== connection.id ||
        !isConversationAddress(binding.target) || binding.id !== conversationAddressKey(target) ||
        binding.id !== conversationAddressKey(binding.target) || typeof binding.revision !== 'string' || !binding.revision.trim()) return undefined
    return persona
  }
  function bindingIsCurrent(target: ConversationAddress, expected: string): boolean {
    try {
      const current = bindingFor(target)
      return !!current && agentBindingToken(current.binding) === expected
    } catch { return false }
  }
  function textBindingToken(binding: AgentBindingSnapshot): string {
    const token = agentBindingToken(binding)
    return binding.target.kind === 'group' && options.textGroupRevision ? JSON.stringify([token, options.textGroupRevision]) : token
  }
  function freshMemberObservation(at: number, startedAt: number): boolean {
    return Number.isSafeInteger(at) && at >= startedAt - 5_000 && at <= Date.now() + 5_000
  }
  function projectMember(member: ConversationMember, target: ConversationAddress): ConversationMember | undefined {
    if (!member || !isPlatformAccount(member.user) || !samePlatformNamespace(target.account, member.user) ||
        typeof member.displayName !== 'string' || member.displayName.length > 240 || !['member', 'admin', 'owner', 'unknown'].includes(member.role)) return undefined
    const profile = member.profile
    if (profile !== undefined) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined
      for (const [name, value] of Object.entries(profile)) {
        if (['nickname', 'conversationName', 'title', 'level', 'region'].includes(name)) {
          if (typeof value !== 'string' || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
        } else if (['joinedAt', 'lastSpokeAt', 'mutedUntil'].includes(name)) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) return undefined
        } else if (name === 'age') {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 150) return undefined
        } else if (name !== 'gender' || typeof value !== 'string' || !['male', 'female', 'unknown'].includes(value)) return undefined
      }
    }
    return { user: { platform: member.user.platform, namespace: member.user.namespace, id: member.user.id },
      displayName: member.displayName, role: member.role, ...(profile ? { profile: structuredClone(profile) } : {}) }
  }
  async function readGroupMembers(target: ConversationAddress, signal: AbortSignal, guard: () => boolean): Promise<ConversationMembersSnapshot | undefined> {
    const adapter = adapterFor(target), startedAt = Date.now()
    const isCurrent = () => isRunning() && !signal.aborted && guard() && adapterFor(target) === adapter && adapter?.isReady() === true
    if (target.kind !== 'group' || !isCurrent() || !adapter?.listConversationMembers) return undefined
    const result = await adapter.listConversationMembers(target, { signal, isCurrent })
    if (!result || !isCurrent() || result.complete !== true || !isConversationAddress(result.target) ||
        conversationAddressKey(result.target) !== conversationAddressKey(target) || !freshMemberObservation(result.observedAt, startedAt) ||
        !Array.isArray(result.members) || result.members.length > 5000 ||
        result.members.some(member => !projectMember(member, target)) ||
        new Set(result.members.map(member => member.user.id)).size !== result.members.length) return undefined
    return { target: structuredClone(target), observedAt: result.observedAt, complete: true, members: result.members.map(member => {
      const projected = projectMember(member, target)!
      return { user: projected.user, displayName: projected.displayName, role: projected.role,
        ...(projected.profile ? { profile: { ...(projected.profile.nickname ? { nickname: projected.profile.nickname } : {}),
          ...(projected.profile.conversationName ? { conversationName: projected.profile.conversationName } : {}) } } : {}) }
    }) }
  }
  async function readGroupMember(target: ConversationAddress, userId: string, signal: AbortSignal, guard: () => boolean): Promise<ConversationMemberSnapshot | undefined> {
    const adapter = adapterFor(target), startedAt = Date.now()
    const isCurrent = () => isRunning() && !signal.aborted && guard() && adapterFor(target) === adapter && adapter?.isReady() === true
    if (target.kind !== 'group' || !isCurrent() || !adapter?.readConversationMember) return undefined
    const result = await adapter.readConversationMember(target, { ...target.account, id: userId }, { signal, isCurrent })
    if (!result || !isCurrent() || !isConversationAddress(result.target) || conversationAddressKey(result.target) !== conversationAddressKey(target) ||
        !projectMember(result.member, target) || result.member.user.id !== userId || !freshMemberObservation(result.observedAt, startedAt)) return undefined
    return { target: structuredClone(target), observedAt: result.observedAt, member: projectMember(result.member, target)! }
  }
  function privacyBlocked(key: string): boolean { return privacyBacklog.has(key) || privacyAdmissions.has(key) }
  function wakeMemoryTurns(key: string) {
    if (privacyBlocked(key)) return
    privacyWaiters.get(key)?.resolve()
    privacyWaiters.delete(key)
  }
  function setPrivacyBacklog(key: string, pending: boolean) {
    if (pending) privacyBacklog.add(key)
    else privacyBacklog.delete(key)
    wakeMemoryTurns(key)
  }
  function beginPrivacyAdmission(binding: AgentBindingSnapshot) {
    const key = platformAccountKey(binding.target.account)
    privacyAdmissions.set(key, (privacyAdmissions.get(key) ?? 0) + 1)
    // Shared teaching can originate from another Agent in this account.
    for (const invalidate of memoryTurns.get(key)?.keys() ?? []) invalidate()
    return () => {
      const remaining = (privacyAdmissions.get(key) ?? 1) - 1
      if (remaining > 0) privacyAdmissions.set(key, remaining)
      else privacyAdmissions.delete(key)
      wakeMemoryTurns(key)
    }
  }
  async function beginMemoryTurn(binding: AgentBindingSnapshot) {
    const key = platformAccountKey(binding.target.account)
    while (isRunning() && privacyBlocked(key)) {
      let waiter = privacyWaiters.get(key)
      if (!waiter) {
        let resolve!: () => void
        const promise = new Promise<void>(done => { resolve = done })
        waiter = { promise, resolve }
        privacyWaiters.set(key, waiter)
      }
      await waiter.promise
    }
    const controller = new AbortController()
    const invalidate = () => controller.abort(new Error('人物记忆权限已改变'))
    const active = memoryTurns.get(key) ?? new Map<() => void, string>()
    active.set(invalidate, binding.agentId)
    memoryTurns.set(key, active)
    return {
      isCurrent: () => isRunning() && !controller.signal.aborted,
      signal: controller.signal,
      release() {
        active.delete(invalidate)
        if (!active.size && memoryTurns.get(key) === active) memoryTurns.delete(key)
      },
    }
  }
  function guardPendingSend(targetKey: string, check: () => boolean) {
    let current = true
    const invalidate = () => { current = false }
    const waiting = pendingSends.get(targetKey) ?? new Set<() => void>()
    waiting.add(invalidate)
    pendingSends.set(targetKey, waiting)
    return {
      isCurrent() {
        if (current) {
          current = false
          try { current = check() } catch { /* The pending send has lost its authorization. */ }
        }
        return current
      },
      release() {
        waiting.delete(invalidate)
        if (!waiting.size && pendingSends.get(targetKey) === waiting) pendingSends.delete(targetKey)
      },
    }
  }

  const messageActions: MessageActionPort = {
    async sendRequesterArchive(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'requester-archive.upload' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_requester_archive' }
      let archive: ReturnType<typeof validateAgentTorrentArchive>, source: SendRequesterArchiveAction['source']
      try {
        for (const [value, keys] of [[action, ['version', 'kind', 'target', 'binding', 'source', 'archive']],
          [action.source, ['messageId', 'sender', 'occurredAt', 'textSha256']]] as const) {
          if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key as never) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('invalid')
        }
        archive = validateAgentTorrentArchive(action.archive)
        const original = action.source
        if (!isMessageId(original.messageId) || typeof original.textSha256 !== 'string' || !/^[a-f\d]{64}$/u.test(original.textSha256) ||
          !isPlatformAccount(original.sender) || !samePlatformNamespace(original.sender, target.account) ||
          !Number.isSafeInteger(original.occurredAt) || original.occurredAt <= 0 || [...adapters.values()].some(adapter =>
            samePlatformNamespace(adapter.account, original.sender) && [adapter.account.id, adapter.botUserId].includes(original.sender.id))) throw new Error('invalid')
        source = Object.freeze({ messageId: original.messageId, sender: Object.freeze({ ...original.sender }), occurredAt: original.occurredAt, textSha256: original.textSha256 })
        if (sanitizeFinalReplyText(archive.name) !== archive.name || options.allowsText?.(archive.name, 'outgoing') === false) throw new Error('invalid')
      } catch { return { state: 'failed', code: 'invalid_requester_archive' } }
      const adapter = adapterFor(target), live = bindingFor(target)
      if (!torrentCurrent() || !adapter?.readMessage || !adapter.actions.sendRequesterArchive || !live || !conversationEnabled(target)) return { state: 'failed', code: 'requester_archive_unavailable' }
      const binding = live.binding
      if (!isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      const expected = agentBindingToken(binding), key = conversationAddressKey(target)
      const send = guardPendingSend(key, () => !guard?.signal?.aborted && torrentCurrent() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected) && options.allowsText?.(archive.name, 'outgoing') !== false)
      try {
        if (!send.isCurrent() || !await inbox.canReply(target, source.messageId)) return { state: 'failed', code: 'source_unavailable' }
        const observed = await adapter.readMessage(target, source.messageId, { isCurrent: send.isCurrent })
        if (!observed || !sameTorrentSource(observed, target, source) || createHash('sha256').update(observed.text).digest('hex') !== source.textSha256 ||
          !send.isCurrent() || !await torrentSourceAllowed(observed, binding) || !send.isCurrent()) return { state: 'failed', code: 'source_unavailable' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendRequesterArchive({ version: 1, kind: 'requester-archive.upload', target: binding.target, binding, source, archive },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendMediaRelay(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'media-relay.send' || !isConversationAddress(target) ||
          action.mode !== 'forward' && action.mode !== 'direct-video') return { state: 'failed', code: 'invalid_media_relay' }
      const allowsText = (text: string) => sanitizeFinalReplyText(text) === text && options.allowsText?.(text, 'outgoing') !== false
      let plan: Readonly<AgentMediaRelayPlan>
      try { plan = validateAgentMediaRelayPlan(action.plan, { allowsText }) } catch { return { state: 'failed', code: 'invalid_media_relay' } }
      const texts = plan.items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')), allText = texts.join('\n')
      if (!allowsText(allText) || texts.some(text => !allowsText(text))) return { state: 'failed', code: 'forbidden_text' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMediaRelay) return { state: 'failed', code: 'media_relay_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false &&
        bindingIsCurrent(target, expected) && allowsText(allText) && texts.every(allowsText) && plan.items.every(item => item.parts.every(part => part.kind !== 'text' || allowsText(part.text))))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeDeliveryReceipt(await adapter.actions.sendMediaRelay({ ...action, plan, binding },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendAudioFile(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'audio-file.upload' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_audio_file' }
      let attachment: AgentAudioAttachment
      try { attachment = validateAgentAudioAttachment(action.attachment) } catch { return { state: 'failed', code: 'invalid_audio_file' } }
      if (options.allowsText?.(attachment.name, 'outgoing') === false) return { state: 'failed', code: 'forbidden_audio_file' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendAudioFile) return { state: 'failed', code: 'audio_file_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendAudioFile({ ...action, attachment, binding },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendMusic(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'music.send' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_music_target' }
      let music: AgentMusicCard
      try { music = validateAgentMusicCard(action.music) } catch { return { state: 'failed', code: 'invalid_music' } }
      if (Object.values(music).some(value => options.allowsText?.(value, 'outgoing') === false)) return { state: 'failed', code: 'forbidden_music' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMusic) return { state: 'failed', code: 'music_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendMusic({ ...action, music, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* Native signing and send may continue after local cancellation. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async sendMedia(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'media.send' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_media' }
      let media: SendMediaAction['media']
      try { media = validateAgentMedia(action.media) } catch { return { state: 'failed', code: 'invalid_media' } }
      if (media.kind === 'audio' && media.spokenText !== undefined && options.allowsText?.(media.spokenText, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMedia) return { state: 'failed', code: 'media_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendMedia({ ...action, media, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* The platform may already have accepted the media. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async sendFile(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'file.upload' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_file' }
      let file: AgentFileUpload
      try {
        file = validateAgentFileUpload(action.file)
        const text = agentFileUploadText(file)
        if (options.allowsText?.(file.name, 'outgoing') === false || text !== undefined && options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      } catch { return { state: 'failed', code: 'invalid_file' } }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendFile) return { state: 'failed', code: 'file_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendFile({ ...action, file, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendBundle(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'message.bundle.send' || !isConversationAddress(target)) {
        return { state: 'failed', code: 'invalid_message' }
      }
      let items: readonly MessageBundleItem[]
      try { items = validateMessageBundle(action.items) } catch { return { state: 'failed', code: 'invalid_bundle' } }
      const targetKey = conversationAddressKey(target)
      const adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendBundle) return { state: 'failed', code: 'bundle_delivery_unavailable' }
      const text = items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')).join('\n')
      if (options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendBundle({ ...action, items, binding }, { isCurrent: send.isCurrent })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* A bundle may already have been accepted by the transport. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async send(action, guard) {
      const { target, parts, replyTo } = action
      if (action.version !== 1 || action.kind !== 'message.send' || !isConversationAddress(target) || !parts.length) {
        return { state: 'failed', code: 'invalid_message' }
      }
      const targetKey = conversationAddressKey(target)
      const adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (parts.some(part => part.kind === 'mention' && part.user !== 'everyone' &&
          (!isPlatformAccount(part.user) || !samePlatformNamespace(target.account, part.user)) ||
          part.kind === 'extension' && part.platform !== target.account.platform)) {
        return { state: 'failed', code: 'part_scope_mismatch' }
      }
      const text = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')
      if (options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      if (replyTo !== undefined && !isMessageId(replyTo)) return { state: 'failed', code: 'reply_source_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) &&
        guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (replyTo !== undefined) {
          try { if (!await inbox.canReply(target, replyTo)) return { state: 'failed', code: 'reply_source_unavailable' } }
          catch { return { state: 'failed', code: 'reply_source_unavailable' } }
        }
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.send({ ...action, binding }, { isCurrent: send.isCurrent })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* Transport may have accepted the send before failing. */ }
        return { state: 'unknown' }
      } finally {
        send.release()
      }
    },
  }
  const extraction = createAgentMusicExtraction({
    ...(options.musicExtraction ? { config: options.musicExtraction } : {}), storage, actions: messageActions,
    ...(options.musicExtractionProvider ? { provider: options.musicExtractionProvider } : {}),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    ...(options.now ? { now: options.now } : {}),
    async readShare(incoming, sourceId, context) {
      const adapter = adapterFor(incoming.conversation)
      if (!adapter?.readMusicShare || !context.isCurrent()) return undefined
      return await adapter.readMusicShare(incoming.conversation, sourceId, {
        signal: context.signal, isCurrent: context.isCurrent, allowsSource: context.allowsSource,
      })
    },
  })
  const mediaOutbox = createAgentMediaOutbox({
    storage, actions: messageActions, ...(options.mediaRelayProvider ? { provider: options.mediaRelayProvider } : {}),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    ...(options.now ? { now: options.now } : {}), openContext: openMediaRelayContext,
  })
  const torrent = createAgentTorrentWorkflow({ config: torrentConfig, storage, actions: messageActions,
    ...(options.torrentProvider ? { provider: options.torrentProvider } : {}),
    ...(options.renderTorrentListing ? { renderListing: options.renderTorrentListing } : {}),
    ...(options.now ? { now: options.now } : {}), allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    isCurrent: torrentCurrent, responsible: torrentResponsible, openContext: openTorrentContext,
  })
  const allowsFileNames = (message: IncomingMessage) => message.parts.every(part => part.kind !== 'file' || !part.name || options.allowsText?.(part.name, 'incoming') !== false)
  const memberTools = options.adapters.some(adapter => adapter.readConversationMember || adapter.listConversationMembers) ? createAgentMemberTools() : []
  const historyTools = options.history?.enabled === true ? [createAgentHistoryTool()] : []
  const registeredTools = createAgentTools({
    get builtIn() { return [...memberTools, ...historyTools, ...(options.toolRegistry?.builtIn ?? [])] },
    get custom() { return options.toolRegistry?.custom ?? [] },
  }, {
    signal: toolCancellation.signal,
    ...(options.allowsToolInput ? { allowsInput: options.allowsToolInput } : {}),
    onStart(event, cancel) {
      const target = (event as AgentBindingTurn)._agentBinding!.target
      const key = conversationAddressKey(target)
      const callbacks = pendingTools.get(key) ?? new Set<() => void>()
      callbacks.add(cancel)
      pendingTools.set(key, callbacks)
      return () => { callbacks.delete(cancel); if (!callbacks.size) pendingTools.delete(key) }
    },
    context(event) {
      const incoming = event as AgentBindingTurn & {
        simulationActor?: { kind?: string; userId?: string }
        _ensureAgentToolCurrent?: () => Promise<void>
        _sendAgentToolImage?: (image: { readonly mime: string; readonly base64: string }, isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _sendAgentToolFile?: (file: AgentFileUpload, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<FileDeliveryReceipt>
        _sendAgentToolMedia?: (media: SendMediaAction['media'], isCurrent?: () => boolean, signal?: AbortSignal) => Promise<DeliveryReceipt>
        _sendAgentToolMusic?: (music: AgentMusicCard, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<DeliveryReceipt>
        _sendAgentToolMediaRelay?: (plan: AgentMediaRelayPlan, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<DeliveryReceipt>
        _agentToolPersona?: AgentToolContext['persona']
        _sendAgentToolBundle?: (items: readonly MessageBundleItem[], isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _readAgentToolImages?: (sourceSeq: number, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<readonly { readonly mime: string; readonly base64: string }[]>
        _sendAgentToolMessage?: (message: AgentToolMessage, isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _agentToolRequest?: AgentToolRequest
        _readAgentFile?: (input: AgentFileRequest, guard: () => boolean, signal: AbortSignal) => Promise<AgentFileBytes>
        _listAgentFiles?: (input: { readonly query?: string; readonly folderPath?: string }, guard: () => boolean, signal: AbortSignal) => Promise<AgentFileListing>
        _readAgentHistory?: (input: Record<string, unknown>, guard: () => boolean, signal: AbortSignal) => Promise<string>
      }
      const binding = incoming?._agentBinding
      const actor = incoming?.simulationActor
      if (!binding || !isConversationAddress(binding.target) || typeof incoming._isAgentBindingCurrent !== 'function' || typeof incoming._ensureAgentToolCurrent !== 'function' ||
          !actor || !['user', 'autonomous', 'commitment'].includes(String(actor.kind)) ||
          (actor.kind === 'user' && !isPlatformIdentifier(actor.userId))) return undefined
      const target = binding.target
      const expected = agentBindingToken(binding)
      const isCurrent = () => {
        try { return isRunning() && adapterFor(target)?.isReady() === true && conversationEnabled(target) &&
          !textInboxFor(target) && incoming._isAgentBindingCurrent?.() === true && bindingIsCurrent(target, expected) }
        catch { return false }
      }
      if (!isCurrent()) return undefined
      return {
        binding: Object.freeze({ ...binding, target: Object.freeze({ ...target, account: Object.freeze({ ...target.account }) }) }),
        actor: Object.freeze({ kind: actor.kind as 'user' | 'autonomous' | 'commitment',
          ...(actor.kind === 'user' ? { user: Object.freeze({ ...target.account, id: actor.userId! }) } : {}),
        }), isCurrent,
        botUserId: adapterFor(target)!.botUserId,
        ...(incoming._agentToolPersona ? { persona: incoming._agentToolPersona } : {}),
        ...(actor.kind === 'user' && incoming._agentToolRequest ? { request: Object.freeze({ ...incoming._agentToolRequest,
          mentions: Object.freeze(incoming._agentToolRequest.mentions.map(user => Object.freeze({ ...user }))),
          ...(incoming._agentToolRequest.replyAuthor ? { replyAuthor: Object.freeze({ ...incoming._agentToolRequest.replyAuthor }) } : {}),
        }) } : {}),
        async ensureCurrent() {
          if (!isCurrent()) throw new Error('工具所属回合已失效')
          await incoming._ensureAgentToolCurrent!()
          if (!isCurrent()) throw new Error('工具所属回合已失效')
        },
        ...(typeof incoming._sendAgentToolImage === 'function' ? {
          sendImage: (image: { readonly mime: string; readonly base64: string }, toolCurrent?: () => boolean) =>
            incoming._sendAgentToolImage!(image, () => isCurrent() && toolCurrent?.() !== false),
        } : {}),
        ...(typeof incoming._sendAgentToolFile === 'function' && adapterFor(target)?.actions.sendFile ? {
          sendFile: (file: AgentFileUpload, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolFile!(file, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(typeof incoming._sendAgentToolMusic === 'function' && target.kind === 'group' && adapterFor(target)?.actions.sendMusic ? {
          sendMusic: (music: AgentMusicCard, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMusic!(music, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._sendAgentToolMediaRelay === 'function' && adapterFor(target)?.actions.sendMediaRelay ? {
          sendMediaRelay: (plan: AgentMediaRelayPlan, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMediaRelay!(plan, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && adapterFor(target)?.readMessage ? {
          async isSourceAvailable(source: { readonly messageId: string; readonly author: PlatformUserRef }, toolCurrent: () => boolean, signal: AbortSignal): Promise<boolean> {
            const adapter = adapterFor(target), current = () => !signal.aborted && isCurrent() && toolCurrent() && adapterFor(target) === adapter
            try {
              if (!isMessageId(source.messageId) || !isPlatformAccount(source.author) || !samePlatformNamespace(source.author, target.account) || !adapter?.readMessage || !current()) return false
              const messageId = source.messageId, author = { ...source.author }
              await incoming._ensureAgentToolCurrent!()
              if (!current() || !await inbox.canReply(target, messageId) || await inbox.isRecalled(target, messageId) || !current()) return false
              const message = await adapter.readMessage(target, messageId, { isCurrent: current })
              if (!message || !isConversationAddress(message.conversation) || conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
                  message.messageId !== messageId || !isPlatformAccount(message.sender) || platformAccountKey(message.sender) !== platformAccountKey(author) ||
                  !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 || matchPersonMemoryCommand(message.text) ||
                  options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message) || !current()) return false
              await incoming._ensureAgentToolCurrent!()
              if (!current() || !await inbox.canReply(target, messageId) || await inbox.isRecalled(target, messageId) || !current()) return false
              const { botId, scene } = personMemoryAddress(target), excerpt = message.text || '[工具请求]'
              const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: author.id })
              return !isPersonMemoryRedacted({ scene, messageId, authorId: author.id, at: message.occurredAt, excerpt }, excerpt, redactions) &&
                options.allowsText?.(message.text, 'incoming') !== false && allowsFileNames(message) && current()
            } catch { return false }
          },
        } : {}),
        ...(typeof incoming._sendAgentToolMedia === 'function' && adapterFor(target)?.actions.sendMedia ? {
          sendAudio: (audio: AgentAudioBytes, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMedia!({ ...audio, kind: 'audio' }, () => isCurrent() && toolCurrent(), signal),
          sendVideo: (video: AgentVideoBytes, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMedia!({ ...video, kind: 'video' }, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(typeof incoming._sendAgentToolBundle === 'function' && adapterFor(target)?.actions.sendBundle ? {
          sendBundle: (items: readonly MessageBundleItem[], toolCurrent?: () => boolean) =>
            incoming._sendAgentToolBundle!(items, () => isCurrent() && toolCurrent?.() !== false),
        } : {}),
        ...(typeof incoming._readAgentToolImages === 'function' ? {
          readImages: (sourceSeq: number, toolCurrent?: () => boolean, signal?: AbortSignal) =>
            incoming._readAgentToolImages!(sourceSeq, () => isCurrent() && toolCurrent?.() !== false, signal),
        } : {}),
        ...(actor.kind === 'user' && typeof incoming._readAgentHistory === 'function' ? {
          readHistory: (input: Record<string, unknown>, guard: () => boolean, signal: AbortSignal) => incoming._readAgentHistory!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._readAgentFile === 'function' ? {
          readFile: (input: AgentFileRequest, guard: () => boolean, signal: AbortSignal) => incoming._readAgentFile!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._listAgentFiles === 'function' ? {
          listFiles: (input: { readonly query?: string; readonly folderPath?: string }, guard: () => boolean, signal: AbortSignal) => incoming._listAgentFiles!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' ? {
          readMember: (userId: string, guard: () => boolean, signal: AbortSignal) => readGroupMember(target, userId, signal, () => isCurrent() && guard()),
          listMembers: (guard: () => boolean, signal: AbortSignal) => readGroupMembers(target, signal, () => isCurrent() && guard()),
          ...(typeof incoming._sendAgentToolMessage === 'function' ? {
            async sendMessage(message: AgentToolMessage, guard: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt> {
              const current = () => !signal.aborted && isCurrent() && guard()
              for (const id of message.mentionUserIds ?? []) {
                await incoming._ensureAgentToolCurrent!()
                if (!await readGroupMember(target, id, signal, current)) return { state: 'failed', code: 'member_unverified' }
              }
              await incoming._ensureAgentToolCurrent!()
              if (!current()) return { state: 'failed', code: 'binding_changed' }
              return incoming._sendAgentToolMessage!(message, current)
            },
          } : {}),
        } : {}),
        recordUsage(model, usage) {
          options.recordTokens?.({ scope: simulationAddressKey(target), stage: 'agent-tool', model, usage })
        },
      }
    },
  })
  const runtime = createSimulationRuntime({
    ...options,
    redis: storage,
    durableIngress: true,
    ...registeredTools,
    extraToolsPlatformNeutral: true,
    messageActions,
    ...(options.adapters.some(adapter => adapter.listConversationMembers) ? { readGroupMembers } : {}),
    handlesTarget: target => target.kind !== 'private' && !!adapterFor(target),
    allowsSimulation: target => !options.useTextGroup?.(target),
    beginMemoryTurn,
    isMemoryInputAvailable: account => !privacyBlocked(platformAccountKey(account)),
    isAccountReady: account => isRunning() && adapters.get(platformAccountKey(account))?.isReady() === true,
    async readSemanticMemory(target, query, guard, signal, excludeMessageIds) {
      const selected = bindingFor(target)
      return selected ? semanticMemory.read(selected.binding, query, guard, signal, excludeMessageIds) : undefined
    },
    ...(options.history?.enabled === true ? { async readHistory(target: ConversationAddress, input: Record<string, unknown>, source: AgentHistoryRequestSource, guard: () => boolean, signal?: AbortSignal) {
      const selected = bindingFor(target)
      if (!selected) throw new Error('历史查询的角色绑定不可用')
      return history.read(selected.binding, input, source, guard, signal)
    } } : {}),
    getSelf: (_id, account) => {
      const adapter = account && adapters.get(platformAccountKey(account))
      return adapter ? { id: adapter.account.id, name: adapter.botName, userId: adapter.botUserId } : { id: '', name: '' }
    },
    getPersona: (_id, _self, target) => {
      const persona = target && bindingFor(target)
      if (!persona) throw new Error('独立宿主会话没有有效角色绑定')
      return persona
    },
    loadDelegatedMemories: scope => typeof scope === 'string' ? [] : memories.store.load(scope),
    getBoundTools: target => adapterFor(target) && target.kind === 'group' ? [new commitments.CommitmentTool(), new memories.DelegateMemoryTool(),
      ...(options.groupMemory?.enabled === true ? [groupKnowledge] : [])] : [],
    async readQuotedMessage(target, messageId, guard) {
      const adapter = adapterFor(target)
      const isCurrent = () => isRunning() && adapter?.isReady() === true && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false
      if (!isMessageId(messageId) || !adapter?.readMessage || !isCurrent() || await inbox.isRecalled(target, messageId) || !isCurrent()) return undefined
      const source = await adapter.readMessage(target, messageId, { isCurrent })
      if (!source || source.messageId !== messageId || conversationAddressKey(source.conversation) !== conversationAddressKey(target) ||
          matchPersonMemoryCommand(source.text) || await inbox.isRecalled(target, messageId) || !isCurrent() ||
          options.allowsText?.(source.text, 'incoming') === false || !allowsFileNames(source)) return undefined
      return mediaSafeMessage(source)
    },
    async readConversationMemory(target, viewer, guard) {
      const selected = bindingFor(target)
      if (!selected || guard?.() === false) return { digest: '', episodes: '' }
      return conversationMemory.read(selected.binding, viewer, () => guard?.() !== false && isRunning(), { simulation: true })
    },
    async readGroupMemory(target, _viewer, sourceId, guard) {
      const selected = bindingFor(target)
      if (!selected || !guard()) return ''
      return groupMemory.prepare(selected.binding, sourceId, guard)
    },
    async isGroupMemoryCurrent(target, expected, includeWorkflows, guard) {
      const selected = bindingFor(target)
      return !!selected && guard() && await groupMemory.read(selected.binding, guard, includeWorkflows) === expected && guard()
    },
    async recordGroupReply(target, guard) {
      const selected = bindingFor(target)
      if (selected) try { await groupMemory.confirmed(selected.binding, guard) } catch { logger.warn('[Agent] 群学习登记失败') }
    },
    async recordEpisode(input) {
      const binding = input.binding
      if (!binding || !input.source || !input.replyIds?.length || !input.isCurrent?.()) return
      await conversationMemory.recordEpisode({ binding, source: input.source, at: input.at ?? (options.now?.() ?? Date.now()),
        ...(input.userId ? { userId: input.userId } : {}), ...(input.userName ? { userName: input.userName } : {}),
        summary: input.summary, reply: input.reply, messageIds: input.messageIds ?? [], replyIds: input.replyIds,
      }, input.isCurrent)
    },
    supportsForwardRead: target => !!adapterFor(target)?.readForward,
    async readForward(target, source, guard) {
      const adapter = adapterFor(target)
      const isCurrent = () => isRunning() && adapter?.isReady() === true && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false
      if (!adapter?.readForward || !isCurrent() || !await inbox.canReply(target, source.messageId) || !isCurrent()) return undefined
      const content = await adapter.readForward(target, source, { isCurrent })
      if (!content || !await inbox.canReply(target, source.messageId) || !isCurrent()) return undefined
      const entries = content.entries.filter(entry => !matchPersonMemoryCommand(entry.text) &&
        options.allowsText?.(`${entry.senderName || ''}\n${entry.text}`, 'incoming') !== false)
      return { entries: entries.map(entry => ({ ...entry, text: sanitizeAgentXiaohongshuShareText(entry.text),
        ...(entry.senderName === undefined ? {} : { senderName: sanitizeAgentXiaohongshuShareText(entry.senderName) }) })), partial: content.partial || entries.length !== content.entries.length }
    },
    supportsMessageImages: target => !!options.describeImages && !!adapterFor(target)?.readMessageImages,
    async readMessageImages(target, source, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessageImages || target.kind === 'private') return undefined
      const originalId = source.quotedMessageId ?? source.messageId
      const isCurrent = () => isRunning() && !guard.signal?.aborted && adapter.isReady() && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false
      const canRead = async () => isCurrent() && await inbox.canReply(target, source.messageId) &&
        !(source.quotedMessageId && await inbox.isRecalled(target, source.quotedMessageId)) && isCurrent()
      if (!await canRead()) return undefined
      const images = await adapter.readMessageImages(target, originalId, {
        isCurrent,
        ...(guard.signal ? { signal: guard.signal } : {}),
        async allowsSource(original) {
          return original.messageId === originalId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
            options.allowsText?.(original.text, 'incoming') !== false && allowsFileNames(original) && await guard.allowsSource(original) && await canRead()
        },
      })
      return images && await canRead() ? images : undefined
    },
    async readMessageFile(target, source, fileIndex, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessageFile || target.kind !== 'group') return undefined
      const originalId = source.quotedMessageId ?? source.messageId
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const canRead = async () => isCurrent() && await inbox.canReply(target, source.messageId) &&
        !(source.quotedMessageId && await inbox.isRecalled(target, source.quotedMessageId)) && isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!await canRead()) throw new Error('文件来源已失效') }
      if (!await canRead()) return undefined
      const result = await adapter.readMessageFile(target, originalId, fileIndex, {
        signal: guard.signal, isCurrent, ensureCurrent,
        async allowsSource(original) {
          return original.messageId === originalId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
            options.allowsText?.(original.text, 'incoming') !== false && allowsFileNames(original) && await guard.allowsSource(original) && await canRead()
        },
      })
      await ensureCurrent()
      return result ? validateAgentFileBytes(result) : undefined
    },
    async listConversationFiles(target, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.listConversationFiles || target.kind !== 'group') return undefined
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!isCurrent()) throw new Error('文件目录权限已失效') }
      await ensureCurrent()
      const result = await adapter.listConversationFiles(target, { signal: guard.signal, isCurrent, ensureCurrent })
      await ensureCurrent()
      if (!result || conversationAddressKey(result.target) !== conversationAddressKey(target) || result.files.some(file => file.uploadedBy && !samePlatformNamespace(file.uploadedBy, target.account))) return undefined
      if (result.files.some(file => options.allowsText?.(`${file.name}\n${file.folderPath}`, 'incoming') === false)) return undefined
      return result
    },
    async readConversationFile(target, entry, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readConversationFile || target.kind !== 'group') return undefined
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!isCurrent()) throw new Error('群文件权限已失效') }
      await ensureCurrent()
      const result = await adapter.readConversationFile(target, entry, {
        signal: guard.signal, isCurrent, ensureCurrent,
        async allowsFile(current) {
          await ensureCurrent()
          return options.allowsText?.(`${current.name}\n${current.folderPath}`, 'incoming') !== false &&
            (!current.uploadedBy || samePlatformNamespace(current.uploadedBy, target.account)) && await guard.allowsFile(current) && isCurrent()
        },
      })
      await ensureCurrent()
      return result ? validateAgentFileBytes(result) : undefined
    },
    readPublicFile: (url, guard) => readAgentPublicFile(url, guard),
    isMessageRecalled: (target, messageId) => inbox.isRecalled(target, messageId),
  })
  const commitments = createCommitmentRuntime({
    redis: storage, logger: toolLogger, getBot: () => null,
    messageActions,
    handlesTarget: target => isRunning() && !!target && adapterFor(target)?.isReady() === true && conversationEnabled(target),
    resolveBinding: target => bindingFor(target)?.binding,
    resolvePrivatePeer: privatePeerFor,
    isSimulationGroup: (_id, target) => target ? runtime.isConversationActive(target) : false,
    waitForSimulation: true,
    wakeSim: (id, card, runOptions, target) => runtime.wakeForCommitment(id, card, runOptions, target),
    loadConfig: () => ({}),
    ...(options.now ? { now: options.now } : {}),
  })
  const textPersonMemory = createTextPersonMemory({
    redis: storage, memory: personMemory,
    ...(options.personProfileExtract ? { extract: options.personProfileExtract } : {}),
    config: () => options.memorySystem,
    token: textBindingToken,
    current(batch) {
      const target = batch.binding.target
      const selected = bindingFor(target)
      return isRunning() && conversationEnabled(target) && !!textInboxFor(target) &&
        !!selected && textBindingToken(selected.binding) === batch.token &&
        (target.kind !== 'private' || privatePeerFor(target) === batch.subjectId && batch.peerId === batch.subjectId) &&
        batch.messages.every(row => options.allowsText?.(row.text, 'incoming') !== false)
    },
    available: target => isRunning() && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    begin: beginMemoryTurn,
    isRecalled: inbox.isRecalled,
    logger,
    ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const conversationMemory = createConversationMemory({
    redis: storage, memory: personMemory,
    midterm: () => options.midtermMemory,
    episodic: () => options.episodicMemory,
    ...(options.summarizeConversation ? { summarize: options.summarizeConversation } : {}),
    resolve(target) {
      if (!isRunning() || !conversationEnabled(target)) return undefined
      const selected = bindingFor(target)
      if (!selected) return undefined
      return { binding: selected.binding, viewer: createPersonaSnapshot({ botId: personMemoryAddress(target).botId,
        personaId: agentPersonaScopeId(selected.binding.agentId), persona: { ...selected.persona, name: String(selected.persona.name ?? '') },
        systemContent: selected.systemContent, binding: selected.binding }) }
    },
    available: target => isRunning() && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn,
    isRunning, allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}), ...(options.now ? { now: options.now } : {}),
  })
  const authorizePrivateSource: NonNullable<Parameters<typeof createAgentSemanticMemory>[0]['authorizePrivateSource']> = async (viewer, source, subjectId, context) => {
    const adapter = adapterFor(source.target)
    const viewerToken = agentBindingToken(viewer), sourceToken = agentBindingToken(source)
    const isCurrent = () => context.isCurrent() && isRunning() && viewer.target.kind === 'private' && source.target.kind === 'group' &&
      viewer.agentId === source.agentId && platformAccountKey(viewer.target.account) === platformAccountKey(source.target.account) &&
      privatePeerFor(viewer.target) === subjectId && bindingIsCurrent(viewer.target, viewerToken) && bindingIsCurrent(source.target, sourceToken) &&
      adapterFor(source.target) === adapter && adapter?.isReady() === true
    if (!adapter || !isCurrent()) return false
    const snapshot = await readGroupMember(source.target, adapter.botUserId, context.signal, isCurrent)
    return !!snapshot && snapshot.member.user.id === adapter.botUserId && isCurrent()
  }
  const history = createAgentHistory({
    redis: storage, memory: personMemory, config: () => options.history,
    resolve: target => isRunning() && conversationEnabled(target) ? bindingFor(target) : undefined,
    available: target => adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning, authorizePrivateSource,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.now ? { now: options.now } : {}),
  })
  const semanticMemory = createAgentSemanticMemory({
    redis: storage, memory: personMemory, config: () => options.semanticMemory,
    ...(options.semanticMemoryBackend ? { backend: options.semanticMemoryBackend } : {}),
    resolve: target => isRunning() && conversationEnabled(target) ? bindingFor(target) : undefined,
    available: target => adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning,
    authorizePrivateSource,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.now ? { now: options.now } : {}),
  })
  const groupMemory = createGroupMemory({
    redis: storage, memory: personMemory, config: () => options.groupMemory,
    ...(options.groupMemoryModel ? { model: options.groupMemoryModel } : {}),
    resolve(target) {
      if (!isRunning() || !conversationEnabled(target) || target.kind === 'private') return undefined
      const selected = bindingFor(target)
      return selected && { binding: selected.binding, viewer: createPersonaSnapshot({ botId: personMemoryAddress(target).botId,
        personaId: agentPersonaScopeId(selected.binding.agentId), persona: { ...selected.persona, name: String(selected.persona.name ?? '') },
        systemContent: selected.systemContent, binding: selected.binding }) }
    },
    botUserId: target => adapterFor(target)?.botUserId ?? '',
    available: target => isRunning() && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    members: readGroupMembers, member: readGroupMember,
    isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}), ...(options.now ? { now: options.now } : {}),
  })
  const groupKnowledge = createGroupKnowledgeTool({
    management: createGroupMemoryManagement({ redis: storage, memory: personMemory, adapter: adapterFor,
      resolve: bindingFor, isRecalled: inbox.isRecalled, ...(options.now ? { now: options.now } : {}) }),
    member: readGroupMember, actions: messageActions,
  })
  const textConversation = createTextConversation({
    inbox, actions: messageActions, personMemory,
    bindingToken: textBindingToken,
    groupToolNames: target => options.groupTextTools?.(target) ?? [],
    groupTools: createGroupTextTools({ commitment: new commitments.CommitmentTool(), memory: new memories.DelegateMemoryTool(),
      ...(options.groupMemory?.enabled === true ? { knowledge: groupKnowledge } : {}) }),
    learnConfirmed: (incoming, binding, isCurrent) => textPersonMemory.enqueue(incoming, binding, isCurrent),
    async readConversationMemory(incoming, viewer, isCurrent) {
      const selected = bindingFor(incoming.conversation)
      if (!selected) return { digest: '', episodes: '' }
      return conversationMemory.read(selected.binding, viewer, isCurrent, { userId: incoming.sender.id, query: incoming.text })
    },
    async readGroupMemory(incoming, _viewer, isCurrent) {
      const selected = bindingFor(incoming.conversation)
      return selected ? groupMemory.prepare(selected.binding, incoming.messageId, isCurrent) : ''
    },
    async readSemanticMemory(incoming, isCurrent, signal) {
      const selected = bindingFor(incoming.conversation)
      const query = incoming.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
      return selected ? semanticMemory.read(selected.binding, query, isCurrent, signal, incoming.messageId ? [incoming.messageId] : [],
        incoming.conversation.kind === 'private' && incoming.messageId ? {
          messageId: incoming.messageId, authorId: incoming.sender.id, at: incoming.occurredAt,
        } : undefined) : undefined
    },
    ...(options.history?.enabled === true ? { async readHistory(incoming: IncomingMessage, input: Record<string, unknown>, guard: () => boolean, signal?: AbortSignal) {
      const selected = bindingFor(incoming.conversation)
      if (!selected || !incoming.messageId) throw new Error('历史查询缺少当前真实消息')
      return history.read(selected.binding, input, { messageId: incoming.messageId, authorId: incoming.sender.id,
        text: incoming.text, at: incoming.occurredAt, mentions: incoming.mentions,
      }, guard, signal)
    } } : {}),
    async isGroupMemoryCurrent(incoming, expected, guard) {
      const selected = bindingFor(incoming.conversation)
      return !!selected && guard() && await groupMemory.read(selected.binding, guard, true) === expected && guard()
    },
    async recordGroupReply(incoming, binding, guard) {
      if (incoming.conversation.kind === 'group') try { await groupMemory.confirmed(binding, guard) } catch { logger.warn('[Agent] 群学习登记失败') }
    },
    async recordEpisode(incoming, source, reply, replyId, isCurrent) {
      if (!source.binding || !incoming.messageId) return
      await conversationMemory.recordEpisode({ binding: source.binding, source, at: options.now?.() ?? Date.now(),
        userId: incoming.sender.id, userName: incoming.senderName ?? '', summary: incoming.text.slice(0, 120), reply,
        messageIds: [incoming.messageId], replyIds: [replyId],
        ...(incoming.conversation.kind === 'private' ? { peerId: incoming.sender.id } : {}),
      }, isCurrent)
    },
    isPrivatePeer: (target, sender) => sender.id === privatePeerFor(target),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false && options.allowsText?.(text, 'incoming') !== false,
    async reserveGroupTurn(target, now) {
      const budget = await runtime.groupTextBudget(target, now)
      if (budget.dailyCostCny > 0 && budget.todayCostCny >= budget.dailyCostCny) return false
      return await inbox.reserveGroupTextTurn(target, dayKey(now), budget.maxTurns, budget.minGapMs, budget.carriedTurns)
    },
    async model(request, target, signal, isCurrent, ensureCurrent) {
      const response = await options.YTapi(request, options.getExecutionConfig(), signal, isCurrent, ensureCurrent)
      if (target.kind === 'group' && !response.error) {
        options.recordTokens?.({ scope: simulationAddressKey(target), stage: 'group-text', model: String(response.model ?? ''), usage: response.usage })
      }
      return response
    },
    ...(options.now ? { now: options.now } : {}),
  })

  const consumers = new Map<string, Promise<void>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let maintenance: ReturnType<typeof setInterval> | undefined
  let shuttingDown: Promise<void> | undefined
  let started = false

  async function accept(adapter: PlatformConnectionAdapter, event: PlatformConversationEvent): Promise<void> {
    if (!isRunning()) throw new Error('独立宿主正在停止')
    const target = inboxEventTarget(event)
    if (!isConversationAddress(target) || adapterFor(target) !== adapter || !adapter.isReady() || !hasValidInboundEvent(event, adapter)) return
    const privateChat = target.kind === 'private'
    if (event.kind === 'recall') {
      textPersonMemory.invalidate(target)
      conversationMemory.invalidate(target)
      semanticMemory.invalidate(target)
      history.invalidate(target)
      groupMemory.invalidate(target)
      // A recalled source may have been retrieved by another turn in this account.
      for (const invalidate of memoryTurns.get(platformAccountKey(target.account))?.keys() ?? []) invalidate()
      for (const invalidate of pendingSends.get(conversationAddressKey(target)) ?? []) invalidate()
      for (const invalidate of pendingTools.get(conversationAddressKey(target)) ?? []) invalidate()
      // Each workflow revokes its in-memory owners synchronously. A failing ledger cannot prevent sibling fences.
      const results = await Promise.allSettled([
        ...(mediaRelayConfig.enabled ? [mediaOutbox.cancelSource(target, event.messageId)] : []),
        ...(torrentConfig.enabled ? [torrent.cancelSource(target, event.messageId)] : []),
        (async () => {
          const received = await inbox.canReply(target, event.messageId)
          const binding = received ? undefined : bindingFor(target)?.binding
          if (!received && !binding) return
          if ((target.kind === 'group' || privateChat) && await inbox.recallText(target, event.messageId)) textConversation.invalidate(target)
          const queue = privateChat ? undefined : await inbox.accept({ event })
          const { botId, scene } = personMemoryAddress(target)
          await revokePersonMemorySourceForAccount(personMemory, botId, scene, event.messageId, binding && agentPersonaScopeId(binding.agentId))
          if (queue) kickInbox(queue)
        })(),
      ])
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      return
    }
    if (!conversationEnabled(target)) return
    if (event.kind === 'message') {
      const request = personMemoryCommand(event.message)
      if (request) {
        const { sender, binding, messageId, occurredAt } = event.message
        const age = (options.now?.() ?? Date.now()) - occurredAt
        if (!request.standalone || !messageId || age >= privacyCommandMaxAgeMs || age < -privacyCommandClockSkewMs ||
            (target.kind !== 'group' && !privateChat) ||
            (privateChat && sender.id !== privatePeerFor(target, adapter))) return
        const persona = bindingFor(target)
        if (!persona || (binding && !isSameBinding(binding, persona.binding))) return
        const text = personMemoryCommandText[request.command]
        const commandEvent = { kind: 'message' as const, message: { version: 1 as const, conversation: target, sender,
          messageId, occurredAt, text, parts: [{ kind: 'text' as const, text }], mentions: [], directedToAccount: privateChat } }
        const accountKey = platformAccountKey(target.account)
        const finishAdmission = beginPrivacyAdmission(persona.binding)
        try {
          const privacyQueue = await inbox.accept({
            event: commandEvent, bindingToken: agentBindingToken(persona.binding), privacyCommand: request.command,
          }, undefined, pending => setPrivacyBacklog(accountKey, pending))
          kickInbox(privacyQueue)
        } catch (error) {
          // Storage may have accepted the row before losing its reply. Rebuild the fence
          // from the account queue rather than opening it on an uncertain acceptance.
          setPrivacyBacklog(accountKey, true)
          kickInbox({ account: target.account, kind: 'privacy' })
          throw error
        } finally {
          finishAdmission()
        }
        return
      }
    }
    const queue = textInboxFor(target)
    let queued = event
    if (queue) {
      if (event.kind !== 'message') return
      const { sender, occurredAt, messageId, quote, directedToAccount } = event.message
      if (privateChat && sender.id !== privatePeerFor(target, adapter)) return
      const text = event.message.text.trim()
      const extractionCandidate = extraction.isCandidate(event.message), extractionCommand = extraction.isCommand(event.message)
      const mediaCandidate = isMediaRelayCandidate(event.message)
      if (!text && !extractionCandidate && !mediaCandidate || text.startsWith('#') || (text && !privateChat && '.\\/'.includes(text.charAt(0)) && !extractionCommand)) return
      const quoteId = isMessageId(quote?.messageId) ? quote.messageId : undefined
      const message: IncomingMessage = {
        version: 1, conversation: target, sender, occurredAt, text,
        ...(messageId ? { messageId } : {}), parts: event.message.parts.filter(part => part.kind === 'text' || part.kind === 'forward' || part.kind === 'file' || (extractionCandidate || mediaCandidate) && part.kind === 'extension').map(part => part.kind === 'file' ? { kind: 'file' as const, ...(part.name ? { name: part.name.slice(0, 255) } : {}) } : part),
        ...(event.message.senderName ? { senderName: event.message.senderName } : {}),
        mentions: event.message.mentions, directedToAccount: privateChat || directedToAccount,
        ...((!privateChat || extractionCommand) && quoteId ? {quote: {messageId: quoteId, parts: []}} : {}),
      }
      queued = { kind: 'message', message }
    } else if (event.kind === 'message') {
      const { binding: _binding, quote, ...incoming } = event.message
      const reloadImages = !!adapter.readMessageImages
      const parts = incoming.parts.map(part =>
        part.kind === 'image' && (reloadImages || part.resource?.kind === 'reference') ? { kind: 'image' as const } :
        part.kind === 'file' ? { kind: 'file' as const, ...(part.name ? { name: part.name.slice(0, 255) } : {}) } : part)
      queued = { kind: 'message', message: {
        ...incoming, parts, ...quoteReference(quote),
      } }
    }
    const persona = bindingFor(target)
    if (!persona) return
    if (event.kind === 'message' && event.message.binding && !isSameBinding(event.message.binding, persona.binding)) return
    if (event.kind === 'message' && (options.allowsText?.(event.message.text, 'incoming') === false || !allowsFileNames(event.message))) {
      if (queue) textConversation.invalidate(target)
      return
    }
    if (queued.kind === 'message') queued = { ...queued, message: mediaSafeMessage(queued.message) }
    const inboxQueue = await inbox.accept({ event: queued, bindingToken: queue ? textBindingToken(persona.binding) : agentBindingToken(persona.binding) }, queue)
    kickInbox(inboxQueue)
  }

  async function applyPrivacyCommand(incoming: IncomingMessage, command: PersonMemoryCommand, token: string | undefined,
    raw: string, adapter: PlatformConnectionAdapter): Promise<boolean> {
    const { conversation: target, messageId, sender } = incoming
    const kind = target.kind
    const persona = bindingFor(target)
    if ((kind !== 'group' && kind !== 'private') || !conversationEnabled(target) || !messageId ||
        !persona || agentBindingToken(persona.binding) !== token) return true
    const state = await inbox.privacyCommandState(target, messageId, raw)
    if (!state || await inbox.isRecalled(target, messageId)) return true
    if (kind === 'private' && !adapter.isReady()) return false
    const isCurrent = () => isRunning() && conversationEnabled(target) && bindingIsCurrent(target, token) &&
      (kind === 'group' || sender.id === privatePeerFor(target, adapter))
    if (!isCurrent()) return true
    if (state === 'pending') {
      const { botId, scene } = personMemoryAddress(target)
      const identity = { botId, personaId: agentPersonaScopeId(persona.binding.agentId) }
      try {
        await personMemory.applyPrivacyCommand({ identity, subjectId: sender.id, command,
          ...(kind === 'group' ? { scene } : {}) }, inbox.privacyCommandReceipt(target, messageId, raw), isCurrent)
      } catch (error) {
        if (isRunning() && (!isCurrent() || await inbox.isRecalled(target, messageId) ||
            !await inbox.privacyCommandState(target, messageId, raw))) return true
        throw error
      }
    }
    if (!adapter.isReady()) return false
    const confirmation = guardPendingSend(conversationAddressKey(target), isCurrent)
    try {
      if (!confirmation.isCurrent() || !await inbox.claimPrivacyConfirmation(target, messageId, raw)) return true
      const text = sanitizeFinalReplyText(privacyConfirmations[command][kind])
      if (text && confirmation.isCurrent()) {
        await messageActions.send({ version: 1, kind: 'message.send', target, binding: persona.binding,
          parts: [{kind: 'text', text}], ...(kind === 'group' ? { replyTo: messageId } : {}) }, { isCurrent: confirmation.isCurrent })
      }
    } finally {
      confirmation.release()
    }
    return true
  }

  function torrentCurrent(): boolean {
    try { return torrentConfig.enabled && options.torrentDownload?.enabled === true && options.isTorrentDownloadCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  function sameTorrentSource(message: IncomingMessage, target: ConversationAddress, expected: AgentTorrentSource): boolean {
    return isConversationAddress(message.conversation) && conversationAddressKey(message.conversation) === conversationAddressKey(target) &&
      message.messageId === expected.messageId && message.occurredAt === expected.occurredAt && platformAccountKey(message.sender) === platformAccountKey(expected.sender)
  }
  async function torrentSourceAllowed(message: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    const target = binding.target
    if (!torrentCurrent() || !message.messageId || options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message) ||
      !await inbox.canReply(target, message.messageId) || await inbox.isRecalled(target, message.messageId)) return false
    const { botId, scene } = personMemoryAddress(target), excerpt = message.text || '[磁链下载]'
    const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: message.sender.id })
    return !isPersonMemoryRedacted({ scene, messageId: message.messageId, authorId: message.sender.id, at: message.occurredAt, excerpt }, excerpt, redactions)
  }
  function torrentResponsible(source: IncomingMessage): boolean {
    if (!torrentCurrent() || source.conversation.kind !== 'group') return false
    try {
      const siblings = [...adapters.values()].filter(adapter => samePlatformNamespace(adapter.account, source.conversation.account))
      if (siblings.some(adapter => [adapter.account.id, adapter.botUserId].includes(source.sender.id))) return false
      const candidates = siblings.filter(adapter => adapter.isReady() && adapter.readMessage && adapter.actions.sendRequesterArchive &&
        conversationEnabled({ account: adapter.account, kind: 'group', id: source.conversation.id }) &&
        bindingFor({ account: adapter.account, kind: 'group', id: source.conversation.id }))
        .sort((a, b) => a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
      const mentioned = candidates.filter(adapter => source.mentions.some(user => samePlatformNamespace(user, adapter.account) && user.id === adapter.botUserId))
      const pool = mentioned.length ? mentioned : candidates
      if (!pool.length) return false
      let hash = 2166136261
      const key = `${source.conversation.id}:${pool.map(adapter => adapter.account.id).join(',')}`
      for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
      return platformAccountKey(pool[hash % pool.length]!.account) === platformAccountKey(source.conversation.account)
    } catch { return false }
  }
  async function openTorrentContext(record: { readonly binding: AgentBindingSnapshot; readonly source: AgentTorrentSource;
    readonly trigger: AgentTorrentSource; readonly expiresAt: number }, externalSignal: AbortSignal): Promise<AgentTorrentWorkflowContext | 'wait' | undefined> {
    const binding = record.binding, target = binding.target, token = agentBindingToken(binding)
    if (!torrentCurrent() || target.kind !== 'group' || !conversationEnabled(target) || !bindingIsCurrent(target, token)) return undefined
    const adapter = adapterFor(target)
    if (!adapter?.readMessage || !adapter.actions.sendRequesterArchive) return undefined
    if (!adapter.isReady()) return 'wait'
    const memoryTurn = await beginMemoryTurn(binding), cancel = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, externalSignal,
      AbortSignal.timeout(Math.max(1, Math.min(2_700_000, record.expiresAt - (options.now?.() ?? Date.now())))), ...(options.signal ? [options.signal] : [])]) }
    catch { memoryTurn.release(); return undefined }
    const pending = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && torrentCurrent() &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && memoryTurn.isCurrent() && bindingIsCurrent(target, token))
    const isCurrent = () => !signal.aborted && pending.isCurrent(), observed = new Map<string, IncomingMessage>()
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('磁链所属会话已失效')
      for (const message of observed.values()) if (!await torrentSourceAllowed(message, binding)) { cancel.abort(); throw new Error('磁链来源已失效') }
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('磁链所属会话已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25); timer.unref()
    return { signal, isCurrent, ensureCurrent,
      async read(messageId, expected) {
        if (![record.source, record.trigger].some(item => item.messageId === messageId && item.occurredAt === expected.occurredAt &&
          platformAccountKey(item.sender) === platformAccountKey(expected.sender))) return undefined
        await ensureCurrent()
        const result = await adapter.readMessage!(target, messageId, { isCurrent })
        await ensureCurrent()
        if (!result || !sameTorrentSource(result, target, expected) || !await torrentSourceAllowed(result, binding) || !isCurrent()) return undefined
        observed.set(messageId, result)
        return result
      },
      release() { clearInterval(timer); cancel.abort(); pending.release(); memoryTurn.release() },
    }
  }
  async function handleTorrent(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!torrent.isCandidate(incoming)) return false
    const age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (age < -privacyCommandClockSkewMs || age >= textConversationSeconds * 1000) return true
    return await torrent.handle(incoming, binding)
  }

  function mediaRelayCurrent(): boolean {
    try { return mediaRelayConfig.enabled && options.mediaRelay?.enabled === true && options.isMediaRelayCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  function mediaProviderEnabled(provider: AgentMediaShare['provider']): boolean {
    try { return (mediaRelayConfig.providers ?? ['bilibili']).includes(provider) &&
      (options.mediaRelay?.providers ?? ['bilibili']).includes(provider) }
    catch { return false }
  }
  function isMediaRelayCandidate(source: IncomingMessage): boolean {
    return mediaRelayCurrent() && source.conversation.kind === 'group' && !!source.messageId &&
      (source.parts.some(part => part.kind === 'extension' && (part.type === 'json' ||
        part.type === 'bilibili' && mediaProviderEnabled('bilibili') || part.type === 'douyin' && mediaProviderEnabled('douyin') ||
        part.type === 'xiaohongshu' && mediaProviderEnabled('xiaohongshu') || part.type === 'youtube' && mediaProviderEnabled('youtube') ||
        part.type === 'pixiv' && mediaProviderEnabled('pixiv'))) ||
        mediaProviderEnabled('bilibili') && /(?:b23\.tv|bilibili\.com)/iu.test(source.text) ||
        mediaProviderEnabled('douyin') && /(?:douyin\.com|iesdouyin\.com)/iu.test(source.text) ||
        mediaProviderEnabled('xiaohongshu') && /(?:xiaohongshu\.com|xhslink\.com)/iu.test(source.text) ||
        mediaProviderEnabled('youtube') && /(?:youtube\.com|youtu\.be)/iu.test(source.text) ||
        mediaProviderEnabled('pixiv') && /pixiv\.net/iu.test(source.text))
  }
  function mediaResponsible(source: IncomingMessage): boolean {
    if (source.conversation.kind !== 'group' || !mediaRelayCurrent()) return false
    try {
      const siblings = [...adapters.values()].filter(adapter => samePlatformNamespace(adapter.account, source.conversation.account))
      if (siblings.some(adapter => source.sender.id === adapter.account.id || source.sender.id === adapter.botUserId)) return false
      const candidates = siblings.filter(adapter => adapter.isReady() && adapter.readMediaShare && adapter.actions.sendMediaRelay &&
        bindingFor({ account: adapter.account, kind: 'group', id: source.conversation.id }))
        .sort((a, b) => a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
      const mentioned = candidates.filter(adapter => source.mentions.some(user => samePlatformNamespace(user, adapter.account) && user.id === adapter.botUserId))
      const pool = mentioned.length ? mentioned : candidates
      if (!pool.length) return false
      let hash = 2166136261
      const key = `${source.conversation.id}:${pool.map(adapter => adapter.account.id).join(',')}`
      for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
      return platformAccountKey(pool[hash % pool.length]!.account) === platformAccountKey(source.conversation.account)
    } catch { return false }
  }
  async function openMediaRelayContext(record: Pick<AgentMediaOutboxRecord, 'binding' | 'expiresAt'> & {
    readonly source: Pick<AgentMediaOutboxRecord['source'], 'messageId' | 'sender' | 'occurredAt'> & { readonly share?: AgentMediaShare }
  }, externalSignal: AbortSignal): Promise<AgentMediaOutboxContext | 'wait' | undefined> {
    const binding = record.binding, target = binding.target, source = record.source
    if (!mediaRelayCurrent() || source.share && !mediaProviderEnabled(source.share.provider) || target.kind !== 'group' || !conversationEnabled(target) ||
        !bindingIsCurrent(target, agentBindingToken(binding))) return undefined
    const adapter = adapterFor(target)
    if (!adapter?.readMediaShare || !adapter.actions.sendMediaRelay) return undefined
    if (!adapter.isReady()) return 'wait'
    const memoryTurn = await beginMemoryTurn(binding), cancel = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, externalSignal,
      AbortSignal.timeout(Math.max(1, Math.min(86_400_000, record.expiresAt - (options.now?.() ?? Date.now())))), ...(options.signal ? [options.signal] : [])]) }
    catch { memoryTurn.release(); return undefined }
    let observed: IncomingMessage | undefined
    const expected = agentBindingToken(binding)
    const pending = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && mediaRelayCurrent() &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && memoryTurn.isCurrent() &&
      bindingIsCurrent(target, expected) && (!observed || mediaResponsible(observed)))
    const isCurrent = () => !signal.aborted && pending.isCurrent() && (!source.share || mediaProviderEnabled(source.share.provider))
    const { botId, scene } = personMemoryAddress(target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const allowsSource = async (message: IncomingMessage): Promise<boolean> => {
      if (!isCurrent() || message.messageId !== source.messageId || message.occurredAt !== source.occurredAt ||
          conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
          platformAccountKey(message.sender) !== platformAccountKey(source.sender) || !mediaResponsible(message) ||
          options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message)) return false
      if (!await inbox.canReply(target, source.messageId) || await inbox.isRecalled(target, source.messageId) || !isCurrent()) return false
      const excerpt = message.text || '[媒体分享]'
      const redactions = await personMemory.getRedactions({ identity, subjectId: message.sender.id })
      if (isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: message.sender.id, at: source.occurredAt, excerpt }, excerpt, redactions) || !isCurrent()) return false
      observed = message
      return true
    }
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent() || observed && !await allowsSource(observed)) throw new Error('媒体来源已失效')
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('媒体来源已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25); timer.unref()
    return {
      signal, isCurrent, ensureCurrent,
      async readSource() {
        await ensureCurrent()
        const result = await adapter.readMediaShare!(target, source.messageId, { signal, isCurrent,
          expectedSource: { author: source.sender, occurredAt: source.occurredAt }, allowsSource })
        await ensureCurrent()
        if (!result || !mediaProviderEnabled(validateAgentMediaShare(result.share).provider) || !await allowsSource(result.message)) return undefined
        await ensureCurrent()
        return result
      },
      release() { clearInterval(timer); cancel.abort(); pending.release(); memoryTurn.release() },
    }
  }
  async function handleMediaRelay(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!incoming.messageId || !isMediaRelayCandidate(incoming) || !mediaResponsible(incoming)) return false
    const now = options.now?.() ?? Date.now(), age = now - incoming.occurredAt
    if (age < -privacyCommandClockSkewMs || age >= textConversationSeconds * 1000) return true
    const context = await openMediaRelayContext({ binding, expiresAt: now + 86_400_000,
      source: { messageId: incoming.messageId, sender: incoming.sender, occurredAt: incoming.occurredAt } }, toolCancellation.signal)
    if (context === 'wait') throw new Error('媒体来源账号暂时断线')
    if (!context) return false
    try {
      const result = await context.readSource()
      if (!result) return false
      await context.ensureCurrent?.()
      const queued = await mediaOutbox.ledger.enqueue({ binding, source: { messageId: incoming.messageId,
        sender: incoming.sender, occurredAt: incoming.occurredAt, share: validateAgentMediaShare(result.share) } })
      if (queued === 'full') throw new Error('媒体队列已满')
      void mediaOutbox.tick().catch(() => {})
      return true
    } finally { context.release() }
  }
  async function handleMusicExtraction(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!extraction.isCandidate(incoming)) return false
    const target = binding.target, adapter = adapterFor(target), token = agentBindingToken(binding)
    const age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (!adapter || !incoming.messageId || age >= textConversationSeconds * 1000 || age < -privacyCommandClockSkewMs) return true
    const memoryTurn = await beginMemoryTurn(binding)
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, AbortSignal.timeout(360_000),
      ...(options.signal ? [options.signal] : [])])
    const sendGuard = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && isRunning() && memoryTurn.isCurrent() && options.isMusicExtractionCurrent?.() !== false &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && bindingIsCurrent(target, token))
    const isCurrent = () => !signal.aborted && sendGuard.isCurrent()
    const sources = new Map<string, IncomingMessage>()
    const { botId, scene } = personMemoryAddress(target)
    const identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const allowsSource = async (source: IncomingMessage): Promise<boolean> => {
      if (!isCurrent() || !isConversationAddress(source.conversation) || conversationAddressKey(source.conversation) !== conversationAddressKey(target) ||
          !source.messageId || !isMessageId(source.messageId) || !isPlatformAccount(source.sender) || !samePlatformNamespace(source.sender, target.account) ||
          !Number.isSafeInteger(source.occurredAt) || source.occurredAt <= 0 ||
          options.allowsText?.(source.text, 'incoming') === false || !allowsFileNames(source)) return false
      if (source.messageId === incoming.messageId && (platformAccountKey(source.sender) !== platformAccountKey(incoming.sender) ||
          source.occurredAt !== incoming.occurredAt)) return false
      if (!await inbox.canReply(target, incoming.messageId!) || await inbox.isRecalled(target, source.messageId) || !isCurrent()) return false
      const excerpt = source.text || '[音乐分享]'
      const redactions = await personMemory.getRedactions({ identity, subjectId: source.sender.id })
      if (isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: source.sender.id, at: source.occurredAt, excerpt }, excerpt, redactions) || !isCurrent()) return false
      sources.set(source.messageId, source)
      return true
    }
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('音乐提取所属会话已失效')
      for (const source of sources.values()) if (!await allowsSource(source)) throw new Error('音乐提取来源已失效')
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('音乐提取所属会话已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    try { return await extraction.handle(incoming, binding, { signal, isCurrent, ensureCurrent, allowsSource }) }
    finally { clearInterval(timer); cancel.abort(); sendGuard.release(); memoryTurn.release() }
  }

  async function consumeInbox(queue: AgentInboxQueue): Promise<void> {
    const accountKey = platformAccountKey(queue.account)
    const setPrivacyPending = queue.kind === 'privacy' ? (pending: boolean) => setPrivacyBacklog(accountKey, pending) : undefined
    while (isRunning()) {
      const item = await inbox.next(queue, setPrivacyPending)
      if (!item) return
      if (!isRunning()) return
      const { event: originalEvent, bindingToken } = item.entry ?? {}
      // Older inboxes retain their exact ACK bytes, but access queries cannot flow
      // from a recovered entry into a new model/history record.
      let event = originalEvent
      const target = inboxEventTarget(event)
      const adapter = isConversationAddress(target) && platformAccountKey(target.account) === accountKey ? adapterFor(target) : undefined
      if (event && target && adapter && hasValidInboundEvent(event, adapter) &&
        (event.kind !== 'message' || options.allowsText?.(event.message.text, 'incoming') !== false && allowsFileNames(event.message))) {
        if (event.kind === 'message') event = { ...event, message: mediaSafeMessage(event.message) }
        const request = event.kind === 'message' ? personMemoryCommand(event.message) : undefined
        if (queue.kind === 'privacy') {
          if (event.kind === 'message' && request?.standalone && 'privacyCommand' in item.entry && request.command === item.entry.privacyCommand &&
              !await applyPrivacyCommand(event.message, request.command, bindingToken, item.raw, adapter)) return
        } else if (event.kind === 'recall') {
          if (queue.kind === 'simulation' && target.kind !== 'private' && await inbox.isRecalled(target, event.messageId)) {
            await runtime.handleRecall({ message_id: event.messageId }, target)
          }
        } else if (!request) {
          const expectedQueue = textInboxFor(target)?.kind ?? 'simulation'
          const persona = conversationEnabled(target) && expectedQueue === queue.kind ? bindingFor(target) : undefined
          if (persona && (queue.kind === 'simulation' ? agentBindingToken(persona.binding) : textBindingToken(persona.binding)) === bindingToken &&
              (event.kind !== 'message' || !event.message.binding || isSameBinding(event.message.binding, persona.binding))) {
            if (event.kind === 'message' && (extraction.isCandidate(event.message) || isMediaRelayCandidate(event.message) || torrent.isCandidate(event.message)) && !adapter.isReady()) return
            const torrentHandled = event.kind === 'message' && await handleTorrent(event.message, persona.binding)
            const mediaHandled = !torrentHandled && event.kind === 'message' && await handleMediaRelay(event.message, persona.binding)
            const musicHandled = !torrentHandled && !mediaHandled && event.kind === 'message' && await handleMusicExtraction(event.message, persona.binding)
            if (torrentHandled || mediaHandled || musicHandled) {
              // Deterministic relay commands and accepted shares never become model prompts.
            } else if (queue.kind !== 'simulation' && event.kind === 'message') {
              if (!adapter.isReady()) return
              const expected = agentBindingToken(persona.binding)
              const incoming = event.message
              const memoryTurn = await beginMemoryTurn(persona.binding)
              const isCurrent = () => isRunning() && conversationEnabled(target) && textInboxFor(target)?.kind === queue.kind &&
                memoryTurn.isCurrent() && bindingIsCurrent(target, expected)
              try {
                if (options.allowsText?.(incoming.text, 'incoming') !== false) {
                  await conversationMemory.capture(incoming, persona.binding, isCurrent)
                  await semanticMemory.capture(incoming, persona.binding, isCurrent)
                  await history.capture(incoming, persona.binding, isCurrent)
                  await groupMemory.capture(incoming, persona.binding, isCurrent)
                  await textConversation.reply(incoming, persona, isCurrent, memoryTurn.signal)
                }
              } finally {
                memoryTurn.release()
              }
            } else if (queue.kind === 'simulation' && event.kind === 'nudge' &&
                'ingressId' in item.entry && isMessageId(item.entry.ingressId)) {
              await runtime.ingestNudge(event, { isCurrent: isRunning, binding: persona.binding, ingressId: item.entry.ingressId })
            } else if (event.kind === 'message' && event.message.messageId && options.allowsText?.(event.message.text, 'incoming') !== false &&
                !await inbox.isRecalled(target, event.message.messageId) && isRunning()) {
              const { quote, ...incoming } = event.message
              await conversationMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await semanticMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await history.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await groupMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await runtime.ingest({ ...incoming, ...quoteReference(quote), binding: persona.binding }, { isCurrent: isRunning })
            }
          }
        }
      }
      if (!isRunning()) return
      await inbox.acknowledge(item.raw, queue, setPrivacyPending)
      if (queue.kind === 'private' || queue.kind === 'group') void textPersonMemory.tick()
      void conversationMemory.tick()
      void semanticMemory.tick()
      void history.tick()
      void groupMemory.tick()
    }
  }

  function kickInbox(queue: AgentInboxQueue): Promise<void> | undefined {
    const key = JSON.stringify([queue.kind, platformAccountKey(queue.account)])
    if (!isRunning() || retryTimers.has(key)) return undefined
    const current = consumers.get(key)
    if (current) return current
    const consumer = consumeInbox(queue).catch(() => {
      logger.warn('[Agent] 收件处理失败，保留队列并等待重试')
      if (isRunning()) retryTimers.set(key, setTimeout(() => { retryTimers.delete(key); kickInbox(queue) }, 1_000))
    }).finally(() => { consumers.delete(key) })
    consumers.set(key, consumer)
    return consumer
  }

  function kickInboxes(): Promise<void>[] {
    const recovery: Promise<void>[] = []
    for (const {account} of adapters.values()) {
      const privacy = kickInbox({ account, kind: 'privacy' })
      const simulation = kickInbox({ account, kind: 'simulation' })
      if (privacy) recovery.push(privacy)
      if (simulation) recovery.push(simulation)
      if (options.privateChatEnabled) kickInbox({ account, kind: 'private' })
      kickInbox({ account, kind: 'group' })
    }
    return recovery
  }

  function tickCommitments(): void {
    if (!isRunning()) return
    for (const adapter of adapters.values()) {
      if (!adapter.isReady()) continue
      void commitments.commitmentTick(adapter.account).catch(() => logger.warn('[Agent] 承诺调度失败，稍后重试'))
    }
  }

  async function start(): Promise<void> {
    if (started || stopping) return
    started = true
    try {
      options.signal?.throwIfAborted()
      await inbox.moveLegacySimulationQueue(isRunning)
      if (!isRunning()) { await stop(); return }
      const pending = await inbox.accountsWithPrivacyWork(options.adapters.map(adapter => adapter.account))
      for (const account of pending) setPrivacyBacklog(platformAccountKey(account), true)
      if (!isRunning()) { await stop(); return }
      await runtime.start()
      if (!isRunning()) { runtime.stop(); await stop(); return }
      await Promise.all([...adapters.values()].map(adapter => adapter.start(event => accept(adapter, event))))
      options.signal?.throwIfAborted()
      if (!isRunning()) return
      if (mediaRelayConfig.enabled) await mediaOutbox.start()
      if (torrentConfig.enabled) await torrent.start()
      const recovered = kickInboxes()
      maintenance = setInterval(() => { kickInboxes(); tickCommitments(); if (mediaRelayConfig.enabled) void mediaOutbox.tick().catch(() => {}); if (torrentConfig.enabled) void torrent.tick().catch(() => {}); void textPersonMemory.tick(); void conversationMemory.tick(); void semanticMemory.tick(); void history.tick(); void groupMemory.tick() }, 1_000)
      maintenance.unref()
      await Promise.all(recovered)
      if (!isRunning()) return
      await runtime.sweepOnce()
      await textPersonMemory.tick()
      await conversationMemory.tick()
      await semanticMemory.tick()
      await history.tick()
      await groupMemory.tick()
      if (isRunning()) tickCommitments()
    } catch (error) {
      await stop()
      throw error
    }
  }

  function stop(): Promise<void> {
    if (shuttingDown) return shuttingDown
    stopping = true
    toolCancellation.abort()
    if (maintenance) clearInterval(maintenance)
    for (const retryTimer of retryTimers.values()) clearTimeout(retryTimer)
    for (const waiter of privacyWaiters.values()) waiter.resolve()
    privacyWaiters.clear()
    for (const adapter of adapters.values()) adapter.stop()
    runtime.stop()
    shuttingDown = Promise.allSettled([...consumers.values(), torrent.stop(), mediaOutbox.stop(), commitments.drainCommitmentTicks(), runtime.drain(), textPersonMemory.stop(), conversationMemory.stop(), semanticMemory.stop(), history.stop(), groupMemory.stop()]).then(() => {})
    return shuttingDown
  }

  options.signal?.addEventListener('abort', () => { void stop() }, { once: true })

  return {
    runtime,
    start,
    stop,
    async resumePendingWork() {
      if (started && !stopping) {
        kickInboxes()
        if (torrentConfig.enabled) await torrent.tick()
        tickCommitments()
        await runtime.sweepOnce()
        await textPersonMemory.tick()
        await conversationMemory.tick()
        await groupMemory.tick()
      }
    },
  }
}
