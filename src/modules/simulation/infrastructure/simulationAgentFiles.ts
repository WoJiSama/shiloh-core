import type { AgentFileBytes, AgentFileListing, AgentFileRequest, ConversationFileCatalog, ConversationFileEntry, ConversationFileReadOptions, FileReadGuard, MessageFileReadOptions } from '../../../contracts/agentFiles.js'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { IncomingMessage, MessagePart } from '../../../contracts/platformMessage.js'
import type { SimFileMetadata, SimMessage } from '../../../contracts/simulation.js'
import { conversationAddressKey } from '../../runtime/domain/agentBindings.js'

const RECENT_WINDOW_MS = 30 * 60_000
const MAX_MESSAGE_FILES = 20
const MAX_CATALOG_FILES = 2000

/** Names are display metadata only. Never retain a resource, provider ID, or URL. */
export function simulationFileMetadata(parts: readonly MessagePart[]): SimFileMetadata[] {
  return parts.filter(part => part.kind === 'file').slice(0, MAX_MESSAGE_FILES).map((part, index) => {
    const raw = 'name' in part && typeof part.name === 'string' ? part.name : ''
    const name = raw.replace(/[\u0000-\u001f\u007f/\\]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 255)
    return { name: name && !/https?:\/\//iu.test(raw) ? name : `文件${index + 1}` }
  })
}

/** Narrow newly persisted metadata on reload; discard any accidental resource fields. */
export function normalizeSimulationMessageFiles(message: SimMessage): SimMessage {
  if (!message || typeof message !== 'object') return message
  const normalize = (value: unknown) => Array.isArray(value) ? simulationFileMetadata(value.slice(0, MAX_MESSAGE_FILES).map(entry => ({ kind: 'file' as const, ...(entry && typeof entry === 'object' && typeof entry.name === 'string' ? { name: entry.name } : {}) }))) : []
  const { files: _files, ...rest } = message
  const files = normalize(message.files)
  const quote = message.quoteSource
  if (!quote?.file) return { ...rest, ...(files.length ? { files } : {}) }
  const { file: _file, ...quoteRest } = quote
  const quoted = normalize(quote.file.files)
  const valid = quoted.length && typeof quote.file.authorId === 'string' && quote.file.authorId.length > 0 && quote.file.authorId.length <= 200 && Number.isSafeInteger(quote.file.occurredAt) && quote.file.occurredAt > 0
  return { ...rest, ...(files.length ? { files } : {}), quoteSource: { ...quoteRest, ...(valid ? { file: { files: quoted, authorId: quote.file.authorId, occurredAt: quote.file.occurredAt } } : {}) } }
}

export interface SimulationMessageFileSource {
  readonly wrapper: SimMessage
  readonly messageId: string
  readonly authorId: string
  readonly occurredAt: number
  readonly files: readonly SimFileMetadata[]
  readonly quoted: boolean
}
export interface SimulationFileProjection { isCurrent(): Promise<boolean> }
export interface SimulationAgentFileContext {
  readonly target: ConversationAddress
  readonly actorId: string
  readonly request: SimMessage
  readonly signal?: AbortSignal
  now(): number
  messages(): readonly SimMessage[]
  isVisible(seq: number): boolean
  /** Turn lifetime, deliberately independent of an individual tool's timeout signal. */
  isCurrent(): boolean
  /** A low-level turn/privacy guard which must not traverse these projections. */
  ensureCurrent(): Promise<void>
  markEphemeral(): void
  registerProjection(projection: SimulationFileProjection): void
  /** Reload, validate identity/privacy/recall and verify the wrapper is still current. */
  loadMessage(source: SimulationMessageFileSource): Promise<IncomingMessage | undefined>
  allowsSource(source: SimulationMessageFileSource, original: IncomingMessage): Promise<boolean>
  allowsRepositoryFile(entry: ConversationFileEntry): Promise<boolean>
  readMessageFile?(target: ConversationAddress, source: { messageId: string; quotedMessageId?: string }, fileIndex: number, guard: MessageFileReadOptions): Promise<AgentFileBytes | undefined>
  listConversationFiles?(target: ConversationAddress, guard: FileReadGuard): Promise<ConversationFileCatalog | undefined>
  readConversationFile?(target: ConversationAddress, entry: ConversationFileEntry, guard: ConversationFileReadOptions): Promise<AgentFileBytes | undefined>
  readPublicFile?(url: string, guard: FileReadGuard): Promise<AgentFileBytes>
}

function requestCopy(input: AgentFileRequest): AgentFileRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sourceSeq', 'fileIndex', 'fileName', 'folderPath', 'fileUrl', 'extensions'].includes(key))) throw new Error('文件来源参数无效')
  const { sourceSeq, fileIndex, fileName, folderPath, fileUrl, extensions } = input
  if (sourceSeq !== undefined && (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) || fileIndex !== undefined && (!Number.isSafeInteger(fileIndex) || fileIndex < 1 || fileIndex > MAX_MESSAGE_FILES)) throw new Error('文件消息序号和附件序号必须是正整数')
  for (const [name, value, max] of [['fileName', fileName, 255], ['folderPath', folderPath, 1024], ['fileUrl', fileUrl, 2048]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error(`${name} 参数无效`)
  }
  if (extensions !== undefined && (!Array.isArray(extensions) || !extensions.length || extensions.length > 12 || extensions.some(value => typeof value !== 'string' || !/^\.[a-z0-9]{1,12}$/u.test(value)))) throw new Error('文件扩展名选择无效')
  if (fileUrl !== undefined && (sourceSeq !== undefined || fileIndex !== undefined || folderPath !== undefined) || folderPath !== undefined && sourceSeq !== undefined) throw new Error('请只选择一种文件来源')
  return { ...(sourceSeq === undefined ? {} : { sourceSeq }), ...(fileIndex === undefined ? {} : { fileIndex }),
    ...(fileName === undefined ? {} : { fileName: fileName.trim() }), ...(folderPath === undefined ? {} : { folderPath: folderPath.trim() }), ...(fileUrl === undefined ? {} : { fileUrl }), ...(extensions === undefined ? {} : { extensions: [...extensions] }) }
}
function exactUrl(text: string, url: string): boolean {
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false } catch { return false }
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"'`，。！？；、）》】]+/gu), match => match[0]).some(value => value === url)
}
function sourceFor(message: SimMessage, quoted: boolean): SimulationMessageFileSource | undefined {
  if (!message.messageId) return undefined
  const quote = quoted ? message.quoteSource : undefined
  const file = quote?.file
  if (quoted && !file) return undefined
  return { wrapper: message, messageId: quote?.messageId ?? String(message.messageId), authorId: file?.authorId ?? message.userId,
    occurredAt: file?.occurredAt ?? message.at, files: (file?.files ?? message.files ?? []).map(({ name }) => ({ name })), quoted }
}
function selectFile(source: SimulationMessageFileSource, input: AgentFileRequest, strict = false): number | undefined {
  const files = source.files
  if (!files.length) return undefined
  const supported = (name: string) => input.extensions === undefined || input.extensions.includes(name.slice(name.lastIndexOf('.')).toLowerCase())
  if (!files.some(file => supported(file.name))) {
    if (strict) throw new Error('该消息的直接文件类型不匹配，未切换到引用或其他来源')
    return undefined
  }
  if (input.fileIndex !== undefined) {
    const file = files[input.fileIndex - 1]
    if (!file) throw new Error('该消息没有这个附件序号，请按已显示的文件选择')
    if (!supported(file.name)) {
      if (strict) throw new Error('该附件类型不匹配，未切换到其他文件')
      return undefined
    }
    if (input.fileName !== undefined && file.name !== input.fileName) {
      if (strict) throw new Error('附件序号与文件名不匹配')
      return undefined
    }
    return input.fileIndex
  }
  const indices = files.flatMap((file, index) => supported(file.name) && (input.fileName === undefined || file.name === input.fileName) ? [index + 1] : [])
  if (indices.length > 1) throw new Error('有多个可用文件，请指定文件名或附件序号')
  if (!indices.length && strict) throw new Error('该消息没有这个文件，未切换到引用或其他来源')
  return indices[0]
}
function entryKey(entry: ConversationFileEntry): string {
  return JSON.stringify([entry.reference, entry.name, normalizeFolderPath(entry.folderPath), entry.size, entry.uploadedBy ? [entry.uploadedBy.platform, entry.uploadedBy.namespace, entry.uploadedBy.id] : null, entry.uploadedAt ?? null])
}
/** Display paths are compared without optional root/trailing slashes; never used as OS paths. */
function normalizeFolderPath(value: string): string { return value.trim().replace(/\/{2,}/gu, '/').replace(/^\/+|\/+$/gu, '').toLocaleLowerCase() }
function folderMatches(path: string, filter: string | undefined): boolean { return filter === undefined || normalizeFolderPath(path) === normalizeFolderPath(filter) }

