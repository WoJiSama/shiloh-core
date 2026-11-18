import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAgentBindingDirectory, createAgentRuntime, type AgentRuntimeOptions,
  type ConversationAddress, type PlatformConnectionAdapter, type PlatformConversationEvent, type OwnMessageSnapshot,
  type SendMessageAction,
  type SendMessageBundleAction, type MessageBundleItem,
  type AgentTool, type AgentToolContext, type AgentToolRequest, type AgentToolMessage, type ConversationMemberProfile,
  type PersonProfileExtractor, type PersonProfileExtractionContext,
  type TextPersonMemoryConfig,
  type MidtermMemoryConfig, type EpisodicMemoryConfig, type ConversationSummaryModel,
  type GroupMemoryConfig, type GroupMemoryModel,
  type AgentSemanticMemoryConfig, type AgentSemanticMemoryBackend,
  type AgentSemanticMemoryQuerySource,
  type AgentFileBytes, type AgentFileRequest, type AgentFileListing, type FileReadGuard,
  type AgentFileUpload, type FileDeliveryReceipt, type SendFileAction,
  type AgentAudioBytes, type AgentVideoBytes, type SendMediaAction,
  type AgentMusicCard, type SendMusicAction,
  type AgentMusicShare, type AgentAudioAttachment, type SendAudioFileAction, type AgentMusicExtractionConfig, type MusicShareReadOptions,
  type AgentMediaArtifact, type AgentMediaResourceContext, type AgentMediaResourcePort, type AgentMediaRelayPlan, type SendMediaRelayAction,
  type AgentVideoInput, type AgentMessageVideo, type MessageVideoReadOptions,
  type AgentGroupLogArtifact, type SendGroupLogAction,
  createAgentDiagnostics, type AgentDiagnosticEvent, type AgentOperationJournal,
  type AgentMediaRelayConfig, type AgentMediaRelayProvider, type AgentMediaShare, type MediaShareReadOptions,
  type AgentBilibiliQualityConfig, type AgentBilibiliQualityRequest, type AgentPreparedBilibiliQuality, type AgentBilibiliQualityProvider,
  type AgentBilibiliAuthSource, type AgentBilibiliAuthSession, type AgentBilibiliAuthService, type SendRequesterBilibiliAuthAction,
  type AgentTorrentProvider, type AgentTorrentConfig, type SendRequesterArchiveAction,
  type AgentHistoryConfig, type AgentHistoryRequestSource, type AgentHistoryRecall,
  type AgentDiceConfig,
  type AgentQqActionsConfig, type AgentQqActionGuard, type AgentQqActionRunner,
  type AgentGiftAction, type AgentGiftDeliveryPort, type AgentGiftReceipt,
  type AgentQzoneAction, type AgentQzoneProvider, type AgentQzoneReceipt,
  type AgentRedPacketPort, type AgentRedPacketPolicy, type AgentRedPacketSnapshot,
  type AgentDeferredActionPolicyConfig, type AgentDeferredActionDefinition, type AgentDeferredFrozenAction,
  type AgentDeferredActionAuthorizationRequest, type AgentDeferredActionExecutionContext,
  createAgentDeferredActionPolicy, createAgentDeferredActionExecutor, createAgentDeferredToolDefinition,
  createAgentDeferredMcpDefinition, createAgentDeferredActionRuntime, createAgentDeferredReminderSender,
  createAgentDeferredActionTool, createAgentDeferredPokeDefinition, AGENT_DEFERRED_POKE_DEFINITION_ID,
  convertLegacyDeferredReminder, stageLegacyDeferredReminders, applyLegacyDeferredReminderTransfer,
  type LegacyDeferredToolMapping, type LegacyDeferredReminderMigrationOptions, type LegacyDeferredReminderStageOptions,
} from 'bl-chat-agent'
import { createOneBotConnection, openQqMediaRelayBridge, createQqMediaRelayDeliveryPort, type QqMediaRelayBridge,
  openQqRequesterArchiveBridge, createQqRequesterArchiveDeliveryPort, type QqRequesterArchiveBridge,
  openQqGroupLogBridge, createQqGroupLogDeliveryPort, type QqGroupLogBridge,
  createQqBilibiliAuthDeliveryPort, QQ_BILIBILI_AUTH_TIMEOUT_MS,
  createQqGiftDeliveryPort, type QqGiftDeliveryOptions,
  createQqQzoneProvider, type QqQzoneProviderOptions,
  createQqRedPacketPort, type QqRedPacketOptions, type QqRedPacketPort,
  createQqInteractionDeliveryPort, type QqInteractionApiAction, type QqInteractionApiOptions } from 'bl-chat-agent/qq'
import { createAgentWebTools } from 'bl-chat-agent/web'
import { createAgentImageTools, type AgentImageBackend } from 'bl-chat-agent/images'
import { openAgentMcpTools, type AgentMcpServerConfig } from 'bl-chat-agent/mcp'
import { createAgentSemanticBackend } from 'bl-chat-agent/semantic'
import { createAgentRepositoryTools, type AgentRepositoryToolsOptions, type AgentGithubOptions } from 'bl-chat-agent/repositories'
import { createAgentModrinthTools, type AgentModrinthOptions, type AgentModrinthToolsOptions } from 'bl-chat-agent/modrinth'
import { createAgentModrinthCardRenderer, buildAgentModrinthCardHtml } from 'bl-chat-agent/modrinth-cards'
import { createAgentRenderingTools, type AgentRenderingConfig, type AgentRenderingToolsOptions, type AgentRenderingContext } from 'bl-chat-agent/rendering'
import { createAgentExcelTool } from 'bl-chat-agent/excel'
import { createAgentFileTextTool } from 'bl-chat-agent/files'
import { createAgentVoiceTool, type AgentVoiceConfig } from 'bl-chat-agent/voice'
import { createAgentMusicTool, createAgentMusicProvider, type AgentMusicConfig } from 'bl-chat-agent/music'
import { createAgentMusicExtractionProvider, parseNeteaseMusicLink } from 'bl-chat-agent/music-extraction'
import { createAgentPixivTools, createAgentPixivSearchProvider, type AgentPixivSearchInput, type AgentPixivSearchResult,
  type AgentPixivSearchProvider, type AgentPixivToolsConfig } from 'bl-chat-agent/pixiv'
import { createAgentVideoAnalysisTool, type AgentVideoAnalysisConfig, validateAgentVideoUploadHosts } from 'bl-chat-agent/video-analysis'
import { createAgentBilibiliSearchProvider, createAgentVideoSearchTools, validateAgentVideoCard, type AgentVideoCard,
  type AgentVideoSearchProvider, type AgentVideoSearchToolsConfig, type AgentBilibiliSearchProviderOptions, type SendVideoCardAction } from 'bl-chat-agent/video-search'
import { createAgentBilibiliQualityProvider, createAgentBilibiliSearchAttachmentProvider, openAgentBilibiliAuthService, validateAgentBilibiliQualityConfig,
  type AgentBilibiliQualityProviderOptions, type AgentBilibiliSearchAttachmentProviderOptions, type AgentBilibiliAuthServiceOptions } from 'bl-chat-agent/bilibili-quality'
import { createAgentGroupLogRenderer, validateAgentGroupLogArtifact, type AgentGroupLogDocument } from 'bl-chat-agent/group-logs'
import { createAgentMediaArtifactStore, validateAgentMediaRelayPlan, createAgentBilibiliRelayProvider, createAgentDouyinRelayProvider,
  createAgentXiaohongshuRelayProvider, parseAgentXiaohongshuReference, readAgentXiaohongshuAccess, xiaohongshuAccessPageUrl,
  createAgentYoutubeRelayProvider, parseAgentYoutubeReference, type AgentYoutubeNative, type AgentYoutubeRequestPolicy,
  createAgentPixivRelayProvider, parseAgentPixivReference, type AgentPixivRelayProviderOptions, type AgentPixivRequestPolicy,
  type AgentMediaRelayPrepareContext, type AgentMediaShareAccess, type AgentXiaohongshuRequestPolicy,
  parseAgentBilibiliReference, parseAgentDouyinReference, validateAgentMediaRelayConfig, validateAgentMediaShare } from 'bl-chat-agent/media-relay'
import { createAgentTorrentProvider, validateAgentTorrentArchive, validateAgentTorrentConfig, parseAgentTorrentMagnet } from 'bl-chat-agent/torrent'
import { createAgentTextImageRenderer } from 'bl-chat-agent/text-images'
import { createAgentMindMapRenderer } from 'bl-chat-agent/mindmaps'
import { createAgentPersonExtractor, createAgentConversationSummary, createAgentGroupMemoryModel } from 'bl-chat-agent/memory'
import { openAgentRedis } from 'bl-chat-agent/redis'
import { openAgentOperationJournal } from 'bl-chat-agent/logging'
import { createAgentInteractionTools, validateAgentInteractionPlan, normalizeInteractionReceipt } from 'bl-chat-agent/interactions'
import type { AgentInteractionPlan, AgentInteractionResult, InteractionReceipt, SendInteractionAction } from 'bl-chat-agent'

