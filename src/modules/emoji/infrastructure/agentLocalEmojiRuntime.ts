import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import sharp from 'sharp'
import type { AgentLocalEmojiCollectionContext, AgentLocalEmojiModel, AgentLocalEmojiRuntime, AgentLocalEmojiCleanupGuard, AgentLocalEmojiCleanupReceipt, AgentLocalEmojiRevokeSource, AgentLocalEmojiPurgeSubject } from '../../../contracts/agentLocalEmoji.js'
import type { AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { EmojiItem, EmojiStoragePort } from '../../../contracts/emoji.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentToolImage, validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'
import { validateMessageBundle } from '../../messaging/infrastructure/messageBundle.js'
import { abortableAgentWeb, ensureAgentWebCurrent } from '../../tools/infrastructure/agentPublicWeb.js'
import { EmojiPackManager, DEFAULT_EMOJI_CONFIG, type EmojiConfig } from './EmojiPackManager.js'
import { decodeEmojiItem } from './emojiDecoders.js'
import { decodeEmojiSources, decodeEmojiRevocations, emptyEmojiSources, emptyEmojiRevocations, emojiSourceProof, emojiMessageRevocation, emojiSubjectSelector, emojiSourceMatches, emojiSourceRevoked, EMOJI_LEDGER_LIMITS, type EmojiSourceProof, type EmojiSourceLedger, type EmojiRevocations, type EmojiSubjectCut } from './agentLocalEmojiLedger.js'
export type { AgentLocalEmojiCollectionContext, AgentLocalEmojiModel, AgentLocalEmojiRuntime, AgentLocalEmojiCleanupGuard, AgentLocalEmojiCleanupReceipt, AgentLocalEmojiRevokeSource, AgentLocalEmojiPurgeSubject } from '../../../contracts/agentLocalEmoji.js'
export { createAgentLocalEmojiIngress, type AgentLocalEmojiIngressGuard, type AgentLocalEmojiIngressInput, type AgentLocalEmojiIngressOptions } from './agentLocalEmojiIngress.js'

export interface AgentLocalEmojiRuntimeOptions {
  readonly dataDir: string
  readonly enabled: boolean
  readonly config: Partial<Omit<EmojiConfig, 'dbPath' | 'storeDir' | 'enabled'>>
  readonly analysis?: AgentLocalEmojiModel
  readonly embedding?: AgentLocalEmojiModel
  readonly tools?: AgentLocalEmojiModel
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly fetch?: typeof fetch
}

type Guard = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
interface Operation {
  readonly guard: Guard
  readonly identity: string
  readonly images: Map<string, Buffer>
  readonly removals: Set<string>
  readonly lifetime: AbortController
  readonly partition?: string
  readonly source?: EmojiSourceProof
  selected?: { readonly partition: string; readonly hash: string; readonly file: string }
}
const fail = () => new Error('本地表情来源、权限或存储不可用')
const filename = /^[a-f0-9]{64}\.(?:jpg|png|gif|webp|bmp)$/u
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function plain(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || allowed && !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw fail()
  return value as Record<string, unknown>
}
function bindingIdentity(value: AgentLocalEmojiCollectionContext['binding']): string {
  if (!value || !isConversationAddress(value.target) || !['configured', 'legacy'].includes(value.source) ||
      ![value.id, value.agentId, value.personaId, value.connectionId, value.revision].every(isPlatformIdentifier) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.agentId)) throw fail()
  return JSON.stringify([agentBindingToken(value), value.target])
}
function collectionIdentity(context: AgentLocalEmojiCollectionContext): string {
  const source = context.source
  if (!source || !isPlatformIdentifier(source.messageId) || !isPlatformAccount(source.author) ||
      !samePlatformNamespace(source.author, context.binding.target.account) || source.author.id === context.binding.target.account.id ||
      !Number.isSafeInteger(source.occurredAt) || source.occurredAt < 0) throw fail()
  return JSON.stringify([bindingIdentity(context.binding), source])
}
function toolIdentity(context: AgentToolContext): string {
  const actor = context.actor, request = context.request
  if (!['user', 'autonomous', 'commitment'].includes(actor.kind)) throw fail()
  if (actor.kind === 'user' && (!actor.user || !isPlatformAccount(actor.user) ||
      !samePlatformNamespace(actor.user, context.binding.target.account) || actor.user.id === context.binding.target.account.id ||
      !request || !isPlatformIdentifier(request.messageId))) throw fail()
  return JSON.stringify([bindingIdentity(context.binding), actor, request])
}

