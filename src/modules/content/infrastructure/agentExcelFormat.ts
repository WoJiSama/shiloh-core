import type { AgentExcelSource } from './agentExcelTypes.js'
import { MAX_AGENT_EXCEL_RESULT_CHARS } from './agentExcelTypes.js'
import type { findInExcelWorkbook, listExcelWorksheets, readExcelCell, readExcelRange } from './excelWorkbook.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'

export type AgentExcelResult = { operation: 'list_sheets'; sheets: ReturnType<typeof listExcelWorksheets> }
  | { operation: 'read_cell' } & ReturnType<typeof readExcelCell>
  | { operation: 'read_range' } & ReturnType<typeof readExcelRange>
  | { operation: 'find' } & ReturnType<typeof findInExcelWorkbook>
export interface AgentExcelListing {
  readonly files: readonly { readonly fullPath: string; readonly size: number }[]
  readonly totalExcelFiles: number
  readonly truncated: boolean
}
const label = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 1024)
function displayValue(value: unknown) {
  if (value === undefined) return '(无)'
  if (value === null) return '(空)'
  if (typeof value === 'string') return value || '(空字符串)'
  return JSON.stringify(value)
}
function formatCell(cell: ReturnType<typeof readExcelCell>['cell']) {
  const lines = [`单元格: ${cell.address}${cell.sourceAddress && cell.sourceAddress !== cell.address ? `（合并区域实际来源: ${cell.sourceAddress}）` : ''}`,
    `公式: ${cell.formula || '(无公式)'}`]
  lines.push(cell.formula && !cell.hasCachedValue ? '值: (工作簿未保存计算结果；请用 Excel/WPS 重新计算并保存后再查询)' : `值: ${displayValue(cell.value)}`)
  lines.push(`显示值: ${cell.displayValue || '(空)'}`)
  if (cell.numberFormat) lines.push(`数字格式: ${cell.numberFormat}`)
  return lines.join('\n')
}
export function boundAgentExcelResult(text: string): string {
  if ([...text].length <= MAX_AGENT_EXCEL_RESULT_CHARS) return text
  const suffix = '\n（结果达到长度上限，已截断；请缩小查询范围。）'
  return safeTruncateUnicode(text, MAX_AGENT_EXCEL_RESULT_CHARS - [...suffix].length) + suffix
}
export function formatAgentExcelResult(result: AgentExcelResult, source: AgentExcelSource): string {
  const header = ['【Excel 工作簿查询结果】', `文件: ${label(source.name)}`, `来源: ${source.origin ?? '当前会话授权文件'}`]
  if (result.operation === 'list_sheets') return boundAgentExcelResult([...header, '工作表:', ...result.sheets.map(sheet =>
    `${sheet.index}. ${sheet.name}（${sheet.state}，${sheet.rowCount}行 × ${sheet.columnCount}列）`)].join('\n'))
  if (result.operation === 'read_cell') return boundAgentExcelResult([...header, `工作表: ${result.sheetName}`, formatCell(result.cell)].join('\n'))
  if (result.operation === 'read_range') return boundAgentExcelResult([...header, `工作表: ${result.sheetName}`, `区域: ${result.range}（${result.cellCount}个单元格）`,
    ...result.rows.flatMap(row => row.map(formatCell))].join('\n\n'))
  const modes: Record<string, string> = { contains: '包含', exact: '完全等于', starts_with: '开头是', ends_with: '结尾是' }
  const lines = [...header, `搜索: ${result.query}`, `匹配方式: ${modes[result.matchMode] ?? result.matchMode}`,
    ...(result.scope ? [`搜索区域: ${result.scope}`] : []), ...(result.relatedTerms.length ? [
      `原词精确命中: ${result.exactMatchCount}`, `关联词: ${result.relatedTerms.join('、')}`,
      ...(result.exactMatchCount ? [] : ['说明: 工作簿中没有出现搜索原词；以下是文件内实际命中的关联内容，不等同于原词的字面命中。']),
    ] : []), `扫描单元格: ${result.scannedCells}`, `匹配数量: ${result.matches.length}${result.truncated ? '（结果或扫描已达到上限）' : ''}`]
  for (const match of result.matches) {
    const matchedBy = match.exactMatch ? '原词' : match.matchedTerms.length ? `关联词:${match.matchedTerms.join('/')}` : ''
    lines.push(`工作表: ${match.sheetName}${matchedBy ? `（命中:${matchedBy}）` : ''}\n${formatCell(match)}`)
  }
  if (!result.matches.length) lines.push('没有找到匹配项')
  return boundAgentExcelResult(lines.join('\n\n'))
}
export function formatAgentExcelListing(result: AgentExcelListing): string {
  return boundAgentExcelResult(['【Excel 工作簿查询结果】', '文件: 当前群文件仓库', '来源: group_file',
    `群文件中的 Excel: ${result.files.length} 个（共扫描到 ${result.totalExcelFiles} 个）${result.truncated ? '，目录扫描达到上限' : ''}`,
    ...result.files.map(file => `${label(file.fullPath)}（${file.size} 字节）`),
    ...(!result.files.length ? ['没有找到匹配的群文件 Excel'] : [])].join('\n'))
}
