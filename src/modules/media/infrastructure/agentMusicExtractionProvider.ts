import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { AgentAudioBytes } from '../../../contracts/agentMedia.js'
import type { AgentAudioAttachment, AgentMusicExtractionContext, AgentMusicShare } from '../../../contracts/agentMusicExtraction.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { MAX_AGENT_AUDIO_BYTES, validateAgentAudioBytes } from './agentMediaBytes.js'

export type { AgentMusicShare, AgentAudioAttachment, AgentMusicExtractionContext } from '../../../contracts/agentMusicExtraction.js'
export interface AgentMusicExtractionResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Uint8Array | string
}
export interface AgentMusicExtractionRequestPolicy { readonly maxBytes: number; readonly accept: string }
export interface AgentMusicExtractionProviderOptions {
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>
  /** Connect to this validated address without another DNS lookup, and honor signal and byte budget. */
  readonly request?: (url: URL, address: LookupAddress, signal: AbortSignal, policy?: AgentMusicExtractionRequestPolicy) => Promise<AgentMusicExtractionResponse>
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  /** May shorten, never extend, the entire 60s preparation budget. */
  readonly timeoutMs?: number
  /** May shorten, never extend, each metadata stage's 10s budget. */
  readonly metadataTimeoutMs?: number
}
export interface AgentPreparedMusicExtraction {
  readonly attachment: AgentAudioAttachment
  readonly audio: AgentAudioBytes
  readonly title: string
  readonly artist: string
}
const META_BYTES = 2 * 1024 * 1024
const META_POLICY: AgentMusicExtractionRequestPolicy = { maxBytes: META_BYTES, accept: 'application/json' }
const AUDIO_POLICY: AgentMusicExtractionRequestPolicy = { maxBytes: MAX_AGENT_AUDIO_BYTES, accept: 'audio/*' }
const failure = () => new Error('音乐提取失败：来源、网络、内容或音频格式不符合要求')
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw failure()
}
function spelling(value: string): void {
  if (!value || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c|2e|25|40|3a|3f|23)/iu.test(value) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(value)) throw failure()
}
function officialUrl(value: unknown): URL {
  if (typeof value !== 'string') throw failure()
  spelling(value)
  const authority = value.match(/^https?:\/\/([^/?#]+)/iu)?.[1]
  if (!authority || authority.includes(':') || authority.includes('@')) throw failure()
  const url = new URL(value), host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || isIP(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) ||
      !(host === 'music.163.com' || host.endsWith('.music.163.com') || host.endsWith('.music.126.net'))) throw failure()
  return url
}
function optionalText(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) throw failure()
  return value
}
export function validateAgentMusicShare(input: unknown): Readonly<AgentMusicShare> {
  try {
    closed(input, ['provider', 'reference', 'title', 'artist'])
    if (input.provider !== 'netease') throw failure()
    const reference = input.reference
    closed(reference, ['kind', 'id', 'url'])
    let captured: AgentMusicShare['reference']
    if (reference.kind === 'song' || reference.kind === 'program') {
      if (Object.hasOwn(reference, 'url') || typeof reference.id !== 'string' || !/^\d{1,20}$/u.test(reference.id)) throw failure()
      captured = Object.freeze({ kind: reference.kind, id: reference.id })
    } else if (reference.kind === 'audio') {
      if (Object.hasOwn(reference, 'id')) throw failure()
      officialUrl(reference.url)
      captured = Object.freeze({ kind: 'audio', url: reference.url as string })
    } else throw failure()
    return Object.freeze({ provider: 'netease', reference: captured,
      ...(input.title !== undefined ? { title: optionalText(input.title) } : {}), ...(input.artist !== undefined ? { artist: optionalText(input.artist) } : {}) })
  } catch { throw failure() }
}
/** Only ordinary official song/dj links; no hash routes, short links, playlists or network resolution. */
export function parseNeteaseMusicLink(text: string): Readonly<AgentMusicShare> | undefined {
  if (typeof text !== 'string' || text.length > 16000) return undefined
  for (const match of text.matchAll(/https?:\/\/(?:y\.)?music\.163\.com\/(?:song|dj)\?[^\s，。！？；;）)\]}>]+/giu)) {
    try {
      const url = officialUrl(match[0])
      if (!['music.163.com', 'y.music.163.com'].includes(url.hostname) || !['/song', '/dj'].includes(url.pathname) || url.searchParams.getAll('id').length !== 1) continue
      const id = url.searchParams.get('id')
      if (!id || !/^\d{1,20}$/u.test(id)) continue
      return validateAgentMusicShare({ provider: 'netease', reference: { kind: url.pathname === '/dj' ? 'program' : 'song', id } })
    } catch { /* Continue only across explicitly supplied, syntactically valid links. */ }
  }
  return undefined
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(failure())
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function ensureCurrent(context: AgentMusicExtractionContext, signal: AbortSignal): Promise<void> {
  const check = () => { context.signal.throwIfAborted(); signal.throwIfAborted(); if (!context.isCurrent()) throw failure() }
  check()
  if (context.ensureCurrent) await abortable(Promise.resolve().then(() => { check(); return context.ensureCurrent!() }), signal)
  check()
}
function boundedTimeout(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum
}
function nativeRequest(url: URL, address: LookupAddress, signal: AbortSignal, policy: AgentMusicExtractionRequestPolicy): Promise<AgentMusicExtractionResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, { method: 'GET', agent: false, signal, family: address.family, maxHeaderSize: 16384,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: policy.accept, 'Accept-Encoding': 'identity' },
      lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
      const headers: Record<string, string | undefined> = { 'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
        'content-encoding': response.headers['content-encoding'], location: response.headers.location }
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) { response.destroy(); resolve({ status, headers, body: '' }); return }
      const length = headers['content-length']
      if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity' ||
          length !== undefined && (!/^\d+$/u.test(length) || Number(length) > policy.maxBytes)) {
        response.destroy(); reject(failure()); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > policy.maxBytes) { response.destroy(failure()); return }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('aborted', () => reject(failure()))
      response.once('end', () => resolve({ status, headers, body: Buffer.concat(chunks, size) }))
    })
    request.once('error', reject)
    request.end()
  })
}
function displayText(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f\u007f]/u.test(value)) throw failure()
  return safeTruncateUnicode(value.replace(/\s+/gu, ' ').trim(), 100) || fallback
}
function idString(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw failure()
  if (typeof value !== 'number' && typeof value !== 'string' || !/^\d{1,20}$/u.test(String(value))) throw failure()
  return String(value)
}
function artistName(song: Record<string, unknown>, fallback = '未知艺术家'): string {
  const artists = song.artists ?? song.ar
  if (artists === undefined) return fallback
  if (!Array.isArray(artists) || artists.length > 32) throw failure()
  const names = artists.map(item => displayText(record(item)?.name, '')).filter(Boolean)
  return displayText(names.join('/'), fallback)
}
const AUDIO_MIME: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/amr': 'amr', 'audio/amr-wb': 'amr', 'audio/silk': 'silk' }
function audioMime(type: string): string {
  const mime = type.split(';', 1)[0]!.trim().toLowerCase()
  const aliases: Record<string, string> = { 'audio/mp3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-ogg': 'audio/ogg', 'audio/x-flac': 'audio/flac' }
  const result = aliases[mime] ?? mime
  if (!Object.hasOwn(AUDIO_MIME, result)) throw failure()
  return result
}
function filename(title: string, artist: string, extension: string): string {
  let base = `${title}-${artist}`.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^\.+|\.+$/gu, '') || '音乐'
  const parts = Array.from(base)
  while (parts.length > 150 || Buffer.byteLength(parts.join('')) > 220) parts.pop()
  base = parts.join('') || '音乐'
  return `${base}.${extension}`
}

