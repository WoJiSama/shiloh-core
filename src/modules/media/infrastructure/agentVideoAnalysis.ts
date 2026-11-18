import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import { isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { resolveChatCompletionUrl } from '../../models/domain/chatCompletionUrl.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { validateAgentVideoInput } from '../domain/agentVideoInput.js'
import { douyinGuard } from './agentDouyinRelayHttp.js'
import { isIP } from 'node:net'

export interface AgentVideoAnalysisConfig {
  readonly enabled: boolean
  readonly baseUrl?: string
  readonly name?: string
  readonly apiKey?: string
  readonly inputMode?: 'inline' | 'bigmodel-upload'
  readonly uploadHosts?: readonly string[]
}
export interface AgentVideoAnalysisOptions { readonly secrets?: readonly string[]; readonly allowsText?: (value: string) => boolean }
const UPLOAD = 'https://www.bigmodel.cn/api/biz/file/uploadTemporaryImage'
const DEFAULT_UPLOAD_HOSTS = Object.freeze(['www.bigmodel.cn', 'open.bigmodel.cn', 'cdn.bigmodel.cn'])
const MiB = 1024 * 1024
const MODEL_RESPONSE_BYTES = 2 * MiB
const failure = () => new Error('视频分析配置、来源或服务不可用')
const failed = (): AgentToolResult => ({ status: 'failed', content: '视频分析未完成：来源、权限、网络或返回内容未通过验证。' })
const row = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}
function endpoint(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 2048 || input !== input.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(input)) throw failure()
  let url: URL; try { url = new URL(input) } catch { throw failure() }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#]/u.test(input)) throw failure()
  return resolveChatCompletionUrl(url.href)
}
function promptText(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) throw failure()
  return input.trim()
}
function human(context: AgentToolContext): void {
  if (context.actor.kind !== 'user' || !context.actor.user || !isPlatformAccount(context.actor.user) || !samePlatformNamespace(context.actor.user, context.binding.target.account) ||
      context.actor.user.id === context.binding.target.account.id || context.binding.target.kind !== 'group' || !context.request || !isPlatformIdentifier(context.request.messageId)) throw failure()
}
function videoDataUrl(value: string): boolean {
  const unicode = value.replace(/\\+u([\da-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
  const decoded = (text: string): string => { try { return decodeURIComponent(text) } catch { return text.replace(/%([\da-f]{2})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16))) } }
  return [value, unicode, decoded(value), decoded(unicode)].some(text => /data\s*:\s*video\//iu.test(text))
}

/** Host-owned exact DNS names replace the documented defaults; no suffix/wildcard authority. */
export function validateAgentVideoUploadHosts(input?: readonly string[]): readonly string[] {
  if (input === undefined) return DEFAULT_UPLOAD_HOSTS
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > 8 || Reflect.ownKeys(input).length !== input.length + 1) throw failure()
  const hosts = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
    const host: unknown = descriptor.value
    if (typeof host !== 'string' || host.length > 253 || !host.includes('.') || host.endsWith('.') || isIP(host) || host.toLowerCase().endsWith('.localhost') ||
        !host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) throw failure()
    const normalized = host.toLowerCase(); let parsed: string
    try { parsed = new URL(`https://${normalized}/`).hostname } catch { throw failure() }
    if (isIP(parsed) || parsed !== normalized) throw failure()
    return normalized
  })
  if (new Set(hosts).size !== hosts.length) throw failure()
  return Object.freeze(hosts)
}

