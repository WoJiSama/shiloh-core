import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'
export { validateAgentMediaShare } from './agentMediaRelayReference.js'

/** Syntax only: credentials, queries and platform payloads never become references. */
export function parseAgentBilibiliReference(text: string): Readonly<AgentMediaShare> | undefined {
  if (typeof text !== 'string' || text.length > 64_000) return undefined
  const pattern = /(?:https?:\/\/|\/\/)?(?:b23\.tv|(?:(?:www|m)\.)?bilibili\.com)\/[^\s，。！？；;）)\]}>"'<>]+/giu
  for (const match of text.matchAll(pattern)) {
    if (match.index && /[\w.@:/=?&%#-]/u.test(text[match.index - 1]!)) continue
    try {
      const raw = match[0]
      if (/[\\\u0000-\u001f\u007f]/u.test(raw)) continue
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : /^https?:/iu.test(raw) ? raw : `https://${raw}`)
      if (url.username || url.password || url.port || url.hash || !['http:', 'https:'].includes(url.protocol)) continue
      const host = url.hostname.toLowerCase()
      const short = host === 'b23.tv' ? /^\/([A-Za-z0-9_-]{1,128})\/?$/u.exec(url.pathname)?.[1] : undefined
      const video = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) ? /^\/video\/(BV[0-9A-Za-z]{8,16})\/?$/iu.exec(url.pathname)?.[1] : undefined
      const episode = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) ? /^\/bangumi\/play\/ep([1-9]\d{0,19})\/?$/iu.exec(url.pathname)?.[1] : undefined
      if (short || video || episode) return validateAgentMediaShare({ provider: 'bilibili', reference: { kind: short ? 'short' : video ? 'video' : 'episode', id: short || video || episode } })
    } catch { /* Only complete official share URLs are candidates. */ }
  }
  return undefined
}
