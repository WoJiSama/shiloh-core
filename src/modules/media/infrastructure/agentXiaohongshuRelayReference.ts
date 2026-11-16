import type { AgentMediaShare, AgentMediaShareAccess } from '../../../contracts/agentMediaRelayWorkflow.js'
import { agentMediaSharePageUrl, validateAgentMediaShare } from './agentMediaRelayReference.js'

type Share = Extract<AgentMediaShare, { provider: 'xiaohongshu' }>
type Access = Extract<AgentMediaShareAccess, { provider: 'xiaohongshu' }>
const invalid = () => new Error('小红书分享访问参数不符合要求')
const candidatePattern = /(?:https?:\/\/|\/\/)?(?:xhslink\.com|(?:www\.)?xiaohongshu\.com)\/[^\s，。！？；）)\]}>"'<>]+/giu
const credentialKey = /token|cookie|authorization|password|passwd|secret|credential|session|api[_-]?key|(?:^|[_-])(?:auth|sid|pwd)(?:$|[_-])/iu

/** Only task-local access material is permitted here; it never belongs to a persisted share. */
export function validateAgentXiaohongshuAccess(input: unknown): Readonly<Access> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['provider', 'xsecToken', 'xsecSource', 'mediaKind'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw invalid()
    const row = input as Record<string, unknown>
    if (row.provider !== 'xiaohongshu' || row.xsecToken !== undefined && (typeof row.xsecToken !== 'string' || !row.xsecToken ||
      row.xsecToken.length > 4096 || /[^\x21-\x7e]/u.test(row.xsecToken)) ||
      row.xsecSource !== undefined && (typeof row.xsecSource !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.xsecSource) || /[\r\n]/u.test(row.xsecSource)) ||
      row.mediaKind !== undefined && row.mediaKind !== 'image' && row.mediaKind !== 'video') throw invalid()
    return Object.freeze({ provider: 'xiaohongshu', ...(row.xsecToken !== undefined ? { xsecToken: row.xsecToken as string } : {}),
      ...(row.xsecSource !== undefined ? { xsecSource: row.xsecSource as string } : {}), ...(row.mediaKind !== undefined ? { mediaKind: row.mediaKind as 'image' | 'video' } : {}) })
  } catch { throw invalid() }
}

function basic(raw: string): { readonly share: Readonly<Share>; readonly query: string; readonly fragment: boolean } | undefined {
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return undefined
  const normalized = raw.startsWith('//') ? `https:${raw}` : /^https?:/iu.test(raw) ? raw : `https://${raw}`
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(#.*)?$/iu.exec(normalized)
  if (!parts || !/^(?:xhslink\.com|(?:www\.)?xiaohongshu\.com)$/iu.test(parts[1]!) || /[%\\]/u.test(parts[2]!)) return undefined
  const host = parts[1]!.toLowerCase(), path = parts[2]!
  const note = host !== 'xhslink.com' ? /^\/(?:explore|discovery\/item)\/([a-f\d]{16,32})\/?$/iu.exec(path)?.[1] : undefined
  const short = host === 'xhslink.com' ? /^\/((?:a\/)?[A-Za-z0-9_-]{1,128})\/?$/u.exec(path)?.[1] : undefined
  if (!note && !short) return undefined
  const selected = validateAgentMediaShare({ provider: 'xiaohongshu', reference: { kind: note ? 'note' : 'short', id: note ? note.toLowerCase() : short } })
  if (selected.provider !== 'xiaohongshu') return undefined
  return { share: selected, query: parts[3] ?? '', fragment: parts[4] !== undefined }
}

function access(query: string): Readonly<Access> | undefined {
  if (query.length > 16384 || /%(?![a-f\d]{2})/iu.test(query)) return undefined
  const values = new Map<string, string>()
  for (const [original, value] of new URLSearchParams(query)) {
    const key = original.toLowerCase()
    if (/[\u0000-\u001f\u007f]/u.test(original + value) || original.length > 128 || value.length > 8192) return undefined
    if (['xsec_token', 'xsec_source', 'type'].includes(key)) {
      if (values.has(key)) return undefined
      values.set(key, value)
    } else if (credentialKey.test(original)) return undefined
  }
  const token = values.get('xsec_token'), source = values.get('xsec_source'), kind = values.get('type')
  if (kind !== undefined && kind !== 'normal' && kind !== 'video') return undefined
  try { return validateAgentXiaohongshuAccess({ provider: 'xiaohongshu', ...(token !== undefined ? { xsecToken: token } : {}),
    ...(source !== undefined ? { xsecSource: source } : {}), ...(kind !== undefined ? { mediaKind: kind === 'normal' ? 'image' : 'video' } : {}) }) } catch { return undefined }
}

function selected(text: string): { readonly share: Readonly<Share>; readonly access: Readonly<Access> } | undefined {
  if (typeof text !== 'string' || text.length > 64_000) return undefined
  for (const match of text.matchAll(candidatePattern)) {
    if (match.index && /[\w.@:/=?&%#-]/u.test(text[match.index - 1]!)) continue
    if (match[0].includes('\\')) continue
    const candidate = basic(match[0])
    if (!candidate || candidate.fragment) continue
    const checked = access(candidate.query)
    if (checked) return { share: candidate.share, access: checked }
  }
  return undefined
}

/** Syntax only; signed queries stay in a separate ephemeral access value. */
export function parseAgentXiaohongshuReference(text: string): Readonly<Share> | undefined {
  return selected(text)?.share
}

/** The exact first selected URL supplies access; later URLs cannot lend it another token. */
export function readAgentXiaohongshuAccess(text: string, original: AgentMediaShare): Readonly<Access> | undefined {
  try {
    const source = validateAgentMediaShare(original), candidate = selected(text)
    if (source.provider !== 'xiaohongshu' || !candidate || JSON.stringify(source) !== JSON.stringify(candidate.share)) return undefined
    return candidate.access
  } catch { return undefined }
}

export function xiaohongshuAccessPageUrl(input: AgentMediaShare, supplied?: AgentMediaShareAccess): string {
  const share = validateAgentMediaShare(input)
  if (share.provider !== 'xiaohongshu') throw invalid()
  const checked = supplied === undefined ? undefined : validateAgentXiaohongshuAccess(supplied), url = new URL(agentMediaSharePageUrl(share))
  if (checked?.xsecToken !== undefined) url.searchParams.set('xsec_token', checked.xsecToken)
  if (checked?.xsecSource !== undefined) url.searchParams.set('xsec_source', checked.xsecSource)
  if (checked?.mediaKind !== undefined) url.searchParams.set('type', checked.mediaKind === 'image' ? 'normal' : 'video')
  return url.href
}

/** Malformed credential queries are also removed once the official base identity is recognizable. */
export function sanitizeAgentXiaohongshuShareText(text: string): string {
  if (typeof text !== 'string') return ''
  return text.replace(candidatePattern, (raw, offset: number) => {
    if (offset && /[\w.@:/=?&%#-]/u.test(text[offset - 1]!)) return raw
    const candidate = basic(raw)
    return candidate && (raw.includes('?') || candidate.fragment) ? agentMediaSharePageUrl(candidate.share) : raw
  })
}
