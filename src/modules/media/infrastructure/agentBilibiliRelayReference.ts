import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'
export { validateAgentMediaShare } from './agentMediaRelayReference.js'

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

/** Season responses may list specials in sections outside the main episode list. */
export function findAgentBilibiliEpisode(value: unknown, id: string): Record<string, unknown> | undefined {
  const { episodes, section = [] } = record(value)
  if (!Array.isArray(section) || section.length > 1000) return undefined
  let found: Record<string, unknown> | undefined, count = 0
  for (const items of [episodes, ...section.map(item => record(item).episodes)]) {
    if (items === undefined) continue
    if (!Array.isArray(items) || (count += items.length) > 1000) return undefined
    for (const item of items) {
      const episode = record(item), key = episode.id
      if (!(typeof key === 'string' || typeof key === 'number' && Number.isSafeInteger(key)) || String(key) !== id) continue
      if (found) return undefined
      found = episode
    }
  }
  return found
}

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
