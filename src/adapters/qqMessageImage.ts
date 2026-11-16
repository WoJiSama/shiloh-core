import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { MessageImage } from '../contracts/platformConnection.js'
import type { MessageResource } from '../contracts/platformMessage.js'
import { readImageDimensions } from '../modules/image/domain/imageDimensions.js'
import { sniffImageMime } from '../modules/image/infrastructure/imageResource.js'
import { isPublicAddress } from '../modules/shared/infrastructure/publicAddress.js'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_PIXELS = 16_000_000
const qqImagePaths = new Map([
  ['multimedia.nt.qq.com.cn', /^\/download\/?$/u],
  ['gchat.qpic.cn', /^(?:\/download\/?$|\/gchatpic_new\/)/u],
  ['gxh.vip.qq.com', /^\/club\/item\/parcel\/item\//u],
])

function qqImageUrl(input: string): URL | undefined {
  if (input.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(input)) return undefined
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password || url.hash ||
      !qqImagePaths.get(url.hostname)?.test(url.pathname)) return undefined
  url.protocol = 'https:'
  return url
}

async function readWhileActive<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    return await new Promise<T>((fulfill, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { signal.throwIfAborted(); return read() }).then(fulfill, reject)
    })
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

async function fetchImage(url: URL, address: LookupAddress, signal: AbortSignal): Promise<Buffer | undefined> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, family: address.family, signal,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' },
    }, resolve)
    req.once('error', reject)
    req.end()
  })
  const encoding = response.headers['content-encoding']
  if (response.statusCode !== 200 || (encoding && encoding !== 'identity') ||
      Number(response.headers['content-length']) > MAX_BYTES) {
    response.destroy()
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  const abort = () => response.destroy()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    for await (const chunk of response) {
      size += chunk.length
      if (size > MAX_BYTES) return undefined
      chunks.push(chunk)
    }
    return signal.aborted ? undefined : Buffer.concat(chunks, size)
  } finally { signal.removeEventListener('abort', abort) }
}

interface ImageReadGuard {
  signal: AbortSignal
  isCurrent(): boolean
  authorize(): Promise<boolean>
}

/** Resolve one attachment from the verified get_msg result, never from a tool argument. */
export async function readQqMessageImage(resource: MessageResource, guard: ImageReadGuard, dependencies: {
  lookup?: (host: string) => Promise<LookupAddress[]>
  request?: typeof fetchImage
} = {}): Promise<MessageImage | undefined> {
  const { signal, isCurrent, authorize } = guard
  if (signal.aborted || !isCurrent()) return undefined
  let bytes: Buffer | undefined
  if (resource.kind === 'reference') {
    const encoded = resource.value.startsWith('base64://') ? resource.value.slice(9) : undefined
    if (!encoded || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || !await readWhileActive(signal, authorize) || signal.aborted || !isCurrent()) return undefined
    bytes = Buffer.from(encoded, 'base64')
  } else {
    const url = qqImageUrl(resource.value)
    if (!url) return undefined
    const addresses = await readWhileActive(signal, () => (dependencies.lookup ?? (host => lookup(host, { all: true })))(url.hostname))
    if (!addresses.length || addresses.some(({address, family}) => isIP(address) !== family || !isPublicAddress(address))) return undefined
    const address = addresses.find(item => item.family === 4) ?? addresses[0]!
    if (!await readWhileActive(signal, authorize) || signal.aborted || !isCurrent()) return undefined
    bytes = await (dependencies.request ?? fetchImage)(url, address, signal)
  }
  if (!bytes || bytes.length > MAX_BYTES || signal.aborted || !isCurrent()) return undefined
  const dimensions = readImageDimensions(bytes)
  const mime = sniffImageMime(bytes)
  if (!dimensions || dimensions.width > 8192 || dimensions.height > 8192 ||
      dimensions.width * dimensions.height > MAX_PIXELS || mime === 'application/octet-stream') return undefined
  return { mime, base64: bytes.toString('base64') }
}