const interactionConfiguration: Pick<AgentRuntimeOptions, 'interactions' | 'isInteractionsCurrent' | 'privateTextTools'> = {
  interactions: { enabled: true }, isInteractionsCurrent: () => true, privateTextTools: ['likeTool', 'recallTool'],
}
assert.equal(interactionConfiguration.isInteractionsCurrent?.(), true)
const diceConfig: AgentDiceConfig = { enabled: true, maxDiceCount: 50, maxDiceSides: 1000, maxRounds: 10 }
const diceConfiguration: Pick<AgentRuntimeOptions, 'dice' | 'isDiceCurrent'> = {
  dice: diceConfig, isDiceCurrent: () => true,
}
assert.equal(diceConfiguration.dice?.maxDiceCount, 50)
assert.equal(diceConfiguration.isDiceCurrent?.(), true)
assert.deepEqual(createAgentInteractionTools({ enabled: false }), [])
const interactionTools = createAgentInteractionTools({ enabled: true })
assert.deepEqual(interactionTools.map(tool => tool.name), ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool'])
const interactionAccount = { platform: 'qq', namespace: 'global', id: '19000418' }
const interactionTarget: ConversationAddress = { account: interactionAccount, kind: 'group', id: '310418' }
const interactionUser = { platform: 'qq', namespace: 'global', id: '330418' }
const interactionMember = { user: interactionUser, displayName: '互动验收员', role: 'member' as const }
const interactionBinding = { source: 'configured' as const, id: 'interaction-binding', agentId: 'interaction-agent', revision: '1',
  personaId: 'interaction-persona', connectionId: 'interaction-connection', target: interactionTarget }
const interactionPlans: AgentInteractionPlan[] = []
for (const [index, text, args] of [[0, '戳我一下。', { times: 1 }], [1, '给我点3个赞。', { count: 3 }], [2, '给引用的消息贴一个表情。', { count: 1 }], [3, '撤回你刚才被引用的消息。', {}]] as const) {
  const context: AgentToolContext = {
    binding: interactionBinding, actor: { kind: 'user', user: interactionUser }, botUserId: interactionAccount.id,
    request: { messageId: 'external-interaction-source', replyMessageId: 'external-quoted-message', text, mentions: [] },
    signal: new AbortController().signal, isCurrent: () => true,
    async listMembers() { return { target: interactionTarget, observedAt: Date.now(), members: [interactionMember], complete: true } },
    async readMember() { return { target: interactionTarget, observedAt: Date.now(), member: interactionMember } },
    async interact(plan): Promise<AgentInteractionResult> {
      interactionPlans.push(validateAgentInteractionPlan(plan, interactionAccount))
      return { state: 'confirmed', completed: plan.operations.length, requested: plan.operations.length }
    },
  }
  const result = await interactionTools[index]!.execute(args, context)
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.parse(result.content).state, 'confirmed')
  assert.equal(Object.hasOwn(JSON.parse(result.content), 'messageId'), false)
}
const interactionAction: SendInteractionAction = { version: 1, kind: 'conversation.interact', target: interactionTarget,
  binding: interactionBinding, interaction: interactionPlans[0]!.operations[0]! }
assert.equal(interactionAction.interaction.kind, 'poke')
assert.equal(interactionPlans[3]?.kind, 'message-recall')
const managedMember = { user: { ...interactionUser, id: '330419' }, displayName: '管理目标', role: 'member' as const }
const groupManagementMembers = [
  { ...interactionMember, role: 'admin' as const },
  { user: interactionAccount, displayName: '管理机器人', role: 'admin' as const }, managedMember,
]
for (const [name, text, args, expected] of [
  ['jinyanTool', '禁言330419一分钟。', { target: ['330419'], time: 60 }, 'member-mute'],
  ['jinyanTool', '解除330419的禁言。', { target: ['330419'], time: 0 }, 'member-mute'],
  ['jinyanTool', '确认开启全体禁言。', { target: 'all', time: 300, confirm: true }, 'group-mute'],
  ['jinyanTool', '解除全体禁言。', { target: 'all', time: 0, confirm: true }, 'group-mute'],
  ['changeCardTool', '把330419的群名片改成测试名片。', { target: '330419', cardName: '测试名片' }, 'member-card'],
  ['changeCardTool', '清空330419的群名片。', { target: '330419', cardName: '' }, 'member-card'],
] as const) {
  const context: AgentToolContext = {
    binding: interactionBinding, actor: { kind: 'user', user: interactionUser }, botUserId: interactionAccount.id,
    request: { messageId: 'external-management-source-' + interactionPlans.length, text, mentions: [] },
    signal: new AbortController().signal, isCurrent: () => true,
    async listMembers() { return { target: interactionTarget, observedAt: Date.now(), members: groupManagementMembers, complete: true } },
    async readMember(id) {
      const member = groupManagementMembers.find(value => value.user.id === id)
      return member ? { target: interactionTarget, observedAt: Date.now(), member } : undefined
    },
    async interact(plan): Promise<AgentInteractionResult> {
      const selected = validateAgentInteractionPlan(plan, interactionAccount)
      assert.equal(selected.kind, expected)
      for (const operation of selected.operations) {
        assert.ok('requester' in operation); if ('requester' in operation) assert.deepEqual(operation.requester, interactionUser)
      }
      interactionPlans.push(selected)
      return { state: 'confirmed', completed: plan.operations.length, requested: plan.operations.length }
    },
  }
  const result = await interactionTools.find(tool => tool.name === name)!.execute(args, context)
  assert.equal(result.status, 'succeeded', result.content)
  assert.equal(JSON.parse(result.content).state, 'confirmed')
  assert.equal(Object.hasOwn(JSON.parse(result.content), 'messageId'), false)
}
const publicManagementCalls: { action: QqInteractionApiAction; params: Record<string, unknown> }[] = []
const publicManagementPort = createQqInteractionDeliveryPort({
  account: interactionAccount, connectionId: interactionBinding.connectionId, isReady: () => true,
  async callApi(action, params, scope: QqInteractionApiOptions) {
    assert.ok(scope.signal instanceof AbortSignal); assert.ok(scope.timeoutMs > 0 && scope.timeoutMs <= 30000)
    await scope.ensureCurrent(); assert.equal(scope.isCurrent(), true)
    publicManagementCalls.push({ action, params })
    if (action === 'get_group_member_info') {
      assert.equal(params.no_cache, true); assert.equal(params.group_id, interactionTarget.id)
      const member = groupManagementMembers.find(value => value.user.id === params.user_id)
      assert.ok(member)
      return { status: 'ok', retcode: 0, data: { group_id: interactionTarget.id, user_id: member.user.id, role: member.role } }
    }
    return { status: 'ok', retcode: 0, data: null }
  },
})
for (const plan of interactionPlans.slice(4)) for (const interaction of plan.operations) {
  assert.deepEqual(await publicManagementPort({ version: 1, kind: 'conversation.interact', target: interactionTarget,
    binding: interactionBinding, interaction }), { state: 'confirmed' })
}
assert.deepEqual(publicManagementCalls.filter(value => value.action !== 'get_group_member_info').map(value => value.action),
  ['set_group_ban', 'set_group_ban', 'set_group_whole_ban', 'set_group_whole_ban', 'set_group_card', 'set_group_card'])
const privateInteractionTarget: ConversationAddress = { account: interactionAccount, kind: 'private', id: interactionUser.id }
const ownMetadata: OwnMessageSnapshot = { conversation: privateInteractionTarget, messageId: 'external-own-message', author: interactionAccount, occurredAt: Date.now() }
const ownershipAdapter: Pick<PlatformConnectionAdapter, 'readOwnMessage'> = {
  async readOwnMessage(destination, id, guard) {
    assert.deepEqual(destination, privateInteractionTarget); assert.equal(id, ownMetadata.messageId); assert.equal(guard?.isCurrent?.(), true)
    return ownMetadata
  },
}
assert.deepEqual(await ownershipAdapter.readOwnMessage?.(privateInteractionTarget, ownMetadata.messageId, { isCurrent: () => true }), ownMetadata)
assert.deepEqual(Object.keys(ownMetadata).sort(), ['author', 'conversation', 'messageId', 'occurredAt'])
for (const [name, text, args, expected] of [['likeTool', '给我点3个赞。', { count: 3 }, 'profile-like'], ['recallTool', '撤回你引用的消息。', {}, 'message-recall']] as const) {
  const tool = interactionTools.find(value => value.name === name)!
  const privateResult = await tool.execute(args, {
    binding: { ...interactionBinding, target: privateInteractionTarget }, actor: { kind: 'user', user: interactionUser }, privatePeer: interactionUser, botUserId: interactionAccount.id,
    request: { messageId: 'external-private-source', replyMessageId: ownMetadata.messageId, text, mentions: [] }, signal: new AbortController().signal, isCurrent: () => true,
    async interact(plan) {
      assert.equal(validateAgentInteractionPlan(plan, interactionAccount).kind, expected)
      return { state: 'confirmed', completed: plan.operations.length, requested: plan.operations.length }
    },
  })
  assert.equal(privateResult.status, 'succeeded')
}
const recallAction: SendInteractionAction = { version: 1, kind: 'conversation.interact', target: privateInteractionTarget,
  binding: { ...interactionBinding, target: privateInteractionTarget }, interaction: { kind: 'message-recall', messageId: ownMetadata.messageId } }
