import type { AgentTool, AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import { resolveChatCompletionUrl } from '../../models/domain/chatCompletionUrl.js'
import { resolveImageAspectRatioIntent, resolveImageProviderSize, isGrokImageModel, assertGrokImageRatio } from '../../image/domain/imageAspectRatio.js'
import { toImageEditUrl, toImageGenerationUrl, shouldRetryWithoutUrlResponseFormat } from '../../image/domain/providerConfig.js'
import { readImageDimensions } from '../../image/domain/imageDimensions.js'
import { sniffImageMime } from '../../image/infrastructure/imageResource.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { abortableAgentWeb, boundedAgentWebTimeout, ensureAgentWebCurrent, readAgentPublicImage, type AgentPublicWebDependencies } from './agentPublicWeb.js'

export interface AgentImageBackend {
  readonly baseUrl: string
  readonly name: string
  /** User-facing channel identity and upstream model are independent. */
  readonly model?: string
  readonly aliases?: readonly string[]
  readonly apiKey: string
  readonly protocol?: 'images' | 'chat'
  readonly size?: string
  readonly quality?: string
}
export interface AgentImageToolsOptions {
  readonly generation?: AgentImageBackend | readonly AgentImageBackend[]
  readonly edit?: AgentImageBackend | readonly AgentImageBackend[]
  readonly secrets?: readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly publicImage?: AgentPublicWebDependencies
  /** May shorten the four minute operation deadline, never increase it. */
  readonly timeoutMs?: number
}

const MAX_RESPONSE = 32 * 1024 * 1024
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024
const rejectedStatuses = new Set([400, 404, 405, 413, 415, 422, 429])
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const failed = (content: string): AgentToolResult => ({ status: 'failed', content })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '图片任务结果尚未确认，请核实后再提交；没有确认图片送达。' })
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const first = (value: unknown) => Array.isArray(value) ? value[0] : undefined
function identifier(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || !value.trim() || value.trim().length > 200) throw new Error('图片服务名称无效')
  return value.trim()
}
/** A single legacy backend remains equivalent to a one-element ordered candidate list. */
export function agentImageBackends(value: AgentImageBackend | readonly AgentImageBackend[] | undefined): readonly AgentImageBackend[] {
  if (value === undefined) return Object.freeze([])
  const rows = (Array.isArray(value) ? value : [value]) as readonly AgentImageBackend[]
  if (!rows.length || rows.length > 8) throw new Error('图片服务渠道数量无效')
  return Object.freeze(Array.from(rows, backend => {
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) throw new Error('图片服务配置无效')
    const name = identifier(backend.name), model = backend.model === undefined ? name : identifier(backend.model)
    if (backend.aliases !== undefined && (!Array.isArray(backend.aliases) || backend.aliases.length > 16)) throw new Error('图片服务别名无效')
    const aliases = backend.aliases === undefined ? undefined : Object.freeze([...new Set(Array.from(backend.aliases, identifier))])
    const normalized = Object.freeze({ ...backend, name, model, ...(aliases ? { aliases } : {}) })
    endpoint(normalized, false)
    return normalized
  }))
}
function hasSecret(value: string, secrets: readonly string[]): boolean {
  const decoded = value.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return secrets.some(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
    .some(part => value.includes(part) || decoded.includes(part)))
}
function endpoint(backend: AgentImageBackend, edit: boolean): string {
  const url = new URL(backend.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      typeof backend.apiKey !== 'string' || !backend.apiKey.trim() || /[\u0000-\u001f\u007f]/u.test(backend.apiKey) ||
      backend.protocol !== undefined && !['images', 'chat'].includes(backend.protocol) ||
      backend.size !== undefined && (typeof backend.size !== 'string' || !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4}|[1248]k)$/iu.test(backend.size)) ||
      backend.quality !== undefined && !['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(backend.quality)) throw new Error('图片服务配置无效')
  if (backend.size?.toLowerCase().includes('x')) {
    const [width, height] = backend.size.toLowerCase().split('x').map(Number)
    if (width! > 16_384 || height! > 16_384 || width! * height! > 64 * 1024 * 1024) throw new Error('图片服务画布超过上限')
  }
  return backend.protocol === 'chat' ? resolveChatCompletionUrl(url.href) : edit ? toImageEditUrl(url.href) : toImageGenerationUrl(url.href)
}
async function readResponse(response: Response, signal: AbortSignal, secrets: readonly string[]): Promise<Record<string, unknown>> {
  if (!response.body) {
    if (rejectedStatuses.has(response.status)) return {}
    throw new Error('图片响应无效')
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('图片响应无效')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await abortableAgentWeb(reader.read(), signal)
      if (item.done) break
      size += item.value.byteLength
      if (size > MAX_RESPONSE) throw new Error('图片响应过大')
      chunks.push(item.value)
    }
    const text = Buffer.concat(chunks, size).toString('utf8')
    if (hasSecret(text, secrets)) throw new Error('图片响应含凭据')
    try { return object(JSON.parse(text)) }
    catch {
      // A fully read explicit rejection can be an HTML gateway response; it did not accept an image job.
      if (rejectedStatuses.has(response.status)) return {}
      throw new Error('图片响应无效')
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
function imageValue(data: Record<string, unknown>, protocol: 'images' | 'chat'): string | undefined {
  if (protocol === 'images') {
    const item = object(first(data.data))
    return typeof item.b64_json === 'string' && item.b64_json ? `base64://${item.b64_json}` : typeof item.url === 'string' ? item.url : undefined
  }
  const message = object(object(first(data.choices)).message)
  if (message.tool_calls || message.function_call) return
  const image = object(first(message.images)), url = object(image.image_url).url ?? image.url
  if (typeof url === 'string') return url
  const content = message.content
  if (Array.isArray(content)) {
    const part = content.map(object).find(item => item.type === 'image_url')
    const value = object(part?.image_url).url
    if (typeof value === 'string') return value
  }
  if (typeof content !== 'string') return
  const text = content.trim()
  if (/^(?:data:image\/|base64:\/\/|https?:\/\/)/iu.test(text) && !/[\s]/u.test(text)) return text
  return text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/iu)?.[1]
}
function recordUsage(data: Record<string, unknown>, backend: AgentImageBackend, context: AgentToolContext) {
  const usage = object(data.usage)
  const counts = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']
    .filter(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
    .map(key => [key, usage[key]]))
  if (Object.keys(counts).length) context.recordUsage?.(backend.model ?? backend.name, counts)
}

/** Generation and editing use scoped binary delivery, never a model-visible image payload. */
export function createAgentImageTools(options: AgentImageToolsOptions = {}): AgentToolRegistry {
  const tools: AgentTool[] = []
  const generation = agentImageBackends(options.generation), edit = agentImageBackends(options.edit)
  const secrets = [...new Set([...generation.map(backend => backend.apiKey), ...edit.map(backend => backend.apiKey), ...(options.secrets ?? [])]
    .filter((value): value is string => typeof value === 'string' && !!value))]
  for (const [editOnly, backends] of [[false, generation], [true, edit]] as const) {
    if (!backends.length) continue
    for (const backend of backends) endpoint(backend, editOnly)
    tools.push({
      name: editOnly ? 'googleImageEditTool' : 'bananaTool',
      description: editOnly ? '按用户要求编辑图片，须提供公开 HTTP(S) 图片地址或本轮可见带图消息 sourceSeq。成功回执表示图片已发到当前会话。' :
        '按用户要求生成一张图片，可使用公开 HTTP(S) 参考图或本轮可见带图消息 sourceSeq。成功回执表示图片已发到当前会话；不要在正文重复输出图片数据。',
      timeoutMs: 240_000,
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000, description: '用户要求的图片内容或修改要求' },
        images: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 2048 }, description: '公开参考图片的 HTTP(S) 地址；编辑时须提供 images 或 sourceSeq' },
        sourceSeq: { type: 'integer', minimum: 1, description: '本轮可见的带图消息序号，读取已核验的附图或引用图；可替代公开图片地址' },
        provider: { type: 'string', maxLength: 200, description: '用户明确指定时填写配置的图片渠道名称或别名' },
        aspectRatio: { type: 'string', enum: ratios, description: '用户要求的画布比例' },
      }, required: ['prompt'], additionalProperties: false },
      async execute(input, context) {
        const prompt = input?.prompt, urls = input?.images ?? [], sourceSeq = input?.sourceSeq
        if (!input || Object.keys(input).some(key => !['prompt', 'images', 'sourceSeq', 'provider', 'aspectRatio'].includes(key)) ||
            typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || hasSecret(prompt, secrets) ||
            !Array.isArray(urls) || urls.length > 10 || editOnly && !urls.length && sourceSeq === undefined ||
            sourceSeq !== undefined && (typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 1) ||
            urls.some(url => typeof url !== 'string' || !/^https?:\/\//iu.test(url) || url.length > 2048 || hasSecret(url, secrets)) ||
            input.provider !== undefined && (typeof input.provider !== 'string' || !input.provider || input.provider.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.provider)) ||
            input.aspectRatio !== undefined && (typeof input.aspectRatio !== 'string' || !ratios.includes(input.aspectRatio))) {
          return failed('图片任务参数无效，或指定的模型未配置。')
        }
        const selected = input.provider === undefined ? undefined : backends.find(backend => backend.name === input.provider)
          ?? backends.find(backend => backend.aliases?.includes(input.provider as string))
        const candidates = input.provider === undefined ? backends : selected ? backends.filter(backend => backend.name === selected.name) : []
        if (!candidates.length) return failed('图片任务参数无效，或指定的模型未配置。')
        if (!context.sendImage) return failed('当前宿主没有可用的图片交付能力。')
        if (sourceSeq !== undefined && !context.readImages) return failed('当前宿主没有可用的消息附图读取能力。')
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(boundedAgentWebTimeout(options.timeoutMs, 240_000))])
        const scoped = { ...context, signal }, ensure = () => ensureAgentWebCurrent(scoped, signal)
        let attempted = false, response: Response | undefined
        try {
          await ensure()
          const references: { mime: string; base64: string }[] = []
          let referenceSize = 0
          const addReference = (value: { readonly mime: string; readonly base64: string }) => {
            const image = validateAgentToolImage(value), bytes = Buffer.from(image.base64, 'base64')
            if (hasSecret(bytes.toString('utf8'), secrets)) throw new Error('参考图片含凭据')
            referenceSize += bytes.length
            if (referenceSize > MAX_REFERENCE_BYTES || references.length >= 10) throw new Error('参考图片超出上限')
            references.push(image)
          }
          if (sourceSeq !== undefined) {
            await ensure()
            const images = await abortableAgentWeb(context.readImages!(sourceSeq as number), signal)
            await ensure()
            if (!Array.isArray(images) || !images.length || images.length > 10) return failed('本轮可见消息没有可编辑的附图。')
            for (const image of images) addReference(image)
          }
          for (const url of urls) {
            await ensure()
            const image = await readAgentPublicImage(url, scoped, options.publicImage)
            await ensure()
            addReference(image)
          }
          const editing = editOnly || references.length > 0
          const intent = resolveImageAspectRatioIntent('', typeof input.aspectRatio === 'string' ? input.aspectRatio : '')
          for (const backend of candidates) {
            await ensure()
            const model = backend.model ?? backend.name
            const size = resolveImageProviderSize({ model, ...(backend.size ? { size: backend.size, defaultEditSize: backend.size } : {}) }, intent, { operation: editing ? 'edit' : 'generate' })
            const protocol = backend.protocol ?? 'images'
            let withFormat = protocol === 'images' && !/^gpt-image/iu.test(model)
            const sendRequest = async () => {
              await ensure()
              const fields: Record<string, string | number> = { model, prompt: prompt.trim(), n: 1,
                ...(size ? { size } : {}), ...(backend.quality ? { quality: backend.quality } : {}),
                ...(isGrokImageModel(model) && input.aspectRatio ? { aspect_ratio: String(input.aspectRatio) } : {}),
                ...(withFormat ? { response_format: 'b64_json' } : {}),
              }
              let body: BodyInit, headers: Record<string, string> = { Authorization: `Bearer ${backend.apiKey}` }
              if (protocol === 'chat') {
                headers['Content-Type'] = 'application/json'
                body = JSON.stringify({ model, messages: [{ role: 'user', content: [
                  { type: 'text', text: `${prompt.trim()}${input.aspectRatio ? `\n画布比例：${input.aspectRatio}` : ''}` },
                  ...references.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } })),
                ] }], stream: false })
              } else if (editing) {
                const form = new FormData()
                for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
                for (const [index, image] of references.entries()) form.append('image', new Blob([new Uint8Array(Buffer.from(image.base64, 'base64'))], { type: image.mime }), `reference-${index + 1}.${image.mime.split('/')[1]}`)
                body = form
              } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(fields) }
              await ensure()
              attempted = true
              response = await abortableAgentWeb((options.fetchImpl ?? fetch)(endpoint(backend, editing), { method: 'POST', headers, body, redirect: 'error', signal }), signal)
              if (response.redirected) throw new Error('图片服务重定向')
              const result = await readResponse(response, signal, secrets)
              recordUsage(result, backend, context)
              await ensure()
              return result
            }
            let result = await sendRequest()
            if (hasSecret(JSON.stringify(result), secrets)) return unknown()
            if (withFormat && response && [400, 422].includes(response.status) && shouldRetryWithoutUrlResponseFormat(String(object(result.error).message ?? result.detail ?? ''))) {
              withFormat = false
              result = await sendRequest()
            }
            await ensure()
            if (hasSecret(JSON.stringify(result), secrets)) return unknown()
            if (!response?.ok) {
              if (response && rejectedStatuses.has(response.status)) continue
              return response && response.status >= 400 && response.status < 500 ? failed('图片服务明确拒绝了本次请求，未确认生成图片。') : unknown()
            }
            if (result.error) return unknown()
            const value = imageValue(result, protocol)
            if (!value) return unknown()
            let image: { mime: string; base64: string }
            const inline = value.match(/^data:(image\/[^;,]+);base64,([\s\S]+)$/u)
            const base64 = value.startsWith('base64://') ? value.slice(9) : inline?.[2]
            if (base64 !== undefined) {
              const mime = inline?.[1] ?? sniffImageMime(Buffer.from(base64, 'base64'))
              image = validateAgentToolImage({ mime, base64 })
            } else image = await readAgentPublicImage(value, scoped, options.publicImage)
            await ensure()
            const bytes = Buffer.from(image.base64, 'base64')
            if (hasSecret(bytes.toString('utf8'), secrets)) return unknown()
            if (isGrokImageModel(model) && input.aspectRatio) assertGrokImageRatio({ model, aspectRatio: input.aspectRatio }, readImageDimensions(bytes))
            const receipt = await abortableAgentWeb(context.sendImage(image), signal)
            await ensure()
            if (receipt.state === 'sent' && typeof receipt.messageId === 'string' && receipt.messageId.trim()) return { status: 'succeeded', content: editing ? '图片编辑完成，已确认发送到当前会话。' : '图片生成完成，已确认发送到当前会话。' }
            if (receipt.state === 'failed') return failed('图片已生成，但平台明确拒绝交付；没有确认送达，请勿重新生成来代替核查。')
            return unknown()
          }
          return failed('图片服务明确拒绝了本次请求，未确认生成图片。')
        } catch { return attempted ? unknown() : failed('图片任务在请求前停止：参考图片不可用、超时或授权已改变。') }
        finally { void response?.body?.cancel().catch(() => {}) }
      },
    })
  }
  return { builtIn: tools }
}
