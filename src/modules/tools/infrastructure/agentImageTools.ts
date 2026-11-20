import type { AgentTool, AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import type { MessageImage } from '../../../contracts/platformConnection.js'
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
const failed = (content: string) => ({ status: 'failed' as const, content })
const unknown = () => ({ status: 'unknown' as const, content: '图片任务结果尚未确认，请核实后再提交；没有确认图片送达。' })
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
function recordUsage(data: Record<string, unknown>, backend: AgentImageBackend, context: ImageRequestGuard) {
  const usage = object(data.usage)
  const counts = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']
    .filter(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
    .map(key => [key, usage[key]]))
  if (Object.keys(counts).length) context.recordUsage?.(backend.model ?? backend.name, counts)
}

type ImageRequestGuard = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent' | 'recordUsage'>
type ImageOperation = 'generate' | 'edit'

interface ImageRequest {
  readonly prompt: string
  readonly provider?: string
  readonly aspectRatio?: string
  readonly size?: string
  readonly quality?: string
  readonly count?: number
  readonly references?: (context: ImageRequestGuard, add: (image: MessageImage) => void) => Promise<void>
}

type ImageResult = ReturnType<typeof failed> | ReturnType<typeof unknown> | {
  readonly status: 'succeeded'
  readonly images: readonly MessageImage[]
  readonly provider: string
  readonly edited: boolean
}

function providerLabels(backends: readonly AgentImageBackend[]) {
  return backends.map((backend, index) => ({
    label: backend.name,
    model: backend.model ?? backend.name,
    host: new URL(backend.baseUrl).host,
    size: backend.size ?? '(渠道默认)',
    priority: index + 1,
  }))
}

function imageResults(result: Record<string, unknown>, protocol: 'images' | 'chat', count: number): string[] {
  if (count === 1) {
    const image = imageValue(result, protocol)
    return image ? [image] : []
  }
  if (protocol === 'images' && Array.isArray(result.data)) {
    return result.data.slice(0, count).flatMap(value => {
      const image = imageValue({ data: [value] }, protocol)
      return image ? [image] : []
    })
  }
  const message = object(object(first(result.choices)).message)
  if (message.tool_calls || message.function_call) return []
  if (Array.isArray(message.images) && message.images.length) {
    return message.images.slice(0, count).flatMap(value => {
      const image = object(value)
      const url = object(image.image_url).url ?? image.url
      return typeof url === 'string' ? [url] : []
    })
  }
  const image = imageValue(result, protocol)
  return image ? [image] : []
}

/** Executes the same configured providers for QQ tools and the web console. Delivery belongs to the caller. */
export function createAgentImageRunner(options: AgentImageToolsOptions = {}) {
  const generation = agentImageBackends(options.generation)
  const edit = agentImageBackends(options.edit)
  const secrets = [...new Set([...generation.map(backend => backend.apiKey), ...edit.map(backend => backend.apiKey), ...(options.secrets ?? [])]
    .filter((value): value is string => typeof value === 'string' && !!value))]
  const containsSecret = (value: string) => hasSecret(value, secrets)
  for (const backend of edit) endpoint(backend, true)

  async function run(operation: ImageOperation, request: ImageRequest, context: ImageRequestGuard): Promise<ImageResult> {
    const { prompt, provider, aspectRatio, size: requestedSize, quality, count = 1 } = request
    const backends = operation === 'edit' ? edit : generation
    const selected = provider === undefined ? undefined : backends.find(backend => backend.name === provider)
      ?? backends.find(backend => backend.aliases?.includes(provider))
    const candidates = provider === undefined ? backends : selected ? backends.filter(backend => backend.name === selected.name) : []
    if (!candidates.length || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || containsSecret(prompt) ||
      aspectRatio !== undefined && !ratios.includes(aspectRatio) ||
      quality !== undefined && !['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(quality) ||
      !Number.isSafeInteger(count) || count < 1 || count > 4) return failed('图片任务参数无效，或指定的模型未配置。')
    if (requestedSize !== undefined) {
      const dimensions = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/u.exec(requestedSize)
      if (!dimensions || Number(dimensions[1]) > 16_384 || Number(dimensions[2]) > 16_384 ||
        Number(dimensions[1]) * Number(dimensions[2]) > 64 * 1024 * 1024) return failed('图片画布尺寸无效。')
    }

    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(boundedAgentWebTimeout(options.timeoutMs, 240_000))])
    const scoped = { signal, isCurrent: () => context.isCurrent(), ensureCurrent: async () => { await context.ensureCurrent?.() } }
    const ensure = () => ensureAgentWebCurrent(scoped, signal)
    let attempted = false
    let response: Response | undefined
    try {
      await ensure()
      const references: MessageImage[] = []
      let referenceSize = 0
      const addReference = (value: MessageImage) => {
        const reference = validateAgentToolImage(value)
        const bytes = Buffer.from(reference.base64, 'base64')
        referenceSize += bytes.length
        if (referenceSize > MAX_REFERENCE_BYTES || references.length >= 10 || containsSecret(bytes.toString('utf8'))) {
          throw new Error('参考图片无效或超出上限')
        }
        references.push(reference)
      }
      if (request.references) await abortableAgentWeb(request.references(scoped, addReference), signal)
      if (operation === 'edit' && !references.length) return failed('图片编辑需要至少一张可用参考图。')
      const edited = operation === 'edit' || references.length > 0
      const intent = resolveImageAspectRatioIntent('', aspectRatio)
      const unsupported = '图片服务明确拒绝了本次请求，未确认生成图片。'
      for (const backend of candidates) {
        await ensure()
        const model = backend.model ?? backend.name
        const size = requestedSize || resolveImageProviderSize({
          model, ...(backend.size ? { size: backend.size, defaultEditSize: backend.size } : {}),
        }, intent, { operation: edited ? 'edit' : 'generate' })
        const protocol = backend.protocol ?? 'images'
        let withFormat = protocol === 'images' && !/^gpt-image/iu.test(model)
        const sendRequest = async () => {
          await ensure()
          const fields: Record<string, string | number> = {
            model, prompt: prompt.trim(), n: count,
            ...(size ? { size } : {}),
            ...(quality || backend.quality ? { quality: quality || backend.quality! } : {}),
            ...(isGrokImageModel(model) && aspectRatio ? { aspect_ratio: aspectRatio } : {}),
            ...(withFormat ? { response_format: 'b64_json' } : {}),
          }
          const headers: Record<string, string> = { Authorization: 'Bearer ' + backend.apiKey }
          let body: BodyInit
          if (protocol === 'chat') {
            headers['Content-Type'] = 'application/json'
            const instructions = [prompt.trim(), ...(aspectRatio ? ['画布比例：' + aspectRatio] : []),
              ...(requestedSize ? ['图像尺寸：' + requestedSize] : []), ...(count > 1 ? ['图片数量：' + count] : [])]
            body = JSON.stringify({ model, messages: [{ role: 'user', content: [
              { type: 'text', text: instructions.join('\n') },
              ...references.map(image => ({ type: 'image_url', image_url: { url: 'data:' + image.mime + ';base64,' + image.base64 } })),
            ] }], stream: false })
          } else if (edited) {
            const form = new FormData()
            for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
            for (const [index, image] of references.entries()) form.append('image',
              new Blob([new Uint8Array(Buffer.from(image.base64, 'base64'))], { type: image.mime }),
              'reference-' + (index + 1) + '.' + image.mime.split('/')[1])
            body = form
          } else {
            headers['Content-Type'] = 'application/json'
            body = JSON.stringify(fields)
          }
          await ensure()
          attempted = true
          response = await abortableAgentWeb((options.fetchImpl ?? fetch)(endpoint(backend, edited), {
            method: 'POST', headers, body, redirect: 'error', signal,
          }), signal)
          if (response.redirected) throw new Error('图片服务重定向')
          const result = await readResponse(response, signal, secrets)
          recordUsage(result, backend, context)
          await ensure()
          return result
        }
        let result = await sendRequest()
        if (containsSecret(JSON.stringify(result))) return unknown()
        if (withFormat && response && [400, 422].includes(response.status) &&
          shouldRetryWithoutUrlResponseFormat(String(object(result.error).message ?? result.detail ?? ''))) {
          withFormat = false
          result = await sendRequest()
        }
        await ensure()
        if (containsSecret(JSON.stringify(result))) return unknown()
        if (!response?.ok) {
          if (response && rejectedStatuses.has(response.status)) continue
          return response && response.status >= 400 && response.status < 500 ? failed(unsupported) : unknown()
        }
        if (result.error) return unknown()

        const images: MessageImage[] = []
        for (const value of imageResults(result, protocol, count)) {
          const inline = value.match(/^data:(image\/[^;,]+);base64,([\s\S]+)$/u)
          const base64 = value.startsWith('base64://') ? value.slice(9) : inline?.[2]
          const image = base64 === undefined ? await readAgentPublicImage(value, scoped, options.publicImage)
            : validateAgentToolImage({ mime: inline?.[1] ?? sniffImageMime(Buffer.from(base64, 'base64')), base64 })
          await ensure()
          const bytes = Buffer.from(image.base64, 'base64')
          if (containsSecret(bytes.toString('utf8'))) return unknown()
          if (isGrokImageModel(model) && aspectRatio) assertGrokImageRatio({ model, aspectRatio }, readImageDimensions(bytes))
          images.push(image)
        }
        if (!images.length) return unknown()
        return { status: 'succeeded', images, provider: backend.name, edited }
      }
      return failed(unsupported)
    } catch {
      return attempted ? unknown() : failed('图片任务在请求前停止：参考图片不可用、超时或授权已改变。')
    } finally {
      void response?.body?.cancel().catch(() => {})
    }
  }
  return { list: { generation: providerLabels(generation), edit: providerLabels(edit) }, containsSecret, run }
}

