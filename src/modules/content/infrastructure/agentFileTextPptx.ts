import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { createRequire } from 'node:module'
import { consumeFileTextZipEntry, fileTextZipBudget } from './agentFileTextZip.js'
import type { FileTextZipBudget } from './agentFileTextZip.js'
import { AgentFileTextError, MAX_FILE_TEXT_CHARS } from './agentFileTextTypes.js'

interface Parser {
  on(event: 'opentag' | 'closetag', callback: (tag: { name: string }) => void): void
  on(event: 'text' | 'cdata', callback: (text: string) => void): void
  on(event: 'error' | 'doctype', callback: () => void): void
  write(text: string): Parser
  close(): void
}
const requireFromHere = createRequire(import.meta.url)
const { SaxesParser } = requireFromHere('saxes') as { SaxesParser: new (options: { xmlns: false }) => Parser }
/** Preflighted PPTX/POTX parts, read sequentially so ZIP end cannot race slide/notes completion. */
export async function extractFileTextPptx(bytes: Uint8Array, overrides: Partial<FileTextZipBudget>): Promise<string> {
  const budget = fileTextZipBudget(overrides)
  const zip = await new Promise<ZipFile>((resolve, reject) => yauzl.fromBuffer(Buffer.from(bytes), { autoClose: false, lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error || !value ? reject(new AgentFileTextError()) : resolve(value)))
  let errored = false; zip.on('error', () => { errored = true })
  try {
    const parts = await new Promise<{ entry: Entry; slide: number; notes: boolean }[]>((resolve, reject) => {
      const result: { entry: Entry; slide: number; notes: boolean }[] = []
      zip.once('error', () => reject(new AgentFileTextError()))
      zip.once('end', () => resolve(result))
      zip.on('entry', (entry: Entry) => {
        const match = entry.fileName.match(/^ppt\/(slides\/slide|notesSlides\/notesSlide)([1-9]\d*)\.xml$/u)
        if (match) result.push({ entry, slide: Number(match[2]), notes: match[1]!.startsWith('notes') })
        zip.readEntry()
      })
      zip.readEntry()
    })
    if (!parts.some(part => !part.notes)) throw new AgentFileTextError()
    parts.sort((a, b) => a.slide - b.slide || Number(a.notes) - Number(b.notes))
    const result: string[] = []; let characters = 0
    for (const part of parts) {
      const parser = new SaxesParser({ xmlns: false }), decoder = new TextDecoder('utf-8', { fatal: true })
      let textDepth = 0, depth = 0, text = ''
      const add = (value: string) => { characters += value.length; if (characters > MAX_FILE_TEXT_CHARS * 2) throw new AgentFileTextError(); text += value }
      parser.on('error', () => { throw new AgentFileTextError() }); parser.on('doctype', () => { throw new AgentFileTextError() })
      parser.on('opentag', tag => { depth++; const name = tag.name.split(':').at(-1); if (name === 't') textDepth = depth; if (name === 'br') add('\n'); if (name === 'tab') add('\t') })
      parser.on('closetag', tag => { if (tag.name.split(':').at(-1) === 'p') add('\n'); if (depth === textDepth) textDepth = 0; depth-- })
      const append = (value: string) => { if (textDepth) add(value) }; parser.on('text', append); parser.on('cdata', append)
      await consumeFileTextZipEntry(zip, part.entry, budget, chunk => { parser.write(decoder.decode(chunk, { stream: true })) })
      parser.write(decoder.decode()).close()
      if (errored) throw new AgentFileTextError()
      result.push(`${part.notes ? '备注' : '幻灯片'} ${part.slide}\n${text.trim()}`)
    }
    return result.join('\n\n')
  } finally { zip.close() }
}
