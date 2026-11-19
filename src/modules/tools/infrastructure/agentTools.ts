import type { AgentInteractionPlan, AgentInteractionResult } from '../../../contracts/agentInteraction.js'
import { normalizeAgentInteractionResult, validateAgentInteractionPlan } from './agentInteractions.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import type { AgentFileBytes, AgentFileListing, AgentFileRequest } from '../../../contracts/agentFiles.js'
import { snapshotAgentFileRequest, validateAgentFileBytes, validateAgentFileListing } from '../../content/infrastructure/agentFileBytes.js'
import type { AgentTool, AgentToolContext, AgentToolDeliveryGuard, AgentToolRegistry, AgentToolMessage } from '../../../contracts/agentTool.js'
import type { ConversationMemberSnapshot, ConversationMembersSnapshot, MessageImage } from '../../../contracts/platformConnection.js'
import { isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentFileUpload, FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { AgentAudioBytes, AgentVideoBytes } from '../../../contracts/agentMedia.js'
import type { AgentVideoInput } from '../../../contracts/agentVideo.js'
import { validateAgentVideoInput } from '../../media/domain/agentVideoInput.js'
import type { AgentMusicCard } from '../../../contracts/agentMusic.js'
import type { AgentVideoCard } from '../../../contracts/agentVideoCard.js'
import { validateAgentVideoCard } from '../../media/infrastructure/agentVideoCard.js'
import type { AgentMediaRelayPlan } from '../../../contracts/agentMediaRelay.js'
import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import { validateAgentMediaRelayPlan } from '../../media/domain/agentMediaRelayPlan.js'
import { sanitizeFinalReplyText, looksLikeToolArguments } from '../../conversation/domain/replySanitizer.js'
import { validateAgentMusicCard } from '../../media/infrastructure/agentMusicCard.js'
import { validateAgentAudioBytes, validateAgentVideoBytes } from '../../media/infrastructure/agentMediaBytes.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { normalizeFileDeliveryReceipt, validateAgentFileUpload } from '../../messaging/infrastructure/agentFileDelivery.js'
import type { MessageBundleItem } from '../../../contracts/platformMessage.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { validateMessageBundle } from '../../messaging/infrastructure/messageBundle.js'
import { validateAgentToolMessage } from '../../messaging/infrastructure/agentToolMessage.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { abortableAgentWeb } from './agentPublicWeb.js'

const maxChars = 16_000
const outcome = (status: 'success' | 'error' | 'unknown', content: string) => ({ kind: 'tool_outcome', status, content })

/** Adapt public host tools into the existing policy and durable action executor. */
export function createAgentTools(registry: AgentToolRegistry | undefined, ports: {
  signal: AbortSignal
  diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  /** Dynamic host credential check before any public tool receives model arguments. */
  allowsInput?(input: string): boolean
  context(event: unknown): (Omit<AgentToolContext, 'signal' | 'sendImage' | 'sendFile' | 'sendAudio' | 'sendVideo' | 'sendMusic' | 'sendVideoCard' | 'sendMediaRelay' | 'interact' | 'isSourceAvailable' | 'readImages' | 'sendBundle' | 'sendMessage' | 'readMember' | 'listMembers' | 'readHistory' | 'readFile' | 'readVideo' | 'listFiles'> & {
    readFile?(input: AgentFileRequest, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileBytes>
    /** The current check lives for the turn; signal ends only this individual call. */
    readVideo?(isCurrent: () => boolean, signal: AbortSignal): Promise<AgentVideoInput>
    listFiles?(input: { readonly query?: string; readonly folderPath?: string }, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileListing>
    readHistory?(input: Record<string, unknown>, isCurrent: () => boolean, signal: AbortSignal): Promise<string>
    sendImage?(image: MessageImage, isCurrent?: () => boolean): Promise<DeliveryReceipt>
    sendFile?(file: AgentFileUpload, isCurrent: () => boolean, signal: AbortSignal): Promise<FileDeliveryReceipt>
    sendAudio?(audio: AgentAudioBytes, isCurrent: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt>
    sendVideo?(video: AgentVideoBytes, isCurrent: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt>
    sendMusic?(music: AgentMusicCard, isCurrent: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt>
    sendVideoCard?(card: AgentVideoCard, isCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>): Promise<DeliveryReceipt>
    sendMediaRelay?(plan: AgentMediaRelayPlan, isCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>): Promise<DeliveryReceipt>
    interact?(plan: AgentInteractionPlan, isCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>): Promise<AgentInteractionResult>
    isSourceAvailable?(source: { readonly messageId: string; readonly author: PlatformUserRef }, isCurrent: () => boolean, signal: AbortSignal): Promise<boolean>
    readImages?(sourceSeq: number, isCurrent?: () => boolean, signal?: AbortSignal): Promise<readonly { readonly mime: string; readonly base64: string }[]>
    sendBundle?(items: readonly MessageBundleItem[], isCurrent?: () => boolean): Promise<DeliveryReceipt>
    sendMessage?(message: AgentToolMessage, isCurrent: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt>
    readMember?(userId: string, isCurrent: () => boolean, signal: AbortSignal): Promise<ConversationMemberSnapshot | undefined>
    listMembers?(isCurrent: () => boolean, signal: AbortSignal): Promise<ConversationMembersSnapshot | undefined>
  }) | undefined
  onStart?(event: unknown, cancel: () => void): () => void
}) {
  const diagnose = (event: Parameters<AgentDiagnostics['emit']>[0]) => { try { ports.diagnostics?.emit(event) } catch { /* diagnostics never affect tools */ } }
  const classify = (value: unknown): 'succeeded' | 'failed' | 'unknown' => {
    if (typeof value === 'string') return value.startsWith('error:') ? 'failed' : 'unknown'
    if (!value || typeof value !== 'object') return 'unknown'
    const row = value as Record<string, unknown>
    return row.status === 'unknown' || row.unknown === true ? 'unknown'
      : row.status === 'error' || row.status === 'failed' || row.ok === false ? 'failed'
        : row.status === 'success' || row.status === 'succeeded' || row.ok === true ? 'succeeded' : 'unknown'
  }
  let instances = new Map<string, AbstractTool>()
  let builtIn: string[] = []
  let cached = new Map<string, { definition: AgentTool; origin: string; instance: AbstractTool }>()
  function refresh() {
    const next = new Map<string, AbstractTool>()
    const nextCache = new Map<string, { definition: AgentTool; origin: string; instance: AbstractTool }>()
    const nextBuiltIn: string[] = []
    for (const [origin, definitions] of [['builtin', registry?.builtIn ?? []], ['custom', registry?.custom ?? []]] as const) {
      for (const definition of definitions) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(definition.name) || definition.name.startsWith('sim') ||
            ['commitmentTool', 'delegateMemoryTool'].includes(definition.name) || next.has(definition.name) ||
            !definition.description?.trim() || definition.description.length > 4000 || typeof definition.execute !== 'function' ||
            definition.dataPolicy !== undefined && definition.dataPolicy !== 'ephemeral') {
          throw new Error('Agent 工具需要唯一且非保留的名称、说明和执行方法')
        }
        const existing = cached.get(definition.name)
        if (existing?.definition === definition && existing.origin === origin) {
          next.set(definition.name, existing.instance); nextCache.set(definition.name, existing)
          if (origin === 'builtin') nextBuiltIn.push(definition.name)
          continue
        }
        const schema = JSON.stringify(definition.parameters)
        if (!schema || schema.length > maxChars || definition.parameters.type !== 'object' ||
            !definition.parameters.properties || Array.isArray(definition.parameters.properties) ||
            !Array.isArray(definition.parameters.required) ||
            definition.parameters.required.some(key => typeof key !== 'string' || !Object.hasOwn(definition.parameters.properties, key))) {
          throw new Error('Agent 工具需要有界的对象参数定义')
        }
        const execute = definition.execute.bind(definition)
        const dataPolicy = definition.dataPolicy
        const timeoutMs = definition.timeoutMs === undefined ? 45_000 : definition.timeoutMs
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240_000) throw new Error('Agent 工具执行时限需要为 1 到 240000 毫秒的整数')
        class HostTool extends AbstractTool {
          constructor() {
            super()
            this.name = definition.name
            this.description = definition.description
            this.parameters = JSON.parse(schema)
            if (dataPolicy) this.agentDataPolicy = dataPolicy
          }
          override async execute(input: unknown, event: unknown): Promise<unknown> {
            const started = Date.now()
            diagnose({ stage: 'tool', operation: this.name, outcome: 'started' })
            try {
              const result = await super.execute(input, event), status = classify(result)
              diagnose({ stage: 'tool', operation: this.name, outcome: status, code: status === 'succeeded' ? 'completed' : `returned_${status}`, durationMs: Date.now() - started })
              return result
            } catch (error) {
              diagnose({ stage: 'tool', operation: this.name, outcome: 'unknown', code: 'tool_threw', error, durationMs: Date.now() - started })
              throw error
            }
          }
          override validateParameters(input: Record<string, unknown>) {
            if (JSON.stringify(input).length > maxChars || (this.parameters.additionalProperties === false &&
                Object.keys(input).some(key => !Object.hasOwn(this.parameters.properties, key)))) return '工具参数超出定义'
            return super.validateParameters(input)
          }
          override async func(input: Record<string, unknown>, event: unknown) {
            const originalScope = ports.context(event)
            const definitionCurrent = () => {
              try { return (origin === 'builtin' ? registry?.builtIn : registry?.custom)?.includes(definition) === true }
              catch { return false }
            }
            const scope = originalScope && { ...originalScope, isCurrent: () => definitionCurrent() && originalScope.isCurrent() }
            if (!scope || !scope.isCurrent() || ports.signal.aborted) return outcome('error', '工具所属回合已失效，未执行')
            if (ports.allowsInput?.(JSON.stringify(input)) === false) return outcome('error', '工具参数包含宿主禁止外发的内容，未执行')
            if (origin === 'custom' && scope.actor.kind !== 'user') return outcome('error', '自定义工具仅允许真实用户触发的回合执行')
            const cancel = new AbortController()
            const inherited = (event as { _agentToolSignal?: AbortSignal })._agentToolSignal
            const signal = AbortSignal.any([cancel.signal, ports.signal, AbortSignal.timeout(timeoutMs), ...(inherited ? [inherited] : [])])
            // Binding/config changes have no event emitter; fence an in-flight request too.
            const timer = setInterval(() => { if (!scope.isCurrent()) cancel.abort() }, 25)
            let usedHistory = false
            let fileDeliveryUnknown = false
            let mediaDeliveryUnknown = false
            let release: (() => void) | undefined
            try {
              release = ports.onStart?.(event, () => cancel.abort())
              const ensureCurrent = async () => {
                try {
                  signal.throwIfAborted()
                  if (!scope.isCurrent()) throw new Error('stale tool')
                  await scope.ensureCurrent?.()
                  signal.throwIfAborted()
                  if (!scope.isCurrent()) throw new Error('stale tool')
                } catch { cancel.abort(); throw new Error('工具权限已失效') }
              }
              const ensureMediaKnown = () => { if (mediaDeliveryUnknown) throw new Error('媒体发送结果未知，核实前不重复执行或发送') }
              const deliverFromSource = async (sourceGuard: AgentToolDeliveryGuard | undefined,
                send: (current: () => boolean) => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> => {
                const deliverySignal = AbortSignal.any([signal, ...(sourceGuard ? [sourceGuard.signal] : [])])
                const current = () => {
                  try { return !deliverySignal.aborted && scope.isCurrent() && sourceGuard?.isCurrent() !== false }
                  catch { return false }
                }
                const check = () => { if (!current()) throw new Error('发送来源已失效') }
                const ensure = async () => {
                  check()
                  await abortableAgentWeb(ensureCurrent(), deliverySignal); check()
                  if (sourceGuard?.ensureCurrent) {
                    await abortableAgentWeb(Promise.resolve().then(() => { check(); return sourceGuard.ensureCurrent!() }), deliverySignal)
                    check()
                  }
                }
                await ensure(); ensureMediaKnown()
                let attempted = false, receipt: DeliveryReceipt | undefined
                try {
                  const delivered = normalizeDeliveryReceipt(await abortableAgentWeb(Promise.resolve().then(() => {
                    check(); ensureMediaKnown(); attempted = true
                    return send(current)
                  }), deliverySignal))
                  receipt = delivered
                  if (delivered.state === 'unknown') mediaDeliveryUnknown = true
                  await ensure()
                  return delivered
                } catch (error) {
                  // A cancelled queue can still finish later. Fence every later send
                  // until the host has an explicit failure, including caught errors.
                  if (attempted && receipt?.state !== 'failed') mediaDeliveryUnknown = true
                  throw error
                }
              }
              const sendImage = scope.sendImage
                ? async (image: MessageImage, sourceGuard?: AgentToolDeliveryGuard) => {
                  if (signal.aborted || !scope.isCurrent()) throw new Error('工具权限已失效')
                  ensureMediaKnown()
                  const validated = validateAgentToolImage(image)
                  return deliverFromSource(sourceGuard, current => scope.sendImage!(validated, current))
                } : undefined
              const sendFile = dataPolicy !== 'ephemeral' && scope.sendFile ? async (file: AgentFileUpload) => {
                ensureMediaKnown()
                const owned = validateAgentFileUpload(file)
                if (usedHistory) throw new Error('临时资料回合不允许上传文件')
                await ensureCurrent()
                const receipt = normalizeFileDeliveryReceipt(await scope.sendFile!(owned, () => !signal.aborted && scope.isCurrent(), signal))
                if (receipt.state === 'unknown') fileDeliveryUnknown = true
                await ensureCurrent()
                return receipt
              } : undefined
              const sendAudio = dataPolicy !== 'ephemeral' && scope.sendAudio ? async (audio: AgentAudioBytes) => {
                ensureMediaKnown()
                const owned = validateAgentAudioBytes(audio)
                if (usedHistory) throw new Error('临时资料回合不允许发送音频')
                await ensureCurrent()
                const receipt = normalizeDeliveryReceipt(await scope.sendAudio!(owned, () => !signal.aborted && scope.isCurrent(), signal))
                if (receipt.state === 'unknown') mediaDeliveryUnknown = true
                await ensureCurrent()
                return receipt
              } : undefined
              const sendMusic = dataPolicy !== 'ephemeral' && scope.sendMusic ? async (music: AgentMusicCard) => {
                ensureMediaKnown()
                const owned = validateAgentMusicCard(music)
                if (usedHistory) throw new Error('临时资料回合不允许发送音乐卡片')
                await ensureCurrent()
                const receipt = normalizeDeliveryReceipt(await scope.sendMusic!(owned, () => !signal.aborted && scope.isCurrent(), signal))
                if (receipt.state === 'unknown') mediaDeliveryUnknown = true
                await ensureCurrent()
                return receipt
              } : undefined
              const sendVideo = dataPolicy !== 'ephemeral' && scope.sendVideo ? async (video: AgentVideoBytes) => {
                ensureMediaKnown()
                const owned = validateAgentVideoBytes(video)
                if (usedHistory) throw new Error('临时资料回合不允许发送视频')
                await ensureCurrent()
                const receipt = normalizeDeliveryReceipt(await scope.sendVideo!(owned, () => !signal.aborted && scope.isCurrent(), signal))
                if (receipt.state === 'unknown') mediaDeliveryUnknown = true
                await ensureCurrent()
                return receipt
              } : undefined
              const sendVideoCard = dataPolicy !== 'ephemeral' && scope.sendVideoCard && scope.actor.kind === 'user' && scope.binding.target?.kind === 'group'
                ? async (card: AgentVideoCard, sourceGuard?: { signal: AbortSignal; isCurrent(): boolean; ensureCurrent?(): Promise<void> }) => {
                  ensureMediaKnown()
                  if (usedHistory) throw new Error('临时资料回合不允许发送视频卡片')
                  const owned = validateAgentVideoCard(card, text => ports.allowsInput?.(text) !== false)
                  const deliverySignal = AbortSignal.any([signal, ...(sourceGuard ? [sourceGuard.signal] : [])])
                  const current = () => !deliverySignal.aborted && scope.isCurrent() && sourceGuard?.isCurrent() !== false
                  await ensureCurrent()
                  await sourceGuard?.ensureCurrent?.()
                  if (!current()) throw new Error('视频卡片来源已失效')
                  const ensure = async () => { await ensureCurrent(); await sourceGuard?.ensureCurrent?.(); if (!current()) throw new Error('视频卡片来源已失效') }
                  const receipt = normalizeDeliveryReceipt(await scope.sendVideoCard!(owned, current, deliverySignal, ensure))
                  if (receipt.state === 'unknown') mediaDeliveryUnknown = true
                  await ensureCurrent()
                  return receipt
                } : undefined
              const sendMediaRelay = dataPolicy !== 'ephemeral' && scope.sendMediaRelay && scope.actor.kind === 'user' && scope.binding.target?.kind === 'group' ? async (plan: AgentMediaRelayPlan,
                sourceGuard?: { readonly signal: AbortSignal; isCurrent(): boolean; ensureCurrent?(): Promise<void> }) => {
                ensureMediaKnown()
                if (usedHistory) throw new Error('临时资料回合不允许发送媒体转发')
                const allowsText = (text: string) => sanitizeFinalReplyText(text) === text && !looksLikeToolArguments(text) && ports.allowsInput?.(text) !== false
                const owned = validateAgentMediaRelayPlan(plan, { allowsText })
                const texts = owned.items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')).filter(Boolean)
                if ([...texts, texts.join('\n')].some(text => !allowsText(text))) throw new Error('媒体转发文字未通过完整内容检查')
                const deliverySignal = AbortSignal.any([signal, ...(sourceGuard ? [sourceGuard.signal] : [])])
                const current = () => !deliverySignal.aborted && scope.isCurrent() && sourceGuard?.isCurrent() !== false
                const ensure = async () => {
                  await ensureCurrent()
                  await sourceGuard?.ensureCurrent?.()
                  if (usedHistory) throw new Error('临时资料回合不允许发送媒体转发')
                  ensureMediaKnown()
                  if (!current()) throw new Error('媒体转发来源已失效')
                }
                await ensure()
                const receipt = normalizeDeliveryReceipt(await scope.sendMediaRelay!(owned, current, deliverySignal, ensure))
                if (receipt.state === 'unknown') mediaDeliveryUnknown = true
                await ensureCurrent()
                return receipt
              } : undefined
              const isSourceAvailable = scope.isSourceAvailable && scope.actor.kind === 'user' && scope.binding.target?.kind === 'group' ? async (source: { readonly messageId: string; readonly author: PlatformUserRef }) => {
                try {
                  const descriptors = Object.getOwnPropertyDescriptors(source), author = descriptors.author?.value as unknown
                  if (!source || Reflect.ownKeys(descriptors).some(key => key !== 'messageId' && key !== 'author') ||
                      !Object.hasOwn(descriptors.messageId ?? {}, 'value') || !Object.hasOwn(descriptors.author ?? {}, 'value') ||
                      !isPlatformIdentifier(descriptors.messageId.value) || descriptors.messageId.value === '0' || !author || typeof author !== 'object') return false
                  const fields = Object.getOwnPropertyDescriptors(author)
                  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !['platform', 'namespace', 'id'].includes(key)) || ['platform', 'namespace', 'id'].some(key => !Object.hasOwn(fields[key] ?? {}, 'value'))) return false
                  const owned = Object.freeze({ messageId: descriptors.messageId.value as string, author: Object.freeze({ platform: fields.platform!.value as string, namespace: fields.namespace!.value as string, id: fields.id!.value as string }) })
                  if (!isPlatformAccount(owned.author) || !samePlatformNamespace(owned.author, scope.binding.target.account)) return false
                  if (ports.allowsInput?.(JSON.stringify(owned)) === false) return false
                  await ensureCurrent()
                  const available = await scope.isSourceAvailable!(owned, () => !signal.aborted && scope.isCurrent(), signal)
                  await ensureCurrent()
                  return available === true
                } catch { return false }
              } : undefined
              const readImages = scope.readImages
                ? async (sourceSeq: number) => {
                  await ensureCurrent()
                  if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) throw new Error('请使用本轮可见的附图消息正整数序号')
                  const images = await scope.readImages!(sourceSeq, () => !signal.aborted && scope.isCurrent(), signal)
                  await ensureCurrent()
                  if (!Array.isArray(images) || images.length > 2) throw new Error('消息图片读取结果无效或超出数量上限')
                  return images.map(validateAgentToolImage)
                } : undefined
              const sendBundle = scope.sendBundle
                ? async (items: readonly MessageBundleItem[], sourceGuard?: AgentToolDeliveryGuard) => {
                  if (signal.aborted || !scope.isCurrent()) throw new Error('工具权限已失效')
                  ensureMediaKnown()
                  // Own immutable bytes/text before an asynchronous authorization wait.
                  const validated = validateMessageBundle(items)
                  return deliverFromSource(sourceGuard, current => scope.sendBundle!(validated, current))
                } : undefined
              const readMember = scope.readMember ? async (userId: string) => {
                if (!isPlatformIdentifier(userId)) throw new Error('成员标识无效')
                await ensureCurrent()
                const result = await scope.readMember!(userId, () => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return result
              } : undefined
              const listMembers = scope.listMembers ? async () => {
                await ensureCurrent()
                const result = await scope.listMembers!(() => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return result
              } : undefined
              const readHistory = scope.readHistory ? async (input: Record<string, unknown>) => {
                usedHistory = true
                // Snapshot model arguments before awaiting authorization.
                const owned: Record<string, unknown> = JSON.parse(JSON.stringify(input))
                await ensureCurrent()
                const result = await scope.readHistory!(owned, () => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return result
              } : undefined
              const readFile = dataPolicy === 'ephemeral' && scope.readFile ? async (input: AgentFileRequest) => {
                usedHistory = true
                const owned = snapshotAgentFileRequest(input)
                await ensureCurrent()
                const result = await scope.readFile!(owned, () => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return validateAgentFileBytes(result)
              } : undefined
              const readVideo = dataPolicy === 'ephemeral' && scope.actor.kind === 'user' && scope.binding.target.kind === 'group' && scope.readVideo ? async () => {
                usedHistory = true
                await ensureCurrent()
                // Keep definition/config authority alive after this tool's timeout
                // controller is released; the read signal still bounds this call.
                const result = await scope.readVideo!(scope.isCurrent, signal)
                await ensureCurrent()
                return validateAgentVideoInput(result)
              } : undefined
              const listFiles = dataPolicy === 'ephemeral' && scope.listFiles ? async (input: { readonly query?: string; readonly folderPath?: string }) => {
                usedHistory = true
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'query' && key !== 'folderPath')) throw new Error('文件目录选择参数无效')
                const owned = JSON.parse(JSON.stringify(input)) as { query?: string; folderPath?: string }
                for (const key of ['query', 'folderPath'] as const) if (owned[key] !== undefined && (typeof owned[key] !== 'string' || owned[key]!.length > 1024 || /[\u0000-\u001f\u007f]/u.test(owned[key]!))) throw new Error('文件目录选择参数无效')
                await ensureCurrent()
                const result = await scope.listFiles!(Object.freeze(owned), () => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return validateAgentFileListing(result)
              } : undefined
              const sendMessage = scope.sendMessage ? async (message: AgentToolMessage) => {
                ensureMediaKnown()
                const owned = validateAgentToolMessage(message)
                await ensureCurrent()
                const receipt = await scope.sendMessage!(owned, () => !signal.aborted && scope.isCurrent(), signal)
                await ensureCurrent()
                return receipt
              } : undefined
              const interact = dataPolicy !== 'ephemeral' && scope.interact ? async (plan: AgentInteractionPlan): Promise<AgentInteractionResult> => {
                ensureMediaKnown()
                if (usedHistory) throw new Error('临时资料回合不允许外部互动')
                const owned = validateAgentInteractionPlan(plan, scope.binding.target.account)
                await ensureCurrent()
                const result = normalizeAgentInteractionResult(await scope.interact!(owned, () => !signal.aborted && scope.isCurrent(), signal, ensureCurrent), owned.operations.length)
                if (result.state === 'unknown') mediaDeliveryUnknown = true
                return result
              } : undefined
              let abort: (() => void) | undefined
              const result = await Promise.race([
                Promise.resolve().then(async () => {
                  await ensureCurrent()
                  const { readMember: _readMember, listMembers: _listMembers, sendMessage: _sendMessage, sendImage: _sendImage, sendBundle: _sendBundle, readImages: _readImages, sendFile: _sendFile, sendAudio: _sendAudio, sendVideo: _sendVideo, sendMusic: _sendMusic, sendVideoCard: _sendVideoCard, sendMediaRelay: _sendMediaRelay, interact: _interact, isSourceAvailable: _isSourceAvailable, readHistory: _readHistory, readFile: _readFile, readVideo: _readVideo, listFiles: _listFiles, runQqAction: _runQqAction, ...publicScope } = scope
                  const result = await execute(input, { ...publicScope, signal, isCurrent: () => !signal.aborted && scope.isCurrent(), ensureCurrent,
                    ...(sendImage ? { sendImage } : {}),
                    ...(sendFile ? { sendFile } : {}),
                    ...(sendAudio ? { sendAudio } : {}),
                    ...(sendVideo ? { sendVideo } : {}),
                    ...(sendMusic ? { sendMusic } : {}),
                    ...(sendVideoCard ? { sendVideoCard } : {}),
                    ...(sendMediaRelay ? { sendMediaRelay } : {}),
                    ...(interact ? { interact } : {}),
                    ...(scope.runQqAction ? { runQqAction: async (kind, operation) => {
                      ensureMediaKnown()
                      if (usedHistory) throw new Error('临时资料不能授权QQ扩展动作')
                      await ensureCurrent()
                      return scope.runQqAction!(kind, async guard => {
                        const current = () => !signal.aborted && scope.isCurrent() && guard.isCurrent()
                        const ensure = async () => { await ensureCurrent(); await guard.ensureCurrent(); if (!current()) throw new Error('QQ扩展动作已失效') }
                        return operation({ signal: AbortSignal.any([signal, guard.signal]), isCurrent: current, ensureCurrent: ensure })
                      })
                    } } : {}),
                    ...(isSourceAvailable ? { isSourceAvailable } : {}),
                    ...(readImages ? { readImages } : {}),
                    ...(sendBundle ? { sendBundle } : {}),
                    ...(sendMessage ? { sendMessage } : {}),
                    ...(readMember ? { readMember } : {}),
                    ...(listMembers ? { listMembers } : {}),
                    ...(readHistory ? { readHistory } : {}),
                    ...(readFile ? { readFile } : {}),
                    ...(readVideo ? { readVideo } : {}),
                    ...(listFiles ? { listFiles } : {}),
                  })
                  await ensureCurrent()
                  return result
                }),
                new Promise<never>((_resolve, reject) => {
                  abort = () => reject(new Error('Agent tool cancelled'))
                  signal.addEventListener('abort', abort, { once: true })
                  if (signal.aborted) abort()
                }),
              ]).finally(() => { if (abort) signal.removeEventListener('abort', abort) })
              if (signal.aborted || !scope.isCurrent()) return outcome('unknown', '执行期间回合已失效，迟到结果不再使用；核实前不重复执行')
              if (fileDeliveryUnknown) return outcome('unknown', '文件上传结果未知，核实前不重复执行或发送')
              if (mediaDeliveryUnknown) return outcome('unknown', '媒体发送结果未知，核实前不重复执行或发送')
              if (!result || !['succeeded', 'failed', 'unknown'].includes(result.status) || typeof result.content !== 'string') {
                return outcome('unknown', '工具没有返回有效执行回执，核实前不重复执行')
              }
              return outcome(result.status === 'succeeded' ? 'success' : result.status === 'failed' ? 'error' : 'unknown', result.content.slice(0, usedHistory ? 32_000 : maxChars))
            } catch (error) {
              diagnose({ stage: 'tool', operation: this.name, outcome: 'unknown', code: signal.aborted ? 'tool_cancelled' : 'tool_threw', error })
              return outcome('unknown', '工具执行未能确认结果，核实前不重复执行')
            } finally { clearInterval(timer); cancel.abort(); release?.() }
          }
        }
        const instance = new HostTool()
        next.set(instance.name, instance)
        nextCache.set(instance.name, { definition, origin, instance })
        if (origin === 'builtin') nextBuiltIn.push(instance.name)
      }
    }
    instances = next; builtIn = nextBuiltIn; cached = nextCache
  }
  refresh()
  return {
    listRegistryToolNames: () => { refresh(); return { builtIn: [...builtIn], all: [...instances.keys()] } },
    isExtraToolAutonomous: (name: string) => { refresh(); return builtIn.includes(name) },
    getExtraTools: (names: string[]) => { refresh(); return [...new Set(names)].flatMap(name => instances.has(name) ? [instances.get(name)!] : []) },
  }
}
