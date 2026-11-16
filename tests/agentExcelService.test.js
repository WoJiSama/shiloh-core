import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createAgentExcelService } from '../dist/backend/modules/content/infrastructure/agentExcelService.js'
import { DEFAULT_EXCEL_ZIP_BUDGET, validateExcelZip } from '../dist/backend/modules/content/infrastructure/excelZipGuard.js'

async function sample() {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('data')
  sheet.getCell('A1').value = 'owned bytes'; sheet.getCell('B2').value = { formula: '1+2', result: 3 }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
const bytesPromise = sample()
function context(overrides = {}) { return { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides } }
async function request(query = { operation: 'read_cell', sheetName: 'data', cell: 'B2' }) { return { bytes: Uint8Array.from(await bytesPromise), query, source: { name: 'fixture.xlsx', origin: 'reply' } } }
async function until(probe, label, timeout = 1500) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (probe()) return; await delay(5) }
  assert.fail(`timed out: ${label}`)
}
function busyFactory(state) {
  return (_url, options) => {
    state.options.push(options)
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent("import { workerData } from 'node:worker_threads'; Atomics.store(new Int32Array(workerData.marker),0,1); while(true) {}")}`),
      { ...options, workerData: { marker: state.marker } })
    state.workers.push(worker)
    return worker
  }
}
const state = () => ({ marker: new SharedArrayBuffer(4), workers: [], options: [] })

test('Excel service real worker owns bytes and query snapshots, returns source-backed formula output without URLs or bytes', { timeout: 10_000 }, async () => {
  const input = await request(), original = Uint8Array.from(input.bytes)
  let release, checks = 0
  const gate = new Promise(resolve => { release = resolve })
  const service = createAgentExcelService()
  const pending = service.query(input, context({ async ensureCurrent() { checks++; await gate } }))
  input.bytes.fill(0)
  input.query.cell = 'A1'; input.source.name = 'mutated.xlsx'; input.source.origin = 'explicit'; release()
  const result = await pending
  assert.match(result, /文件: fixture.xlsx/); assert.match(result, /来源: reply/); assert.match(result, /单元格: B2/)
  assert.match(result, /公式: =1\+2/); assert.match(result, /值: 3/); assert.ok(checks >= 2)
  assert.ok(!result.includes(Buffer.from(original).toString('base64'))); assert.ok(!result.includes('https://'))
})

test('real busy worker is terminated and exited before cancellation returns; parent event loop remains responsive', { timeout: 5000 }, async () => {
  const s = state(), controller = new AbortController(), service = createAgentExcelService({ timeoutMs: 2000, workerFactory: busyFactory(s) })
  const pending = service.query(await request(), context({ signal: controller.signal }))
  const rejected = assert.rejects(pending, /Excel 读取已停止/)
  await until(() => Atomics.load(new Int32Array(s.marker), 0) === 1, 'busy worker started')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  await delay(30); controller.abort(); await rejected; clearInterval(timer)
  assert.ok(ticks >= 2); assert.equal(s.workers[0].threadId, -1)
  assert.deepEqual(s.options[0].env, {}); assert.deepEqual(s.options[0].execArgv, [])
  assert.equal(s.options[0].resourceLimits.maxOldGenerationSizeMb, 256)
})

test('real busy worker observes total timeout, and periodic fresh authorization failure terminates without isCurrent changing', { timeout: 5000 }, async () => {
  for (const mode of ['timeout', 'authority']) {
    const s = state(); let authorized = true, checks = 0
    const service = createAgentExcelService({ timeoutMs: mode === 'timeout' ? 700 : 2000, workerFactory: busyFactory(s) })
    const pending = service.query(await request(), context({ async ensureCurrent() { checks++; if (!authorized) throw new Error('private-store-detail') } }))
    const rejected = assert.rejects(pending, error => { assert.match(error.message, /Excel 读取已停止/); assert.doesNotMatch(error.message, /private-store-detail/); return true })
    await until(() => Atomics.load(new Int32Array(s.marker), 0) === 1, `${mode} worker started`)
    if (mode === 'authority') authorized = false
    await rejected
    assert.ok(checks >= 2); assert.equal(s.workers[0].threadId, -1)
  }
})

test('bounded queue cancels a waiter without creating its worker, rejects overload and releases capacity only after worker exit', { timeout: 5000 }, async () => {
  const s = state(), firstController = new AbortController(), queuedController = new AbortController()
  const service = createAgentExcelService({ maxConcurrent: 1, maxQueued: 1, timeoutMs: 2000, workerFactory: busyFactory(s) })
  const first = service.query(await request(), context({ signal: firstController.signal })), firstRejected = assert.rejects(first)
  await until(() => s.workers.length === 1, 'first worker')
  const queued = service.query(await request(), context({ signal: queuedController.signal })), queuedRejected = assert.rejects(queued)
  await assert.rejects(service.query(await request(), context()), /Excel 读取已停止/)
  queuedController.abort(); await queuedRejected
  assert.equal(s.workers.length, 1)
  firstController.abort(); await firstRejected
  assert.equal(s.workers[0].threadId, -1)
})

test('a hung authorization is cancelled by the same deadline before any worker starts, and stale successful responses never escape', { timeout: 5000 }, async () => {
  let workers = 0
  const service = createAgentExcelService({ timeoutMs: 40, workerFactory() { workers++; throw new Error('never') } })
  await assert.rejects(service.query(await request(), context({ async ensureCurrent() { await new Promise(() => {}) } })))
  assert.equal(workers, 0)
  const s = state(), controller = new AbortController()
  const late = createAgentExcelService({ workerFactory(_url, options) {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent("import {parentPort} from 'node:worker_threads'; parentPort.postMessage({ok:true,content:'late result'}); setInterval(()=>{},1000)")}`), options)
    s.workers.push(worker); return worker
  } })
  let checks = 0
  await assert.rejects(late.query(await request(), context({ signal: controller.signal, async ensureCurrent() { if (++checks > 1) controller.abort() } })))
  assert.equal(s.workers[0]?.threadId, -1)
})

