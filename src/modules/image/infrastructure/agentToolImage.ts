import { readImageDimensions } from '../domain/imageDimensions.js'
import { sniffImageMime } from './imageResource.js'
import type { MessageImage } from '../../../contracts/platformConnection.js'

const MAX_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 64 * 1024 * 1024
const MAX_SIDE = 16_384
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const invalid = () => new Error('图片数据无效或超过大小、尺寸上限')

/** One byte boundary for generated images, downloaded results and scoped delivery. */
export function validateAgentToolImageBytes(bytes: Uint8Array, expectedMime?: string): MessageImage {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw invalid()
  const buffer = Buffer.from(bytes)
  const mime = sniffImageMime(buffer)
  const dimensions = readImageDimensions(buffer)
  if (!MIMES.has(mime) || expectedMime !== undefined && expectedMime !== mime || !dimensions ||
      dimensions.width > MAX_SIDE || dimensions.height > MAX_SIDE || dimensions.width * dimensions.height > MAX_PIXELS) throw invalid()
  return { mime, base64: buffer.toString('base64') }
}

/** Accept only canonical inline bytes, never URLs, paths or permissive base64 decoding. */
export function validateAgentToolImage(image: MessageImage): MessageImage {
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw invalid()
  const presentation = image.presentation
  if (Object.keys(image).some(key => !['mime', 'base64', 'presentation'].includes(key)) || !MIMES.has(image.mime) ||
      presentation !== undefined && presentation !== 'sticker' ||
      typeof image.base64 !== 'string' || !image.base64 || image.base64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.base64)) throw invalid()
  const buffer = Buffer.from(image.base64, 'base64')
  if (buffer.toString('base64') !== image.base64) throw invalid()
  return { ...validateAgentToolImageBytes(buffer, image.mime), ...(presentation === undefined ? {} : { presentation }) }
}
