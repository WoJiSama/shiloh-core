import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { createAgentExcelTool } from '../dist/backend/modules/content/infrastructure/agentExcelTool.js'

async function workbookFile(name = '预算.xlsx', origin = 'current') {
  const workbook = new ExcelJS.Workbook()
  const budget = workbook.addWorksheet('预算表')
  budget.getCell('A1').value = '项目'
  budget.getCell('B2').value = { formula: 'SUMPRODUCT({3,7},{4,6})', result: 54 }
  budget.getCell('B2').numFmt = '0.00'
  budget.getCell('B3').value = { formula: '1+2' }
  budget.mergeCells('A4:B4'); budget.getCell('A4').value = '合并标题'
  const names = workbook.addWorksheet('Names')
  names.getCell('A2').value = '力量 STR'
  names.getCell('B39').value = '尚虹叙项目组'
  names.getCell('C41').value = '前缀尚虹叙不算'
  names.getCell('G60').value = '尚虹叙远处记录'
  names.getCell('D8').value = { formula: 'B2*2', result: 176 }
  return { name, origin, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') }
}
const filePromise = workbookFile()
function context(overrides = {}) {
  return { binding: { id: 'excel-binding', agentId: 'excel-agent', revision: 'v1', target: { account: { platform: 'fixture', namespace: 'excel', id: 'bot' }, kind: 'group', id: 'group-a' } },
    actor: { kind: 'user', user: { platform: 'fixture', namespace: 'excel', id: 'peer-a' } },
    request: { messageId: 'current-request', text: '读取本轮附件的预算表', mentions: [] }, signal: new AbortController().signal,
    isCurrent: () => true, async ensureCurrent() {}, async readFile() { return await filePromise }, ...overrides }
}

test('Core Excel tool preserves the five read operations, every existing field and closed schema', () => {
  const tool = createAgentExcelTool()
  assert.equal(tool.name, 'excelWorkbookTool')
  assert.equal(tool.dataPolicy, 'ephemeral')
  assert.deepEqual(tool.parameters.properties.operation.enum, ['list_group_excels', 'list_sheets', 'read_cell', 'read_range', 'find'])
  for (const field of ['sheetName', 'cell', 'range', 'query', 'searchIn', 'matchMode', 'anchorCell', 'rowRadius', 'columnRadius', 'relatedTerms', 'limit', 'fileUrl', 'fileName', 'folderPath', 'sourceSeq', 'fileIndex']) assert.ok(tool.parameters.properties[field], field)
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.extensions, undefined)
  assert.equal(tool.parameters.properties.dataPolicy, undefined)
  assert.match(tool.description, /原式|缓存/)
  assert.doesNotMatch(tool.description, /编辑工作簿/)
})

test('file bytes and trusted origin are copied before reauthorization and legitimate 255-character names remain readable', async () => {
  const original = await filePromise, returned = { ...original, name: `${'a'.repeat(250)}.xlsx`, origin: 'recent' }
  const seen = []
  let checks = 0
  const tool = createAgentExcelTool({ service: { async query(input) { seen.push(input); return 'safe result' } } })
  const result = await tool.execute({ operation: 'list_sheets' }, context({ async readFile() { return returned }, async ensureCurrent() {
    if (++checks === 2) { returned.name = 'mutated.xlsx'; returned.base64 = 'aGVsbG8='; returned.origin = 'explicit' }
  } }))
  assert.equal(result.status, 'succeeded')
  assert.equal(seen[0].source.name.length, 255); assert.equal(seen[0].source.origin, 'recent')
  assert.equal(Buffer.from(seen[0].bytes).toString('base64'), original.base64)
})