assert.equal(recallAction.interaction.kind, 'message-recall')
const interactionReceipt: InteractionReceipt = normalizeInteractionReceipt({ state: 'confirmed' })
assert.deepEqual(interactionReceipt, { state: 'confirmed' })
assert.deepEqual(normalizeInteractionReceipt({ state: 'confirmed', messageId: 'invented' }), { state: 'unknown' })
// @ts-expect-error Non-message confirmations cannot carry a fabricated platform message ID.
const invalidInteractionReceipt: InteractionReceipt = { state: 'confirmed', messageId: 'invented' }
void invalidInteractionReceipt

const packetPolicy: AgentRedPacketPolicy = { enabled: false, allowExplicit: false, allowPasswordSend: false,
  automatic: { enabled: false, toolConfigured: false } }
const qqActionsConfig: AgentQqActionsConfig = { gift: { enabled: false }, qzone: { enabled: false }, redPackets: packetPolicy }
const qqActionsConfiguration: Pick<AgentRuntimeOptions, 'qqActions' | 'isQqActionsCurrent'> = {
  qqActions: qqActionsConfig, isQqActionsCurrent: () => true,
}
assert.equal(qqActionsConfiguration.qqActions?.redPackets?.enabled, false)
const qqGuard: AgentQqActionGuard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
const runQqAction: AgentQqActionRunner = async (_kind, operation) => operation(qqGuard)
assert.deepEqual(await runQqAction('gift', async guard => {
  await guard.ensureCurrent(); return { state: 'failed' as const, completed: 0 as const, code: 'consumer_not_dispatched' }
}), { state: 'failed', completed: 0, code: 'consumer_not_dispatched' })
let consumerNativeCalls = 0
const giftOptions: QqGiftDeliveryOptions = { account: interactionAccount, connectionId: interactionBinding.connectionId,
  supportsGiftPacket: true, isReady: () => false, async callApi(_name, _params, guard) {
    await guard.ensureCurrent(); consumerNativeCalls++; throw Error('offline consumer must not call native QQ')
  } }
const giftPort: AgentGiftDeliveryPort | undefined = createQqGiftDeliveryPort(giftOptions)
assert.ok(giftPort)
const giftAction: AgentGiftAction = { version: 1, kind: 'qq.gift-display', binding: interactionBinding,
  source: { messageId: '120001', author: interactionUser }, plan: { version: 1, recipient: interactionUser, giftType: 'champagne' } }
const giftReceipt: AgentGiftReceipt = await giftPort(giftAction, qqGuard)
assert.equal(giftReceipt.state, 'failed')
const qzoneOptions: QqQzoneProviderOptions = { account: interactionAccount, connectionId: interactionBinding.connectionId,
  isReady: () => false, async callApi(_name, _params, guard) {
    await guard.ensureCurrent(); consumerNativeCalls++; throw Error('offline consumer must not call native Qzone')
  }, async fetch() { consumerNativeCalls++; throw Error('offline consumer must not call Qzone HTTP') } }
const qzoneProvider: AgentQzoneProvider = createQqQzoneProvider(qzoneOptions)
const qzoneAction: AgentQzoneAction = { version: 1, binding: interactionBinding, operation: { kind: 'publish', text: '离线公共接口验证。' } }
const qzoneReceipt: AgentQzoneReceipt = await qzoneProvider.execute(qzoneAction, qqGuard)
assert.equal(qzoneReceipt.state, 'failed')
const redPacketOptions: QqRedPacketOptions = { account: interactionAccount, connectionId: interactionBinding.connectionId,
  driver: 'napcat', supportsRedPacket: true, isReady: () => false, async callApi(_name, _params, guard) {
    await guard.ensureCurrent(); consumerNativeCalls++; throw Error('offline consumer must not call a wallet')
  } }
const nativePacketPort: QqRedPacketPort | undefined = createQqRedPacketPort(redPacketOptions)
assert.ok(nativePacketPort)
const packetPort: AgentRedPacketPort = nativePacketPort
const packet: AgentRedPacketSnapshot | undefined = await packetPort.read(interactionTarget, '120001', qqGuard)
assert.equal(packet, undefined); nativePacketPort.close(); assert.equal(consumerNativeCalls, 0)
// @ts-expect-error A gift acceptance is not a sent text message receipt.
const invalidGiftReceipt: AgentGiftReceipt = { state: 'confirmed', evidence: 'packet-accepted', messageId: 'invented' }
void invalidGiftReceipt

const deferredDefinition: AgentDeferredActionDefinition = createAgentDeferredToolDefinition({
  tool: { name: 'consumerProbe', description: 'offline package contract', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_input, context) {
      assert.equal(context.actor.kind, 'commitment'); assert.equal(context.request, undefined)
      return { status: 'succeeded', content: 'unpersisted consumer result' }
    } }, executor: 'builtin', definitionId: 'consumer:probe:v1', isCurrent: () => true, validate: params => params.fixed === true,
})
const deferredExecutor = createAgentDeferredActionExecutor({ getDefinitions: () => [deferredDefinition] })
const deferredAt = Date.now(), deferredAction: AgentDeferredFrozenAction = {
  tool: deferredDefinition.name, executor: 'builtin', definitionId: deferredDefinition.definitionId, params: { fixed: true },
}
const deferredConfig: AgentDeferredActionPolicyConfig = { enabled: true, rules: [{ id: 'consumer-rule', revision: 'v1',
  bindingIdentity: JSON.stringify(['configured', interactionBinding.id, interactionBinding.agentId, interactionBinding.personaId, interactionBinding.connectionId]),
  scopeKey: JSON.stringify([interactionBinding.agentId, 'qq', 'global', interactionAccount.id, 'group', interactionTarget.id]),
  creatorIds: [interactionUser.id], tool: deferredAction.tool, executor: deferredAction.executor,
  definitionId: deferredAction.definitionId, maxDelayMs: 60_000 }] }
const deferredConfiguration: Pick<AgentRuntimeOptions, 'deferredActions' | 'isDeferredActionsCurrent' | 'getDeferredActionDefinitions' | 'verifyDeferredMigration'> = {
  deferredActions: deferredConfig, isDeferredActionsCurrent: () => true, getDeferredActionDefinitions: () => [deferredDefinition],
  async verifyDeferredMigration(_request, guard) { return !guard.signal.aborted && guard.isCurrent() ? 'denied' : 'unavailable' },
}
assert.equal(deferredConfiguration.getDeferredActionDefinitions?.()[0]?.definitionId, 'consumer:probe:v1')
const deferredPolicy = createAgentDeferredActionPolicy({ getConfig: () => deferredConfig, resolveDefinition: deferredExecutor.resolve,
  mode: () => 'simulation', isToolAllowed: () => true, now: () => deferredAt, async verifyAuthority(input) {
    assert.equal(input.isCurrent(), true); assert.equal(input.signal.aborted, false); return 'allowed'
  } })
const deferredRequest: AgentDeferredActionAuthorizationRequest = { binding: interactionBinding, creator: interactionUser, action: deferredAction,
  source: { kind: 'message', messageId: 'consumer-deferred-source', at: deferredAt }, dueAt: deferredAt + 30_000,
  requestText: '半分钟后执行固定探针并提醒我。' }
const delegation = await deferredPolicy.issue(deferredRequest, qqGuard)
assert.ok(delegation)
const deferredContext: AgentDeferredActionExecutionContext = { kind: 'deferred', taskId: 'consumer-deferred-task', binding: interactionBinding,
  creator: interactionUser, delegation, signal: qqGuard.signal, isCurrent: () => deferredPolicy.isCurrent(delegation, deferredRequest),
  async ensureCurrent() { assert.equal(await deferredPolicy.check(delegation, deferredRequest, qqGuard), 'allowed') } }
assert.equal((await deferredExecutor.execute(deferredAction, deferredContext)).status, 'succeeded')
assert.equal(AGENT_DEFERRED_POKE_DEFINITION_ID, 'core:deferred-poke:v1')
assert.equal(createAgentDeferredPokeDefinition({ definitionId: AGENT_DEFERRED_POKE_DEFINITION_ID, isCurrent: () => false,
  async readMember() { return undefined }, async perform() { throw Error('offline consumer must not poke') } }).validate({ target: [interactionUser.id] }), true)
assert.equal(createAgentDeferredMcpDefinition({ name: 'consumer_mcp_probe', remoteName: 'probe', definitionId: 'consumer:mcp:v1',
  isCurrent: () => false, validate: () => true, async callTool() { throw Error('offline consumer must not call MCP') } }).executor, 'mcp')
for (const constructor of [createAgentDeferredActionRuntime, createAgentDeferredReminderSender, createAgentDeferredActionTool]) assert.equal(typeof constructor, 'function')

