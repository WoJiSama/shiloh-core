import { createHash } from 'node:crypto'
import type { AgentLocalEmojiCollectionContext, AgentLocalEmojiPurgeSubject, AgentLocalEmojiRevokeSource } from '../../../contracts/agentLocalEmoji.js'
import { conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'

export const EMOJI_LEDGER_LIMITS = { agents: 256, images: 20_000, sources: 100_000, perImage: 64, messages: 8192, subjects: 4096, bytes: 32 * 1024 * 1024 } as const
export const emojiDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digestPattern = /^[a-f0-9]{64}$/u
const invalid = () => new Error('本地表情来源账本不可用')
export interface EmojiSourceProof {
  readonly id: string
  readonly account: string
  readonly target: string
  readonly message: string
  readonly subject: string
  readonly at: number
}
export interface EmojiImageProof {
  readonly file: string
  sources: EmojiSourceProof[]
  pendingDelete?: true
}
export interface EmojiSourceLedger { readonly version: 1; readonly images: Record<string, EmojiImageProof> }
export interface EmojiSubjectCut {
  readonly id: string
  readonly agent: string
  readonly account: string
  readonly subject: string
  readonly target?: string
  readonly requestedThrough: number
  readonly effectiveThrough: number
}
export interface EmojiRevocations { readonly version: 1; overflow: boolean; readonly messages: string[]; readonly subjects: EmojiSubjectCut[] }
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      keys && Object.keys(value).some(key => !keys.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
function digest(value: unknown): string { if (typeof value !== 'string' || !digestPattern.test(value)) throw invalid(); return value }
export function emojiSourceProof(context: AgentLocalEmojiCollectionContext): EmojiSourceProof {
  const target = conversationAddressKey(context.binding.target), author = platformAccountKey(context.source.author)
  return { id: emojiDigest([context.binding.agentId, target, context.source.messageId, author, context.source.occurredAt]),
    account: emojiDigest(platformAccountKey(context.binding.target.account)), target: emojiDigest(target),
    message: emojiMessageRevocation({ target: context.binding.target, messageId: context.source.messageId }), subject: emojiDigest(author), at: context.source.occurredAt }
}
export function emojiMessageRevocation(input: AgentLocalEmojiRevokeSource): string { return emojiDigest([conversationAddressKey(input.target), input.messageId]) }
export function emojiSubjectSelector(input: AgentLocalEmojiPurgeSubject) {
  const value = { agent: createHash('sha256').update(input.agentId).digest('hex'), account: emojiDigest(platformAccountKey(input.account)),
    subject: emojiDigest(platformAccountKey({ ...input.account, id: input.subjectId })), ...(input.target ? { target: emojiDigest(conversationAddressKey(input.target)) } : {}) }
  return { ...value, id: emojiDigest(value) }
}
export function emojiSourceMatches(source: EmojiSourceProof, cut: Pick<EmojiSubjectCut, 'account' | 'subject' | 'target'>): boolean {
  return source.account === cut.account && source.subject === cut.subject && (!cut.target || source.target === cut.target)
}
export function emojiSourceRevoked(state: EmojiRevocations, agent: string, source: EmojiSourceProof): boolean {
  return state.overflow || state.messages.includes(source.message) || state.subjects.some(cut => cut.agent === agent && emojiSourceMatches(source, cut) && source.at <= cut.effectiveThrough)
}
export function decodeEmojiSources(value: unknown): EmojiSourceLedger {
  const raw = record(value, ['version', 'images'])
  if (raw.version !== 1) throw invalid()
  const images = record(raw.images), result: EmojiSourceLedger = { version: 1, images: Object.create(null) as Record<string, EmojiImageProof> }
  if (Object.keys(images).length > EMOJI_LEDGER_LIMITS.images) throw invalid()
  let total = 0
  for (const [key, value] of Object.entries(images)) {
    digest(key)
    const row = record(value, ['file', 'sources', 'pendingDelete'])
    if (typeof row.file !== 'string' || !new RegExp('^' + key + '\\.(?:png|jpg|gif|webp|bmp)$', 'u').test(row.file) ||
        !Array.isArray(row.sources) || row.sources.length > EMOJI_LEDGER_LIMITS.perImage || row.pendingDelete !== undefined && row.pendingDelete !== true) throw invalid()
    const sources = row.sources.map(value => {
      const item = record(value, ['id', 'account', 'target', 'message', 'subject', 'at'])
      if (!timestamp(item.at)) throw invalid()
      return { id: digest(item.id), account: digest(item.account), target: digest(item.target), message: digest(item.message), subject: digest(item.subject), at: item.at }
    })
    total += sources.length
    if (new Set(sources.map(source => source.id)).size !== sources.length || total > EMOJI_LEDGER_LIMITS.sources || row.pendingDelete && sources.length) throw invalid()
    result.images[key] = { file: row.file, sources, ...(row.pendingDelete ? { pendingDelete: true as const } : {}) }
  }
  return result
}
export function decodeEmojiRevocations(value: unknown): EmojiRevocations {
  const raw = record(value, ['version', 'overflow', 'messages', 'subjects'])
  if (raw.version !== 1 || typeof raw.overflow !== 'boolean' || !Array.isArray(raw.messages) || raw.messages.length > EMOJI_LEDGER_LIMITS.messages ||
      !Array.isArray(raw.subjects) || raw.subjects.length > EMOJI_LEDGER_LIMITS.subjects) throw invalid()
  const messages = raw.messages.map(digest), subjects = raw.subjects.map(value => {
    const item = record(value, ['id', 'agent', 'account', 'subject', 'target', 'requestedThrough', 'effectiveThrough'])
    if (!timestamp(item.requestedThrough) || !timestamp(item.effectiveThrough) || item.effectiveThrough < item.requestedThrough) throw invalid()
    const selector = { agent: digest(item.agent), account: digest(item.account), subject: digest(item.subject), ...(item.target === undefined ? {} : { target: digest(item.target) }) }
    if (digest(item.id) !== emojiDigest(selector)) throw invalid()
    return { ...selector, id: String(item.id), requestedThrough: item.requestedThrough, effectiveThrough: item.effectiveThrough }
  })
  if (new Set(messages).size !== messages.length || new Set(subjects.map(item => item.id)).size !== subjects.length) throw invalid()
  return { version: 1, overflow: raw.overflow, messages, subjects }
}
export const emptyEmojiSources = (): EmojiSourceLedger => ({ version: 1, images: Object.create(null) as Record<string, EmojiImageProof> })
export const emptyEmojiRevocations = (): EmojiRevocations => ({ version: 1, overflow: false, messages: [], subjects: [] })
