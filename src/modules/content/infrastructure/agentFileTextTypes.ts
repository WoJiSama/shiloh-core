import type { AgentFileBytes, AgentFileRequest } from '../../../contracts/agentFiles.js'
import { snapshotAgentFileRequest } from './agentFileBytes.js'

export const MAX_FILE_TEXT_BYTES = 12 * 1024 * 1024
export const MAX_FILE_TEXT_CHARS = 1_000_000
export const MAX_FILE_TEXT_PAGE = 11_000
export const MAX_FILE_TEXT_RESULT = 12_000
export const FILE_TEXT_NATIVE_FORMATS = ['doc', 'rtf', 'ocr', 'dxf'] as const
export type FileTextNativeFormat = typeof FILE_TEXT_NATIVE_FORMATS[number]
const fileTextErrorCodes = ['invalid', 'unsupported', 'native_disabled', 'native_unavailable', 'archive_entry_missing', 'archive_entry_not_text'] as const
export type FileTextErrorCode = typeof fileTextErrorCodes[number]
export function isFileTextErrorCode(value: unknown): value is FileTextErrorCode {
  return fileTextErrorCodes.some(code => code === value)
}
export class AgentFileTextError extends Error {
  constructor(readonly code: FileTextErrorCode = 'invalid') { super('文件文本读取已停止：格式、解析预算、期限或授权无效') }
}
export const fileTextFailureSteps = {
  file_text_selection_invalid: 'file_request_validation',
  file_text_source_unavailable: 'file_source_read',
  file_text_source_changed: 'file_source_authorization',
  file_text_format_unsupported: 'file_parse',
  file_text_archive_entry_missing: 'file_archive_entry',
  file_text_archive_entry_not_text: 'file_archive_entry',
  file_text_native_disabled: 'file_parse',
  file_text_native_unavailable: 'file_parse',
  file_text_parse_failed: 'file_parse',
  file_text_content_blocked: 'file_output_validation',
} as const
export type FileTextFailureCode = keyof typeof fileTextFailureSteps
export interface AgentFileTextSource { readonly name: string; readonly mime: string; readonly origin?: AgentFileBytes['origin'] }
export interface AgentFileTextRequest {
  readonly bytes: Uint8Array
  readonly source: AgentFileTextSource
  readonly archiveEntry?: string
  readonly offset?: number
  readonly limit?: number
}
export interface AgentFileTextPage {
  readonly text: string
  readonly offset: number
  readonly totalChars: number
  readonly nextOffset?: number
}
export interface AgentFileTextInput extends AgentFileRequest { readonly archiveEntry?: string; readonly offset?: number; readonly limit?: number }
export function validFileTextArchivePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\\]/u.test(value) &&
    !/^[a-z]:/iu.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..')
}
export function fileTextArchiveEntry(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!validFileTextArchivePath(value)) throw new AgentFileTextError()
  return value
}
export function pagination(input: { readonly offset?: number; readonly limit?: number }) {
  const offset = input.offset ?? 0, limit = input.limit ?? MAX_FILE_TEXT_PAGE
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILE_TEXT_CHARS ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_TEXT_PAGE) throw new AgentFileTextError()
  return { offset, limit }
}
export function fileTextInput(raw: Record<string, unknown>): AgentFileTextInput & { readonly offset: number; readonly limit: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !['sourceSeq', 'fileIndex', 'fileName', 'folderPath', 'fileUrl', 'archiveEntry', 'offset', 'limit'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, 'value'))) throw new AgentFileTextError()
  const { archiveEntry: requestedEntry, offset, limit, ...selection } = raw
  const archiveEntry = fileTextArchiveEntry(requestedEntry)
  const page = pagination({ ...(offset === undefined ? {} : { offset: offset as number }), limit: limit === undefined ? 4_000 : limit as number })
  return Object.freeze({ ...snapshotAgentFileRequest(selection), ...(archiveEntry === undefined ? {} : { archiveEntry }), ...page })
}
export function nativeFormats(input: readonly FileTextNativeFormat[] = []): readonly FileTextNativeFormat[] {
  if (!Array.isArray(input) || input.length > 4 || input.some(value => !FILE_TEXT_NATIVE_FORMATS.includes(value))) throw new AgentFileTextError()
  return Object.freeze([...new Set(input)])
}
export function fileTextPage(raw: unknown, offset: number, limit: number): AgentFileTextPage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentFileTextError()
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['text', 'offset', 'totalChars', 'nextOffset'].includes(key)) || typeof value.text !== 'string' ||
      value.text.length > limit * 2 || Array.from(value.text).length > limit || value.offset !== offset || !Number.isSafeInteger(value.totalChars) ||
      (value.totalChars as number) < 0 || (value.totalChars as number) > MAX_FILE_TEXT_CHARS) throw new AgentFileTextError()
  const end = offset + Array.from(value.text).length, total = value.totalChars as number
  if (Array.from(value.text).length !== Math.min(limit, Math.max(0, total - offset)) ||
      (end < total ? value.nextOffset !== end : value.nextOffset !== undefined)) throw new AgentFileTextError()
  return Object.freeze({ text: value.text, offset, totalChars: total, ...(end < total ? { nextOffset: end } : {}) })
}
