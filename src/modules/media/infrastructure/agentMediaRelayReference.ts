import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'

const invalid = () => new Error('媒体分享参数不符合要求')
function closed(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw invalid()
}

/** The persisted reference contains only the bounded provider, kind and ID. */
export function validateAgentMediaShare(input: unknown): Readonly<AgentMediaShare> {
  try {
    closed(input, ['provider', 'reference'])
    const ref = input.reference
    closed(ref, ['kind', 'id'])
    if (typeof ref.id !== 'string' || ref.id.trim() !== ref.id || /[\u0000-\u001f\u007f]/u.test(ref.id)) throw invalid()
    if (input.provider === 'bilibili') {
      const id = ref.kind === 'video' && /^BV[0-9A-Za-z]{8,16}$/iu.test(ref.id) ? `BV${ref.id.slice(2)}`
        : ref.kind === 'episode' && /^[1-9]\d{0,19}$/u.test(ref.id) ? ref.id
          : ref.kind === 'short' && /^[A-Za-z0-9_-]{1,128}$/u.test(ref.id) ? ref.id : undefined
      if (!id) throw invalid()
      return Object.freeze({ provider: 'bilibili', reference: Object.freeze({ kind: ref.kind as 'video' | 'episode' | 'short', id }) })
    }
    if (input.provider === 'douyin') {
      const id = (ref.kind === 'video' || ref.kind === 'note') && /^[1-9]\d{5,19}$/u.test(ref.id) ? ref.id
        : ref.kind === 'short' && /^[A-Za-z0-9_-]{1,128}$/u.test(ref.id) ? ref.id : undefined
      if (!id) throw invalid()
      return Object.freeze({ provider: 'douyin', reference: Object.freeze({ kind: ref.kind as 'video' | 'note' | 'short', id }) })
    }
    if (input.provider === 'xiaohongshu') {
      const id = ref.kind === 'note' && /^[a-f\d]{16,32}$/iu.test(ref.id) ? ref.id.toLowerCase()
        : ref.kind === 'short' && /^(?:a\/)?[A-Za-z0-9_-]{1,128}$/u.test(ref.id) ? ref.id : undefined
      if (!id) throw invalid()
      return Object.freeze({ provider: 'xiaohongshu', reference: Object.freeze({ kind: ref.kind as 'note' | 'short', id }) })
    }
    if (input.provider === 'youtube' && ref.kind === 'video' && /^[A-Za-z0-9_-]{11}$/u.test(ref.id)) {
      return Object.freeze({ provider: 'youtube', reference: Object.freeze({ kind: 'video', id: ref.id }) })
    }
    if (input.provider === 'pixiv' && ref.kind === 'artwork' && /^[1-9]\d{0,11}$/u.test(ref.id)) {
      return Object.freeze({ provider: 'pixiv', reference: Object.freeze({ kind: 'artwork', id: ref.id }) })
    }
    throw invalid()
  } catch { throw invalid() }
}

/** A safe fallback is reconstructed from the reference; original queries never return. */
export function agentMediaSharePageUrl(input: AgentMediaShare): string {
  const share = validateAgentMediaShare(input), ref = share.reference
  if (share.provider === 'bilibili') return ref.kind === 'short' ? `https://b23.tv/${ref.id}`
    : ref.kind === 'episode' ? `https://www.bilibili.com/bangumi/play/ep${ref.id}` : `https://www.bilibili.com/video/${ref.id}`
  if (share.provider === 'xiaohongshu') return ref.kind === 'short' ? `https://xhslink.com/${ref.id}` : `https://www.xiaohongshu.com/explore/${ref.id}`
  if (share.provider === 'youtube') return `https://www.youtube.com/watch?v=${ref.id}`
  if (share.provider === 'pixiv') return `https://www.pixiv.net/artworks/${ref.id}`
  return ref.kind === 'short' ? `https://v.douyin.com/${ref.id}/` : `https://www.douyin.com/${ref.kind}/${ref.id}`
}

/** Prepared pages must identify the original provider and, for direct references, the original item. */
export function validateAgentMediaPreparedPageUrl(input: unknown, original: AgentMediaShare): string {
  const source = validateAgentMediaShare(original)
  if (typeof input !== 'string') throw invalid()
  const match = source.provider === 'bilibili'
    ? /^https:\/\/www\.bilibili\.com\/(?:video\/(BV[0-9A-Za-z]{8,16})|bangumi\/play\/ep([1-9]\d{0,19}))$/u.exec(input)
    : source.provider === 'douyin' ? /^https:\/\/www\.douyin\.com\/(video|note)\/([1-9]\d{5,19})$/u.exec(input)
      : source.provider === 'youtube' ? /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/u.exec(input)
        : source.provider === 'pixiv' ? /^https:\/\/www\.pixiv\.net\/artworks\/([1-9]\d{0,11})$/u.exec(input)
          : /^https:\/\/www\.xiaohongshu\.com\/explore\/([a-f\d]{16,32})$/u.exec(input)
  if (!match || match[0] !== input) throw invalid()
  if (source.reference.kind !== 'short') {
    const id = source.provider === 'bilibili' ? match[1] ?? match[2] : source.provider === 'douyin' ? match[2] : match[1]
    if (id !== source.reference.id || source.provider === 'bilibili' &&
      (source.reference.kind === 'video') !== (match[1] !== undefined)) throw invalid()
  }
  return input
}