/** Generation and editing use scoped binary delivery, never a model-visible image payload. */
export function createAgentImageTools(options: AgentImageToolsOptions = {}): AgentToolRegistry {
  const runner = createAgentImageRunner(options)
  const tools: AgentTool[] = []
  for (const [editOnly, backends] of [[false, runner.list.generation], [true, runner.list.edit]] as const) {
    if (!backends.length) continue
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
        provider: { type: 'string', maxLength: 200, description: '用户明确指定时填写配置的图片渠道名称或别名' },
        aspectRatio: { type: 'string', enum: ratios, description: '用户要求的画布比例' },
      }, required: ['prompt'], additionalProperties: false },
      async execute(input, context): Promise<AgentToolResult> {
        const prompt = input?.prompt, urls = input?.images ?? [], sourceSeq = input?.sourceSeq
        if (!input || Object.keys(input).some(key => !['prompt', 'images', 'sourceSeq', 'provider', 'aspectRatio'].includes(key)) ||
            typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || runner.containsSecret(prompt) ||
            !Array.isArray(urls) || urls.length > 10 || editOnly && !urls.length && sourceSeq === undefined ||
            sourceSeq !== undefined && (typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 1) ||
            urls.some(url => typeof url !== 'string' || !/^https?:\/\//iu.test(url) || url.length > 2048 || runner.containsSecret(url)) ||
            input.provider !== undefined && (typeof input.provider !== 'string' || !input.provider || input.provider.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.provider)) ||
            input.aspectRatio !== undefined && (typeof input.aspectRatio !== 'string' || !ratios.includes(input.aspectRatio))) {
          return failed('图片任务参数无效，或指定的模型未配置。')
        }
        if (!context.sendImage) return failed('当前宿主没有可用的图片交付能力。')
        if (sourceSeq !== undefined && !context.readImages) return failed('当前宿主没有可用的消息附图读取能力。')
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(boundedAgentWebTimeout(options.timeoutMs, 240_000))])
        const scoped = { ...context, signal }
        let missingSourceImages = false
        const result = await runner.run(editOnly ? 'edit' : 'generate', {
          prompt,
          ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
          ...(typeof input.aspectRatio === 'string' ? { aspectRatio: input.aspectRatio } : {}),
          async references(guard, add) {
            if (sourceSeq !== undefined) {
              await ensureAgentWebCurrent(guard)
              const source = await abortableAgentWeb(context.readImages!(sourceSeq as number), guard.signal)
              await ensureAgentWebCurrent(guard)
              if (!Array.isArray(source) || !source.length || source.length > 10) {
                missingSourceImages = true
                throw new Error('本轮可见消息没有可编辑的附图')
              }
              for (const image of source) add(image)
            }
            for (const url of urls) add(await readAgentPublicImage(url, guard, options.publicImage))
          },
        }, scoped)
        if (missingSourceImages) return failed('本轮可见消息没有可编辑的附图。')
        if (result.status !== 'succeeded') return result
        try {
          await ensureAgentWebCurrent(scoped)
          const receipt = await abortableAgentWeb(context.sendImage(result.images[0]!), scoped.signal)
          await ensureAgentWebCurrent(scoped)
          if (receipt.state === 'sent' && typeof receipt.messageId === 'string' && receipt.messageId.trim()) {
            return { status: 'succeeded', content: result.edited ? '图片编辑完成，已确认发送到当前会话。' : '图片生成完成，已确认发送到当前会话。' }
          }
          if (receipt.state === 'failed') return failed('图片已生成，但平台明确拒绝交付；没有确认送达，请勿重新生成来代替核查。')
        } catch { return unknown() }
        return unknown()
      },
    })
  }
  return { builtIn: tools }
}
