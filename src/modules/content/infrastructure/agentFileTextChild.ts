import { readFile, access, constants } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validateFileTextZip } from './agentFileTextZip.js'
import { AgentFileTextError, MAX_FILE_TEXT_BYTES, MAX_FILE_TEXT_CHARS, nativeFormats, pagination } from './agentFileTextTypes.js'
import type { FileTextNativeFormat } from './agentFileTextTypes.js'
import { sanitizeUnicodeText } from '../../models/domain/unicodeText.js'
import { stripFileTextHtmlDoctype } from './agentFileTextMarkup.js'
import { extractFileTextPptx } from './agentFileTextPptx.js'

const requireFromHere = createRequire(import.meta.url)
type Extractor = { extract(file: string, options: Record<string, unknown>, done: (error: unknown, text?: string) => void): void }
const mimeTypes = requireFromHere('mime-types') as { lookup(name: string): string | false }
const plainExtensions = new Set('txt text csv tsv json jsonl ndjson yaml yml toml ini cfg conf log py js mjs cjs jsx ts tsx sh bash zsh fish ps1 java c cpp h hpp cs go rs rb php sql r lua swift kt kts vue svelte css scss less tex rst adoc graphql gql proto env gitignore'.split(' '))
const officeMimes: Record<string, string> = {
  'application/pdf': 'pdf', 'application/msword': 'doc', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.template': 'pptx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xls',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': 'xls', 'application/vnd.ms-excel.sheet.macroenabled.12': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'xls', 'application/vnd.oasis.opendocument.spreadsheet-template': 'xls',
  'application/epub+zip': 'epub', 'text/html': 'html', 'application/xhtml+xml': 'html', 'text/xml': 'html',
  'application/xml': 'html', 'application/rss+xml': 'html', 'application/atom+xml': 'html', 'text/markdown': 'md', 'text/x-markdown': 'md',
}
for (const type of ['text', 'text-template', 'graphics', 'graphics-template', 'presentation', 'presentation-template']) officeMimes[`application/vnd.oasis.opendocument.${type}`] = 'odf'
for (const type of ['image/png', 'image/jpeg', 'image/gif']) officeMimes[type] = 'ocr'
for (const type of ['application/dxf', 'application/x-autocad', 'application/x-dxf', 'drawing/x-dxf', 'image/vnd.dxf', 'image/x-autocad', 'image/x-dxf', 'zz-application/zz-winassoc-dxf']) officeMimes[type] = 'dxf'
function looksText(bytes: Uint8Array) {
  if (!bytes.length) return true
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff) return true
  let controls = 0
  for (const byte of bytes) { if (byte === 0) return false; if (byte < 32 && ![9, 10, 12, 13].includes(byte)) controls++ }
  return controls / bytes.length < 0.005
}
async function extractUsing(extractor: Extractor, options: Record<string, unknown> = {}): Promise<string> {
  return await new Promise((resolve, reject) => extractor.extract(path.join(process.cwd(), 'input'), { preserveLineBreaks: true, ...options }, (error, text) => error || typeof text !== 'string' ? reject(new AgentFileTextError()) : resolve(text)))
}
async function decodeText(bytes: Uint8Array): Promise<string> {
  if (!looksText(bytes)) throw new AgentFileTextError('unsupported')
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { return await extractUsing(requireFromHere('textract/lib/extractors/text.js') as Extractor) }
}
async function requireNative(kind: FileTextNativeFormat, enabled: readonly FileTextNativeFormat[]) {
  if (!enabled.includes(kind)) throw new AgentFileTextError('native_disabled')
  const binary = kind === 'doc' ? process.platform === 'darwin' ? 'textutil' : 'antiword' : kind === 'rtf' ? process.platform === 'darwin' ? 'textutil' : 'unrtf' : kind === 'ocr' ? 'tesseract' : 'drawingtotext'
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    try { await access(path.join(folder, binary), constants.X_OK); return } catch { /* Fixed system search path only. */ }
  }
  throw new AgentFileTextError('native_unavailable')
}
async function extract(bytes: Uint8Array, source: { name: string; mime: string }, enabled: readonly FileTextNativeFormat[], zipBudget: Record<string, number>): Promise<string> {
  const extension = source.name.split('.').at(-1)?.toLowerCase() ?? ''
  const guessed = mimeTypes.lookup(source.name)
  const mime = (guessed || source.mime).toLowerCase()
  const kind = officeMimes[mime]
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b
  if (zipped) await validateFileTextZip(bytes, zipBudget)
  if (kind === 'pdf') {
    // PDF.js 1.x ignores byteOffset in substreams; never pass a pooled Buffer.
    const pdf = requireFromHere('pdf-parse') as (input: Uint8Array) => Promise<{ text: string }>
    return (await pdf(Uint8Array.from(bytes))).text
  }
  if (kind === 'docx') return await extractUsing(requireFromHere('textract/lib/extractors/docx.js') as Extractor)
  if (kind === 'pptx') return await extractFileTextPptx(bytes, zipBudget)
  if (kind === 'xls') return await extractUsing(requireFromHere('textract/lib/extractors/xls.js') as Extractor)
  if (kind === 'odf') return await extractUsing(requireFromHere('textract/lib/extractors/odt.js') as Extractor)
  if (kind === 'epub') return await extractUsing(requireFromHere('textract/lib/extractors/epub.js') as Extractor)
  if (kind === 'html' || kind === 'md') {
    let text = await decodeText(bytes)
    if (['text/html', 'application/xhtml+xml'].includes(mime)) text = stripFileTextHtmlDoctype(text)
    if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(text)) throw new AgentFileTextError()
    if (kind === 'md') return await extractUsing(requireFromHere('textract/lib/extractors/md.js') as Extractor)
    const html = requireFromHere('textract/lib/extractors/html.js') as { extractFromText(text: string, options: object, done: (error: unknown, result: string) => void): void }
    return await new Promise((resolve, reject) => html.extractFromText(text, { preserveLineBreaks: true }, (error, result) => error ? reject(new AgentFileTextError()) : resolve(result)))
  }
  if (kind === 'doc' || kind === 'rtf' || kind === 'ocr' || kind === 'dxf') {
    await requireNative(kind, enabled)
    const options = { exec: { timeout: 10_000, maxBuffer: MAX_FILE_TEXT_CHARS * 4 } }
    if (kind === 'doc') return await extractUsing(process.platform === 'darwin' ? requireFromHere('textract/lib/extractors/doc-osx.js') as Extractor : requireFromHere('textract/lib/extractors/doc.js') as Extractor, options)
    if (kind === 'rtf') return await extractUsing(process.platform === 'darwin' ? requireFromHere('textract/lib/extractors/doc-osx.js') as Extractor : requireFromHere('textract/lib/extractors/rtf.js') as Extractor, options)
    if (kind === 'ocr') return await extractUsing(requireFromHere('textract/lib/extractors/images.js') as Extractor, options)
    return await extractUsing(requireFromHere('textract/lib/extractors/dxf.js') as Extractor, options)
  }
  // Known or unknown text remains usable; a failed binary parser never falls back to decoded ZIP/OLE bytes.
  if (zipped || bytes[0] === 0xd0 && bytes[1] === 0xcf || bytes[0] === 0x89 && bytes[1] === 0x50 ||
      bytes[0] === 0xff && bytes[1] === 0xd8 || Buffer.from(bytes.subarray(0, 4)).toString('ascii') === '%PDF') throw new AgentFileTextError('unsupported')
  if (plainExtensions.has(extension) || mime.startsWith('text/') || ['application/octet-stream', 'application/json', 'application/javascript', 'application/csv'].includes(mime) || looksText(bytes)) return await decodeText(bytes)
  throw new AgentFileTextError('unsupported')
}
// One fixed request per child. It remains alive until the parent kills the process group and cleans the private directory.
process.once('message', (raw: unknown) => {
  void (async () => {
    if (!raw || typeof raw !== 'object') throw new AgentFileTextError()
    const input = raw as { source: { name: string; mime: string }; offset?: number; limit?: number; nativeFormats?: readonly FileTextNativeFormat[]; zipBudget: Record<string, number> }
    const page = pagination(input), enabled = nativeFormats(input.nativeFormats)
    const bytes = await readFile(path.join(process.cwd(), 'input'))
    if (!bytes.length || bytes.length > MAX_FILE_TEXT_BYTES) throw new AgentFileTextError()
    const text = sanitizeUnicodeText(await extract(Uint8Array.from(bytes), input.source, enabled, input.zipBudget))
    if (text.length > MAX_FILE_TEXT_CHARS * 2) throw new AgentFileTextError()
    const characters = Array.from(text)
    if (characters.length > MAX_FILE_TEXT_CHARS) throw new AgentFileTextError()
    const end = Math.min(characters.length, page.offset + page.limit)
    process.send?.({ ok: true, page: { text: characters.slice(page.offset, end).join(''), offset: page.offset, totalChars: characters.length, ...(end < characters.length ? { nextOffset: end } : {}) } })
  })().catch((error: unknown) => process.send?.({ ok: false, code: error instanceof AgentFileTextError ? error.code : 'invalid' }))
})
process.once('disconnect', () => process.exit(0))
