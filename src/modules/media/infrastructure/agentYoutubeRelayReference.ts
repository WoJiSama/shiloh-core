import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'

const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']
const sensitiveQuery = /token|cookie|authorization|password|passwd|secret|credential|session|api[_-]?key|(?:^|[_-])(?:auth|sid|pwd)(?:$|[_-])/iu

/** Syntax only. Persisted references contain the case-sensitive video ID, never source queries. */
export function parseAgentYoutubeReference(text: string): Readonly<Extract<AgentMediaShare, { provider: 'youtube' }>> | undefined {
  if (typeof text !== 'string' || text.length > 64_000) return undefined
  const candidates = /https?:\/\/[^\s，。！？；）)\]}>"'<>]+/giu
  for (const candidate of text.matchAll(candidates)) {
    if (candidate.index && /[\w.@:/=?&%#-]/u.test(text[candidate.index - 1]!)) continue
    try {
      const raw = candidate[0]
      if (raw.length > 8192 || /[\\#\u0000-\u001f\u007f]/u.test(raw)) continue
      const parts = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/iu.exec(raw)
      if (!parts || /%|(?:^|\/)\.{1,2}(?:\/|$)/u.test(parts[3]!) || (parts[4]?.length ?? 0) > 4096) continue
      const authority = /^([a-z.]+)(?::(\d+))?$/iu.exec(parts[2]!)
      if (!authority || !hosts.includes(authority[1]!.toLowerCase()) ||
        authority[2] && authority[2] !== (parts[1]!.toLowerCase() === 'https' ? '443' : '80')) continue
      // URLSearchParams replaces malformed escapes; reject them before decoding any parameter.
      if (parts[4] !== undefined) {
        if (!parts[4]) continue
        for (const component of parts[4].split('&')) {
          if (!component || !component.includes('=')) throw Error()
          const separator = component.indexOf('=')
          const key = decodeURIComponent(component.slice(0, separator).replace(/\+/gu, ' '))
          if (key.toLowerCase() === 'v' && !/^[A-Za-z0-9_-]{11}$/u.test(component.slice(separator + 1))) throw Error()
          decodeURIComponent(component.slice(separator + 1).replace(/\+/gu, ' '))
        }
      }
      const url = new URL(raw), params = [...url.searchParams]
      if (url.username || url.password || url.port || url.hash ||
        params.some(([key, value]) => !key || key.length > 128 || value.length > 2048 || sensitiveQuery.test(key) ||
          /[\\\u0000-\u001f\u007f]/u.test(key + value))) continue
      const videoKeys = params.filter(([key]) => key.toLowerCase() === 'v')
      if (videoKeys.length > 1) continue
      const id = url.hostname === 'youtu.be' ? /^\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1]
        : url.pathname === '/watch' && videoKeys.length === 1 && videoKeys[0]![0] === 'v' ? videoKeys[0]![1]
          : /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1]
      if (!id || !/^[A-Za-z0-9_-]{11}$/u.test(id)) continue
      const selected = validateAgentMediaShare({ provider: 'youtube', reference: { kind: 'video', id } })
      if (selected.provider === 'youtube') return selected
    } catch { /* Only bounded official references become candidates. */ }
  }
  return undefined
}
