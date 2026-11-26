import assert from 'node:assert/strict'
import test from 'node:test'
import { fork, execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { createAgentFileTextService } from '../dist/backend/modules/content/infrastructure/agentFileTextService.js'
import { validateFileTextZip } from '../dist/backend/modules/content/infrastructure/agentFileTextZip.js'

const marker = 'REAL_DOCUMENT_MARKER'
const context = (overrides = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const request = (name, bytes, extra = {}) => ({ bytes: Uint8Array.from(bytes), source: { name, mime: 'application/octet-stream', origin: 'reply' }, ...extra })
async function zip(parts) { const value = new JSZip(); for (const [name, bytes] of Object.entries(parts)) value.file(name, bytes); return await value.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }
async function workbook() { const book = new ExcelJS.Workbook(); book.addWorksheet('data').getCell('A1').value = marker; return Buffer.from(await book.xlsx.writeBuffer()) }
function pdf() {
  const content = `BT /F1 12 Tf 50 750 Td (${marker}) Tj ET\n`, objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`]
  let output = '%PDF-1.4\n'; const offsets = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(output)
  return Buffer.from(`${output}xref\n0 6\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}
function record(type, bytes = Buffer.alloc(0)) { const header = []; do { header.push((type & 127) | (type > 127 ? 128 : 0)); type >>>= 7 } while (type); let size = bytes.length; do { header.push((size & 127) | (size > 127 ? 128 : 0)); size >>>= 7 } while (size); return Buffer.concat([Buffer.from(header), bytes]) }
function wide(text) { const size = Buffer.alloc(4); size.writeUInt32LE(text.length); return Buffer.concat([size, Buffer.from(text, 'utf16le')]) }
async function binaryWorkbook() {
  const value = await JSZip.loadAsync(await workbook())
  const bundle = Buffer.alloc(8); bundle.writeUInt32LE(1, 4)
  const book = Buffer.concat([record(0x83), record(0x8f), record(0x9c, Buffer.concat([bundle, wide('rId1'), wide('data')])), record(0x90), record(0x84)])
  const sheet = Buffer.concat([record(0x81), record(0x94, Buffer.alloc(16)), record(0x91), record(0, Buffer.alloc(4)), record(6, Buffer.concat([Buffer.alloc(8), wide(marker)])), record(0x92), record(0x82)])
  const types = (await value.file('[Content_Types].xml').async('string')).replaceAll('/xl/workbook.xml', '/xl/workbook.bin').replaceAll('/xl/worksheets/sheet1.xml', '/xl/worksheets/sheet1.bin').replaceAll('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.binary.macroEnabled.main').replaceAll('application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml', 'application/vnd.ms-excel.worksheet')
  value.file('[Content_Types].xml', types)
  value.file('_rels/.rels', (await value.file('_rels/.rels').async('string')).replaceAll('xl/workbook.xml', 'xl/workbook.bin'))
  value.file('xl/_rels/workbook.bin.rels', (await value.file('xl/_rels/workbook.xml.rels').async('string')).replaceAll('worksheets/sheet1.xml', 'worksheets/sheet1.bin'))
  value.remove('xl/_rels/workbook.xml.rels'); value.remove('xl/workbook.xml'); value.remove('xl/worksheets/sheet1.xml')
  value.file('xl/workbook.bin', book); value.file('xl/worksheets/sheet1.bin', sheet)
  return await value.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function epub() {
  return await zip({ mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">id</dc:identifier><dc:title>test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="toc"><itemref idref="chapter"/></spine></package>',
    'OEBPS/toc.ncx': '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>test</text></docTitle><navMap><navPoint id="chapter" playOrder="1"><navLabel><text>chapter</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>',
    'OEBPS/chapter.xhtml': `<!--${' '.repeat(16_370)}--><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>test</title></head><body><p>${marker}</p></body></html>` })
}
test('real child preserves text/code/JSON/CSV/HTML/XML/Markdown, UTF16 and small exact PDF without native programs', { timeout: 30_000 }, async () => {
  const service = createAgentFileTextService()
  for (const [name, bytes] of [['source.txt', Buffer.from(`${marker} 中文😀`)], ['source.py', Buffer.from(`import os\n# ${marker}`)], ['source.json', Buffer.from(`{"value":"${marker}"}`)], ['source.csv', Buffer.from(`name,value\na,${marker}`)], ['source.html', Buffer.from(`<!DOCTYPE html><html><body><p>${marker}</p><script>DO_NOT_INCLUDE</script></body></html>`)], ['source.xml', Buffer.from(`<root>${marker}</root>`)], ['source.md', Buffer.from(`# ${marker}\n\ntext`)], ['utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from(`${marker} 中文`, 'utf16le')])], ['source.pdf', pdf()]]) {
    const page = await service.extract(request(name, bytes), context())
    assert.match(page.text, new RegExp(marker), name); assert.doesNotMatch(page.text, /DO_NOT_INCLUDE/); assert.ok(page.totalChars < 1000)
  }
})

test('ordinary ZIP lists paths, then reads only one chosen text entry with Unicode pagination', async () => {
  const service = createAgentFileTextService(), archive = await zip({
    'docs/说明.txt': `${marker}😀后续`, 'docs/其他.txt': 'OTHER_ENTRY_PRIVATE', 'image.bin': Buffer.from([0, 255, 3]),
    'data/sample.xml': '<!DOCTYPE example><bad>',
  })
  const listing = await service.extract(request('sources.zip', archive), context())
  assert.match(listing.text, /4 个普通文件条目/)
  assert.match(listing.text, /docs\/说明\.txt/)
  assert.doesNotMatch(listing.text, /OTHER_ENTRY_PRIVATE|REAL_DOCUMENT_MARKER/)
  const member = { archiveEntry: 'docs/说明.txt', offset: marker.length, limit: 2 }
  const page = await service.extract(request('sources.zip', archive, member), context())
  assert.deepEqual(page, { text: '😀后', totalChars: marker.length + 3, offset: marker.length, nextOffset: marker.length + 2 })
  await assert.rejects(service.extract(request('sources.zip', archive, { archiveEntry: 'other.txt' }), context()), { code: 'archive_entry_missing' })
  await assert.rejects(service.extract(request('sources.zip', archive, { archiveEntry: 'image.bin' }), context()), { code: 'archive_entry_not_text' })
  await assert.rejects(service.extract(request('sources.zip', archive, { archiveEntry: 'docs/../image.bin' }), context()))
  const corrupt = await zip({ 'test.txt': marker })
  const centralHeader = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(centralHeader >= 0)
  corrupt.writeUInt32LE(0, centralHeader + 16)
  assert.match((await service.extract(request('corrupt.zip', corrupt), context())).text, /test\.txt/)
  await assert.rejects(service.extract(request('corrupt.zip', corrupt, { archiveEntry: 'test.txt' }), context()), { code: 'invalid' })
})
test('real Office/ODF/EPUB parsers preserve DOCX/PPTX/POTX/Excel XML XLS/XLSX/XLSM/XLTX/XLSB and all OpenDocument families', { timeout: 30_000 }, async t => {
  const doc = await zip({ 'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:body></w:document>` })
  const slide = await zip({ 'ppt/slides/slide1.xml': `<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>${marker}</a:t></a:r></a:p>`, 'ppt/notesSlides/notesSlide1.xml': '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>NOTES_MARKER</a:t></a:r></a:p>' })
  const odf = await zip({ 'content.xml': `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>${marker}</text:p></office:text></office:body></office:document-content>` })
  const ods = await zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'META-INF/manifest.xml': '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/></manifest:manifest>',
    'content.xml': `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="data"><table:table-row><table:table-cell office:value-type="string"><text:p>${marker}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>` })
  const xlsx = await workbook()
  const xml = Buffer.from(`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="data"><Table><Row><Cell><Data ss:Type="String">${marker}</Data></Cell></Row></Table></Worksheet></Workbook>`)
  const cases = [['source.docx', doc], ['source.pptx', slide], ['source.potx', slide], ['source.epub', await epub()], ['source.xls', xml], ['source.xlsb', await binaryWorkbook()], ...['xlsx','xlsm','xltx'].map(ext => [`source.${ext}`, xlsx]), ...['odt','ott','odg','otg','odp','otp'].map(ext => [`source.${ext}`, odf]), ...['ods','ots'].map(ext => [`source.${ext}`, ods])]
  const service = createAgentFileTextService()
  const failures = []
  for (const [name, bytes] of cases) { t.diagnostic(name); try { const page = await service.extract(request(name, bytes), context()); assert.match(page.text, new RegExp(marker), name); if (/\.p(?:pt|ot)x$/u.test(name)) assert.match(page.text, /备注 1\nNOTES_MARKER/) } catch (error) { failures.push(`${name}: ${error.message}`) } }
  assert.deepEqual(failures, [])
})
test('Unicode pagination reads the middle and end; byte/source/page snapshots precede authorization', async () => {
  const text = '前😀'.repeat(7000) + 'TAIL_MARKER', input = request('original.txt', Buffer.from(text), { offset: 13_995, limit: 15 })
  let release; const gate = new Promise(resolve => { release = resolve })
  const pending = createAgentFileTextService().extract(input, context({ async ensureCurrent() { await gate } }))
  input.bytes.fill(0); input.source.name = 'mutated.txt'; input.offset = 0; release()
  const page = await pending
  assert.equal(page.text, Array.from(text).slice(13_995, 14_010).join('')); assert.equal(page.nextOffset, 14_010)
  const end = await createAgentFileTextService().extract(request('source.txt', Buffer.from(text), { offset: page.nextOffset, limit: 100 }), context())
  assert.equal(end.text, 'R'); assert.equal(end.nextOffset, undefined); assert.equal(end.totalChars, 14_011)
})
async function until(probe, label) { const end = Date.now() + 2500; while (Date.now() < end) { if (await probe()) return; await delay(10) } assert.fail(`timed out ${label}`) }
async function busyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-file-text-test-'))
  const file = path.join(root, 'busy.cjs')
  await writeFile(file, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(child.pid));while(true){}`)
  const state = { children: [], options: [] }
  return { root, state, factory(_url, options) { state.options.push(options); const child = fork(file, [], options); state.children.push(child); return child } }
}
test('abort and timeout kill the real detached parser group, await exit, clean private temp and keep parent responsive', { timeout: 10_000 }, async () => {
  for (const mode of ['abort', 'timeout', 'authority']) {
    const f = await busyFixture(), controller = new AbortController(); let allowed = true, ticks = 0
    const service = createAgentFileTextService({ timeoutMs: mode === 'timeout' ? 900 : 3000, childFactory: f.factory })
    const pending = service.extract(request('source.txt', Buffer.from(marker)), context({ signal: controller.signal, async ensureCurrent() { if (!allowed) throw Error('PRIVATE_AUTH_DETAIL') } }))
    const rejected = assert.rejects(pending, error => { assert.doesNotMatch(error.message, /PRIVATE_AUTH_DETAIL/); return true })
    const timer = setInterval(() => { ticks++ }, 5)
    try {
      await until(async () => { try { await access(path.join(f.state.options[0]?.cwd ?? f.root, 'descendant.pid')); return true } catch { return false } }, 'real descendant')
      const directory = f.state.options[0].cwd, pid = Number(await readFile(path.join(directory, 'descendant.pid'), 'utf8'))
      if (mode === 'abort') controller.abort(); if (mode === 'authority') allowed = false
      await rejected
      assert.ok(ticks >= 2)
      const child = f.state.children[0]
      if (process.platform === 'win32') assert.ok(child.signalCode === 'SIGKILL' || (child.exitCode ?? 0) !== 0)
      else assert.equal(child.signalCode, 'SIGKILL')
      await assert.rejects(access(directory))
      assert.deepEqual(f.state.options[0].execArgv, ['--max-old-space-size=256']); assert.equal(f.state.options[0].detached, true)
      assert.equal(f.state.options[0].env.NODE_OPTIONS, undefined); assert.equal(f.state.options[0].env.OPENAI_API_KEY, undefined)
      if (process.platform !== 'win32') { try { const result = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(pid)]); assert.match(result.stdout, /^\s*Z/u) } catch (error) { if (error.code !== 1) throw error } }
    } finally { clearInterval(timer); controller.abort(); await rejected; await rm(f.root, { recursive: true, force: true }) }
  }
})
test('queue allows one running plus four waiters, rejects overload, cancels waiters without spawning and bounds hung authority', { timeout: 7000 }, async () => {
  const f = await busyFixture(), controllers = Array.from({ length: 5 }, () => new AbortController())
  try {
    const service = createAgentFileTextService({ timeoutMs: 3000, childFactory: f.factory })
    const running = service.extract(request('a.txt', Buffer.from(marker)), context({ signal: controllers[0].signal })), results = [assert.rejects(running)]
    await until(() => f.state.children.length === 1, 'first child')
    for (const controller of controllers.slice(1)) results.push(assert.rejects(service.extract(request('a.txt', Buffer.from(marker)), context({ signal: controller.signal }))))
    await assert.rejects(service.extract(request('a.txt', Buffer.from(marker)), context()))
    for (const controller of controllers.slice(1)) controller.abort()
    await Promise.all(results.slice(1)); assert.equal(f.state.children.length, 1)
    controllers[0].abort(); await results[0]
    let calls = 0
    await assert.rejects(createAgentFileTextService({ timeoutMs: 50, childFactory() { calls++; throw Error('must not spawn') } }).extract(request('a.txt', Buffer.from(marker)), context({ async ensureCurrent() { await new Promise(() => {}) } })))
    assert.equal(calls, 0)
  } finally { controllers.forEach(value => value.abort()); await rm(f.root, { recursive: true, force: true }) }
})
test('ZIP guards count actual inflate, reject paths/duplicates/DTD/depth/nodes and enforce every entry before real document parsing', { timeout: 12_000 }, async () => {
  const forged = await zip({ 'payload.bin': 'x'.repeat(32_768) })
  for (let offset = 0; offset + 46 < forged.length; offset++) if (forged.readUInt32LE(offset) === 0x02014b50 && forged.toString('utf8', offset + 46, offset + 46 + forged.readUInt16LE(offset + 28)) === 'payload.bin') forged.writeUInt32LE(1, offset + 24)
  const duplicate = await zip({ 'payloadA.bin': 'a', 'payloadB.bin': 'b' }); const needle = Buffer.from('payloadB.bin')
  for (let offset = 0; offset < duplicate.length - needle.length; offset++) if (duplicate.subarray(offset, offset + needle.length).equals(needle)) duplicate.write('payloadA.bin', offset)
  const bad = [[forged, {}], [duplicate, {}], [await zip({ '../escape.xml': '<a/>' }), {}], [await zip({ 'content.xml': '<!DOCTYPE a [<!ENTITY e "secret">]><a>&e;</a>' }), {}], [await zip({ 'chapter.xhtml': '<!DOCTYPE html [<!ENTITY e "secret">]><html/>' }), {}], [await zip({ 'content.xml': '<a><b><c/></b></a>' }), { xmlDepth: 2 }], [await zip({ 'content.xml': '<a><b/><c/></a>' }), { xmlNodes: 2 }], [await zip({ 'payload.bin': 'x'.repeat(4096) }), { entryBytes: 1000 }], [await zip({ 'a': 'a', 'b': 'b' }), { entries: 1 }]]
  for (const [bytes, budget] of bad) {
    await assert.rejects(validateFileTextZip(bytes, budget))
    await assert.rejects(createAgentFileTextService({ zipBudget: budget, timeoutMs: 1500 }).extract(request('source.docx', bytes), context()))
  }
  await validateFileTextZip(await epub())
})
test('native capability is disabled by default, optional RTF works where installed, corrupt binaries never become garbled text', async () => {
  await assert.rejects(createAgentFileTextService().extract(request('source.rtf', Buffer.from('{\\rtf1 hello}')), context()), error => error.code === 'native_disabled')
  for (const [name, bytes] of [['broken.docx', Buffer.from('PK broken zip')], ['binary.unknown', Buffer.from([0, 1, 2, 0, 255])], ['broken.pdf', Buffer.from('%PDF-invalid')]]) await assert.rejects(createAgentFileTextService().extract(request(name, bytes), context()))
  if (process.platform === 'darwin') assert.match((await createAgentFileTextService({ nativeFormats: ['rtf'] }).extract(request('source.rtf', Buffer.from(`{\\rtf1\\ansi ${marker}}`)), context())).text, new RegExp(marker))
})
