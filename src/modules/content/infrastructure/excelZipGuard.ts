import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { createRequire } from 'node:module'
import { createInflateRaw } from 'node:zlib'
import { normalizeExcelCellAddress, parseExcelRange } from './excelWorkbook.js'
import { MAX_AGENT_EXCEL_BYTES } from './agentExcelTypes.js'

interface XmlParser {
  on(event: 'opentag', callback: (tag: { name: string; attributes: Record<string, string> }) => void): void
  on(event: 'text' | 'cdata', callback: (text: string) => void): void
  on(event: 'error' | 'doctype' | 'closetag', callback: () => void): void
  write(text: string): XmlParser
  close(): void
}
// saxes 5 has incompatible public declarations under strict NodeNext; keep its narrow runtime seam local.
const requireFromHere = createRequire(import.meta.url)
const { SaxesParser } = requireFromHere('saxes') as { SaxesParser: new (options: { xmlns: false }) => XmlParser }

export interface ExcelZipBudget {
  readonly entries: number
  readonly entryBytes: number
  readonly totalBytes: number
  readonly sheets: number
  readonly sharedStringBytes: number
  readonly sharedStrings: number
  readonly stringChars: number
  readonly cells: number
  readonly rows: number
  readonly mergedCells: number
  readonly columns: number
}
export const DEFAULT_EXCEL_ZIP_BUDGET: Readonly<ExcelZipBudget> = Object.freeze({
  entries: 2000, entryBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, sheets: 100,
  sharedStringBytes: 8 * 1024 * 1024, sharedStrings: 100_000, stringChars: 32_767,
  cells: 200_000, rows: 200_000, mergedCells: 200_000, columns: 200_000,
})
const bad = () => new Error('Excel 压缩包、XML 或解析预算无效')
export function excelZipBudget(input: Partial<ExcelZipBudget> = {}): ExcelZipBudget {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in DEFAULT_EXCEL_ZIP_BUDGET))) throw bad()
  const result = { ...DEFAULT_EXCEL_ZIP_BUDGET }
  for (const key of Object.keys(DEFAULT_EXCEL_ZIP_BUDGET) as (keyof ExcelZipBudget)[]) {
    const value = input[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_EXCEL_ZIP_BUDGET[key]) throw bad()
    result[key] = value
  }
  return Object.freeze(result)
}
function open(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { autoClose: false, lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
    (error, zip) => error || !zip ? reject(bad()) : resolve(zip)))
}
// Cover custom part names and ExcelJS's unanchored sheet-name matching, including unusual suffixes.
const isWorksheetEntry = (name: string) => /xl\/worksheets\/[^/]+\.xml/u.test(name)
function entries(zip: ZipFile, budget: ExcelZipBudget): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 1 || zip.entryCount > budget.entries) { reject(bad()); return }
    const result: Entry[] = [], paths = new Set<string>()
    let total = 0, sheets = 0
    zip.on('error', () => reject(bad()))
    zip.on('end', () => result.length === zip.entryCount ? resolve(result) : reject(bad()))
    zip.on('entry', (entry: Entry) => {
      try {
        const name = entry.fileName, normalized = name.replace(/\/$/u, '')
        if (!name || name.length > 512 || /[\u0000-\u001f\u007f\\]/u.test(name) || name.startsWith('/') ||
            normalized.split('/').some(part => !part || part === '.' || part === '..') || paths.has(normalized) || entry.isEncrypted() ||
            ![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            entry.uncompressedSize > budget.entryBytes || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) throw bad()
        paths.add(normalized)
        total += entry.uncompressedSize
        if (total > budget.totalBytes || name === 'xl/sharedStrings.xml' && entry.uncompressedSize > budget.sharedStringBytes ||
            isWorksheetEntry(name) && ++sheets > budget.sheets) throw bad()
        result.push(entry)
        if (result.length > budget.entries) throw bad()
        zip.readEntry()
      } catch { reject(bad()); zip.close() }
    })
    zip.readEntry()
  })
}
/** Preflight every inflated entry before ExcelJS can eagerly materialize it. Runs only in the parsing worker. */
export async function validateExcelZip(bytes: Uint8Array, overrides: Partial<ExcelZipBudget> = {}): Promise<void> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_AGENT_EXCEL_BYTES) throw bad()
  const budget = excelZipBudget(overrides), buffer = Buffer.from(bytes)
  const zip = await open(buffer)
  // A permanent handler also observes errors between lazy reads and stream acquisition.
  let zipError = false
  zip.on('error', () => { zipError = true })
  try {
    const list = await entries(zip, budget)
    if (!list.some(entry => entry.fileName === 'xl/workbook.xml') || !list.some(entry => entry.fileName === '[Content_Types].xml')) throw bad()
    let total = 0, sheets = 0, strings = 0, cells = 0, rows = 0, mergedCells = 0, columns = 0
    for (const entry of list) {
      if (zipError) throw bad()
      const shared = entry.fileName === 'xl/sharedStrings.xml', sheet = isWorksheetEntry(entry.fileName)
      const workbook = entry.fileName === 'xl/workbook.xml'
      const xml = sheet || /\.(?:xml|rels|vml)$/iu.test(entry.fileName)
      const parser = xml ? new SaxesParser({ xmlns: false }) : undefined
      const decoder = xml ? new TextDecoder('utf-8', { fatal: true }) : undefined
      let stringDepth = 0, stringChars = 0
      parser?.on('doctype', () => { throw bad() })
      parser?.on('error', () => { throw bad() })
      parser?.on('opentag', tag => {
        const name = tag.name.split(':').at(-1)
        if (workbook && name === 'sheet' && ++sheets > budget.sheets) throw bad()
        if (shared && name === 'si') { if (++strings > budget.sharedStrings || stringDepth) throw bad(); stringDepth = 1; stringChars = 0 }
        else if (stringDepth) stringDepth++
        if (sheet && name === 'c') {
          if (++cells > budget.cells) throw bad()
          if (tag.attributes.r) normalizeExcelCellAddress(String(tag.attributes.r))
        }
        if (sheet && name === 'row') {
          if (++rows > budget.rows) throw bad()
          if (tag.attributes.r && (!/^[1-9]\d*$/u.test(String(tag.attributes.r)) || Number(tag.attributes.r) > 1_048_576)) throw bad()
        }
        if (sheet && name === 'mergeCell') {
          mergedCells += parseExcelRange(String(tag.attributes.ref ?? '')).cellCount
          if (mergedCells > budget.mergedCells) throw bad()
        }
        if (sheet && name === 'col') {
          const minimum = Number(tag.attributes.min), maximum = Number(tag.attributes.max)
          if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum < minimum || maximum > 16_384) throw bad()
          columns += maximum - minimum + 1
          if (columns > budget.columns) throw bad()
        }
      })
      parser?.on('closetag', () => { if (stringDepth) stringDepth-- })
      const countText = (text: string) => { if (stringDepth && (stringChars += text.length) > budget.stringChars) throw bad() }
      parser?.on('text', countText); parser?.on('cdata', countText)
      const raw = await new Promise<import('node:stream').Readable>((resolve, reject) => {
        const done = (error: Error | null, value?: import('node:stream').Readable) => error || !value ? reject(bad()) : resolve(value)
        if (entry.compressionMethod === 8) zip.openReadStream(entry, { decompress: false, decrypt: null, start: null, end: null }, done)
        else zip.openReadStream(entry, done)
      })
      // Own zlib rather than yauzl's AssertByteCountStream: its destroy override suppresses modern Node transform errors.
      const inflate = entry.compressionMethod === 8 ? createInflateRaw() : undefined
      const stream = inflate ?? raw
      let actual = 0
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = (error?: Error) => {
            if (settled) return
            settled = true
            stream.removeListener('data', data)
            stream.removeListener('end', end)
            if (error) { stream.destroy(); reject(error) } else resolve()
          }
          const data = (item: Buffer) => {
            try {
              actual += item.length; total += item.length
              if (actual > entry.uncompressedSize || actual > budget.entryBytes || total > budget.totalBytes || shared && actual > budget.sharedStringBytes) throw bad()
              parser?.write(decoder!.decode(item, { stream: true }))
            } catch { finish(bad()) }
          }
          const end = () => finish()
          // Keep observing late zlib/yauzl errors even after a deliberate destroy.
          stream.on('error', () => finish(bad()))
          if (inflate) raw.on('error', () => finish(bad()))
          stream.once('end', end)
          stream.on('data', data)
          if (inflate) raw.pipe(inflate)
        })
        if (actual !== entry.uncompressedSize || zipError) throw bad()
        if (parser) parser.write(decoder!.decode()).close()
      } finally { if (inflate) { raw.unpipe(inflate); inflate.destroy() } raw.destroy() }
    }
  } finally { zip.close() }
}
