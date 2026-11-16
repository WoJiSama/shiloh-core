import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import type { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import { createRequire } from 'node:module'
import { AgentFileTextError, MAX_FILE_TEXT_BYTES } from './agentFileTextTypes.js'
import { stripFileTextHtmlDoctype } from './agentFileTextMarkup.js'

interface XmlParser {
  on(event: 'opentag', callback: (tag: { attributes: Record<string, string> }) => void): void
  on(event: 'closetag' | 'doctype' | 'error', callback: () => void): void
  write(text: string): XmlParser
  close(): void
}
const requireFromHere = createRequire(import.meta.url)
const { SaxesParser } = requireFromHere('saxes') as { SaxesParser: new (options: { xmlns: false }) => XmlParser }
export interface FileTextZipBudget { readonly entries: number; readonly entryBytes: number; readonly totalBytes: number; readonly xmlNodes: number; readonly xmlDepth: number }
export const DEFAULT_FILE_TEXT_ZIP_BUDGET: Readonly<FileTextZipBudget> = Object.freeze({ entries: 2000, entryBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, xmlNodes: 500_000, xmlDepth: 100 })
const bad = () => new AgentFileTextError()
export function fileTextZipBudget(input: Partial<FileTextZipBudget> = {}): FileTextZipBudget {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in DEFAULT_FILE_TEXT_ZIP_BUDGET))) throw bad()
  const result = { ...DEFAULT_FILE_TEXT_ZIP_BUDGET }
  for (const key of Object.keys(result) as (keyof FileTextZipBudget)[]) {
    const value = input[key]
    if (value !== undefined) { if (!Number.isSafeInteger(value) || value < 1 || value > result[key]) throw bad(); result[key] = value }
  }
  return Object.freeze(result)
}
/** Shared raw-inflate reader: never relies on yauzl's error-suppressing AssertByteCount transform. */
export async function consumeFileTextZipEntry(zip: ZipFile, entry: Entry, budget: FileTextZipBudget, consume: (bytes: Buffer) => void): Promise<number> {
  const raw = await new Promise<Readable>((resolve, reject) => {
    const done = (error: Error | null, value?: Readable) => error || !value ? reject(bad()) : resolve(value)
    if (entry.compressionMethod === 8) zip.openReadStream(entry, { decompress: false, decrypt: null, start: null, end: null }, done)
    else zip.openReadStream(entry, done)
  })
  const inflate = entry.compressionMethod === 8 ? createInflateRaw() : undefined, stream = inflate ?? raw
  let actual = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => { if (settled) return; settled = true; stream.removeListener('data', data); stream.removeListener('end', end); if (error) { stream.destroy(); reject(error) } else resolve() }
      const data = (item: Buffer) => { try { actual += item.length; if (actual > entry.uncompressedSize || actual > budget.entryBytes) throw bad(); consume(item) } catch { finish(bad()) } }
      const end = () => finish()
      stream.on('error', () => finish(bad())); if (inflate) raw.on('error', () => finish(bad()))
      stream.once('end', end); stream.on('data', data); if (inflate) raw.pipe(inflate)
    })
    if (actual !== entry.uncompressedSize) throw bad()
    return actual
  } finally { if (inflate) { raw.unpipe(inflate); inflate.destroy() } raw.destroy() }
}
/** Format-independent preflight. Every entry is inflated and counted before any eager document parser runs. */
export async function validateFileTextZip(bytes: Uint8Array, overrides: Partial<FileTextZipBudget> = {}): Promise<void> {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_FILE_TEXT_BYTES) throw bad()
  const budget = fileTextZipBudget(overrides)
  const zip = await new Promise<ZipFile>((resolve, reject) => yauzl.fromBuffer(Buffer.from(bytes), { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(bad()) : resolve(value)))
  let zipError = false
  zip.on('error', () => { zipError = true })
  try {
    const list = await new Promise<Entry[]>((resolve, reject) => {
      const result: Entry[] = [], names = new Set<string>(); let total = 0
      if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 1 || zip.entryCount > budget.entries) { reject(bad()); return }
      zip.on('error', () => reject(bad()))
      zip.on('end', () => result.length === zip.entryCount ? resolve(result) : reject(bad()))
      zip.on('entry', (entry: Entry) => {
        try {
          const name = entry.fileName, key = name.replace(/\/$/u, '')
          if (!name || name.length > 512 || /[\u0000-\u001f\u007f\\]/u.test(name) || name.startsWith('/') || /^[a-z]:/iu.test(name) ||
              key.split('/').some(part => !part || part === '.' || part === '..') || names.has(key) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > budget.entryBytes ||
              !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || (total += entry.uncompressedSize) > budget.totalBytes) throw bad()
          names.add(key); result.push(entry); zip.readEntry()
        } catch { reject(bad()); zip.close() }
      })
      zip.readEntry()
    })
    let total = 0, nodes = 0
    for (const entry of list) {
      if (zipError) throw bad()
      const xml = /\.(?:xml|rels|vml|opf|ncx|xhtml)$/iu.test(entry.fileName), html = /\.(?:xhtml|html?)$/iu.test(entry.fileName)
      const parser = xml ? new SaxesParser({ xmlns: false }) : undefined
      const decoder = xml || html ? new TextDecoder('utf-8', { fatal: true }) : undefined
      let depth = 0, tail = '', prelude = '', started = !html
      parser?.on('doctype', () => { throw bad() }); parser?.on('error', () => { throw bad() })
      parser?.on('opentag', tag => { if (++nodes > budget.xmlNodes || ++depth > budget.xmlDepth || Object.values(tag.attributes).some(value => value.length > 65_536)) throw bad() })
      parser?.on('closetag', () => { depth-- })
      const consume = (text: string, final = false) => {
            if (!started) {
              prelude += text
              if (prelude.length > budget.entryBytes) throw bad()
              if (!/<(?![?!/])\s*[a-z]/iu.test(prelude) && !final) return
              text = stripFileTextHtmlDoctype(prelude); prelude = ''; started = true
            }
            const combined = tail + text
            if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(combined)) throw bad()
            tail = combined.slice(-32); parser?.write(text)
      }
      await consumeFileTextZipEntry(zip, entry, budget, item => {
        total += item.length
        if (total > budget.totalBytes) throw bad()
        if (decoder) consume(decoder.decode(item, { stream: true }))
      })
      if (decoder) consume(decoder.decode(), true)
      parser?.close()
      if (zipError) throw bad()
    }
  } finally { zip.close() }
}
