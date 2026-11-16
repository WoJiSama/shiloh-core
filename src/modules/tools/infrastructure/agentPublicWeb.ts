import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import type { AgentFileBytes, FileReadGuard } from '../../../contracts/agentFiles.js'
import { validateAgentToolImageBytes } from '../../image/infrastructure/agentToolImage.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'

const MAX_WEB_BYTES = 2 * 1024 * 1024
const MAX_WEB_MS = 15_000
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
interface PublicReadPolicy {
  readonly maxBytes: number
  readonly accept: string
  readonly signedQuery: boolean
  readonly timeoutMs?: number
}
const WEB_POLICY: PublicReadPolicy = { maxBytes: MAX_WEB_BYTES,
  accept: 'text/html, application/xhtml+xml, text/plain, application/json', signedQuery: false }
const IMAGE_POLICY: PublicReadPolicy = { maxBytes: 20 * 1024 * 1024,
  accept: 'image/png, image/jpeg, image/webp, image/gif', signedQuery: true }

const FILE_POLICY: PublicReadPolicy = { maxBytes: 12 * 1024 * 1024, accept: 'application/octet-stream, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signedQuery: true, timeoutMs: 20_000 }
type PublicReadGuard = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>

export interface AgentPublicWebResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Uint8Array | string
}

export interface AgentPublicWebDependencies {
  lookup?(hostname: string): Promise<readonly LookupAddress[]>
  /** The implementation must connect to this validated address and honor signal. */
  request?(url: URL, address: LookupAddress, signal: AbortSignal): Promise<AgentPublicWebResponse>
  /** May shorten the fixed deadline, never increase it. */
  readonly timeoutMs?: number
}

export interface AgentPublicWebContent {
  readonly url: string
  readonly title: string
  readonly text: string
}

export function assertAgentWebCurrent(context: PublicReadGuard, signal = context.signal): void {
  signal.throwIfAborted()
  context.signal.throwIfAborted()
  if (!context.isCurrent()) throw new Error('工具授权已失效')
}

export async function ensureAgentWebCurrent(context: PublicReadGuard, signal = context.signal): Promise<void> {
  assertAgentWebCurrent(context, signal)
  const ensureCurrent = context.ensureCurrent
  if (ensureCurrent) await abortableAgentWeb(Promise.resolve().then(() => {
    assertAgentWebCurrent(context, signal)
    return ensureCurrent.call(context)
  }), signal)
  assertAgentWebCurrent(context, signal)
}

/** Bound even injected transports that fail to settle when their signal aborts. */
export async function abortableAgentWeb<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('工具请求已取消或超时'))
    // Observe even an already-started operation when cancellation preceded entry.
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function boundedAgentWebTimeout(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum
}

function normalizeAgentPublicUrl(input: string, signedQuery: boolean): URL {
  if (!input || input !== input.trim() || input.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(input)) throw new Error('网页地址格式错误')
  const url = new URL(input)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      (!host.includes('.') && !isIP(host)) || (isIP(host) && !isPublicAddress(host))) throw new Error('只允许无凭据的公共网页地址')
  for (const key of signedQuery ? [] : url.searchParams.keys()) {
    if (/token|secret|passw(?:or)?d|auth|api.?key|signature|credential|cookie|session|rkey/iu.test(key)) throw new Error('网页地址不接受凭据参数')
  }
  url.hash = ''
  return url
}

export function normalizeAgentPublicWebUrl(input: string): URL {
  return normalizeAgentPublicUrl(input, false)
}

function nativePublicWebRequest(url: URL, address: LookupAddress, signal: AbortSignal, policy: PublicReadPolicy): Promise<AgentPublicWebResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, family: address.family, signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: policy.accept, 'Accept-Encoding': 'identity', 'User-Agent': 'BL-Agent-Public-Web/1.0' },
    }, response => {
      const headers = {
        'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
        'content-encoding': response.headers['content-encoding'], location: response.headers.location,
      }
      const status = response.statusCode ?? 0
      // Redirect and error bodies are unnecessary and may be unbounded streams.
      if (status < 200 || status >= 300) {
        response.destroy()
        resolve({ status, headers, body: '' })
        return
      }
      if ((headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') ||
          Number(headers['content-length']) > policy.maxBytes) {
        response.destroy()
        reject(new Error('网页响应格式或大小不受支持'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > policy.maxBytes) { response.destroy(new Error('网页响应过大')); return }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({ status, headers, body: Buffer.concat(chunks, size) }))
    })
    request.once('error', reject)
    request.end()
  })
}

const htmlEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  middot: '·', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  ensp: ' ', emsp: ' ', thinsp: ' ', bull: '•', laquo: '«', raquo: '»',
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (original, entity: string) => {
    if (!entity.startsWith('#')) return htmlEntities[entity] ?? original
    const code = Number.parseInt(entity.slice(/^#x/iu.test(entity) ? 2 : 1), /^#x/iu.test(entity) ? 16 : 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
  })
}

function plainText(input: string): string {
  return decodeHtmlEntities(input).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')
    .replace(/[ \t\r]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Inert static extraction only: no DOM, JavaScript, screenshots or subresource requests. */
export function extractAgentHtmlText(html: string): { title: string; text: string } {
  // Scan once rather than retrying an unclosed tag regex at every '<'. Attribute
  // quotes and raw-text elements are skipped without invoking a browser/parser.
  const lower = html.replace(/[A-Z]/gu, char => char.toLowerCase())
  const skipped = new Set(['script', 'style', 'noscript', 'template', 'svg'])
  const blocks = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'section', 'main', 'li', 'tr', 'blockquote', 'pre'])
  const text: string[] = [], title: string[] = []
  let cursor = 0, inHead = false, sawBody = false, rawTag = ''
  while (cursor < html.length) {
    if (rawTag) {
      let end = lower.indexOf(`</${rawTag}`, cursor)
      while (end >= 0 && !/[\s>]/u.test(html[end + rawTag.length + 2] ?? '')) end = lower.indexOf(`</${rawTag}`, end + rawTag.length + 2)
      if (rawTag === 'title') title.push(html.slice(cursor, end < 0 ? html.length : end))
      if (end < 0) break
      cursor = end
      rawTag = ''
    }
    const opening = html.indexOf('<', cursor)
    if (!inHead) text.push(html.slice(cursor, opening < 0 ? html.length : opening))
    if (opening < 0) break
    if (html.startsWith('<!--', opening)) {
      const end = html.indexOf('-->', opening + 4)
      cursor = end < 0 ? html.length : end + 3
      continue
    }
    let end = opening + 1, quote = ''
    for (; end < html.length; end++) {
      const char = html[end]!
      if (quote) { if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") quote = char
      else if (char === '>' || char === '<') break
    }
    if (end >= html.length) break
    if (html[end] === '<') { cursor = end; continue }
    const token = lower.slice(opening, end + 1)
    const name = token.match(/^<\/?([a-z][a-z\d:-]*)(?=[\s/>])/u)?.[1]
    const closing = token.startsWith('</')
    cursor = end + 1
    if (!name) continue
    if (name === 'head') inHead = !closing
    if (name === 'body' && !closing && !sawBody) { sawBody = true; inHead = false; text.length = 0 }
    if (!closing && (skipped.has(name) || name === 'title')) rawTag = name
    if (!inHead && blocks.has(name)) text.push('\n')
  }
  return { title: plainText(title.join('')), text: plainText(text.join('')) }
}

async function readAgentPublicResponse(input: string, context: PublicReadGuard, dependencies: AgentPublicWebDependencies, policy: PublicReadPolicy) {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(boundedAgentWebTimeout(dependencies.timeoutMs, policy.timeoutMs ?? MAX_WEB_MS))])
  const lookup = dependencies.lookup ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true }))
  const request = dependencies.request ?? ((url, address, signal) => nativePublicWebRequest(url, address, signal, policy))
  assertAgentWebCurrent(context, signal)
  let url = normalizeAgentPublicUrl(input, policy.signedQuery)
  for (let redirects = 0; redirects <= 3; redirects++) {
    await ensureAgentWebCurrent(context, signal)
    const hostname = url.hostname.replace(/^\[|\]$/gu, '')
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortableAgentWeb(lookup(hostname), signal)
    if (!addresses.length || addresses.some(address => isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw new Error('网页 DNS 含非公共地址')
    await ensureAgentWebCurrent(context, signal)
    const response = await abortableAgentWeb(request(url, addresses[0]!, signal), signal)
    await ensureAgentWebCurrent(context, signal)
    if (response.status >= 300 && response.status < 400) {
      if (redirects === 3 || !response.headers.location) throw new Error('网页重定向过多或无目标')
      url = normalizeAgentPublicUrl(new URL(response.headers.location, url).href, policy.signedQuery)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error('网页服务未返回成功结果')
    if (response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw new Error('网页不接受压缩响应')
    if (Number(response.headers['content-length']) > policy.maxBytes ||
        (typeof response.body === 'string' ? Buffer.byteLength(response.body) : response.body.byteLength) > policy.maxBytes) throw new Error('网页响应过大')
    return { url, response, signal }
  }
  throw new Error('网页重定向过多')
}

export async function readAgentPublicWeb(input: string, context: AgentToolContext, dependencies: AgentPublicWebDependencies = {}): Promise<AgentPublicWebContent> {
  const { url, response, signal } = await readAgentPublicResponse(input, context, dependencies, WEB_POLICY)
  const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (!TEXT_TYPES.has(type)) throw new Error('网页响应不是支持的文本')
  const charset = response.headers['content-type']?.match(/charset\s*=\s*["']?([\w-]+)/iu)?.[1] ?? 'utf-8'
  const body = typeof response.body === 'string' ? response.body : new TextDecoder(charset).decode(response.body)
  const content = type === 'text/html' || type === 'application/xhtml+xml' ? extractAgentHtmlText(body) : { title: '', text: plainText(body) }
  await ensureAgentWebCurrent(context, signal)
  if (!content.text) throw new Error('未找到静态网页正文')
  return { url: url.href, ...content }
}

/** Provider-result images may use signed CDN queries; no host credentials or URL are returned. */
export async function readAgentPublicImage(input: string, context: AgentToolContext, dependencies: AgentPublicWebDependencies = {}): Promise<{ readonly mime: string; readonly base64: string }> {
  try {
    const { response, signal } = await readAgentPublicResponse(input, context, dependencies, IMAGE_POLICY)
    if (!(response.body instanceof Uint8Array)) throw new Error('图片响应不是二进制数据')
    const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (type && type !== 'application/octet-stream' && !IMAGE_TYPES.has(type)) throw new Error('图片响应类型不受支持')
    const image = validateAgentToolImageBytes(response.body, IMAGE_TYPES.has(type) ? type : undefined)
    await ensureAgentWebCurrent(context, signal)
    return image
  } catch {
    throw new Error('公共图片读取失败：地址、授权或图片响应无效')
  }
}

/** Only the Core resolver may call this after matching the verified human request. */
export async function readAgentPublicFile(input: string, context: FileReadGuard, dependencies: AgentPublicWebDependencies = {}): Promise<AgentFileBytes> {
  try {
    const { url, response, signal } = await readAgentPublicResponse(input, context, dependencies, FILE_POLICY)
    if (!(response.body instanceof Uint8Array) || !response.body.byteLength) throw new Error('文件响应不是二进制数据')
    const safeName = (address: URL) => {
      try {
        const value = decodeURIComponent(address.pathname.split('/').pop() || '')
        return value && value.length <= 255 && !/[\u0000-\u001f\u007f/\\]/u.test(value) ? value : undefined
      } catch { return undefined }
    }
    const original = safeName(new URL(input)), final = safeName(url)
    // The verified user URL owns the display filename even when a CDN redirects to /download.
    const name = original && /\.[a-z0-9]{1,10}$/iu.test(original) ? original : final || original || 'workbook.xlsx'
    const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    const mime = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(type) && type.length <= 128 ? type : 'application/octet-stream'
    await ensureAgentWebCurrent(context, signal)
    return { name, mime, base64: Buffer.from(response.body).toString('base64'), origin: 'explicit' }
  } catch { throw new Error('公共文件读取失败：地址、授权或响应无效') }
}