async function zip(parts = {}, options = {}) {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', '<Types/>')
  archive.file('xl/workbook.xml', '<workbook><sheets><sheet name="data" sheetId="1"/></sheets></workbook>')
  archive.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>')
  for (const [name, value] of Object.entries(parts)) archive.file(name, value)
  return await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', ...options })
}
test('ZIP preflight accepts ordinary real workbooks and rejects declared entries, expanded bytes, sharedStrings, cells, rows and columns before ExcelJS load', async () => {
  await validateExcelZip(await bytesPromise)
  const bad = [
    [await zip(), { entries: 1 }],
    [await zip({ 'payload.bin': 'x'.repeat(4096) }), { entryBytes: 1024 }],
    [await zip({ 'payload.bin': 'x'.repeat(4096) }), { totalBytes: 3000 }],
    [await zip({ 'xl/sharedStrings.xml': '<sst><si><t>abcdef</t></si></sst>' }), { sharedStringBytes: 20 }],
    [await zip({ 'xl/sharedStrings.xml': '<sst count="1" uniqueCount="1"><si><t>a</t></si><si><t>b</t></si></sst>' }), { sharedStrings: 1 }],
    [await zip({ 'xl/sharedStrings.xml': '<sst><si><r><t>abcd</t></r><r><t>efgh</t></r></si></sst>' }), { stringChars: 7 }],
    [await zip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"/><c r="B1"/></row></sheetData></worksheet>' }), { cells: 1 }],
    [await zip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"/><row r="2"/></sheetData></worksheet>' }), { rows: 1 }],
    [await zip({ 'xl/worksheets/sheet1.xml': '<worksheet><cols><col min="1" max="16384"/></cols><sheetData/></worksheet>' }), { columns: 100 }],
    [await zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="a"/><sheet name="b"/></sheets></workbook>' }), { sheets: 1 }],
  ]
  for (const [bytes, budget] of bad) await assert.rejects(validateExcelZip(bytes, budget))
  await assert.rejects(validateExcelZip(await zip(), { entries: DEFAULT_EXCEL_ZIP_BUDGET.entries + 1 }))
})

test('ZIP preflight rejects actual inflate beyond forged central sizes, DTD and huge merge spans; real worker refuses those workbooks', { timeout: 10_000 }, async t => {
  const forged = await zip({ 'payload.bin': 'x'.repeat(32 * 1024) })
  for (let offset = 0; offset + 46 < forged.length; offset++) {
    if (forged.readUInt32LE(offset) !== 0x02014b50) continue
    const length = forged.readUInt16LE(offset + 28)
    if (forged.toString('utf8', offset + 46, offset + 46 + length) === 'payload.bin') forged.writeUInt32LE(1, offset + 24)
  }
  const hugeMergeXml = '<worksheet><sheetData/><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'
  const hugeMerge = await zip({ 'xl/worksheets/sheet1.xml': hugeMergeXml })
  const customMerge = await zip({ 'xl/worksheets/custom-name.xml': hugeMergeXml })
  const misleadingSuffix = await zip({ 'prefix_xl/worksheets/sheet2.xml.extra': hugeMergeXml })
  const dtd = await zip({ 'xl/sharedStrings.xml': '<!DOCTYPE sst [<!ENTITY expansion "secret">]><sst><si><t>&expansion;</t></si></sst>' })
  for (const [label, bytes] of [['forged', forged], ['merge', hugeMerge], ['custom', customMerge], ['suffix', misleadingSuffix], ['dtd', dtd]]) {
    t.diagnostic(`preflight ${label}`)
    await assert.rejects(validateExcelZip(bytes))
    t.diagnostic(`worker ${label}`)
    await assert.rejects(createAgentExcelService().query({ ...(await request()), bytes }, context()), /Excel 读取已停止/)
  }
})

test('worker bounds long result content with a visible truncation marker', { timeout: 10_000 }, async () => {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('long').getCell('A1').value = '内容'.repeat(8000)
  const content = await createAgentExcelService().query({ bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
    query: { operation: 'read_cell', cell: 'A1' }, source: { name: 'long.xlsx' } }, context())
  assert.ok([...content].length <= 12_000); assert.match(content, /已截断/)
})