const legacyMapping: LegacyDeferredToolMapping = { from: 'pokeTool', to: 'pokeTool', executor: 'builtin', definitionId: AGENT_DEFERRED_POKE_DEFINITION_ID }
const legacyRaw = JSON.stringify({ id: 'consumer-legacy-reminder', user_id: interactionUser.id, group_id: interactionTarget.id,
  bot_id: interactionAccount.id, bindingIdentity: deferredConfig.rules![0]!.bindingIdentity, content: '喝水', reminder_message: '去喝水',
  trigger_time: deferredAt + 30_000, created_at: deferredAt - 1000, status: 'pending', retry_count: 0, extra_action: { tool: 'pokeTool', params: {} } })
const legacyMigration: LegacyDeferredReminderMigrationOptions = { raw: legacyRaw, detailKey: 'legacy:consumer:detail',
  pending: { id: 'consumer-legacy-reminder', trigger_time: deferredAt + 30_000 }, sourceBinding: interactionBinding, binding: interactionBinding,
  destinationMode: 'simulation', mapping: legacyMapping, now: deferredAt }
assert.deepEqual(convertLegacyDeferredReminder(legacyMigration), { kind: 'retained', reason: 'authorization' })
const legacyValues = new Map([['legacy:consumer:index', JSON.stringify([legacyMigration.pending])], ['legacy:consumer:detail', legacyRaw]])
const legacyStage: LegacyDeferredReminderStageOptions = { read: async key => legacyValues.get(key) ?? null,
  sourceIndexKey: 'legacy:consumer:index', destinationIndexKey: 'current:consumer:index', sourceDetailKey: () => 'legacy:consumer:detail',
  destinationDetailKey: () => 'current:consumer:detail', sourceBinding: interactionBinding, binding: interactionBinding,
  destinationMode: 'simulation', selections: [{ id: 'consumer-legacy-reminder', mapping: legacyMapping }],
  idleKeys: ['legacy:consumer:lock', 'current:consumer:lock'], now: deferredAt, isCurrent: () => true }
const stagedLegacy = await stageLegacyDeferredReminders(legacyStage)
assert.equal(stagedLegacy.report.retained, 1); assert.equal(stagedLegacy.report.moved, 0)
await applyLegacyDeferredReminderTransfer({ checks: stagedLegacy.checks, isCurrent: () => true,
  redis: { async eval() { throw Error('an unauthorized migration must not write') } } })

const diagnosticDir = await mkdtemp(path.join(tmpdir(), 'external-agent-diagnostics-'))
try {
  const journal: AgentOperationJournal = await openAgentOperationJournal({ dataDir: diagnosticDir, maxFiles: 2 })
  const diagnosticEvent: AgentDiagnosticEvent = { version: 1, id: 'consumer-event', traceId: 'consumer-trace', at: Date.now(), scope: { kind: 'host' }, stage: 'model', operation: 'consumer_probe', outcome: 'failed', httpStatus: 503 }
  assert.equal(await journal.append(diagnosticEvent), true)
  const diagnostics = createAgentDiagnostics({ sink: journal, logger: { info() {}, warn() {}, error() {} } })
  await diagnostics.run({ kind: 'host' }, 'consumer_operation', async () => ({ state: 'unknown' }), 'delivery')
  await diagnostics.flush()
  assert.equal(await journal.close(), true); assert.equal(journal.health().written, 3)
} finally { await rm(diagnosticDir, { recursive: true, force: true }) }

const workbookBytes: AgentFileBytes = { name: 'agentWorkbook.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: (await readFile(new URL('./agentWorkbook.xlsx', import.meta.url))).toString('base64'), origin: 'current' }
const workbookRequest: AgentFileRequest = { sourceSeq: 1, fileIndex: 1 }
const workbookListing: AgentFileListing = { files: [{ name: workbookBytes.name, folderPath: '/', size: 1 }], totalFiles: 1, truncated: false }
const workbookGuard: FileReadGuard = { signal: new AbortController().signal, isCurrent: () => true }
const checkFilePorts = (context: AgentToolContext) => [context.readFile?.(workbookRequest), context.listFiles?.({})]
assert.equal(typeof checkFilePorts, 'function')
assert.equal(workbookListing.totalFiles, 1)
const excelTool = createAgentExcelTool()
assert.equal(excelTool.name, 'excelWorkbookTool')
const workbookResult = await excelTool.execute({ operation: 'read_cell', cell: 'B2' }, {
  binding: { target: { account: { platform: 'qq', namespace: 'global', id: 'consumer-bot' }, kind: 'group', id: 'consumer-group' }, id: 'consumer-binding', agentId: 'consumer-agent', personaId: 'consumer-persona', revision: '1', connectionId: 'consumer-connection', source: 'configured' },
  actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'consumer-user' } }, request: { messageId: 'consumer-request', text: '读取当前工作簿B2', mentions: [] }, ...workbookGuard, async readFile() { return workbookBytes },
})
assert.equal(workbookResult.status, 'succeeded')
assert.match(workbookResult.content, /公式: =2\+3/u)
assert.match(workbookResult.content, /值: 5/u)
const textFile: AgentFileUpload = { name: 'consumer.txt', mime: 'text/plain', base64: Buffer.from('外部安装包子进程抽取证据').toString('base64') }
const fileReceipt: FileDeliveryReceipt = { state: 'uploaded', fileId: 'opaque-file-evidence' }
const fileAction: SendFileAction = { version: 1, kind: 'file.upload', target: { account: { platform: 'qq', namespace: 'global', id: 'consumer-bot' }, kind: 'group', id: 'consumer-group' }, file: textFile }
const checkSendFile = (context: AgentToolContext) => context.sendFile?.(textFile)
assert.equal(fileReceipt.state, 'uploaded')
assert.equal(fileAction.target.kind, 'group')
assert.equal(typeof checkSendFile, 'function')
const audioBytes: AgentAudioBytes = { mime: 'audio/wav', base64: 'fixture-typed-audio', spokenText: '安装包语音接口' }
const videoBytes: AgentVideoBytes = { mime: 'video/mp4', base64: 'fixture-typed-video' }
const mediaAction: SendMediaAction = { version: 1, kind: 'media.send', target: fileAction.target, media: { kind: 'audio', ...audioBytes } }
const checkMediaPorts = (context: AgentToolContext) => [context.sendAudio?.(audioBytes), context.sendVideo?.(videoBytes), context.persona?.aliases]
const inputVideo: AgentVideoInput = { mime: 'video/mp4', base64: 'AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQy' }
const videoSource: AgentMessageVideo = { origin: 'current', fingerprint: 'a'.repeat(64), video: inputVideo }
const readVideoGuard: MessageVideoReadOptions = { signal: new AbortController().signal, isCurrent: () => true,
  allowsSource: async () => true, allowsForwardSource: async () => true, inspectOnly: true }
const checkVideoPort = (context: AgentToolContext) => context.readVideo?.()
const videoConfig: AgentVideoAnalysisConfig = { enabled: false }
assert.equal(createAgentVideoAnalysisTool(videoConfig).name, 'videoAnalysisTool')
assert.equal(createAgentVideoAnalysisTool(videoConfig).dataPolicy, 'ephemeral')
assert.deepEqual(validateAgentVideoUploadHosts(['cdn.bigmodel.cn']), ['cdn.bigmodel.cn'])
assert.equal(typeof checkVideoPort, 'function'); assert.equal(videoSource.video?.mime, 'video/mp4'); assert.equal(readVideoGuard.inspectOnly, true)
const voiceConfig: AgentVoiceConfig = { enabled: false }
assert.equal(mediaAction.media.kind, 'audio'); assert.equal(typeof checkMediaPorts, 'function')
assert.equal(createAgentVoiceTool(voiceConfig).name, 'voiceTool')
const musicConfig: AgentMusicConfig = { enabled: false }
const musicCard: AgentMusicCard = { title: '外部音乐接口', artist: '测试歌手', pageUrl: 'https://y.qq.com/n/yqq/song/songmid.html', audioUrl: 'http://ws.stream.qqmusic.qq.com/M500song.mp3?vkey=fixture', coverUrl: 'http://y.gtimg.cn/music/photo_new/T002R150x150M000album.jpg' }
const musicAction: SendMusicAction = { version: 1, kind: 'music.send', target: fileAction.target, music: musicCard }
const checkMusicPort = (context: AgentToolContext) => context.sendMusic?.(musicCard)
assert.equal(musicAction.music.title, '外部音乐接口'); assert.equal(typeof checkMusicPort, 'function')
assert.equal(createAgentMusicTool(musicConfig).name, 'searchMusicTool')
assert.equal(typeof createAgentMusicProvider(musicConfig).refresh, 'function')
const extractionConfig: AgentMusicExtractionConfig = { enabled: false, operators: [] }
const extractionShare: AgentMusicShare | undefined = parseNeteaseMusicLink('https://music.163.com/song?id=123')
const audioAttachment: AgentAudioAttachment = { name: 'consumer.wav', mime: audioBytes.mime, base64: audioBytes.base64 }
const audioFileAction: SendAudioFileAction = { version: 1, kind: 'audio-file.upload', target: fileAction.target, attachment: audioAttachment }
const musicSourceGuard: MusicShareReadOptions = { signal: new AbortController().signal, isCurrent: () => true, allowsSource: async () => true }
const checkExtractionPorts = (adapter: PlatformConnectionAdapter) => [adapter.readMusicShare?.(fileAction.target, '123', musicSourceGuard), adapter.actions.sendAudioFile?.(audioFileAction)]
assert.equal(extractionConfig.enabled, false); assert.equal(extractionShare?.reference.kind, 'song')
assert.equal(typeof createAgentMusicExtractionProvider().prepare, 'function'); assert.equal(typeof checkExtractionPorts, 'function')
const mediaDirectory = await mkdtemp(path.join(tmpdir(), 'external-agent-media-'))
const resourceContext: AgentMediaResourceContext = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
const bilibiliQualityConfig: AgentBilibiliQualityConfig = validateAgentBilibiliQualityConfig({ enabled: false, masters: [] })
const publicVideo: AgentVideoCard = { provider: 'bilibili', id: 'BV1xx411c7mD', title: '安装包公开视频', author: '安装包作者', durationSeconds: 123,
  pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }
