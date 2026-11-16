import { randomUUID } from 'node:crypto'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import type { AgentAudioBytes } from '../../../contracts/agentMedia.js'
import type { VoiceStyle } from './VolcengineVoiceProvider.js'
import { MAX_AGENT_AUDIO_BYTES, validateAgentAudioBytes } from './agentMediaBytes.js'

export type { VoiceStyle } from './VolcengineVoiceProvider.js'
export interface AgentVoiceConfig {
  enabled: boolean
  provider?: 'volcengine'
  endpoint?: string
  appId?: string
  accessToken?: string
  authorization?: string
  resourceId?: string
  voiceType?: string
  uid?: string
  format?: 'mp3' | 'wav' | 'ogg'
  sampleRate?: number
  speedRatio?: number
  pitchRatio?: number
  volumeRatio?: number
  emotion?: string
  stylePrompt?: string
  maxTextLength?: number
  styles?: Record<string, VoiceStyle>
}
export interface AgentVoiceProviderOptions {
  readonly fetchImpl?: typeof fetch
  /** May shorten, never increase, the 25s HTTP deadline. */
  readonly timeoutMs?: number
}
export type AgentVoiceContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' } as const
const MAX_HTTP_MS = 25_000
const MAX_FRAMES = 16_384
const failure = () => new Error('语音服务请求失败或返回了无效音频')
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function boundedVoiceTimeout(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum
}
/** Observe a started operation even when an injected transport ignores cancellation. */
export async function abortableVoice<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(failure())
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}
export async function ensureVoiceCurrent(context: AgentVoiceContext, signal = context.signal): Promise<void> {
  const check = () => { signal.throwIfAborted(); context.signal.throwIfAborted(); if (!context.isCurrent()) throw failure() }
  check()
  if (context.ensureCurrent) await abortableVoice(Promise.resolve().then(() => { check(); return context.ensureCurrent!() }), signal)
  check()
}
function validText(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (empty || !!value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value)
}
function header(value: unknown): value is string { return typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/u.test(value) }
function endpoint(value: unknown): string {
  if (!validText(value, 2048) || /[\s\\]/u.test(value)) throw failure()
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw failure()
    return parsed.href
  } catch { throw failure() }
}
function voiceSettings(value: VoiceStyle): void {
  if (value.format !== undefined && !['mp3', 'wav', 'ogg'].includes(value.format)) throw failure()
  for (const [key, low, high] of [['sampleRate', 8000, 48000], ['speedRatio', .5, 2], ['pitchRatio', .5, 2], ['volumeRatio', .1, 3]] as const) {
    const number = value[key]
    if (number !== undefined && (!Number.isFinite(number) || number < low || number > high || key === 'sampleRate' && !Number.isInteger(number))) throw failure()
  }
  for (const key of ['voiceType', 'resourceId', 'emotion', 'prompt'] as const) {
    if (value[key] !== undefined && !validText(value[key], key === 'prompt' ? 2000 : 256, key === 'emotion' || key === 'prompt')) throw failure()
  }
}
/** Trusted configuration only: the model cannot choose routes, credentials, speakers or files. */
export function buildAgentVoiceRequest(config: AgentVoiceConfig, input: { text: string; style?: VoiceStyle }) {
  if (config.enabled !== true || config.provider !== undefined && config.provider !== 'volcengine' ||
      !header(config.appId) || !header(config.accessToken) || !header(config.resourceId) || !validText(config.voiceType, 256) ||
      config.authorization !== undefined && !header(config.authorization) || config.uid !== undefined && !validText(config.uid, 256) ||
      config.stylePrompt !== undefined && !validText(config.stylePrompt, 2000, true) ||
      typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)) throw failure()
  voiceSettings(config)
  voiceSettings(input.style ?? {})
  const style = input.style ?? {}, format = (style.format ?? config.format ?? 'mp3') as keyof typeof MIME
  const resourceId = style.resourceId ?? config.resourceId
  if (!header(resourceId)) throw failure()
  const audio = { format, sample_rate: style.sampleRate ?? config.sampleRate ?? 24000,
    speech_rate: style.speedRatio ?? config.speedRatio, pitch_rate: style.pitchRatio ?? config.pitchRatio, volume_ratio: style.volumeRatio ?? config.volumeRatio }
  const additions = { emotion: style.emotion ?? config.emotion, style: style.prompt ?? config.stylePrompt }
  const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
  return {
    endpoint: endpoint(config.endpoint ?? DEFAULT_ENDPOINT), mime: MIME[format],
    headers: { 'Content-Type': 'application/json', 'X-Api-App-Id': config.appId, 'X-Api-Access-Key': config.accessToken,
      'X-Api-Resource-Id': resourceId, 'X-Api-Connect-Id': randomUUID(), ...(config.authorization ? { Authorization: `Bearer ${config.authorization}` } : {}) },
    body: { user: { uid: config.uid ?? 'shiloh-plugin' }, req_params: { text: input.text, speaker: style.voiceType ?? config.voiceType,
      audio_params: defined(audio), additions: defined(additions) } }
  }
}
async function readBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (!response.body || declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_AGENT_AUDIO_BYTES)) {
    void response.body?.cancel().catch(() => {})
    throw failure()
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await abortableVoice(reader.read(), signal)
      if (item.done) break
      size += item.value.byteLength
      if (size > MAX_AGENT_AUDIO_BYTES) throw failure()
      parts.push(item.value)
    }
    signal.throwIfAborted()
    return Buffer.concat(parts, size)
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** Decode only documented audio slots, never harvest arbitrary strings in metadata. */
function decodeFrames(raw: Buffer, contentType: string): Buffer {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).trim()
  const parts: Buffer[] = []
  let size = 0, frames = 0, finished = false
  const consume = (line: string) => {
    if (++frames > MAX_FRAMES) throw failure()
    if (line === '[DONE]') { finished = true; return }
    const frame = record(JSON.parse(line))
    if (!frame) throw failure()
    if (frame.error || typeof frame.status === 'string' && /^(error|failed|failure)$/iu.test(frame.status)) throw failure()
    if (frame.code !== undefined && ![0, '0', 20000000, '20000000'].includes(frame.code as number | string)) throw failure()
    const nested = record(frame.data)
    const candidates = [frame.audio, frame.audio_data, frame.audioData, typeof frame.data === 'string' ? frame.data : undefined,
      nested?.audio, nested?.audio_data, nested?.audioData].filter(value => value !== undefined && value !== '')
    if (candidates.length > 1 || candidates.some(value => typeof value !== 'string')) throw failure()
    const candidate = candidates[0]
    if (typeof candidate === 'string') {
      if (finished || candidate.length % 4 !== 0 || candidate.length > Math.ceil(MAX_AGENT_AUDIO_BYTES / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/u.test(candidate)) throw failure()
      const decoded = Buffer.from(candidate, 'base64')
      if (!decoded.length || decoded.toString('base64') !== candidate) throw failure()
      size += decoded.length
      if (size > MAX_AGENT_AUDIO_BYTES) throw failure()
      parts.push(decoded)
    }
    if (frame.code === 20000000 || frame.code === '20000000') finished = true
  }
  if (contentType === 'text/event-stream' || /^(?:data:|event:|:)/mu.test(text)) {
    let event = '', lines: string[] = []
    const flush = () => {
      if (/^(error|failed|failure)$/iu.test(event)) throw failure()
      if (lines.length) consume(lines.join('\n'))
      lines = []; event = ''
    }
    for (const line of text.split(/\r?\n/u)) {
      if (!line) flush()
      else if (line.startsWith(':')) continue
      else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /u, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (!/^(?:id|retry):/u.test(line)) throw failure()
    }
    flush()
  } else {
    let whole: unknown
    try { whole = JSON.parse(text) } catch { /* NDJSON is parsed frame by frame below. */ }
    if (whole !== undefined) consume(text)
    else for (const line of text.split(/\r?\n/u).filter(line => line.trim())) consume(line)
  }
  if (!parts.length) throw failure()
  return Buffer.concat(parts, size)
}
export function parseAgentVoiceAudio(raw: Buffer, contentType: string, mime: string): Readonly<AgentAudioBytes> {
  try {
  if (!raw.length || raw.length > MAX_AGENT_AUDIO_BYTES) throw failure()
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase()
  let audio: Buffer
  if (type.startsWith('audio/') || type === 'application/octet-stream') {
    const aliases: Record<string, string> = { 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-ogg': 'audio/ogg' }
    if (type !== 'application/octet-stream' && (aliases[type] ?? type) !== mime) throw failure()
    audio = raw
  } else {
    if (type && !['text/event-stream', 'application/json', 'application/x-ndjson', 'application/jsonlines', 'text/plain'].includes(type)) throw failure()
    audio = decodeFrames(raw, type)
  }
  return validateAgentAudioBytes({ mime, base64: audio.toString('base64') })
  } catch { throw failure() }
}
export function createAgentVoiceProvider(config: AgentVoiceConfig, options: AgentVoiceProviderOptions = {}) {
  const captured = structuredClone(config)
  return {
    async synthesize(input: { text: string; style?: VoiceStyle }, context: AgentVoiceContext): Promise<Readonly<AgentAudioBytes>> {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, context.signal])
      const timer = setTimeout(() => controller.abort(), boundedVoiceTimeout(options.timeoutMs, MAX_HTTP_MS))
      timer.unref?.()
      try {
        const request = buildAgentVoiceRequest(captured, input)
        await ensureVoiceCurrent(context, signal)
        const response = await abortableVoice((options.fetchImpl ?? globalThis.fetch)(request.endpoint, {
          method: 'POST', headers: request.headers, body: JSON.stringify(request.body), redirect: 'error', signal
        }), signal)
        if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); throw failure() }
        const raw = await readBody(response, signal)
        await ensureVoiceCurrent(context, signal)
        return parseAgentVoiceAudio(raw, response.headers.get('content-type') ?? '', request.mime)
      } catch { throw failure() } finally { clearTimeout(timer) }
    }
  }
}
