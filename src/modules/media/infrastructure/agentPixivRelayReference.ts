import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'

const sensitiveQuery = /token|cookie|authorization|password|passwd|secret|credential|session|api[_-]?key|(?:^|[_-])(?:auth|sid|pwd)(?:$|[_-])/iu

/** Syntax only. Rebuild every outgoing page from the bounded artwork ID. */
export function parseAgentPixivReference(text: string): Readonly<Extract<AgentMediaShare, { provider: 'pixiv' }>> | undefined {
  if (typeof text !== 'string' || text.length > 64_000) return undefined
  for (const candidate of text.matchAll(/https?:\/\/[^\s，。！？；）)\]}>"'<>]+/giu)) {
    if (candidate.index && /[\w.@:/=?&%#-]/u.test(text[candidate.index - 1]!)) continue
    try {
      const raw = candidate[0]
      if (raw.length > 8192 || /[\\#\u0000-\u001f\u007f]/u.test(raw)) continue
      const parts = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/iu.exec(raw)
      if (!parts || /%|(?:^|\/)\.{1,2}(?:\/|$)/u.test(parts[3]!) || (parts[4]?.length ?? 0) > 4096) continue
      const authority = /^((?:www\.)?pixiv\.net)(?::(\d+))?$/iu.exec(parts[2]!)
      if (!authority || authority[2] && authority[2] !== (parts[1]!.toLowerCase() === 'https' ? '443' : '80')) continue
      if (parts[4] !== undefined) {
        if (!parts[4]) continue
        for (const component of parts[4].split('&')) {
          if (!component || !component.includes('=')) throw Error()
          const separator = component.indexOf('='), key = decodeURIComponent(component.slice(0, separator).replace(/\+/gu, ' '))
          if (key.toLowerCase() === 'illust_id' && !/^[1-9]\d{0,11}$/u.test(component.slice(separator + 1))) throw Error()
          decodeURIComponent(component.slice(separator + 1).replace(/\+/gu, ' '))
        }
      }
      const url = new URL(raw), params = [...url.searchParams]
      if (url.username || url.password || url.port || url.hash || params.some(([key, value]) => !key || key.length > 128 ||
        value.length > 2048 || sensitiveQuery.test(key) || /[\\\u0000-\u001f\u007f]/u.test(key + value))) continue
      const identities = params.filter(([key]) => key.toLowerCase() === 'illust_id'), modes = params.filter(([key]) => key.toLowerCase() === 'mode')
      if (identities.length > 1 || modes.length > 1) continue
      const modern = /^\/(?:[a-z]{2}\/)?artworks\/([1-9]\d{0,11})$/u.exec(url.pathname)?.[1]
      if (modern && identities.length) continue
      const legacy = url.pathname === '/member_illust.php' && identities.length === 1 && identities[0]![0] === 'illust_id' &&
        (!modes.length || modes[0]![0] === 'mode' && modes[0]![1] === 'medium') ? identities[0]![1] : undefined
      const id = modern ?? legacy
      if (!id) continue
      const selected = validateAgentMediaShare({ provider: 'pixiv', reference: { kind: 'artwork', id } })
      if (selected.provider === 'pixiv') return selected
    } catch { /* Only a fully valid official artwork reference becomes a candidate. */ }
  }
  return undefined
}