let videoSearchRequests = 0
const videoSearchOptions: AgentBilibiliSearchProviderOptions = {
  async lookup() { return [{ address: '8.8.8.8', family: 4 }] },
  async request(url, address, signal, policy) {
    assert.equal(address.address, '8.8.8.8'); assert.ok(signal instanceof AbortSignal); assert.equal(policy?.maxBytes, 2 * 1024 * 1024)
    assert.equal(url.hostname, 'api.bilibili.com'); videoSearchRequests++
    const data = url.pathname === '/x/frontend/finger/spi' ? { b_3: 'EXTERNAL_VIDEO_DEVICE' }
      : url.pathname === '/x/web-interface/search/type' ? { result: [{ bvid: publicVideo.id, title: publicVideo.title, author: publicVideo.author, duration: '2:03' }] }
        : url.pathname === '/x/web-interface/view' ? { bvid: publicVideo.id, title: publicVideo.title, owner: { name: publicVideo.author }, duration: 123 } : undefined
    assert.ok(data)
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 0, data }) }
  },
}
const videoSearchProvider: AgentVideoSearchProvider = createAgentBilibiliSearchProvider(videoSearchOptions)
assert.deepEqual((await videoSearchProvider.search('安装包视频查询', resourceContext)).items, [publicVideo])
assert.deepEqual(await videoSearchProvider.resolve({ url: publicVideo.pageUrl }, resourceContext), publicVideo)
assert.equal(videoSearchRequests, 4); assert.deepEqual(validateAgentVideoCard(publicVideo), publicVideo)
const videoSearchConfig: AgentVideoSearchToolsConfig = { enabled: false }
assert.deepEqual(createAgentVideoSearchTools(videoSearchConfig, { provider: videoSearchProvider, storage: { get: async () => null, eval: async () => null } }).builtIn, [])
const checkVideoCardPort = (context: AgentToolContext, adapter: PlatformConnectionAdapter, action: SendVideoCardAction) => [
  context.sendVideoCard?.(publicVideo, resourceContext), adapter.actions.sendVideoCard?.(action, { signal: resourceContext.signal, isCurrent: resourceContext.isCurrent }),
]
assert.equal(typeof checkVideoCardPort, 'function')
const torrentConfig: AgentTorrentConfig = validateAgentTorrentConfig({ enabled: false })
const torrentProvider: AgentTorrentProvider = createAgentTorrentProvider({ directory: mediaDirectory })
assert.equal(torrentConfig.enabled, false); assert.equal(typeof torrentProvider.prepare, 'function')
assert.equal(parseAgentTorrentMagnet(`magnet:?xt=urn:btih:${'A'.repeat(40)}`)?.startsWith('magnet:'), true)
const requesterZip = validateAgentTorrentArchive({ name: '外部ZIP合同.zip', mime: 'application/zip',
  base64: 'UEsDBBQAAAAAAAAAAABa2DqeDgAAAA4AAAAIAAAAZGF0YS5iaW5hYWFhYWFhYWFhYWFhYVBLAQIUABQAAAAAAAAAAABa2DqeDgAAAA4AAAAIAAAAAAAAAAAAAAAAAAAAAABkYXRhLmJpblBLBQYAAAAAAQABADYAAAA0AAAAAAA=' })
const requesterTarget: ConversationAddress = { account: { platform: 'qq', namespace: 'global', id: '123456' }, kind: 'group', id: '654321' }
const requesterBindings = createAgentBindingDirectory({ version: 1, agents: [{ id: 'zip-role', personaId: 'default' }],
  connections: [{ id: 'zip-connection', platform: 'qq', namespace: 'global', accountId: '123456' }],
  bindings: [{ connectionId: 'zip-connection', kind: 'group', conversationId: '654321', agentId: 'zip-role' }] }, 'zip-revision')
const requesterAction: SendRequesterArchiveAction = { version: 1, kind: 'requester-archive.upload', target: requesterTarget,
  binding: requesterBindings.resolve(requesterTarget)!, source: { messageId: '123', sender: { platform: 'qq', namespace: 'global', id: '330001' }, occurredAt: 1_800_000_000_000,
    textSha256: createHash('sha256').update('合成来源').digest('hex') }, archive: requesterZip }
const authCommand = '.B站授权 状态'
const authSource: AgentBilibiliAuthSource = { target: requesterTarget, messageId: '123', author: requesterAction.source.sender,
  occurredAt: requesterAction.source.occurredAt, textSha256: createHash('sha256').update(authCommand).digest('hex') }
const authAction: SendRequesterBilibiliAuthAction = { version: 1, kind: 'bilibili-auth.notify', binding: requesterAction.binding!, source: authSource,
  content: { kind: 'text', text: '当前绑定尚无B站授权。' } }
let authNotices = 0
const sendAuth = createQqBilibiliAuthDeliveryPort({ account: requesterTarget.account, connectionId: 'zip-connection',
  async readApi(action, params) {
    assert.equal(action, 'get_msg'); assert.equal(params.message_id, authSource.messageId)
    return { status: 'ok', retcode: 0, data: { message_type: 'group', self_id: 123456, group_id: 654321, user_id: 330001,
      sender: { user_id: 330001 }, time: 1_800_000_000, message_id: 123, message: [{ type: 'text', data: { text: authCommand } }] } }
  }, async sendApi(action, params) {
    assert.equal(action, 'send_private_msg'); assert.equal(params.user_id, '330001'); assert.equal(params.group_id, '654321')
    authNotices++; return { status: 'ok', retcode: 0, data: { message_id: 456, user_id: 330001 } }
  } })
assert.deepEqual(await sendAuth(authAction, { signal: resourceContext.signal, isCurrent: resourceContext.isCurrent }), { state: 'sent', messageId: '456' }); assert.equal(authNotices, 1)
assert.equal(QQ_BILIBILI_AUTH_TIMEOUT_MS, 30_000)
const checkAuthPort = (adapter: PlatformConnectionAdapter) => adapter.actions.sendRequesterBilibiliAuth?.(authAction, resourceContext)
const checkAuthSession = (session: AgentBilibiliAuthSession) => [session.expiresAt, session.image.mime, session.poll, session.cancel]
assert.equal(typeof checkAuthPort, 'function'); assert.equal(typeof checkAuthSession, 'function')
const zipBridge: QqRequesterArchiveBridge = await openQqRequesterArchiveBridge({ directory: mediaDirectory, listen: { host: '127.0.0.1', port: 0 },
  advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] })
try {
  let uploads = 0
  const sendZip = createQqRequesterArchiveDeliveryPort({ account: requesterTarget.account, connectionId: 'zip-connection', bridge: zipBridge,
    async readApi(action, params) {
      assert.equal(action, 'get_msg'); assert.equal(String(params.message_id), '123')
      return { status: 'ok', retcode: 0, data: { message_type: 'group', self_id: 123456, group_id: 654321, user_id: 330001,
        sender: { user_id: 330001 }, time: 1_800_000_000, message_id: 123, message: [{ type: 'text', data: { text: '合成来源' } }] } }
    }, async sendApi(action, params) {
      assert.equal(action, 'upload_private_file'); assert.equal(params.user_id, '330001'); assert.equal(params.name, requesterZip.name)
      assert.deepEqual(Buffer.from(await (await fetch(String(params.file))).arrayBuffer()), Buffer.from(requesterZip.base64, 'base64'))
      uploads++; return { status: 'ok', retcode: 0, data: { file_id: 'external-zip-proof' } }
    } })
  assert.deepEqual(await sendZip(requesterAction, { signal: resourceContext.signal, isCurrent: resourceContext.isCurrent }), { state: 'uploaded', fileId: 'external-zip-proof' })
  assert.equal(uploads, 1)
  const checkRequesterPort = (adapter: PlatformConnectionAdapter) => adapter.actions.sendRequesterArchive?.(requesterAction, resourceContext)
  assert.equal(typeof checkRequesterPort, 'function')
} finally { await zipBridge.close() }
const logDocument: AgentGroupLogDocument = { title: '外部团录接口', startedAt: '2026-11-16T12:00:00Z' }
const groupLog: AgentGroupLogArtifact = createAgentGroupLogRenderer()(
  logDocument, [{ userId: '330001', name: '合成玩家', content: '完整团录正文 <script> 不执行', at: '2026-11-16T12:01:00Z' }], 'html')
