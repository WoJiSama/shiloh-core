import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'

const sensitiveQuery = /token|cookie|authorization|password|passwd|secret|credential|session|api[_-]?key|(?:^|[_-])(?:auth|sid|pwd)(?:$|[_-])/iu

/** Syntax only. Download URLs, tracking queries and credentials never cross this boundary. */
export function parseAgentDouyinReference(text: string): Readonly<Extract<AgentMediaShare, { provider: 'douyin' }>> | undefined {
  if (typeof text !== 'string' || text.length > 64_000) return undefined
  const pattern = /(?:https?:\/\/|\/\/)?(?:v\.douyin\.com|(?:www\.)?(?:douyin\.com|iesdouyin\.com))\/[^\s，。！？；;）)\]}>"'<>]+/giu
  for (const match of text.matchAll(pattern)) {
    if (match.index && /[\w.@:/=?&%#-]/u.test(text[match.index - 1]!)) continue
    try {
      const raw = match[0]
      if (/[\\#\u0000-\u001f\u007f]/u.test(raw) || raw.length > 8192) continue
      const normalized = raw.startsWith('//') ? `https:${raw}` : /^https?:/iu.test(raw) ? raw : `https://${raw}`
      const parts = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/iu.exec(normalized)
      if (!parts || !/^(?:v\.douyin\.com|(?:www\.)?(?:douyin\.com|iesdouyin\.com))$/iu.test(parts[1]!) ||
        /%|(?:^|\/)\.{1,2}(?:\/|$)/u.test(parts[2]!) || (parts[3]?.length ?? 0) > 4096) continue
      const url = new URL(normalized)
      if (url.username || url.password || url.port || url.hash || !['http:', 'https:'].includes(url.protocol) ||
        [...url.searchParams].some(([key, value]) => sensitiveQuery.test(key) || key.length > 128 || value.length > 2048 || /[\\\u0000-\u001f\u007f]/u.test(key + value))) continue
      const host = url.hostname.toLowerCase(), path = url.pathname
      const direct = ['douyin.com', 'www.douyin.com'].includes(host) ? /^\/(video|note)\/([1-9]\d{5,19})\/?$/u.exec(path)
        : ['iesdouyin.com', 'www.iesdouyin.com'].includes(host) ? /^\/share\/(video|note)\/([1-9]\d{5,19})\/?$/u.exec(path) : undefined
      const short = host === 'v.douyin.com' ? /^\/([A-Za-z0-9_-]{1,128})\/?$/u.exec(path)?.[1] : undefined
      if (!direct && !short) continue
      const selected = validateAgentMediaShare({ provider: 'douyin', reference: { kind: direct ? direct[1] : 'short', id: direct ? direct[2] : short } })
      if (selected.provider === 'douyin') return selected
    } catch { /* Only bounded official references become candidates. */ }
  }
  return undefined
}