/** Each Agent owns its library; platform targets remain operation and cooldown boundaries. */
export function createAgentLocalEmojiRuntime(options: AgentLocalEmojiRuntimeOptions): AgentLocalEmojiRuntime {
  plain(options)
  if (typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir) || typeof options.enabled !== 'boolean' || !options.config ||
      options.allowsText !== undefined && typeof options.allowsText !== 'function' || options.fetch !== undefined && typeof options.fetch !== 'function' ||
      options.secrets !== undefined && (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(value => typeof value !== 'string' || value.length > 32768))) throw fail()
  const rawConfig = plain(options.config), defaults = DEFAULT_EMOJI_CONFIG as Record<string, unknown>
  if (Object.keys(rawConfig).some(key => ['enabled', 'dbPath', 'storeDir'].includes(key) || !(key in defaults || ['sendAsSticker', 'admissionExtraAllow', 'admissionExtraReject'].includes(key)))) throw fail()
  for (const [key, value] of Object.entries(rawConfig)) {
    if (['admissionExtraAllow', 'admissionExtraReject'].includes(key)) {
      if (!Array.isArray(value) || value.length > 32 || value.some(row => typeof row !== 'string' || row.length > 512)) throw fail()
    } else if (key === 'sendAsSticker' ? typeof value !== 'boolean' : typeof value !== typeof defaults[key]) throw fail()
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) throw fail()
  }
  const config: EmojiConfig = { ...DEFAULT_EMOJI_CONFIG, ...structuredClone(rawConfig), enabled: options.enabled }
  if (!Number.isSafeInteger(config.maxItems) || config.maxItems < 1 || config.maxItems > 10_000 || config.selectionTopK < 1 || config.selectionTopK > 100 || config.embeddingThreshold > 1 || config.contentFilterMinConfidence > 1 || config.familiarityBias > 1) throw fail()
  function model(input: AgentLocalEmojiModel | undefined): AgentLocalEmojiModel | undefined {
    if (input === undefined) return undefined
    const value = plain(input, ['baseUrl', 'model', 'apiKey'])
    if (![value.baseUrl, value.model, value.apiKey].every(row => typeof row === 'string' && !!row.trim() && row.length <= 32768 && !/[\u0000-\u001f\u007f]/u.test(row))) throw fail()
    const url = new URL(String(value.baseUrl))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail()
    return Object.freeze({ baseUrl: url.href, model: String(value.model), apiKey: String(value.apiKey) })
  }
  const analysis = model(options.analysis), embedding = model(options.embedding), tools = model(options.tools)
  if (options.enabled && (config.contentFiltration || config.visionTagOnAdd) && !analysis || options.enabled && config.useEmbedding && !embedding || options.enabled && config.doReplace && !tools) throw fail()
  const checkSecret = createAgentSecretTextCheck([...(options.secrets ?? []), ...[analysis, embedding, tools].flatMap(row => row ? [row.apiKey] : [])])
  const allowed = (text: string) => checkSecret(text) && options.allowsText?.(text) !== false
  if (!allowed(JSON.stringify(rawConfig))) throw fail()
  // Resolve the explicitly supplied host root once (including platform aliases such as /var).
  // Every directory created beneath that root must remain a real, identity-stable directory.
  let existingRoot = path.resolve(options.dataDir)
  const missingRootParts: string[] = []
  while (!fs.existsSync(existingRoot)) {
    missingRootParts.unshift(path.basename(existingRoot))
    const parent = path.dirname(existingRoot)
    if (parent === existingRoot) throw fail()
    existingRoot = parent
  }
  const dataRoot = path.join(fs.realpathSync(existingRoot), ...missingRootParts)
  const emojiRoot = path.join(dataRoot, 'emoji'), root = path.join(emojiRoot, 'agents'), operations = new AsyncLocalStorage<Operation>(), stop = new AbortController()
  const managers = new Map<string, EmojiPackManager>(), queues = new Map<string, Promise<unknown>>(), pending = new Set<Promise<unknown>>(), maintainedAt = new Map<string, number>()
  const directoryIdentities = new Map<string, string>()
  const sourceLedgers = new Map<string, EmojiSourceLedger>(), catalogs = new Map<string, EmojiItem[]>(), active = new Set<Operation>()
  const pendingMessages = new Set<string>(), pendingSubjects = new Map<string, EmojiSubjectCut>(), badPartitions = new Set<string>()
  let revocations = emptyEmojiRevocations(), overflow = false, globalFault = false
  let closed = false
  function current(): Operation {
    const operation = operations.getStore()
    if (!operation || closed || stop.signal.aborted) throw fail()
    operation.guard.signal.throwIfAborted()
    if (!operation.guard.isCurrent()) throw fail()
    return operation
  }
  async function ensure() {
    const operation = current()
    await ensureAgentWebCurrent(operation.guard)
    if (current() !== operation) throw fail()
  }
  function directory(location: string, create = false) {
    current()
    const resolved = path.resolve(location)
    if (!resolved.startsWith(dataRoot + path.sep)) throw fail()
    const parsed = path.parse(resolved), pieces = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let cursor = parsed.root
    for (const piece of pieces) {
      cursor = path.join(cursor, piece)
      let stat: fs.Stats
      try { stat = fs.lstatSync(cursor) } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        current(); fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail()
      const identity = `${stat.dev}:${stat.ino}`, expected = directoryIdentities.get(cursor)
      if (expected !== undefined && expected !== identity) throw fail()
      directoryIdentities.set(cursor, identity)
    }
    return resolved
  }
  function readFile(location: string, maxBytes: number): Buffer | undefined {
    current(); directory(path.dirname(location))
    let stat: fs.Stats
    try { stat = fs.lstatSync(location) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw fail()
    const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const held = fs.fstatSync(fd)
      if (held.ino !== stat.ino || held.dev !== stat.dev) throw fail()
      const bytes = fs.readFileSync(fd)
      if (bytes.length > maxBytes) throw fail()
      current(); directory(path.dirname(location)); return bytes
    } finally { fs.closeSync(fd) }
  }
  function atomicWrite(location: string, bytes: Buffer) {
    current(); directory(path.dirname(location))
    try { const stat = fs.lstatSync(location); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = path.join(path.dirname(location), '.' + path.basename(location) + '.' + randomUUID())
    let fd: number | undefined
    try {
      current(); fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      current(); directory(path.dirname(location)); fs.renameSync(temporary, location)
      const parent = fs.openSync(path.dirname(location), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  }
  const archive = (item: EmojiItem) => /^legacy-archive:[a-f0-9]{64}$/u.test(item.source ?? '')
  function imageCurrent(partition: string, imageHash: string, file: string): boolean {
    if (globalFault || revocations.overflow || badPartitions.has(partition)) return false
    const item = catalogs.get(partition)?.find(row => row.hash === imageHash && path.basename(row.file) === file)
    if (!item) return false
    if (archive(item)) return true
    const proof = sourceLedgers.get(partition)?.images[imageHash]
    return !!proof && proof.file === file && !proof.pendingDelete && proof.sources.some(source => !emojiSourceRevoked(revocations, partition, source))
  }
  function loadRevocations() {
    try {
      directory(emojiRoot, true)
      const bytes = readFile(path.join(emojiRoot, 'revocations.json'), EMOJI_LEDGER_LIMITS.bytes)
      const loaded = bytes ? decodeEmojiRevocations(JSON.parse(bytes.toString('utf8'))) : emptyEmojiRevocations()
      for (const message of pendingMessages) if (!loaded.messages.includes(message)) {
        if (loaded.messages.length >= EMOJI_LEDGER_LIMITS.messages) overflow = true
        else loaded.messages.push(message)
      }
      for (const cut of pendingSubjects.values()) {
        const index = loaded.subjects.findIndex(row => row.id === cut.id), previous = loaded.subjects[index]
        if (previous) loaded.subjects[index] = { ...cut, requestedThrough: Math.max(previous.requestedThrough, cut.requestedThrough), effectiveThrough: Math.max(previous.effectiveThrough, cut.effectiveThrough) }
        else if (loaded.subjects.length >= EMOJI_LEDGER_LIMITS.subjects) overflow = true
        else loaded.subjects.push(cut)
      }
      loaded.overflow ||= overflow
      revocations = loaded; globalFault = false
    } catch (error) { globalFault = true; throw error }
  }
  function jsonWrite(location: string, value: unknown) {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > EMOJI_LEDGER_LIMITS.bytes || !allowed(text)) throw fail()
    atomicWrite(location, Buffer.from(text))
  }
  function readSources(partition: string): EmojiSourceLedger {
    try {
      const folder = path.join(root, partition); directory(folder, true)
      const bytes = readFile(path.join(folder, 'emoji-sources.json'), EMOJI_LEDGER_LIMITS.bytes)
      const ledger = bytes ? decodeEmojiSources(JSON.parse(bytes.toString('utf8'))) : emptyEmojiSources()
      sourceLedgers.set(partition, structuredClone(ledger)); badPartitions.delete(partition); return ledger
    } catch (error) { badPartitions.add(partition); throw error }
  }
  function saveSources(partition: string, ledger: EmojiSourceLedger) {
    const checked = decodeEmojiSources(ledger)
    jsonWrite(path.join(root, partition, 'emoji-sources.json'), checked)
    sourceLedgers.set(partition, checked); badPartitions.delete(partition)
  }
  function readCatalog(partition: string): EmojiItem[] {
    const folder = path.join(root, partition); directory(path.join(folder, 'emoji_files'), true)
    const bytes = readFile(path.join(folder, 'emoji-packs.ndjson'), EMOJI_LEDGER_LIMITS.bytes)
    const rows = bytes?.toString('utf8').split('\n').filter(Boolean) ?? []
    if (rows.length > 10_000 || bytes && !allowed(bytes.toString('utf8'))) throw fail()
    const items = rows.map(line => {
      const item = decodeEmojiItem(JSON.parse(line))
      if (!item || !/^[a-f0-9]{64}$/u.test(item.hash) || !filename.test(path.basename(item.file)) || item.file !== 'emoji_files/' + path.basename(item.file) ||
          !path.basename(item.file).startsWith(item.hash + '.') || item.tags.length > 64 || item.useCases.length > 64 || item.description.length > 4096 || item.embedding && item.embedding.length > 8192) throw fail()
      return item
    })
    if (new Set(items.map(item => item.hash)).size !== items.length) throw fail()
    catalogs.set(partition, items.map(item => ({ ...item }))); return items
  }
  function saveCatalog(partition: string, items: readonly EmojiItem[]) {
    const content = items.map(row => JSON.stringify(row)).join('\n') + (items.length ? '\n' : '')
    if (items.length > 10_000 || Buffer.byteLength(content) > EMOJI_LEDGER_LIMITS.bytes || !allowed(content)) throw fail()
    atomicWrite(path.join(root, partition, 'emoji-packs.ndjson'), Buffer.from(content))
    catalogs.set(partition, items.map(item => ({ ...item })))
  }
  function invalidateSources() {
    for (const row of active) if (row.source && row.partition && emojiSourceRevoked(revocations, row.partition, row.source) ||
        row.selected && !imageCurrent(row.selected.partition, row.selected.hash, row.selected.file)) row.lifetime.abort()
  }
  async function safeFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    await ensure()
    const operation = current(), body = String(init?.body ?? '')
    if (body.length > 8 * 1024 * 1024 || !allowed(body)) throw fail()
    const requested = Promise.resolve((options.fetch ?? globalThis.fetch)(input, { ...init, signal: operation.guard.signal, redirect: 'error' }))
    void requested.then(response => { if (operation.guard.signal.aborted) void response.body?.cancel().catch(() => {}) }, () => {}).catch(() => {})
    const response = await abortableAgentWeb(requested, operation.guard.signal)
    await ensure()
    if (!response.ok || response.redirected || !response.headers.get('content-type')?.toLowerCase().includes('json')) { void response.body?.cancel().catch(() => {}); throw fail() }
    const chunks: Buffer[] = []; let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw fail()
    try {
      while (true) {
        await ensure()
        const row = await abortableAgentWeb(reader.read(), operation.guard.signal)
        await ensure()
        if (row.done) break
        size += row.value.byteLength
        if (size > 512 * 1024) throw fail()
        chunks.push(Buffer.from(row.value))
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    const text = Buffer.concat(chunks, size).toString('utf8')
    if (!allowed(text)) throw fail()
    const decoded: unknown = JSON.parse(text)
    if (!allowed(JSON.stringify(decoded))) throw fail()
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  function manager(agentId: string): EmojiPackManager {
    let selected = managers.get(agentId)
    if (selected) return selected
    if (managers.size >= 256) throw fail()
    const owner = hash(agentId), partition = path.join(root, owner), images = path.join(partition, 'emoji_files')
    const storage: EmojiStoragePort = {
      async ensureDirs() { await ensure(); directory(images, true); current() },
      async loadItems() {
        await ensure(); loadRevocations(); readSources(owner); return readCatalog(owner)
      },
      async saveItems(items) {
        await ensure(); directory(images, true)
        const operation = current()
        if (items.length > config.maxItems) throw fail()
        for (const [name, bytes] of operation.images) { current(); atomicWrite(path.join(images, name), bytes) }
        current(); saveCatalog(owner, items)
        for (const name of operation.removals) {
          current(); const target = path.join(images, name), bytes = readFile(target, 5 * 1024 * 1024)
          if (bytes) { current(); fs.unlinkSync(target) }
        }
        operation.images.clear(); operation.removals.clear(); current()
      },
      async writeImage(name, bytes) { await ensure(); if (!filename.test(name)) throw fail(); current().removals.delete(name); current().images.set(name, Buffer.from(bytes)) },
      async removeImage(name) { await ensure(); if (!filename.test(name)) throw fail(); const operation = current(); if (!operation.images.delete(name)) operation.removals.add(name) },
      fileAvailable(name) { current(); if (!filename.test(name) || !imageCurrent(owner, name.slice(0, 64), name)) return false; try { return !!readFile(path.join(images, name), 5 * 1024 * 1024) } catch { return false } },
      async listImages() { await ensure(); directory(images); const names = fs.readdirSync(images); if (names.length > 20_128) throw fail(); return names.filter(name => filename.test(name) && storage.fileAvailable(name)) },
      allowsMaintenance(item) { current(); return imageCurrent(owner, item.hash, path.basename(item.file)) },
    }
    selected = new EmojiPackManager({ storage, ensureCurrent: ensure, assertCurrent: () => { current() }, fetch: safeFetch,
      standalone: { rootDirectory: partition, config,
        ...(analysis ? { analysisAiConfig: { analysisApiUrl: analysis.baseUrl, analysisApiKey: analysis.apiKey, analysisApiModel: analysis.model } } : {}),
        ...(embedding ? { embeddingAiConfig: { embeddingApiUrl: embedding.baseUrl, embeddingApiKey: embedding.apiKey, embeddingApiModel: embedding.model } } : {}),
        ...(tools ? { toolsAiConfig: { toolsAiUrl: tools.baseUrl, toolsAiApikey: tools.apiKey, toolsAiModel: tools.model } } : {}) } })
    managers.set(agentId, selected); return selected
  }
  async function maintain(selected: EmojiPackManager, agentId: string) {
    if (!config.enableMaintenance || Date.now() - (maintainedAt.get(agentId) ?? 0) < Math.max(1, config.checkIntervalMinutes) * 60_000) return
    await ensure(); await selected.runMaintenance(); await ensure()
    maintainedAt.set(agentId, Date.now())
  }
  async function operation<T>(context: Guard, identify: () => string, work: () => Promise<T>, metadata?: { partition: string; source: EmojiSourceProof }): Promise<T> {
    const identity = identify(), lifetime = new AbortController(), signal = AbortSignal.any([context.signal, stop.signal, lifetime.signal, AbortSignal.timeout(90_000)])
    let row: Operation
    const guard: Guard = { signal, isCurrent() { try { return !signal.aborted && identity === identify() && context.isCurrent() &&
        (!metadata || !globalFault && !emojiSourceRevoked(revocations, metadata.partition, metadata.source)) &&
        (!row?.selected || imageCurrent(row.selected.partition, row.selected.hash, row.selected.file)) } catch { return false } },
      async ensureCurrent() { if (!this.isCurrent()) throw fail(); await context.ensureCurrent?.(); if (!this.isCurrent()) throw fail() } }
    row = { guard, identity, images: new Map(), removals: new Set(), lifetime, ...metadata }
    active.add(row)
    try { return await operations.run(row, () => abortableAgentWeb(work(), signal)) }
    finally { active.delete(row); lifetime.abort(); row.images.clear(); row.removals.clear() }
  }
  async function serial<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    if (closed) throw fail()
    const waiting = queues.get(agentId) ?? Promise.resolve(), result = waiting.then(async () => { await ensure(); return work() })
    const tail = result.catch(() => {})
    queues.set(agentId, tail); pending.add(result)
    try { return await result } finally { pending.delete(result); if (queues.get(agentId) === tail) queues.delete(agentId) }
  }
  function cleanupIdentity(kind: 'source' | 'subject', input: AgentLocalEmojiRevokeSource | AgentLocalEmojiPurgeSubject): string {
    const raw = plain(input, kind === 'source' ? ['target', 'messageId'] : ['agentId', 'account', 'subjectId', 'target', 'through'])
    if (kind === 'source' ? !isConversationAddress((input as AgentLocalEmojiRevokeSource).target) || !isPlatformIdentifier(raw.messageId) :
      !isPlatformAccount((input as AgentLocalEmojiPurgeSubject).account) || !isPlatformIdentifier(raw.subjectId) ||
      typeof raw.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(raw.agentId) || !Number.isSafeInteger(raw.through) || Number(raw.through) < 0 ||
      raw.target !== undefined && (!isConversationAddress((input as AgentLocalEmojiPurgeSubject).target) || platformAccountKey((input as AgentLocalEmojiPurgeSubject).target!.account) !== platformAccountKey((input as AgentLocalEmojiPurgeSubject).account))) throw fail()
    return JSON.stringify([kind, input])
  }
  function partitions(only?: string): string[] {
    if (!fs.existsSync(root)) return []
    directory(root)
    const names = fs.readdirSync(root)
    if (names.length > EMOJI_LEDGER_LIMITS.agents || names.some(name => !/^[a-f0-9]{64}$/u.test(name))) throw fail()
    for (const name of names) directory(path.join(root, name))
    return only ? names.filter(name => name === only) : names
  }
  async function cleanup(kind: 'source' | 'subject', input: AgentLocalEmojiRevokeSource | AgentLocalEmojiPurgeSubject, authority: AgentLocalEmojiCleanupGuard): Promise<AgentLocalEmojiCleanupReceipt> {
    cleanupIdentity(kind, input)
    if (!authority || !(authority.signal instanceof AbortSignal) || authority.signal.aborted || !authority.isCurrent()) throw fail()
    let removedSources = 0, removedImages = 0, unattributedImages = 0, uncertain = false, unsupported = false, durable = false
    const receipt = (state: 'completed' | 'unknown' | 'unsupported'): AgentLocalEmojiCleanupReceipt => ({ usage: 'blocked', cleanup: state, removedSources, removedImages, unattributedImages })
    try {
      return await operation(authority, () => cleanupIdentity(kind, input), async () => {
        // A synchronous liveness probe is not permission to revoke another operation.
        await ensure()
        loadRevocations()
        let only: string | undefined
        if (kind === 'source') {
          const message = emojiMessageRevocation(input as AgentLocalEmojiRevokeSource)
          if (!revocations.messages.includes(message)) {
            if (pendingMessages.size >= EMOJI_LEDGER_LIMITS.messages || revocations.messages.length >= EMOJI_LEDGER_LIMITS.messages) overflow = true
            else pendingMessages.add(message)
          }
        } else {
          const request = input as AgentLocalEmojiPurgeSubject, selector = emojiSubjectSelector(request)
          only = selector.agent
          const previous = revocations.subjects.find(cut => cut.id === selector.id)
          if (!previous || request.through > previous.requestedThrough) {
            let effective = Math.max(request.through, previous?.effectiveThrough ?? 0)
            try {
              if (partitions(only).length) for (const image of Object.values(readSources(only).images)) for (const source of image.sources)
                if (emojiSourceMatches(source, selector)) effective = Math.max(effective, source.at)
            } catch { uncertain = true }
            for (const row of active) if (row.partition === only && row.source && emojiSourceMatches(row.source, selector)) effective = Math.max(effective, row.source.at)
            if (!previous && (revocations.subjects.length >= EMOJI_LEDGER_LIMITS.subjects || pendingSubjects.size >= EMOJI_LEDGER_LIMITS.subjects)) overflow = true
            else pendingSubjects.set(selector.id, { ...selector, requestedThrough: request.through, effectiveThrough: effective })
          }
        }
        loadRevocations(); invalidateSources()
        await ensure()
        // No collection/model queue stands between accepting revocation and its durable fence.
        loadRevocations(); jsonWrite(path.join(emojiRoot, 'revocations.json'), revocations)
        durable = true
        uncertain ||= revocations.overflow
        if (revocations.overflow) return receipt('unknown')
        let owners: string[]
        try { owners = partitions(only) } catch { return receipt('unknown') }
        for (const owner of owners) {
          try {
            // Skip unrelated live queues; only a partition with attributable revoked data needs mutation.
            const before = readSources(owner), items = readCatalog(owner)
            const unproven = items.filter(item => !archive(item) && !before.images[item.hash])
            unattributedImages += items.filter(archive).length + unproven.length
            unsupported ||= unproven.length > 0
            const names = fs.readdirSync(directory(path.join(root, owner, 'emoji_files')))
            if (names.length > 20_128) throw fail()
            const orphans = names.filter(name => filename.test(name) && !items.some(item => path.basename(item.file) === name) && !before.images[name.slice(0, 64)])
            unattributedImages += orphans.length; unsupported ||= orphans.length > 0
            if (!Object.values(before.images).some(image => image.pendingDelete || image.sources.some(source => emojiSourceRevoked(revocations, owner, source)))) continue
            await serial(owner, async () => {
              await ensure(); loadRevocations()
              const ledger = readSources(owner), rows = readCatalog(owner), deleting = new Set<string>()
              let sourceCount = 0, changed = false
              for (const [imageHash, image] of Object.entries(ledger.images)) {
                const kept = image.sources.filter(source => !emojiSourceRevoked(revocations, owner, source))
                sourceCount += image.sources.length - kept.length
                if (kept.length !== image.sources.length) {
                  image.sources = kept; changed = true
                  if (!kept.length && !rows.some(row => row.hash === imageHash && archive(row))) image.pendingDelete = true
                }
                if (image.pendingDelete) deleting.add(imageHash)
              }
              if (changed) { saveSources(owner, ledger); removedSources += sourceCount }
              if (!deleting.size) return
              saveCatalog(owner, rows.filter(row => !deleting.has(row.hash)))
              for (const imageHash of deleting) {
                const proof = ledger.images[imageHash]!, images = path.join(root, owner, 'emoji_files'), location = path.join(images, proof.file)
                try {
                  const bytes = readFile(location, 5 * 1024 * 1024)
                  if (bytes) { current(); fs.unlinkSync(location) }
                  const fd = fs.openSync(directory(images), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
                  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
                  current(); delete ledger.images[imageHash]
                  if (bytes || rows.some(row => row.hash === imageHash)) removedImages++
                } catch { uncertain = true }
              }
              saveSources(owner, ledger)
            })
          } catch { uncertain = true }
        }
        await ensure()
        return receipt(uncertain ? 'unknown' : unsupported ? 'unsupported' : 'completed')
      })
    } catch (error) { if (!durable) throw error; return receipt('unknown') }
  }
  const failure = (): AgentToolResult => ({ status: 'failed', content: '本地表情未完成，本轮没有确认表情送达。' })
  const unknown = (): AgentToolResult => ({ status: 'unknown', content: '表情投递结果未知，请核对当前会话；不会自动重发或补发。' })
  return Object.freeze({
    builtIn: options.enabled ? [{ name: 'sendLocalEmojiTool', timeoutMs: 90_000,
      description: '从本人自己的表情库选择符合情绪和使用场景的一张图片发送到当前会话。配文可放在图片前后，一轮最多使用一次；没有匹配时用文字回复。',
      parameters: { type: 'object' as const, additionalProperties: false, required: ['tags'], properties: {
        tags: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 5 },
        useCases: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 4 },
        query: { type: 'string', maxLength: 200 }, leadText: { type: 'string', maxLength: 80 }, followUpText: { type: 'string', maxLength: 80 },
      } },
      async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
        let sending = false
        try {
          return await operation(context, () => toolIdentity(context), () => serial(hash(context.binding.agentId), async () => {
            const value = plain(input, ['tags', 'useCases', 'query', 'leadText', 'followUpText'])
            for (const [field, max] of [['tags', 5], ['useCases', 4]] as const) if (value[field] !== undefined &&
              (!Array.isArray(value[field]) || value[field].length > max || value[field].some((row: unknown) => typeof row !== 'string' || row.length > 64))) throw fail()
            for (const [field, max] of [['query', 200], ['leadText', 80], ['followUpText', 80]] as const) if (value[field] !== undefined &&
              (typeof value[field] !== 'string' || value[field].length > max)) throw fail()
            if (!allowed(JSON.stringify(value)) || !((value.tags as unknown[])?.length || (value.useCases as unknown[])?.length || String(value.query ?? '').trim())) throw fail()
            await ensure()
            const selected = manager(context.binding.agentId), scope = conversationAddressKey(context.binding.target)
            await maintain(selected, context.binding.agentId)
            if (!selected.checkRateLimit(scope).allowed) return { status: 'failed', content: '当前会话近期表情较多，本轮请用文字回复。' }
            const choice = await selected.selectEmoji(value, { groupId: scope }); await ensure()
            if (!choice.item) return { status: 'succeeded', content: choice.strategy === 'no_match' ? '本人表情库中没有匹配内容，本轮请用文字回复。' : '本人表情库暂时没有可用表情，本轮请用文字回复。' }
            current().selected = { partition: hash(context.binding.agentId), hash: choice.item.hash, file: path.basename(choice.item.file) }
            const bytes = readFile(selected.getAbsoluteFilePath(choice.item), 5 * 1024 * 1024)
            if (!bytes || hash(bytes) !== choice.item.hash) throw fail()
            const image = validateAgentToolImageBytes(bytes, selected.detectMimeFromExt(path.extname(choice.item.file)))
            await ensure()
            const payload = { ...image, ...(config.sendAsSticker !== false ? { presentation: 'sticker' as const } : {}) }
            const before = String(value.leadText ?? '').trim(), after = String(value.followUpText ?? '').trim()
            const bundle = validateMessageBundle([{ parts: [...(before ? [{ kind: 'text' as const, text: before }] : []), { kind: 'image' as const, ...payload }, ...(after ? [{ kind: 'text' as const, text: after }] : [])] }])
            if ((before || after) && !context.sendBundle || !before && !after && !context.sendImage && !context.sendBundle) throw fail()
            await ensure(); sending = true
            selected.recordSend(scope)
            const sendGuard = current().guard
            const receipt = await abortableAgentWeb(!before && !after && context.sendImage ? context.sendImage(payload, sendGuard) : context.sendBundle!(bundle, sendGuard), sendGuard.signal)
            await ensure()
            if (receipt.state === 'failed') return failure()
            if (receipt.state !== 'sent' || !isPlatformIdentifier(receipt.messageId) || receipt.messageId === '0') return unknown()
            selected.recordPick(scope, choice.item.hash, choice.item.tags)
            await selected.markUsed(choice.item.hash); await ensure()
            return { status: 'succeeded', content: '已确认向当前会话发送一张本地表情及所选配文。不要重复发送。' +
              (choice.firstUse ? '这是本人收藏后首次使用的新表情，如需自然补充文字可按刚捡到的表情理解，不必解释收藏过程。' : '') }
          }))
        } catch { return sending ? unknown() : failure() }
      },
    }] : [],
    async collect(image: { readonly mime: string; readonly base64: string }, context: AgentLocalEmojiCollectionContext) {
      if (!options.enabled) return { ok: false, error: '本地表情收藏未启用' }
      try {
        collectionIdentity(context)
        const owner = hash(context.binding.agentId), source = emojiSourceProof(context)
        return await operation(context, () => collectionIdentity(context), () => serial(owner, async () => {
          loadRevocations(); await ensure()
          plain(image, ['mime', 'base64']); await ensure()
          if (typeof image.base64 !== 'string' || image.base64.length > Math.ceil(5 * 1024 * 1024 / 3) * 4 || !allowed(image.base64)) throw fail()
          const checked = validateAgentToolImage(image), bytes = Buffer.from(checked.base64, 'base64')
          await ensure()
          if (bytes.length > 5 * 1024 * 1024 || !allowed(bytes.toString('utf8'))) throw fail()
          const meta = await sharp(bytes, { failOn: 'error' }).metadata(); await ensure()
          if (!meta.width || !meta.height) throw fail()
          const selected = manager(context.binding.agentId)
          await maintain(selected, context.binding.agentId)
          const result = await selected.addFromBuffer(bytes, { source: 'verified-source:' + hash(collectionIdentity(context)) })
          await ensure()
          if (!result.added && result.reason !== 'duplicate') return { ok: false, error: '图片未通过表情收藏条件' }
          const item = result.item
          if (!item) throw fail()
          const ledger = readSources(owner), proof = ledger.images[item.hash] ?? { file: path.basename(item.file), sources: [] }
          if (proof.file !== path.basename(item.file)) throw fail()
          if (!proof.sources.some(row => row.id === source.id)) proof.sources.push(source)
          delete proof.pendingDelete; ledger.images[item.hash] = proof
          saveSources(owner, ledger)
          const items = readCatalog(owner), registered = items.find(row => row.hash === item.hash)
          if (!registered) throw fail()
          // A quarantined pre-ledger record can regain proof only from these verified bytes.
          if (registered.noFileFlag) { registered.noFileFlag = false; saveCatalog(owner, items) }
          await ensure(); return { ok: true }
        }), { partition: owner, source })
      } catch { return { ok: false, error: '表情收藏来源、权限、服务或图片不可用' } }
    },
    revokeSource(input: AgentLocalEmojiRevokeSource, guard: AgentLocalEmojiCleanupGuard) { return cleanup('source', input, guard) },
    purgeSubject(input: AgentLocalEmojiPurgeSubject, guard: AgentLocalEmojiCleanupGuard) { return cleanup('subject', input, guard) },
    async close() {
      if (closed) return
      closed = true; stop.abort()
      await Promise.allSettled([...pending])
      await Promise.allSettled([...managers.values()].map(row => row.close()))
      managers.clear(); queues.clear(); maintainedAt.clear(); sourceLedgers.clear(); catalogs.clear()
    },
  })
}
