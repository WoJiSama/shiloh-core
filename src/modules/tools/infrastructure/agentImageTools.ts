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
  readonly apiKey: string
  readonly protocol?: 'images' | 'chat'
  readonly size?: string
  readonly quality?: string
}
export interface AgentImageToolsOptions {
  readonly generation?: AgentImageBackend
  readonly edit?: AgentImageBackend
  readonly secrets?: readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly publicImage?: AgentPublicWebDependencies
  /** May shorten the four minute operation deadline, never increase it. */
  readonly timeoutMs?: number
}

const MAX_RESPONSE = 32 * 1024 * 1024
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const failed = (content: string): AgentToolResult => ({ status: 'failed', content })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '图片任务结果尚未确认，请核实后再提交；没有确认图片送达。' })
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const first = (value: unknown) => Array.isArray(value) ? value[0] : undefined
function hasSecret(value: string, secrets: readonly string[]): boolean {
  const decoded = value.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return secrets.some(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
    .some(part => value.includes(part) || decoded.includes(part)))
}
function endpoint(backend: AgentImageBackend, edit: boolean): string {
  const url = new URL(backend.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !backend.apiKey.trim() || !backend.name.trim() || backend.name.length > 200 ||
      backend.protocol !== undefined && !['images', 'chat'].includes(backend.protocol) ||
      backend.size !== undefined && (typeof backend.size !== 'string' || !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4}|[1248]k)$/iu.test(backend.size)) ||
      backend.quality !== undefined && !['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(backend.quality)) throw new Error('图片服务配置无效')
  if (backend.size?.toLowerCase().includes('x')) {
    const [width, height] = backend.size.toLowerCase().split('x').map(Number)
    if (width! > 16_384 || height! > 16_384 || width! * height! > 64 * 1024 * 1024) throw new Error('图片服务画布超过上限')
  }
  return backend.protocol === 'chat' ? resolveChatCompletionUrl(url.href) : edit ? toImageEditUrl(url.href) : toImageGenerationUrl(url.href)
}
async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('图片响应无效')
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
    return object(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
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
  if (Object.keys(counts).length) context.recordUsage?.(backend.name, counts)
}

/** Generation and editing use scoped binary delivery, never a model-visible image payload. */
export function createAgentImageTools(options: AgentImageToolsOptions = {}): AgentToolRegistry {
  const tools: AgentTool[] = []
  const secrets = [...new Set([options.generation?.apiKey, options.edit?.apiKey, ...(options.secrets ?? [])]
    .filter((value): value is string => typeof value === 'string' && !!value))]
  for (const [editOnly, backend] of [[false, options.generation], [true, options.edit]] as const) {
    if (!backend) continue
    endpoint(backend, editOnly)
    tools.push({
      name: editOnly ? 'googleImageEditTool' : 'bananaTool',
      effect: input => ({ required: input.sourceSeq === undefined ? ['sendImage'] : ['sendImage', 'readImages'] }),
      description: editOnly ? '按用户要求编辑图片，须提供公开 HTTP(S) 图片地址或本轮可见带图消息 sourceSeq。成功回执表示图片已发到当前会话。' :
        '按用户要求生成一张图片，可使用公开 HTTP(S) 参考图或本轮可见带图消息 sourceSeq。成功回执表示图片已发到当前会话；不要在正文重复输出图片数据。',
      timeoutMs: 240_000,
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000, description: '用户要求的图片内容或修改要求' },
        images: { type: ['array', 'null'], maxItems: 10, items: { type: 'string', maxLength: 2048 }, description: '公开参考图片的 HTTP(S) 地址；编辑时须提供 images 或 sourceSeq' },
        sourceSeq: { type: 'integer', minimum: 1, description: '本轮可见的带图消息序号，读取已核验的附图或引用图；可替代公开图片地址' },
        provider: { type: 'string', maxLength: 200, description: '用户明确指定时填写配置的图片模型名称' },
        aspectRatio: { type: 'string', enum: ratios, description: '用户要求的画布比例' },
      }, required: ['prompt'], additionalProperties: false },
      async execute(input, context) {
        const prompt = input?.prompt, urls = input?.images ?? [], sourceSeq = input?.sourceSeq
        if (!input || Object.keys(input).some(key => !['prompt', 'images', 'sourceSeq', 'provider', 'aspectRatio'].includes(key)) ||
            typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || hasSecret(prompt, secrets) ||
            !Array.isArray(urls) || urls.length > 10 || editOnly && !urls.length && sourceSeq === undefined ||
            sourceSeq !== undefined && (typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 1) ||
            urls.some(url => typeof url !== 'string' || !/^https?:\/\//iu.test(url) || url.length > 2048 || hasSecret(url, secrets)) ||
            input.provider !== undefined && input.provider !== backend.name ||
            input.aspectRatio !== undefined && (typeof input.aspectRatio !== 'string' || !ratios.includes(input.aspectRatio))) {
          return failed('图片任务参数无效，或指定的模型未配置。')
        }
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
          const size = resolveImageProviderSize({ model: backend.name, ...(backend.size ? { size: backend.size, defaultEditSize: backend.size } : {}) }, intent, { operation: editing ? 'edit' : 'generate' })
          const protocol = backend.protocol ?? 'images'
          let withFormat = protocol === 'images' && !/^gpt-image/iu.test(backend.name)
          const sendRequest = async () => {
            await ensure()
            const fields: Record<string, string | number> = { model: backend.name, prompt: prompt.trim(), n: 1,
              ...(size ? { size } : {}), ...(backend.quality ? { quality: backend.quality } : {}),
              ...(isGrokImageModel(backend.name) && input.aspectRatio ? { aspect_ratio: String(input.aspectRatio) } : {}),
              ...(withFormat ? { response_format: 'b64_json' } : {}),
            }
            let body: BodyInit, headers: Record<string, string> = { Authorization: `Bearer ${backend.apiKey}` }
            if (protocol === 'chat') {
              headers['Content-Type'] = 'application/json'
              body = JSON.stringify({ model: backend.name, messages: [{ role: 'user', content: [
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
            const result = await readResponse(response, signal)
            recordUsage(result, backend, context)
            await ensure()
            return result
          }
          let result = await sendRequest()
          if (withFormat && response && [400, 422].includes(response.status) && shouldRetryWithoutUrlResponseFormat(String(object(result.error).message ?? result.detail ?? ''))) {
            withFormat = false
            result = await sendRequest()
          }
          await ensure()
          if (!response?.ok) return response && response.status >= 400 && response.status < 500 ? failed('图片服务明确拒绝了本次请求，未确认生成图片。') : unknown()
          if (result.error || hasSecret(JSON.stringify(result), secrets)) return unknown()
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
          if (isGrokImageModel(backend.name) && input.aspectRatio) assertGrokImageRatio({ model: backend.name, aspectRatio: input.aspectRatio }, readImageDimensions(bytes))
          const receipt = await abortableAgentWeb(context.sendImage(image), signal)
          await ensure()
          if (receipt.state === 'sent' && typeof receipt.messageId === 'string' && receipt.messageId.trim()) return { status: 'succeeded', content: editing ? '图片编辑完成，已确认发送到当前会话。' : '图片生成完成，已确认发送到当前会话。' }
          if (receipt.state === 'failed') return failed('图片已生成，但平台明确拒绝交付；没有确认送达，请勿重新生成来代替核查。')
          return unknown()
        } catch { return attempted ? unknown() : failed('图片任务在请求前停止：参考图片不可用、超时或授权已改变。') }
        finally { void response?.body?.cancel().catch(() => {}) }
      },
    })
  }
  return { builtIn: tools }
}
