import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAgentBindingDirectory, createAgentRuntime, type AgentRuntimeOptions,
  type ConversationAddress, type PlatformConnectionAdapter, type PlatformConversationEvent,
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
  type AgentMediaRelayConfig, type AgentMediaRelayProvider, type AgentMediaShare, type MediaShareReadOptions,
  type AgentTorrentProvider, type AgentTorrentConfig, type SendRequesterArchiveAction,
  type AgentHistoryConfig, type AgentHistoryRequestSource, type AgentHistoryRecall,
} from 'bl-chat-agent'
import { createOneBotConnection, openQqMediaRelayBridge, createQqMediaRelayDeliveryPort, type QqMediaRelayBridge,
  openQqRequesterArchiveBridge, createQqRequesterArchiveDeliveryPort, type QqRequesterArchiveBridge } from 'bl-chat-agent/qq'
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
try {
  const store = await createAgentMediaArtifactStore({ directory: mediaDirectory })
  try {
    const relayConfig: AgentMediaRelayConfig = validateAgentMediaRelayConfig({ enabled: false })
    const relayShare: AgentMediaShare | undefined = parseAgentBilibiliReference('https://www.bilibili.com/video/BV1H7Gq6zEiC')
    const relayProvider: AgentMediaRelayProvider = createAgentBilibiliRelayProvider({ directory: mediaDirectory, artifacts: store })
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