/** A validated response from the fixed upload endpoint alone grants this temporary URL. */
export function validateAgentBigmodelUploadUrl(input: unknown, allows: (value: string) => boolean, hosts?: readonly string[]): string {
  const allowed = validateAgentVideoUploadHosts(hosts)
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || input.includes('#') || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw failure()
  const path = input.split('?')[0]!, authority = /^https:\/\/([^/?#]+)/u.exec(input)?.[1]
  if (!authority || /[:@]/u.test(authority) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path) || /%(?:2e|2f|5c)/iu.test(path)) throw failure()
  let url: URL; try { url = new URL(input) } catch { throw failure() }
  for (const value of [url.pathname, ...[...url.searchParams].flat()]) if (/[\u0000-\u001f\u007f]/u.test(value)) throw failure()
  if (!allowed.includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname === '/' || !allows(url.href)) throw failure()
  return url.href
}

async function readJson(response: Response, guard: ReturnType<typeof douyinGuard>, maximum: number, check: (value: string) => boolean): Promise<Record<string, unknown>> {
  try {
    if (response.status !== 200 || response.redirected || (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase() !== 'application/json' || response.headers.get('content-encoding') && response.headers.get('content-encoding')!.toLowerCase() !== 'identity' || !response.body) throw failure()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw failure()
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0
    try {
      while (true) {
        await guard.ensure(); const next = await guard.wait(reader.read())
        if (next.done) break
        size += next.value.byteLength; if (size > maximum) throw failure()
        chunks.push(Buffer.from(next.value))
      }
      if (!size || length !== null && Number(length) !== size) throw failure()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
      if (!check(text)) throw failure()
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object' || Array.isArray(data) || !check(JSON.stringify(data))) throw failure()
      await guard.ensure(); return data as Record<string, unknown>
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  } catch { void response.body?.cancel().catch(() => {}); throw failure() }
}

/** Model-selected analysis consumes only owned bytes of this verified human group's current source. */
export function createAgentVideoAnalysisTool(config: AgentVideoAnalysisConfig, options: AgentVideoAnalysisOptions = {}): AgentTool {
  const raw = object(config, ['enabled', 'baseUrl', 'name', 'apiKey', 'inputMode', 'uploadHosts'])
  if (typeof raw.enabled !== 'boolean') throw failure()
  const enabled = raw.enabled
  let model = '', key = '', modelEndpoint = '', mode: 'inline' | 'bigmodel-upload' = 'inline', uploadHosts = DEFAULT_UPLOAD_HOSTS as readonly string[]
  if (enabled) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(raw.name) || typeof raw.apiKey !== 'string' || !raw.apiKey.trim() || raw.apiKey.length > 8192 || /[^\x21-\x7e]/u.test(raw.apiKey) || raw.inputMode !== undefined && !['inline', 'bigmodel-upload'].includes(raw.inputMode as string)) throw failure()
    model = raw.name; key = raw.apiKey; modelEndpoint = endpoint(raw.baseUrl); mode = (raw.inputMode as 'inline' | 'bigmodel-upload' | undefined) ?? 'inline'
    uploadHosts = validateAgentVideoUploadHosts(raw.uploadHosts as readonly string[] | undefined)
  }
  if (options.secrets !== undefined && (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(value => typeof value !== 'string' || value.length > 32768)) || options.allowsText !== undefined && typeof options.allowsText !== 'function') throw failure()
  const secretCheck = createAgentSecretTextCheck([key, ...options.secrets ?? []])
  const allows = (value: string): boolean => { try { return secretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  return {
    name: 'videoAnalysisTool', dataPolicy: 'ephemeral', timeoutMs: 240_000,
    description: '分析当前真人群消息、其引用或嵌套转发中的首个已核验视频。可说明总结、识别或解读诉求；不接受视频URL、路径、来源身份或服务端点参数。视频和分析只用于当前回合。',
    parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 4000, description: '视频分析诉求；缺省使用当前真人请求，仍为空时分析视频内容' } }, required: [], additionalProperties: false },
    async execute(input, context) {
      let guard: ReturnType<typeof douyinGuard> | undefined
      try {
        if (!enabled) return failed()
        human(context)
        const data = object(input, ['prompt'])
        const supplied = data.prompt === undefined ? '' : promptText(data.prompt)
        const prompt = supplied || promptText(context.request!.text) || '请分析这个视频内容'
        if (!allows(prompt) || !allows(model)) throw failure()
        guard = douyinGuard(context, 240_000); await guard.ensure()
        if (!context.readVideo) throw failure()
        const video = validateAgentVideoInput(await guard.wait(context.readVideo()))
        const bytes = Buffer.from(video.base64, 'base64'), binaryText = bytes.toString('utf8'), inlineUrl = `data:${video.mime};base64,${video.base64}`
        if (!secretCheck(video.base64) || !secretCheck(binaryText)) throw failure()
        // A full echo longer than the bounded response cannot occur; avoid multiplying a 64MiB input into encoded secret variants.
        const sourceCheck = createAgentSecretTextCheck([video.base64, inlineUrl, binaryText].filter(value => value.length <= MODEL_RESPONSE_BYTES))
        const sourceResponseCheck = (value: string): boolean => secretCheck(value) && sourceCheck(value) && !videoDataUrl(value)
        await guard.ensure()
        const post = async (url: string, body: BodyInit, headers: Record<string, string>, maximum: number, responseCheck = sourceResponseCheck): Promise<Record<string, unknown>> => {
          await guard!.ensure()
          let response: Response | undefined
          try {
            response = await guard!.wait(fetch(url, { method: 'POST', redirect: 'error', signal: guard!.signal, headers, body }), late => late.body?.cancel())
            await guard!.ensure()
            return await readJson(response, guard!, maximum, responseCheck)
          } finally { void response?.body?.cancel().catch(() => {}) }
        }
        let videoUrl = inlineUrl, responseCheck = sourceResponseCheck
        if (mode === 'bigmodel-upload') {
          const multipart = new FormData()
          multipart.set('file', new Blob([new Uint8Array(bytes)], { type: video.mime }), `video.${video.mime === 'video/mp4' ? 'mp4' : 'webm'}`)
          const uploaded = await post(UPLOAD, multipart, { Authorization: `Bearer ${key}` }, 64 * 1024)
          if (uploaded.error) throw failure()
          videoUrl = validateAgentBigmodelUploadUrl(uploaded.url, allows, uploadHosts)
          // The validated URL is bounded at 8192 characters; its decoded query values are temporary credentials too.
          const transientCheck = createAgentSecretTextCheck([videoUrl, ...new URL(videoUrl).searchParams.values()].filter(Boolean))
          responseCheck = value => sourceResponseCheck(value) && transientCheck(value)
        }
        const body = JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: videoUrl } }] }], stream: false })
        if (!secretCheck(body)) throw failure()
        const result = await post(modelEndpoint, body, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, MODEL_RESPONSE_BYTES, responseCheck)
        await guard.ensure()
        const usage = row(result.usage), counts = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens'].filter(name => typeof usage[name] === 'number' && Number.isSafeInteger(usage[name]) && Number(usage[name]) >= 0).map(name => [name, usage[name]]))
        if (Object.keys(counts).length) context.recordUsage?.(model, counts)
        const message = row(row(Array.isArray(result.choices) ? result.choices[0] : undefined).message)
        if (result.error || message.tool_calls || message.function_call || typeof message.content !== 'string' || message.content.length > 200_000 || !allows(message.content) || !responseCheck(message.content)) throw failure()
        const analysis = Array.from(sanitizeFinalReplyText(message.content)).slice(0, 24000).join('').trim()
        if (!analysis || !allows(analysis) || !responseCheck(analysis)) throw failure()
        const content = JSON.stringify({ analysis })
        if (!allows(content) || !responseCheck(content)) throw failure()
        await guard.ensure(); return { status: 'succeeded', content }
      } catch { return failed() }
      finally { guard?.close() }
    },
  }
}
