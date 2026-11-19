import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import type { PlatformConnectionAdapter } from '../../../contracts/platformConnection.js'
import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { SimMessage } from '../../../contracts/simulation.js'
import { conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { createSimulationAgentFiles, simulationFileMetadata, type SimulationMessageFileSource } from '../../simulation/infrastructure/simulationAgentFiles.js'
import { createSimulationAgentVideo, simulationVideoCount } from '../../simulation/infrastructure/simulationAgentVideo.js'
import { readAgentPublicFile } from '../../tools/infrastructure/agentPublicWeb.js'
import type { AgentTextToolPorts } from './agentTextRegistryTools.js'

/** The resolvers are shared with simulation; this bridge supplies a fixed, verified text turn. */
export function createAgentTextToolSources(ports: {
  incoming: IncomingMessage
  adapter: PlatformConnectionAdapter
  signal: AbortSignal
  privatePeer?: string
  now(): number
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  available(source: { readonly messageId: string; readonly author: PlatformUserRef }, expected?: Pick<IncomingMessage, 'text' | 'occurredAt'>): Promise<boolean>
  allowsUnlinkedSource(author: PlatformUserRef, at: number): Promise<boolean>
  registerProjection(projection: { isCurrent(): Promise<boolean> }): void
}): AgentTextToolPorts {
  const { incoming, adapter, signal } = ports, target = incoming.conversation
  const request: SimMessage = { seq: 1, messageId: incoming.messageId!, userId: incoming.sender.id, name: incoming.senderName ?? '',
    text: incoming.text, at: incoming.occurredAt, atSelf: incoming.directedToAccount, quoteToSelf: false,
    kind: 'text', imageCount: incoming.parts.filter(part => part.kind === 'image').length, videoCount: simulationVideoCount(incoming.parts),
    files: simulationFileMetadata(incoming.parts), ...(incoming.parts.find(part => part.kind === 'forward') ? {
      forwardId: incoming.parts.find(part => part.kind === 'forward')!.id,
    } : {}) }
  let quoted: IncomingMessage | undefined, quoteLoaded = false
  const current = () => !signal.aborted && ports.isCurrent()
  const load = async (id: string) => {
    await ports.ensureCurrent()
    if (!current() || id !== incoming.messageId && id !== incoming.quote?.messageId) return undefined
    const value = await adapter.readMessage?.(target, id, { signal, isCurrent: current })
    if (!value || value.messageId !== id || conversationAddressKey(value.conversation) !== conversationAddressKey(target) ||
        target.kind === 'private' && value.sender.id !== ports.privatePeer ||
        !await ports.available({ messageId: id, author: value.sender }, id === incoming.messageId ? incoming : quoted)) return undefined
    if (id === incoming.messageId && (platformAccountKey(value.sender) !== platformAccountKey(incoming.sender) ||
        value.quote?.messageId !== incoming.quote?.messageId || JSON.stringify(simulationFileMetadata(value.parts)) !== JSON.stringify(request.files) ||
        simulationVideoCount(value.parts) !== request.videoCount || value.parts.filter(part => part.kind === 'image').length !== request.imageCount ||
        value.parts.find(part => part.kind === 'forward')?.id !== request.forwardId)) return undefined
    if (id !== incoming.messageId && quoted && (platformAccountKey(value.sender) !== platformAccountKey(quoted.sender) ||
        JSON.stringify(simulationFileMetadata(value.parts)) !== JSON.stringify(simulationFileMetadata(quoted.parts)) ||
        simulationVideoCount(value.parts) !== simulationVideoCount(quoted.parts))) return undefined
    return current() ? value : undefined
  }
  const ensureSources = async () => {
    if (!await load(incoming.messageId!)) throw new Error('本轮工具原消息已失效')
    if (!quoteLoaded) {
      quoteLoaded = true
      if (incoming.quote?.messageId) {
        quoted = await load(incoming.quote.messageId)
        if (quoted) {
          request.quoteSource = { messageId: incoming.quote.messageId, invalidatedAt: 0,
            file: { files: simulationFileMetadata(quoted.parts), authorId: quoted.sender.id, occurredAt: quoted.occurredAt },
            video: { count: simulationVideoCount(quoted.parts), authorId: quoted.sender.id, occurredAt: quoted.occurredAt,
              ...(quoted.parts.some(part => part.kind === 'forward') ? { hasForward: true } : {}) } }
        }
      }
    }
    if (quoted && !await load(quoted.messageId!)) throw new Error('本轮工具引用消息已失效')
  }
  const allowsFileSource = async (source: SimulationMessageFileSource, original: IncomingMessage) => {
    const fresh = await load(source.messageId)
    return !!fresh && original.messageId === source.messageId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
      platformAccountKey(original.sender) === platformAccountKey(fresh.sender) && original.sender.id === source.authorId &&
      original.occurredAt === source.occurredAt && original.text === fresh.text &&
      JSON.stringify(simulationFileMetadata(original.parts)) === JSON.stringify(source.files)
  }
  const files = createSimulationAgentFiles({ target, actorId: incoming.sender.id, request, signal, now: ports.now,
    messages: () => [request], isVisible: seq => seq === 1, isCurrent: current, ensureCurrent: ensureSources,
    markEphemeral() {}, registerProjection: ports.registerProjection,
    async loadMessage(source) { const value = await load(source.messageId); return value && await allowsFileSource(source, value) ? value : undefined },
    allowsSource: allowsFileSource,
    async allowsRepositoryFile(entry) {
      return !!entry.uploadedBy && entry.uploadedAt !== undefined && await ports.allowsUnlinkedSource(entry.uploadedBy, entry.uploadedAt)
    },
    ...(adapter.readMessageFile ? { readMessageFile: (_target, source, index, guard) => adapter.readMessageFile!(target, source.quotedMessageId ?? source.messageId, index, guard) } : {}),
    ...(target.kind === 'group' && adapter.listConversationFiles ? { listConversationFiles: (_target, guard) => adapter.listConversationFiles!(target, guard) } : {}),
    ...(target.kind === 'group' && adapter.readConversationFile ? { readConversationFile: (_target, entry, guard) => adapter.readConversationFile!(target, entry, guard) } : {}),
    readPublicFile: readAgentPublicFile,
  })
  const controller = new AbortController(), turnSignal = AbortSignal.any([signal, controller.signal])
  let video: ReturnType<typeof createSimulationAgentVideo> | undefined
  return {
    readFile: async (input, guard, toolSignal) => { await ensureSources(); return files.readFile(input, guard, toolSignal) },
    ...(target.kind === 'group' && adapter.listConversationFiles ? { listFiles: async (input, guard, toolSignal) => {
      await ensureSources(); return files.listFiles(input, guard, toolSignal)
    } } : {}),
    ...(adapter.readMessageImages ? { async readImages(seq: number, guard?: () => boolean, toolSignal?: AbortSignal) {
      await ensureSources()
      const source = seq === 1 ? incoming : seq === 2 ? quoted : undefined
      if (!source?.messageId) throw new Error('请使用当前消息序号1或已核验引用序号2')
      const readSignal = AbortSignal.any([signal, ...(toolSignal ? [toolSignal] : [])]), isCurrent = () => !readSignal.aborted && current() && guard?.() !== false
      const projection = { async isCurrent() { return current() && !!await load(source.messageId!) } }
      ports.registerProjection(projection)
      const images = await adapter.readMessageImages!(target, source.messageId, { signal: readSignal, isCurrent,
        async allowsSource(original) { const fresh = await load(source.messageId!); return isCurrent() && !!fresh &&
          original.messageId === fresh.messageId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
          platformAccountKey(original.sender) === platformAccountKey(fresh.sender) && original.text === fresh.text && original.occurredAt === fresh.occurredAt },
      })
      if (!isCurrent() || !await projection.isCurrent()) throw new Error('图片来源已改变')
      return images ?? []
    } } : {}),
    ...(target.kind === 'group' && adapter.readMessageVideo ? { async readVideo(guard: () => boolean, toolSignal: AbortSignal) {
      await ensureSources()
      video ??= createSimulationAgentVideo({ target, request, signal: turnSignal, isCurrent: current,
        requestCurrent: current, ensureCurrent: ensureSources, cancelTurn: () => controller.abort(), markEphemeral() {}, registerProjection: ports.registerProjection,
        loadMessage: load,
        async allowsOriginal(original, id, author, at) { const fresh = await load(id); return !!fresh && original.messageId === id &&
          conversationAddressKey(original.conversation) === conversationAddressKey(target) && original.sender.id === author &&
          platformAccountKey(original.sender) === platformAccountKey(fresh.sender) && original.occurredAt === at && original.text === fresh.text },
        requestTextCurrent: original => original.text === incoming.text,
        allowsForwardSource: source => ports.allowsUnlinkedSource(source.author, source.occurredAt),
        readMessageVideo: (fixedTarget, id, options) => adapter.readMessageVideo!(fixedTarget, id, options),
      })
      return video.readVideo(guard, toolSignal)
    } } : {}),
  }
}