test('real parsing worker preserves names, sheet ordinals, exact formulas, cached results and merged range sources', { timeout: 20_000 }, async () => {
  const tool = createAgentExcelTool(), ctx = context()
  let result = await tool.execute({ operation: 'list_sheets' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /1\. 预算表/); assert.match(result.content, /2\. Names/)
  result = await tool.execute({ operation: 'read_cell', sheetName: '1', cell: '$b$2' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /公式: =SUMPRODUCT\(\{3,7\},\{4,6\}\)/)
  assert.match(result.content, /值: 54/); assert.match(result.content, /显示值: 54/); assert.match(result.content, /数字格式: 0\.00/)
  result = await tool.execute({ operation: 'read_cell', sheetName: '预算表', cell: 'B3' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /公式: =1\+2/); assert.match(result.content, /未保存计算结果/)
  assert.doesNotMatch(result.content, /值: 3/)
  result = await tool.execute({ operation: 'read_range', sheetName: '预算表', range: 'B4:A4' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /区域: A4:B4（2个单元格）/)
  assert.match(result.content, /B4（合并区域实际来源: A4）/); assert.match(result.content, /合并标题/)
  result = await tool.execute({ operation: 'read_cell', cell: 'B2' }, ctx)
  assert.equal(result.status, 'failed'); assert.match(result.content, /请指定工作表名称.*预算表.*Names/)
})

test('budgeted Excel ranges keep whole rows with column labels and give an exact continuation row', { timeout: 20_000 }, async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('分块')
  for (let row = 1; row <= 10; row++) {
    sheet.getCell('A' + row).value = ('工作说明\n\n还有一段 ' + row + '。').repeat(60)
    sheet.getCell('B' + row).value = '行回执 ' + row
  }
  const file = { ...(await filePromise), base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') }
  const tool = createAgentExcelTool(), ctx = context({ async readFile() { return file } })
  const first = await tool.execute({ operation: 'read_range', sheetName: '分块', range: 'A1:B10' }, ctx)
  assert.equal(first.status, 'succeeded')
  assert.match(first.content, /列: A、B/u)
  assert.ok([...first.content].length <= 12_000)
  const next = Number(first.content.match(/从 A(\d+) 所在行/u)?.[1])
  assert.ok(next > 1 && next <= 10)
  for (const column of ['A', 'B']) assert.equal([...first.content.matchAll(new RegExp('单元格: ' + column + '(\\d+)', 'gu'))].length, next - 1)
  const second = await tool.execute({ operation: 'read_range', sheetName: '分块', range: 'A' + next + ':B' + next }, ctx)
  assert.equal(second.status, 'succeeded')
  assert.ok(second.content.includes('行回执 ' + next))
})

test('real worker retains all find modes, formula selection, neighborhood, range priority and related-term evidence', { timeout: 20_000 }, async () => {
  const tool = createAgentExcelTool(), ctx = context()
  for (const [mode, query] of [['contains', '虹叙'], ['exact', '尚虹叙项目组'], ['starts_with', '尚虹叙'], ['ends_with', '项目组']]) {
    const result = await tool.execute({ operation: 'find', sheetName: 'names', query, matchMode: mode, anchorCell: 'B40', rowRadius: 3, columnRadius: 2, limit: 1 }, ctx)
    assert.equal(result.status, 'succeeded'); assert.match(result.content, /单元格: B39/)
    assert.doesNotMatch(result.content, /单元格: G60/); assert.match(result.content, /搜索区域: A37:D43/)
  }
  let result = await tool.execute({ operation: 'find', sheetName: '2', query: 'B2*2', searchIn: 'formula', range: 'D8:D8', anchorCell: 'B40', rowRadius: 0, columnRadius: 0 }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /搜索区域: D8:D8/); assert.match(result.content, /公式: =B2\*2/)
  result = await tool.execute({ operation: 'find', sheetName: '2', query: '.st', relatedTerms: ['力量', 'STR'], searchIn: 'value' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /原词精确命中: 0/); assert.match(result.content, /不等同于原词/)
  assert.match(result.content, /单元格: A2/); assert.match(result.content, /命中:关联词/)
})

test('group catalog counts Excel before filters, retains nested paths, legacy entries and truncation without reading bytes', async () => {
  let reads = 0, lists = 0
  const ctx = context({ async readFile() { reads++; throw new Error('must not download') }, async listFiles(input) {
    lists++; assert.deepEqual(input, {})
    return { files: [{ name: '说明.pdf', folderPath: '/', size: 2 }, { name: '总表.xlsx', folderPath: '/', size: 3 },
      { name: '预算.XLSM', folderPath: '/财务/2026', size: 4 }, { name: '旧表.xls', folderPath: '/归档', size: 5 },
      { name: '模板.xltx', folderPath: '/财务', size: 6 }, { name: '宏模板.xltm', folderPath: '/财务', size: 7 }], totalFiles: 6, truncated: true }
  } })
  const result = await createAgentExcelTool().execute({ operation: 'list_group_excels', query: '预算', folderPath: '财务' }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /Excel: 1 个（共扫描到 5 个）/)
  assert.match(result.content, /\/财务\/2026\/预算.XLSM/); assert.match(result.content, /目录扫描达到上限/)
  assert.deepEqual([reads, lists], [0, 1])
})

test('source selection is delegated unchanged to the scoped Core port and is snapshotted before authorization', async () => {
  const inputs = [], queries = [], mutable = { operation: 'find', query: '预算', relatedTerms: ['金额'], sourceSeq: 4, fileIndex: 2, fileName: '预算.xlsx', folderPath: '财务', fileUrl: 'https://example.test/预算.xlsx' }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const tool = createAgentExcelTool({ service: { async query(input) { queries.push(input); return 'safe result' } } })
  const pending = tool.execute(mutable, context({ async ensureCurrent() { await gate }, async readFile(input) { inputs.push(input); return await filePromise } }))
  mutable.query = 'mutated'; mutable.relatedTerms[0] = 'mutated'; mutable.fileUrl = 'https://attacker.test/private.xlsx'; release()
  assert.equal((await pending).status, 'succeeded')
  assert.deepEqual(inputs, [{ sourceSeq: 4, fileIndex: 2, fileName: '预算.xlsx', folderPath: '财务', fileUrl: 'https://example.test/预算.xlsx',
    extensions: ['.xlsx', '.xlsm', '.xltx', '.xltm', '.xls', '.xlt'] }])
  assert.equal(queries[0].query.query, '预算'); assert.deepEqual(queries[0].query.relatedTerms, ['金额'])
  assert.equal(queries[0].source.origin, 'current'); assert.ok(queries[0].bytes instanceof Uint8Array)
  assert.ok(!JSON.stringify(queries[0].query).includes('fileUrl'))
})

test('invalid arguments, nonhuman requests, revoked authority and missing ports never call file services', async () => {
  let reads = 0, lists = 0
  const ctx = context({ async readFile() { reads++; return await filePromise }, async listFiles() { lists++; return { files: [], totalFiles: 0, truncated: false } } })
  const tool = createAgentExcelTool()
  for (const input of [null, [], {}, { operation: 'write_cell' }, { operation: 'read_cell' }, { operation: 'read_range', range: 'A1:Z99' },
    { operation: 'read_cell', cell: 'XFE1' }, { operation: 'find', query: 'x', relatedTerms: new Array(2) }, { operation: 'find', query: 'x', limit: Infinity },
    { operation: 'find', query: 'x', matchMode: 'regex' }, { operation: 'list_sheets', filePath: '/private' }, { operation: 'list_sheets', target: 'foreign' },
    { operation: 'list_sheets', extensions: ['.pdf'] },
    { operation: 'list_sheets', sourceSeq: 1.2 }, { operation: 'list_sheets', fileIndex: 0 }]) assert.equal((await tool.execute(input, ctx)).status, 'failed')
  for (const overrides of [{ actor: { kind: 'autonomous' } }, { request: undefined }, { isCurrent: () => false }, { async ensureCurrent() { throw new Error('revoked') } }]) {
    assert.equal((await tool.execute({ operation: 'list_sheets' }, context({ ...ctx, ...overrides }))).status, 'failed')
  }
  assert.deepEqual([reads, lists], [0, 0])
  assert.equal((await tool.execute({ operation: 'list_sheets' }, context({ readFile: undefined }))).status, 'failed')
  assert.equal((await tool.execute({ operation: 'list_group_excels' }, context({ listFiles: undefined }))).status, 'failed')
})

test('strict byte boundary rejects corrupt, noncanonical, excessive, path-shaped and legacy files before worker creation', async () => {
  const file = await filePromise
  let queries = 0
  const tool = createAgentExcelTool({ service: { async query() { queries++; return 'never' } } })
  for (const bad of [{ ...file, base64: '/tmp/workbook.xlsx' }, { ...file, base64: 'aGVsbG8=' }, { ...file, base64: file.base64 + '\n' },
    { ...file, base64: 'AB==' }, { ...file, base64: 'A'.repeat(16 * 1024 * 1024 + 4) }, { ...file, name: 'old.xls' },
    { ...file, name: 'private\n.xlsx' }, { ...file, path: '/tmp/private' }, { ...file, origin: 'foreign' }]) {
    assert.equal((await tool.execute({ operation: 'list_sheets' }, context({ async readFile() { return bad } }))).status, 'failed')
  }
  assert.equal(queries, 0)
})

test('query content is bounded untrusted evidence and credentials or output-policy failures are suppressed', async () => {
  const secret = 'excel-host-private-key-12345'
  for (const output of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'blocked']) {
    const tool = createAgentExcelTool({ secrets: [secret], allowsText: text => !text.includes('blocked'), service: { async query() { return output } } })
    const result = await tool.execute({ operation: 'list_sheets' }, context())
    assert.equal(result.status, 'failed'); assert.ok(!result.content.includes(output))
  }
  const file = await workbookFile()
  const tool = createAgentExcelTool()
  const result = await tool.execute({ operation: 'read_cell', sheetName: '预算表', cell: 'B2' }, context({ async readFile() { return file } }))
  assert.equal(result.status, 'succeeded'); assert.ok(!result.content.includes(file.base64)); assert.ok(!result.content.includes('https://'))
})