/** Resolves official references into complete owned bytes without filesystem or native-message access. */
export function createAgentMusicExtractionProvider(options: AgentMusicExtractionProviderOptions = {}) {
  const allowsSecretText = createAgentSecretTextCheck(options.secrets ?? [])
  const allowed = (value: string) => allowsSecretText(value) && options.allowsText?.(value) !== false
  const requireText = (value: string) => { if (!allowed(value)) throw failure() }
  function checkMetadata(value: unknown): void {
    const pending = [{ value, depth: 0 }]; let visited = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++visited > 40000 || next.depth > 16) throw failure()
      if (typeof next.value === 'string') { if (next.value.length > 32768) throw failure(); requireText(next.value) }
      else if (Array.isArray(next.value)) for (const value of next.value) pending.push({ value, depth: next.depth + 1 })
      else if (record(next.value)) for (const [key, value] of Object.entries(next.value!)) {
        if (key.length > 256) throw failure()
        requireText(key); pending.push({ value, depth: next.depth + 1 })
      }
    }
  }
  async function read(input: string, context: AgentMusicExtractionContext, signal: AbortSignal, policy: AgentMusicExtractionRequestPolicy) {
    requireText(input)
    let url = officialUrl(input)
    const lookup = options.lookup ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true }))
    const request = options.request ?? nativeRequest
    for (let redirects = 0; redirects <= 3; redirects++) {
      requireText(url.href)
      await ensureCurrent(context, signal)
      const addresses = await abortable(lookup(url.hostname), signal)
      if (!addresses.length || addresses.length > 32 || addresses.some(item => isIP(item.address) !== item.family || !isPublicAddress(item.address))) throw failure()
      await ensureCurrent(context, signal)
      const response = await abortable(request(url, addresses[0]!, signal, policy), signal)
      await ensureCurrent(context, signal)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location
        if (redirects === 3 || !location) throw failure()
        requireText(location); spelling(location)
        const authority = location.match(/^(?:https?:)?\/\/([^/?#]+)/iu)?.[1]
        if (authority && (authority.includes(':') || authority.includes('@'))) throw failure()
        url = officialUrl(new URL(location, url).href)
        continue
      }
      if (response.status < 200 || response.status >= 300 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw failure()
      const declared = response.headers['content-length']
      const size = typeof response.body === 'string' ? Buffer.byteLength(response.body) : response.body.byteLength
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > policy.maxBytes) || size > policy.maxBytes || !size) throw failure()
      return response
    }
    throw failure()
  }
  async function metadata(url: string, context: AgentMusicExtractionContext, signal: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => controller.abort(), boundedTimeout(options.metadataTimeoutMs, 10000)); timer.unref?.()
    try {
      const response = await read(url, context, combined, META_POLICY)
      const raw = typeof response.body === 'string' ? response.body : new TextDecoder('utf-8', { fatal: true }).decode(response.body)
      requireText(raw)
      const value = record(JSON.parse(raw))
      if (!value) throw failure()
      checkMetadata(value)
      await ensureCurrent(context, combined)
      return value
    } finally { clearTimeout(timer) }
  }
  return {
    async prepare(input: AgentMusicShare, context: AgentMusicExtractionContext): Promise<AgentPreparedMusicExtraction> {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, context.signal])
      const timer = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs, 60000)); timer.unref?.()
      try {
        const share = validateAgentMusicShare(input)
        checkMetadata(share)
        await ensureCurrent(context, signal)
        let title = displayText(share.title, '音乐'), artist = displayText(share.artist, '未知艺术家'), source: string
        if (share.reference.kind === 'audio') source = share.reference.url
        else if (share.reference.kind === 'program') {
          const payload = await metadata(`https://music.163.com/api/dj/program/detail?id=${share.reference.id}`, context, signal)
          const program = record(payload.program), song = record(program?.mainSong)
          if (payload.code !== 200 || !song) throw failure()
          const id = idString(song.id)
          title = displayText(song.name ?? program?.name, title)
          artist = artistName(song, displayText(record(program?.dj)?.nickname, artist))
          source = `https://music.163.com/song/media/outer/url?id=${id}`
        } else {
          const payload = await metadata(`https://music.163.com/api/song/detail/?ids=[${share.reference.id}]`, context, signal)
          const song = record(Array.isArray(payload.songs) ? payload.songs[0] : undefined)
          if (payload.code !== 200 || !song) throw failure()
          const id = idString(song.id)
          if (id !== share.reference.id) throw failure()
          title = displayText(song.name, title); artist = artistName(song, artist)
          source = `https://music.163.com/song/media/outer/url?id=${id}`
        }
        requireText(title); requireText(artist); requireText(source)
        await ensureCurrent(context, signal)
        const response = await read(source, context, signal, AUDIO_POLICY)
        const mime = audioMime(response.headers['content-type'] ?? '')
        const buffer = typeof response.body === 'string' ? Buffer.from(response.body) : Buffer.from(response.body)
        const audio = validateAgentAudioBytes({ mime, base64: buffer.toString('base64') })
        const name = filename(title, artist, AUDIO_MIME[mime]!)
        requireText(name)
        await ensureCurrent(context, signal)
        return { attachment: Object.freeze({ name, mime: audio.mime, base64: audio.base64 }), audio, title, artist }
      } catch { throw failure() } finally { clearTimeout(timer) }
    }
  }
}
