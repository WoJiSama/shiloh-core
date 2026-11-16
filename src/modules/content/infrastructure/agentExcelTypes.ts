import type { AgentFileBytes } from '../../../contracts/agentFiles.js'

export const AGENT_EXCEL_OPERATIONS = ['list_group_excels', 'list_sheets', 'read_cell', 'read_range', 'find'] as const
export type AgentExcelOperation = typeof AGENT_EXCEL_OPERATIONS[number]
export interface AgentExcelInput {
  readonly operation: AgentExcelOperation
  readonly sheetName?: string
  readonly cell?: string
  readonly range?: string
  readonly query?: string
  readonly searchIn?: 'all' | 'value' | 'formula'
  readonly matchMode?: 'contains' | 'exact' | 'starts_with' | 'ends_with'
  readonly anchorCell?: string
  readonly rowRadius?: number
  readonly columnRadius?: number
  readonly relatedTerms?: readonly string[]
  readonly limit?: number
  readonly sourceSeq?: number
  readonly fileIndex?: number
  readonly fileUrl?: string
  readonly fileName?: string
  readonly folderPath?: string
}
export type AgentExcelQuery = Omit<AgentExcelInput, 'operation' | 'sourceSeq' | 'fileIndex' | 'fileUrl' | 'fileName' | 'folderPath'> & {
  readonly operation: Exclude<AgentExcelOperation, 'list_group_excels'>
}
export interface AgentExcelSource {
  readonly name: string
  readonly origin?: AgentFileBytes['origin']
}
export interface AgentExcelWorkerRequest {
  readonly bytes: Uint8Array
  readonly query: AgentExcelQuery
  readonly source: AgentExcelSource
}
export const MAX_AGENT_EXCEL_BYTES = 12 * 1024 * 1024
export const MAX_AGENT_EXCEL_RESULT_CHARS = 12_000
const stringLimits = { sheetName: 200, cell: 20, range: 45, query: 1000, searchIn: 20, matchMode: 20,
  anchorCell: 20, fileUrl: 2048, fileName: 255, folderPath: 1024 } as const
const numberLimits = { rowRadius: [0, 500], columnRadius: [0, 100], limit: [1, 100], sourceSeq: [1, Number.MAX_SAFE_INTEGER], fileIndex: [1, 100] } as const
const bad = () => new Error('Excel 查询参数无效或超过上限')
export function parseAgentExcelInput(value: unknown): AgentExcelInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad()
  const input = value as Record<string, unknown>
  const allowed = ['operation', 'relatedTerms', ...Object.keys(stringLimits), ...Object.keys(numberLimits)]
  if (Object.keys(input).some(key => !allowed.includes(key)) || !AGENT_EXCEL_OPERATIONS.includes(input.operation as AgentExcelOperation)) throw bad()
  const owned: Record<string, unknown> = { operation: input.operation }
  for (const [key, maximum] of Object.entries(stringLimits)) {
    const text = input[key]
    if (text === undefined) continue
    if (typeof text !== 'string' || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw bad()
    owned[key] = text
  }
  for (const [key, [minimum, maximum]] of Object.entries(numberLimits)) {
    const number = input[key]
    if (number === undefined) continue
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum ||
        ['sourceSeq', 'fileIndex'].includes(key) && !Number.isSafeInteger(number)) throw bad()
    owned[key] = number
  }
  if (input.relatedTerms !== undefined) {
    if (!Array.isArray(input.relatedTerms) || input.relatedTerms.length > 30 || Array.from(input.relatedTerms).some(term =>
      typeof term !== 'string' || term.length > 200 || /[\u0000-\u001f\u007f]/u.test(term))) throw bad()
    owned.relatedTerms = Object.freeze([...input.relatedTerms])
  }
  if (owned.searchIn !== undefined && !['all', 'value', 'formula'].includes(String(owned.searchIn)) ||
      owned.matchMode !== undefined && !['contains', 'exact', 'starts_with', 'ends_with'].includes(String(owned.matchMode))) throw bad()
  if (input.operation === 'read_cell' && !String(owned.cell ?? '').trim() || input.operation === 'read_range' && !String(owned.range ?? '').trim() ||
      input.operation === 'find' && !String(owned.query ?? '').trim()) throw bad()
  return Object.freeze(owned) as unknown as AgentExcelInput
}

export function agentExcelQuery(input: AgentExcelInput): AgentExcelQuery {
  if (input.operation === 'list_group_excels') throw bad()
  const { sourceSeq: _seq, fileIndex: _index, fileUrl: _url, fileName: _name, folderPath: _folder, ...query } = input
  return { ...query, operation: input.operation }
}

export function supportedAgentExcelName(name: string): boolean { return /\.(?:xlsx|xlsm|xltx|xltm)$/iu.test(name) }
export function legacyAgentExcelName(name: string): boolean { return /\.(?:xls|xlt)$/iu.test(name) }