/** Resolves only host-attested sources. All text/bytes and derived answers remain turn-local. */
export function createSimulationAgentFiles(context: SimulationAgentFileContext) {
  const turnSignal = context.signal ?? new AbortController().signal
  const turnGuard: FileReadGuard = { signal: turnSignal, isCurrent: () => !turnSignal.aborted && context.isCurrent(), ensureCurrent: () => context.ensureCurrent() }
  const ensure = async (isCurrent: () => boolean, signal: AbortSignal) => {
    if (signal.aborted || turnSignal.aborted || !isCurrent() || !context.isCurrent()) throw new Error('文件读取所属回合已失效')
    await context.ensureCurrent()
    if (signal.aborted || turnSignal.aborted || !isCurrent() || !context.isCurrent()) throw new Error('文件读取所属回合已失效')
  }
  const requestSource = () => sourceFor(context.request, false)!
  const requestCurrent = async () => context.isCurrent() && !!await context.loadMessage(requestSource())
  const project = (isCurrent: () => Promise<boolean>) => {
    const projection = { async isCurrent() { try { return !turnSignal.aborted && context.isCurrent() && await isCurrent() && !turnSignal.aborted && context.isCurrent() } catch { return false } } }
    context.registerProjection(projection)
    return projection
  }
  const readCatalog = async (guard: FileReadGuard): Promise<ConversationFileCatalog> => {
    if (!context.listConversationFiles) throw new Error('当前会话没有群文件目录读取能力')
    await guard.ensureCurrent?.()
    if (!guard.isCurrent() || guard.signal.aborted) throw new Error('群文件目录来源已失效')
    const boundedGuard = { ...guard, signal: AbortSignal.any([guard.signal, AbortSignal.timeout(10_000)]) }
    const catalog = await context.listConversationFiles(context.target, boundedGuard)
    if (!catalog || conversationAddressKey(catalog.target) !== conversationAddressKey(context.target) || !Number.isSafeInteger(catalog.observedAt) || catalog.observedAt <= 0 || !Array.isArray(catalog.files) || catalog.files.length > MAX_CATALOG_FILES || typeof catalog.truncated !== 'boolean') throw new Error('无法确认当前群的文件目录')
    for (const entry of catalog.files) {
      if (!entry || typeof entry.reference !== 'string' || !entry.reference || entry.reference.length > 2048 || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 255 || /[/\\]/u.test(entry.name) || typeof entry.folderPath !== 'string' || entry.folderPath.length > 1024 || /[\u0000-\u001f\u007f]/u.test(entry.name + entry.folderPath) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.uploadedAt !== undefined && (!Number.isSafeInteger(entry.uploadedAt) || entry.uploadedAt <= 0 || entry.uploadedAt > catalog.observedAt) || entry.uploadedBy && (entry.uploadedBy.platform !== context.target.account.platform || entry.uploadedBy.namespace !== context.target.account.namespace || typeof entry.uploadedBy.id !== 'string' || !entry.uploadedBy.id)) throw new Error('群文件目录条目无效')
    }
    const files: ConversationFileEntry[] = []
    for (const entry of catalog.files) if (await context.allowsRepositoryFile(entry)) files.push(entry)
    if (!guard.isCurrent() || boundedGuard.signal.aborted) throw new Error('群文件目录来源已失效')
    return structuredClone({ ...catalog, files })
  }
  const messageRead = async (source: SimulationMessageFileSource, fileIndex: number, origin: NonNullable<AgentFileBytes['origin']>, guard: FileReadGuard) => {
    if (!context.readMessageFile) throw new Error('当前会话没有消息文件读取能力')
    const projection = project(async () => await requestCurrent() && !!await context.loadMessage(source))
    if (!await projection.isCurrent()) throw new Error('文件消息来源已改变或已撤回')
    await guard.ensureCurrent?.()
    const file = await context.readMessageFile(context.target, { messageId: String(source.wrapper.messageId), ...(source.quoted ? { quotedMessageId: source.messageId } : {}) }, fileIndex,
      { ...guard, async allowsSource(original) { return guard.isCurrent() && !guard.signal.aborted && await context.allowsSource(source, original) } })
    await guard.ensureCurrent?.()
    if (!await projection.isCurrent()) throw new Error('文件消息来源已改变或已撤回')
    if (!file) throw new Error('该文件当前无法读取')
    return { ...file, origin }
  }
  return {
    async readFile(raw: AgentFileRequest, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileBytes> {
      context.markEphemeral()
      const input = requestCopy(raw)
      const guard: FileReadGuard = { signal: AbortSignal.any([signal, turnSignal]), isCurrent: () => context.isCurrent() && isCurrent() && !signal.aborted && !turnSignal.aborted, ensureCurrent: () => ensure(isCurrent, signal) }
      await ensure(isCurrent, signal)
      if (!await requestCurrent()) throw new Error('文件读取缺少当前已核验的真人请求')
      if (input.fileUrl !== undefined) {
        const original = await context.loadMessage(requestSource())
        if (!original || !exactUrl(original.text, input.fileUrl)) throw new Error('文件链接必须由本轮真人请求原文明确提供')
        if (!context.readPublicFile) throw new Error('当前会话没有公开文件链接读取能力')
        const projection = project(async () => { const current = await context.loadMessage(requestSource()); return !!current && exactUrl(current.text, input.fileUrl!) })
        const file = await context.readPublicFile(input.fileUrl, guard)
        await ensure(isCurrent, signal)
        if (!await projection.isCurrent()) throw new Error('文件链接请求来源已改变')
        return { ...file, ...(input.fileName === undefined ? {} : { name: input.fileName }), origin: 'explicit' }
      }
      if (input.sourceSeq !== undefined) {
        if (!context.isVisible(input.sourceSeq)) throw new Error('请使用本轮可见的文件消息序号')
        const message = context.messages().find(message => message.seq === input.sourceSeq)
        if (!message) throw new Error('文件消息已不在当前上下文')
        // A direct attachment fixes the source even when its name/index does not match.
        const source = sourceFor(message, !message.files?.length)
        if (!source) throw new Error('这条消息没有可读取的文件')
        const index = selectFile(source, input, true)
        if (!index) throw new Error('这条消息没有可读取的文件')
        return messageRead(source, index, source.quoted ? 'reply' : message.seq === context.request.seq ? 'current' : 'recent', guard)
      }
      if (input.folderPath === undefined) {
        for (const quoted of [false, true]) {
          const source = sourceFor(context.request, quoted)
          const index = source && selectFile(source, input)
          if (source && index) return messageRead(source, index, quoted ? 'reply' : 'current', guard)
        }
        const recent = [...context.messages()].filter(message => message.userId === context.actorId && message.seq !== context.request.seq && message.at <= context.request.at && message.at >= Math.max(context.request.at, context.now()) - RECENT_WINDOW_MS).sort((a, b) => b.seq - a.seq).slice(0, 30)
        const matches = recent.flatMap(message => { const source = sourceFor(message, false); const index = source && selectFile(source, input); return source && index ? [{ source, index }] : [] })
        if (matches.length > 1) throw new Error('本人近期有多个可用文件，请指定文件名或本轮可见的消息序号')
        if (matches[0]) return messageRead(matches[0].source, matches[0].index, 'recent', guard)
      }
      if (!context.readConversationFile) throw new Error('没有找到可用文件，请上传、引用文件或明确提供文件名')
      const catalog = await readCatalog(guard)
      const eligible = (entry: ConversationFileEntry) => (input.extensions === undefined || input.extensions.includes(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) && folderMatches(entry.folderPath, input.folderPath) && (input.fileName !== undefined ? entry.name === input.fileName : entry.uploadedBy?.id === context.actorId && entry.uploadedAt !== undefined && entry.uploadedAt <= context.request.at && entry.uploadedAt >= Math.max(context.request.at, context.now()) - RECENT_WINDOW_MS)
      const matches = catalog.files.filter(eligible)
      if (catalog.truncated || matches.length > 1) throw new Error('群文件目录不完整或文件名/路径有歧义，请补充准确文件名和目录')
      const selected = matches[0]
      if (!selected) throw new Error('当前群没有找到该文件，请上传或指定准确文件名和目录')
      if (input.fileIndex !== undefined && input.fileIndex !== 1) throw new Error('群文件来源不支持这个附件序号')
      const key = entryKey(selected)
      const currentEntry = async () => { if (!await requestCurrent()) return false; const fresh = await readCatalog(turnGuard); const found = fresh.files.filter(eligible); return !fresh.truncated && found.length === 1 && entryKey(found[0]!) === key }
      const projection = project(currentEntry)
      if (!await projection.isCurrent()) throw new Error('群文件目录来源已改变')
      const file = await context.readConversationFile(context.target, selected, { ...guard, async allowsFile(entry) { return entryKey(entry) === key && await projection.isCurrent() && guard.isCurrent() } })
      await ensure(isCurrent, signal)
      if (!await projection.isCurrent()) throw new Error('群文件目录来源已改变')
      if (!file) throw new Error('当前群文件无法读取')
      return { ...file, origin: 'group_file' }
    },
    async listFiles(raw: { readonly query?: string; readonly folderPath?: string }, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileListing> {
      context.markEphemeral()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['query', 'folderPath'].includes(key))) throw new Error('文件目录参数无效')
      const input = structuredClone(raw)
      if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 255 || /[\u0000-\u001f\u007f]/u.test(input.query)) || input.folderPath !== undefined && (typeof input.folderPath !== 'string' || input.folderPath.length > 1024 || /[\u0000-\u001f\u007f]/u.test(input.folderPath))) throw new Error('文件目录参数无效')
      const guard: FileReadGuard = { signal: AbortSignal.any([signal, turnSignal]), isCurrent: () => context.isCurrent() && isCurrent() && !signal.aborted && !turnSignal.aborted, ensureCurrent: () => ensure(isCurrent, signal) }
      await ensure(isCurrent, signal)
      if (!await requestCurrent()) throw new Error('目录读取缺少当前已核验的真人请求')
      const catalog = await readCatalog(guard)
      const selected = catalog.files.filter(entry => folderMatches(entry.folderPath, input.folderPath) && (input.query === undefined || entry.name.includes(input.query)))
      const keys = selected.map(entryKey).sort()
      const projection = project(async () => {
        if (!await requestCurrent()) return false
        const current = await readCatalog(turnGuard)
        const fresh = current.files.filter(entry => folderMatches(entry.folderPath, input.folderPath) && (input.query === undefined || entry.name.includes(input.query))).map(entryKey).sort()
        return current.truncated === catalog.truncated && JSON.stringify(fresh) === JSON.stringify(keys)
      })
      await ensure(isCurrent, signal)
      if (!await projection.isCurrent()) throw new Error('群文件目录来源已改变')
      return { files: selected.map(({ name, folderPath, size }) => ({ name, folderPath, size })), totalFiles: selected.length, truncated: catalog.truncated }
    },
  }
}
