import { isIP } from 'node:net'
import type { AgentMusicCard } from '../../../contracts/agentMusic.js'

function data(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['title', 'artist', 'pageUrl', 'audioUrl', 'coverUrl'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('音乐卡片必须为闭合普通数据')
}
function text(value: unknown, required: boolean): string {
  if (typeof value !== 'string' || Array.from(value).length > 300 || required && !value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('音乐标题或艺人无效或超过 300 字符')
  return value
}
function publicUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(value)) throw new Error('音乐资源须为有界公开 HTTP(S) URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('音乐资源 URL 无效') }
  const host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      isIP(host.replace(/^\[|\]$/gu, '')) || host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/u.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|onion|invalid|test|arpa)$/u.test(host) ||
      /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me|lvh\.me)$/u.test(host)) throw new Error('音乐资源 URL 不属于公开主机')
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|authorization|^auth$|api[_-]?key|cookie|session|credential/iu.test(key)) throw new Error('音乐资源 URL 不能包含宿主凭据')
  }
  return value
}

/** Syntax-only public URL checks; no DNS, fetch, redirect or playback claim is made here. */
export function validateAgentMusicCard(input: unknown): Readonly<AgentMusicCard> {
  data(input)
  return Object.freeze({ title: text(input.title, true), ...(input.artist !== undefined ? { artist: text(input.artist, false) } : {}),
    pageUrl: publicUrl(input.pageUrl), audioUrl: publicUrl(input.audioUrl), coverUrl: publicUrl(input.coverUrl),
  })
}