assert.deepEqual(validateAgentGroupLogArtifact(groupLog), groupLog)
const groupLogAction: SendGroupLogAction = { version: 1, kind: 'group-log.upload', target: requesterTarget,
  binding: requesterAction.binding, source: { ...requesterAction.source, textSha256: createHash('sha256').update('合成来源').digest('hex') }, log: groupLog }
const groupLogBridge: QqGroupLogBridge = await openQqGroupLogBridge({ directory: mediaDirectory, listen: { host: '127.0.0.1', port: 0 },
  advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] })
try {
  let uploads = 0
  const sendGroupLog = createQqGroupLogDeliveryPort({ account: requesterTarget.account, connectionId: 'zip-connection', bridge: groupLogBridge,
    async readApi(action, params) {
      assert.equal(action, 'get_msg'); assert.equal(String(params.message_id), '123')
      return { status: 'ok', retcode: 0, data: { message_type: 'group', self_id: 123456, group_id: 654321, user_id: 330001,
        sender: { user_id: 330001 }, time: 1_800_000_000, message_id: 123, message: [{ type: 'text', data: { text: '合成来源' } }] } }
    }, async sendApi(action, params) {
      assert.equal(action, 'upload_group_file'); assert.equal(params.group_id, '654321'); assert.equal(params.user_id, undefined)
      const bytes = Buffer.from(await (await fetch(String(params.file))).arrayBuffer())
      assert.deepEqual(bytes, Buffer.from(groupLog.base64, 'base64')); assert.match(bytes.toString('utf8'), /&lt;script&gt;/u)
      uploads++; return { status: 'ok', retcode: 0, data: { file_id: 'external-group-log-proof' } }
    } })
  const groupLogGuard = { signal: resourceContext.signal, isCurrent: resourceContext.isCurrent }
  assert.deepEqual(await sendGroupLog(groupLogAction, groupLogGuard), { state: 'uploaded', fileId: 'external-group-log-proof' })
  assert.equal(uploads, 1)
  const checkGroupLogPort = (adapter: PlatformConnectionAdapter) => adapter.actions.sendGroupLog?.(groupLogAction, groupLogGuard)
  assert.equal(typeof checkGroupLogPort, 'function')
} finally { await groupLogBridge.close() }
try {
  const store = await createAgentMediaArtifactStore({ directory: mediaDirectory })
  try {
    const relayConfig: AgentMediaRelayConfig = validateAgentMediaRelayConfig({ enabled: false })
    const relayShare: AgentMediaShare | undefined = parseAgentBilibiliReference('https://www.bilibili.com/video/BV1H7Gq6zEiC')
    const relayProvider: AgentMediaRelayProvider = createAgentBilibiliRelayProvider({ directory: mediaDirectory, artifacts: store })
    const authOptions: AgentBilibiliAuthServiceOptions = { directory: path.join(await realpath(mediaDirectory), 'bilibili-auth'), isLeaseCurrent: () => true,
      registerSecrets() {}, async lookup() { assert.fail('public vault operations must not resolve DNS') }, async request() { assert.fail('public vault operations must not request HTTP') } }
    const authService: AgentBilibiliAuthService = await openAgentBilibiliAuthService(authOptions)
    try {
      assert.deepEqual(await authService.status(requesterAction.binding!, resourceContext), { authorized: false })
      assert.equal(await authService.credential(requesterAction.binding!, resourceContext), undefined)
      const qualityOptions: AgentBilibiliQualityProviderOptions = { directory: mediaDirectory, artifacts: store,
        credential: async context => await authService.credential(requesterAction.binding!, context) ?? '' }
      const qualityProvider: AgentBilibiliQualityProvider = createAgentBilibiliQualityProvider(qualityOptions)
      const attachmentOptions: AgentBilibiliSearchAttachmentProviderOptions = { directory: mediaDirectory, artifacts: store }
      const attachmentProvider: AgentMediaRelayProvider = createAgentBilibiliSearchAttachmentProvider(attachmentOptions)
      assert.equal(typeof attachmentProvider.prepare, 'function')
      const attachmentTools = createAgentVideoSearchTools({ enabled: true }, { provider: videoSearchProvider, attachmentProvider,
        storage: { get: async () => null, eval: async () => null } })
      assert.deepEqual(attachmentTools.builtIn?.map(tool => tool.name), ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'])
      const guardedRelay: NonNullable<AgentToolContext['sendMediaRelay']> = async (_plan, guard) => {
        await guard?.ensureCurrent?.()
        return { state: 'failed', code: 'public_guard_type_fixture' }
      }
      assert.equal(typeof guardedRelay, 'function')
      if (relayShare?.provider !== 'bilibili') throw Error('expected canonical Bilibili share')
      const qualityRequest: AgentBilibiliQualityRequest = { share: relayShare, quality: 80 }
      await assert.rejects(qualityProvider.prepare(qualityRequest, resourceContext), /B站媒体获取失败/u)
      const checkPreparedQuality = (prepared: AgentPreparedBilibiliQuality) => [prepared.requestedQuality, prepared.actualQualities, prepared.release]
      assert.equal(typeof checkPreparedQuality, 'function')
      await authService.logout(requesterAction.binding!, resourceContext)
    } finally { await authService.close() }
    const douyin: AgentMediaShare | undefined = parseAgentDouyinReference('https://www.douyin.com/note/7482233445566778899')
    const douyinProvider: AgentMediaRelayProvider = createAgentDouyinRelayProvider({ directory: mediaDirectory, artifacts: store })
    assert.deepEqual(douyin, { provider: 'douyin', reference: { kind: 'note', id: '7482233445566778899' } })
    assert.equal(typeof douyinProvider.prepare, 'function')
    const youtube = parseAgentYoutubeReference('https://youtu.be/AbC_123-xYz?t=10')!
    const youtubeNative: AgentYoutubeNative = async (_command, _args, options) => { assert.ok(options.signal instanceof AbortSignal); return { stdout: '{}' } }
    const youtubePolicy: AgentYoutubeRequestPolicy = { maxBytes: 1024, headers: { Accept: '*/*' } }
    const youtubeProvider = createAgentYoutubeRelayProvider({ directory: mediaDirectory, artifacts: store, native: youtubeNative })
    assert.deepEqual(youtube, { provider: 'youtube', reference: { kind: 'video', id: 'AbC_123-xYz' } })
    assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['youtube'] }).providers, ['youtube'])
    assert.equal(typeof youtubeProvider.prepare, 'function'); assert.equal(youtubePolicy.maxBytes, 1024)
    await assert.rejects(relayProvider.prepare(youtube, resourceContext))
    const pixiv = parseAgentPixivReference('https://www.pixiv.net/en/artworks/123456789?utm_source=external')!
    const pixivPolicy: AgentPixivRequestPolicy = { maxBytes: 1024, headers: { Accept: 'application/json' } }
    let pixivRequests = 0
    const pixivOptions: AgentPixivRelayProviderOptions = { directory: mediaDirectory, artifacts: store,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (url, _address, _signal, policy) => {
        assert.ok(url.pathname === '/ajax/illust/123456789' || url.pathname === '/ajax/illust/123456789/pages')
        assert.equal(policy?.maxBytes, 2 * 1024 * 1024); pixivRequests++
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: false,
          body: url.pathname.endsWith('/pages') ? [] : { id: '123456789', title: '外部安装包作品', xRestrict: 1, pageCount: 1 } }) }
      } }
    const pixivProvider: AgentMediaRelayProvider = createAgentPixivRelayProvider(pixivOptions)
    assert.deepEqual(pixiv, { provider: 'pixiv', reference: { kind: 'artwork', id: '123456789' } })
    assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['pixiv'] }).providers, ['pixiv'])
    assert.equal(pixivPolicy.maxBytes, 1024)
    const pixivPrepared = await pixivProvider.prepare(pixiv, resourceContext)
    try {
      assert.equal(pixivPrepared.status, 'restricted'); assert.equal(pixivRequests, 2)
      assert.equal(pixivPrepared.pageUrl, 'https://www.pixiv.net/artworks/123456789')
      assert.equal(pixivPrepared.plan.items.length, 1)
      assert.match(pixivPrepared.infoText, /外部安装包作品/u)
    } finally { await pixivPrepared.release() }
    const searchInput: AgentPixivSearchInput = { keyword: '外部安装包', orderBy: 'newest' }
    const searchProvider: AgentPixivSearchProvider = createAgentPixivSearchProvider({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async url => {
        assert.equal(url.pathname, '/ajax/search/artworks/外部安装包'.replace('外部安装包', encodeURIComponent('外部安装包')))
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: false, body: {
          illustManga: { total: 1, data: [{ id: '123456789', title: '公共搜索接口', userName: '安装包画师', pageCount: 2, xRestrict: 0 }] },
        } }) }
      },
    })
    const searchResult: AgentPixivSearchResult = await searchProvider.search(searchInput, resourceContext)
    assert.equal(searchResult.items[0]?.id, '123456789')
    const searchCard = await searchProvider.renderList(searchResult, resourceContext)
    assert.equal(searchCard.mime, 'image/jpeg'); assert.ok(searchCard.base64.length > 100)
    const pixivToolConfig: AgentPixivToolsConfig = { enabled: false }
    assert.deepEqual(createAgentPixivTools(pixivToolConfig, { provider: searchProvider, relayProvider: pixivProvider,
      storage: { get: async () => null, eval: async () => null },
    }).builtIn, [])
    const checkPixivPorts = (context: AgentToolContext) => [context.sendMediaRelay?.(pixivPrepared.plan),
      context.isSourceAvailable?.({ messageId: 'external-search-source', author: { platform: 'qq', namespace: 'global', id: 'human' } })]
    assert.equal(typeof checkPixivPorts, 'function')
    await assert.rejects(relayProvider.prepare(pixiv, resourceContext))
    const xhs = parseAgentXiaohongshuReference('https://www.xiaohongshu.com/explore/66aabbccddeeff0011223344?xsec_token=EXTERNAL_ACCESS%3D&type=normal')!
    const xhsAccess: AgentMediaShareAccess | undefined = readAgentXiaohongshuAccess('https://www.xiaohongshu.com/explore/66aabbccddeeff0011223344?xsec_token=EXTERNAL_ACCESS%3D&type=normal', xhs)
    const xhsContext: AgentMediaRelayPrepareContext = { ...resourceContext, async readSourceAccess() { return xhsAccess } }
    const xhsProvider: AgentMediaRelayProvider = createAgentXiaohongshuRelayProvider({ directory: mediaDirectory, artifacts: store })
    const feedPolicy: AgentXiaohongshuRequestPolicy = { method: 'POST', body: '{"source_note_id":"66aabbccddeeff0011223344"}', maxBytes: 1024,
      headers: { 'Content-Type': 'application/json', 'x-s': 'EXTERNAL_SYNTHETIC_SIGNATURE' } }
    assert.equal(feedPolicy.method, 'POST')
    assert.equal(typeof xhsProvider.prepare, 'function')
    assert.deepEqual(xhs, { provider: 'xiaohongshu', reference: { kind: 'note', id: '66aabbccddeeff0011223344' } })
    assert.equal((await xhsContext.readSourceAccess!())?.xsecToken, 'EXTERNAL_ACCESS=')
    assert.equal(new URL(xiaohongshuAccessPageUrl(xhs, xhsAccess)).searchParams.get('xsec_token'), 'EXTERNAL_ACCESS=')
    assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['xiaohongshu'] }).providers, ['xiaohongshu'])
    await assert.rejects(relayProvider.prepare(xhs, xhsContext))
    assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['douyin'] }).providers, ['douyin'])
    assert.throws(() => validateAgentMediaShare({ provider: 'douyin', reference: { kind: 'episode', id: '7482233445566778899' } }))
    await assert.rejects(relayProvider.prepare(douyin!, resourceContext))
    const sourceGuard: MediaShareReadOptions = { ...resourceContext, expectedSource: { author: fileAction.target.account, occurredAt: Date.now() }, allowsSource: async () => true }
    const checkSourceReader = (adapter: PlatformConnectionAdapter) => adapter.readMediaShare?.(fileAction.target, '123', sourceGuard)
    assert.equal(relayConfig.enabled, false); assert.equal(relayShare?.provider, 'bilibili')
    assert.equal(typeof relayProvider.prepare, 'function'); assert.equal(typeof checkSourceReader, 'function')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=', 'base64')
    const lease = await store.stage({ kind: 'image', mime: 'image/png', chunks: (async function* () { yield png })() }, resourceContext)
    const artifact: AgentMediaArtifact = lease.artifact
    const plan: AgentMediaRelayPlan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [{ kind: 'text', text: '外部资源合同' }, { kind: 'image', artifact }] }] })
    assert.equal(plan.items[0]?.parts[1]?.kind, 'image')
    const resources: AgentMediaResourcePort = store, reader = await resources.open(artifact, resourceContext)
    try {
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.chunks) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), png)
    } finally { await reader.close() }
    const bridge: QqMediaRelayBridge = await openQqMediaRelayBridge({
      directory: mediaDirectory, resources, listen: { host: '127.0.0.1', port: 0 },
      advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'],
    })
    try {
      const published = await bridge.stage(artifact, resourceContext)
      const response = await fetch(published.nativeUrl)
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
      await published.release()
      assert.equal((await fetch(published.nativeUrl)).status, 404)
      const relayTarget: ConversationAddress = { account: { platform: 'qq', namespace: 'global', id: '123456' }, kind: 'group', id: '654321' }
      const relayAction: SendMediaRelayAction = { version: 1, kind: 'media-relay.send', target: relayTarget, mode: 'forward', plan }
      let nativeCalls = 0
      const sendRelay = createQqMediaRelayDeliveryPort({ account: relayTarget.account, bridge, async sendApi(action, params, options) {
        assert.equal(action, 'send_group_forward_msg')
        assert.equal(params.group_id, '654321')
        assert.equal(options.isCurrent(), true)
        nativeCalls++
        return { status: 'ok', retcode: 0, data: { message_id: 7654321 } }
      } })
      assert.deepEqual(await sendRelay(relayAction, resourceContext), { state: 'sent', messageId: '7654321' })
      assert.equal(nativeCalls, 1)
      const checkRelayPort = (adapter: PlatformConnectionAdapter) => adapter.actions.sendMediaRelay?.(relayAction, resourceContext)
      assert.equal(typeof checkRelayPort, 'function')
    } finally { await bridge.close() }
    await lease.release()
    await assert.rejects(resources.open(artifact, resourceContext))
  } finally { await store.close() }
} finally { await rm(mediaDirectory, { recursive: true, force: true }) }
const fileTextResult = await createAgentFileTextTool().execute({}, {
  binding: { target: fileAction.target, id: 'consumer-binding', agentId: 'consumer-agent', personaId: 'consumer-persona', revision: '1', connectionId: 'consumer-connection', source: 'configured' },
  actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'consumer-user' } }, request: { messageId: 'consumer-request', text: '读取当前文本文件', mentions: [] }, ...workbookGuard, async readFile() { return { ...textFile, origin: 'current' } },
})
assert.equal(fileTextResult.status, 'succeeded')
assert.match(fileTextResult.content, /外部安装包子进程抽取证据/u)
assert.equal(typeof createOneBotConnection, 'function')
const memberProfile: ConversationMemberProfile = { nickname: '外部宿主成员', level: '0', joinedAt: 1_600_000_000_000 }
const memberRequest: AgentToolRequest = { messageId: 'public-api-request', text: '请通知该成员', mentions: [] }
const memberMessage: AgentToolMessage = { text: '集合', mentionUserIds: ['member'] }
const checkMemberPorts = (context: AgentToolContext) => [context.readMember?.('member'), context.listMembers?.(), context.sendMessage?.(memberMessage)]
assert.equal(memberProfile.level, '0')
assert.equal(memberRequest.messageId, 'public-api-request')
assert.equal(typeof checkMemberPorts, 'function')
const historyConfig: AgentHistoryConfig = { enabled: true, retentionDays: 30, maxMessagesPerConversation: 1000, timeoutMs: 5000 }
const historySource: AgentHistoryRequestSource = { messageId: 'history-request', authorId: 'member', text: '查询历史', at: Date.now(), mentions: [] }
const historyRecall: AgentHistoryRecall = { text: '{}', async isCurrent() { return true } }
const checkHistoryPort = (context: AgentToolContext) => context.readHistory?.({ question: historySource.text })
assert.equal(historyConfig.enabled, true)
assert.equal(await historyRecall.isCurrent(), true)
assert.equal(typeof checkHistoryPort, 'function')
assert.deepEqual(createAgentWebTools({}), { builtIn: [] })
assert.deepEqual(createAgentImageTools({}), { builtIn: [] })
assert.deepEqual(createAgentRepositoryTools({}), { builtIn: [] })
assert.deepEqual(createAgentModrinthTools({}), { builtIn: [] })
assert.equal(typeof createAgentModrinthCardRenderer().render, 'function')
assert.deepEqual(createAgentRenderingTools(), { builtIn: [] })
const renderingConfig: AgentRenderingConfig = { textImage: { enabled: true } }
const renderingOptions: AgentRenderingToolsOptions = { rendering: renderingConfig, renderTextImage: createAgentTextImageRenderer().render }
assert.deepEqual(createAgentRenderingTools(renderingOptions).builtIn?.map(tool => tool.name), ['textImageTool'])
assert.equal(typeof createAgentMindMapRenderer().render, 'function')
const renderingContext: AgentRenderingContext = { signal: new AbortController().signal, isCurrent: () => true, assertText(text) { assert.equal(typeof text, 'string') } }
assert.equal(typeof renderingContext.assertText, 'function')
assert.ok(buildAgentModrinthCardHtml({ name: '<script>fixture</script>' }).includes('&lt;script&gt;fixture&lt;/script&gt;'))
const githubOptions: AgentGithubOptions = { enabled: true }
const repositoryOptions: AgentRepositoryToolsOptions = { github: githubOptions }
assert.deepEqual(createAgentRepositoryTools(repositoryOptions).builtIn?.map(tool => tool.name), ['githubRepoTool'])
const mcpServer: AgentMcpServerConfig = { type: 'stdio', command: process.execPath, autoReconnect: false }
assert.equal(mcpServer.type, 'stdio')
const emptyMcp = await openAgentMcpTools()
assert.deepEqual(emptyMcp.registry.custom, [])
await emptyMcp.close()
const semanticConfig: AgentSemanticMemoryConfig = { enabled: true, topK: 3 }
const semanticQuerySource: AgentSemanticMemoryQuerySource = { authorId: 'fixture-author', messageId: 'fixture-source', at: Date.now() }
assert.equal(semanticQuerySource.authorId, 'fixture-author')
const semanticBackend: AgentSemanticMemoryBackend & { dispose(): void } = createAgentSemanticBackend({
  embedding: { baseUrl: 'http://127.0.0.1:1/v1/embeddings', name: 'fixture-embedding', apiKey: 'fixture-embedding-key' },
})
assert.equal(semanticConfig.topK, 3)
assert.match(semanticBackend.id, /^[a-f0-9]{64}$/u)
semanticBackend.dispose()
const imageBackend: AgentImageBackend = { baseUrl: 'http://127.0.0.1:1/v1', name: 'fixture-image', apiKey: 'fixture-image-key', protocol: 'images' }
assert.deepEqual(createAgentImageTools({ generation: imageBackend, edit: imageBackend }).builtIn?.map(tool => tool.name), ['bananaTool', 'googleImageEditTool'])
const extractor: PersonProfileExtractor = createAgentPersonExtractor({
  baseUrl: 'http://127.0.0.1:1', name: 'fixture-extraction', apiKey: 'fixture-credential',
})
assert.equal(typeof extractor, 'function')
const summarizer: ConversationSummaryModel = createAgentConversationSummary({
  baseUrl: 'http://127.0.0.1:1', name: 'fixture-summary', apiKey: 'fixture-credential',
})
assert.equal(typeof summarizer, 'function')
const groupMemoryModel: GroupMemoryModel = createAgentGroupMemoryModel({
  baseUrl: 'http://127.0.0.1:1', name: 'fixture-group-memory', apiKey: 'fixture-credential',
})
assert.equal(typeof groupMemoryModel, 'function')
const checkExtractionContext = (context: PersonProfileExtractionContext): AbortSignal => context.signal
assert.equal(typeof checkExtractionContext, 'function')
const extension: AgentTool = {
  name: 'externalLookup', description: 'External host capability',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async execute(_input, context) {
    assert.equal(context.binding.agentId, 'role')
    return { status: 'succeeded', content: 'public host extension' }
  },
}
const account = { platform: 'fixture', namespace: 'external', id: 'bot/account' }
const target: ConversationAddress = { account, kind: 'private', id: 'member/17' }
const directory = createAgentBindingDirectory({
  version: 1,
  agents: [{ id: 'role', personaId: 'default' }],
  connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
  bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }],
}, 'external-revision')
const repositoryBinding = directory.resolve(target)
assert.ok(repositoryBinding)
const repositoryRequests: string[] = []
const repositoryTool = createAgentRepositoryTools({
  github: githubOptions,
  fetchImpl: async (url, init) => {
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    repositoryRequests.push(String(url))
    return new Response(JSON.stringify(repositoryRequests.length === 1
      ? { full_name: 'fixture-owner/fixture-repo', private: false, visibility: 'public', description: 'public consumer repository' }
      : []), { headers: { 'content-type': 'application/json' } })
  },
}).builtIn?.[0]
assert.ok(repositoryTool)
const repositoryResult = await repositoryTool.execute({ repoUrl: 'https://github.com/fixture-owner/fixture-repo' }, {
  binding: repositoryBinding, actor: { kind: 'user', user: { ...account, id: target.id } },
  signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {},
})
assert.equal(repositoryResult.status, 'succeeded')
assert.ok(repositoryResult.content.includes('public consumer repository'))
assert.equal(repositoryRequests.length, 4)
const modrinthOptions: AgentModrinthOptions = { enabled: true,
  translation: { baseUrl: 'https://translation.example/v1', name: 'compact', apiKey: 'translation-private-key' } }
