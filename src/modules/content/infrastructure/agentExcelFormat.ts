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
function boundBlocks(header: string[], blocks: string[], separator: string, continuation?: (index: number) => string): string {
  const intro = header.join(separator), sizes = blocks.map(block => [...block].length + separator.length)
  let used = [...intro].length
  if (used + sizes.reduce((total, size) => total + size, 0) <= MAX_AGENT_EXCEL_RESULT_CHARS) return [intro, ...blocks].join(separator)
  const suffixes = blocks.map((_block, index) => `\n（结果达到长度上限，已截断；${continuation?.(index) ?? '请缩小查询范围。'}）`)
  const budget = MAX_AGENT_EXCEL_RESULT_CHARS - Math.max(...suffixes.map(suffix => [...suffix].length))
  if (used > budget) return safeTruncateUnicode(intro, budget) + suffixes[0]!
  const kept = [intro]
  for (const [index, block] of blocks.entries()) {
    if (used + sizes[index]! > budget) return kept.join(separator) + suffixes[index]!
    kept.push(block)
    used += sizes[index]!
  }
  return kept.join(separator)
}
export function formatAgentExcelResult(result: AgentExcelResult, source: AgentExcelSource): string {
  const header = ['【Excel 工作簿查询结果】', `文件: ${label(source.name)}`, `来源: ${source.origin ?? '当前会话授权文件'}`]
  if (result.operation === 'list_sheets') return boundBlocks([...header, '工作表:'], result.sheets.map(sheet =>
    `${sheet.index}. ${sheet.name}（${sheet.state}，${sheet.rowCount}行 × ${sheet.columnCount}列）`), '\n')
  if (result.operation === 'read_cell') return boundAgentExcelResult([...header, `工作表: ${result.sheetName}`, formatCell(result.cell)].join('\n'))
  if (result.operation === 'read_range') return boundBlocks([...header, `工作表: ${result.sheetName}`, `区域: ${result.range}（${result.cellCount}个单元格）`,
    `列: ${[...new Set((result.rows[0] ?? []).map(cell => cell.address.replace(/\d+$/u, '')))].join('、')}`],
    result.rows.map(row => row.map(formatCell).join('\n')), '\n\n', index =>
      `请从 ${result.rows[index]?.[0]?.address ?? result.range} 所在行缩小范围续读。`)
  const modes: Record<string, string> = { contains: '包含', exact: '完全等于', starts_with: '开头是', ends_with: '结尾是' }
  const lines = [...header, `搜索: ${result.query}`, `匹配方式: ${modes[result.matchMode] ?? result.matchMode}`,
    ...(result.scope ? [`搜索区域: ${result.scope}`] : []), ...(result.relatedTerms.length ? [
      `原词精确命中: ${result.exactMatchCount}`, `关联词: ${result.relatedTerms.join('、')}`,
      ...(result.exactMatchCount ? [] : ['说明: 工作簿中没有出现搜索原词；以下是文件内实际命中的关联内容，不等同于原词的字面命中。']),
    ] : []), `扫描单元格: ${result.scannedCells}`, `匹配数量: ${result.matches.length}${result.truncated ? '（结果或扫描已达到上限）' : ''}`]
  const blocks = result.matches.map(match => {
    const matchedBy = match.exactMatch ? '原词' : match.matchedTerms.length ? `关联词:${match.matchedTerms.join('/')}` : ''
    return `工作表: ${match.sheetName}${matchedBy ? `（命中:${matchedBy}）` : ''}\n${formatCell(match)}`
  })
  return boundBlocks(lines, blocks.length ? blocks : ['没有找到匹配项'], '\n\n')
}
export function formatAgentExcelListing(result: AgentExcelListing): string {
  return boundBlocks(['【Excel 工作簿查询结果】', '文件: 当前群文件仓库', '来源: group_file',
    `群文件中的 Excel: ${result.files.length} 个（共扫描到 ${result.totalExcelFiles} 个）${result.truncated ? '，目录扫描达到上限' : ''}`],
    result.files.length ? result.files.map(file => `${label(file.fullPath)}（${file.size} 字节）`) : ['没有找到匹配的群文件 Excel'], '\n')
}
