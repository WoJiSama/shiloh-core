import { parentPort, workerData } from 'node:worker_threads'
import { findInExcelWorkbook, listExcelWorksheets, loadExcelWorkbook, readExcelCell, readExcelRange } from './excelWorkbook.js'
import { validateExcelZip } from './excelZipGuard.js'
import { agentExcelQuery, parseAgentExcelInput } from './agentExcelTypes.js'
import type { AgentExcelSource } from './agentExcelTypes.js'
import { boundAgentExcelResult, formatAgentExcelResult } from './agentExcelFormat.js'
import type { AgentExcelResult } from './agentExcelFormat.js'

/** No platform, host configuration, credentials, network or filesystem paths enter this worker. */
async function main() {
  if (!parentPort || !workerData || !(workerData.bytes instanceof ArrayBuffer)) throw new Error('Invalid Excel worker request')
  const bytes = Buffer.from(workerData.bytes), query = agentExcelQuery(parseAgentExcelInput(workerData.query))
  await validateExcelZip(bytes, workerData.budget)
  const workbook = await loadExcelWorkbook(bytes)
  let result: AgentExcelResult
  try {
    if (query.operation === 'list_sheets') result = { operation: 'list_sheets', sheets: listExcelWorksheets(workbook) }
    else if (query.operation === 'read_cell') result = { operation: 'read_cell', ...readExcelCell(workbook, {
      ...(query.sheetName === undefined ? {} : { sheetName: query.sheetName }), ...(query.cell === undefined ? {} : { address: query.cell }),
    }) }
    else if (query.operation === 'read_range') result = { operation: 'read_range', ...readExcelRange(workbook, {
      ...(query.sheetName === undefined ? {} : { sheetName: query.sheetName }), ...(query.range === undefined ? {} : { range: query.range }), maxCells: 300,
    }) }
    else {
      const { relatedTerms, ...finding } = query
      result = { operation: 'find', ...findInExcelWorkbook(workbook, { ...finding, ...(relatedTerms ? { relatedTerms: [...relatedTerms] } : {}) }) }
    }
  } catch (error) {
    // These are bounded, source-backed query explanations (e.g. an ambiguous sheet), not parser/provider diagnostics.
    parentPort.postMessage({ ok: true, content: boundAgentExcelResult(`error: Excel 查询失败: ${error instanceof Error ? error.message : '查询参数无效'}`) })
    return
  }
  parentPort.postMessage({ ok: true, content: formatAgentExcelResult(result, workerData.source as AgentExcelSource) })
}
if (parentPort) void main().catch(() => { parentPort!.postMessage({ ok: false }); parentPort!.close() })