const modrinthBundles: (readonly MessageBundleItem[])[] = []
const modrinthToolOptions: AgentModrinthToolsOptions = { modrinth: modrinthOptions,
  async fetchImpl(url, init) {
    assert.equal(init?.redirect, 'error')
    if (String(url).startsWith('https://api.modrinth.com/v2/search?')) {
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      return new Response(JSON.stringify({ total_hits: 1, hits: [{ project_type: 'mod', project_id: 'consumer', slug: 'consumer-mod',
        title: 'External consumer mod', author: 'fixture', description: 'A public demo.', downloads: 12, follows: 3 }] }))
    }
    assert.equal(String(url), 'https://translation.example/v1/chat/completions')
    assert.equal(init?.method, 'POST')
    const request = JSON.parse(String(init?.body))
    assert.deepEqual(JSON.parse(request.messages[1].content), [{ projectId: 'consumer', en: 'A public demo.' }])
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify([{ projectId: 'consumer', zh: '一个公开示例。' }]) } }] }))
  },
}
const modrinthTool = createAgentModrinthTools(modrinthToolOptions).builtIn?.[0]
assert.ok(modrinthTool)
const modrinthResult = await modrinthTool.execute({ limit: 1 }, {
  binding: repositoryBinding, actor: { kind: 'user', user: { ...account, id: target.id } },
  signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {},
  async sendBundle(items) { modrinthBundles.push(items); return { state: 'sent', messageId: 'consumer-bundle' } },
})
assert.equal(modrinthResult.status, 'succeeded')
assert.equal(modrinthBundles.length, 1)
assert.equal(modrinthBundles[0]?.length, 2)
assert.ok(JSON.stringify(modrinthBundles).includes('一个公开示例。'))
const bundleTypeCheck: SendMessageBundleAction = { version: 1, kind: 'message.bundle.send', target, items: modrinthBundles[0]! }
assert.equal(bundleTypeCheck.target, target)
const redis = await openAgentRedis({
  url: process.env.BL_AGENT_CONSUMER_REDIS_URL!, instance: 'external-consumer', onLost() {},
})
let accept: ((event: PlatformConversationEvent) => Promise<void>) | undefined
const sent: SendMessageAction[] = []
const adapter: PlatformConnectionAdapter = {
  id: 'connection', account, botUserId: account.id, botName: 'fixture',
  isReady: () => true, stop() {},
  async start(consume) { accept = consume },
  actions: {
    async send(action, guard) {
      assert.equal(guard?.isCurrent?.(), true)
      assert.deepEqual(action.target, target)
      assert.equal(action.binding?.agentId, 'role')
      sent.push(action)
      return { state: 'sent', messageId: `confirmed/${sent.length}` }
    },
  },
}
const options: AgentRuntimeOptions = {
  ...interactionConfiguration,
  ...diceConfiguration,
  storage: redis.storage, isExecutionCurrent: redis.isCurrent, adapters: [adapter],
  logger: { info() {}, warn() {}, error() {} },
  getSection: () => ({ enabled: true, reflection: { enabled: false } }),
  getExecutionConfig: () => ({ providers: 'openai', useTools: false }),
  privateChatEnabled: true,
  memorySystem: { enabled: false } satisfies TextPersonMemoryConfig,
  midtermMemory: { enabled: false } satisfies MidtermMemoryConfig,
  episodicMemory: { enabled: true } satisfies EpisodicMemoryConfig,
  summarizeConversation: summarizer,
  groupMemory: { enabled: false } satisfies GroupMemoryConfig,
  groupMemoryModel,
  history: historyConfig,
  bilibiliQuality: bilibiliQualityConfig, isBilibiliQualityCurrent: () => false,
  toolRegistry: { custom: [extension] },
  resolvePersona(address) {
    const binding = directory.resolve(address)
    return binding && { binding, persona: { name: 'fixture' }, systemContent: '独立宿主验收。' }
  },
  async YTapi(request, _config, _signal, _isCurrent, ensureCurrent) {
    assert.equal(typeof ensureCurrent, 'function')
    await ensureCurrent?.()
    assert.ok(JSON.stringify(request.messages).includes('外部宿主消息'))
    return { choices: [{ message: { content: '外部宿主已收到。' } }] }
  },
}
const host = createAgentRuntime(options)
try {
  await host.start()
  assert.ok(accept)
  await accept({
    kind: 'message', message: {
      version: 1, conversation: target, sender: { ...account, id: target.id },
      messageId: 'incoming/1', occurredAt: Date.now(), text: '外部宿主消息',
      parts: [{ kind: 'text', text: '外部宿主消息' }], mentions: [], directedToAccount: false,
    },
  })
  const deadline = Date.now() + 5_000
  while (!sent.length && Date.now() < deadline) await delay(20)
  assert.equal(sent.length, 1)
  assert.ok(sent[0]?.parts.some(part => part.kind === 'text' && part.text.includes('外部宿主已收到')))
  console.log('external Agent host confirmed delivery')
} finally {
  await host.stop()
  await redis.close()
}
