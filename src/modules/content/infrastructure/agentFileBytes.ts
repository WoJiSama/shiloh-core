import type { AgentFileBytes, AgentFileListing, AgentFileRequest } from '../../../contracts/agentFiles.js'

export const MAX_AGENT_FILE_BYTES = 12 * 1024 * 1024
const origins = new Set(['current', 'reply', 'recent', 'group_file', 'explicit'])

function dataRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('文件参数必须为普通数据')
}

function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(value)) throw new Error('文件名无效')
  return value
}

export function validateAgentFileBytes(input: AgentFileBytes): AgentFileBytes {
  dataRecord(input)
  const name = fileName(input.name)
  const { mime, base64, origin } = input
  if (typeof mime !== 'string' || mime.length > 128 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(mime) ||
      typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(MAX_AGENT_FILE_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) throw new Error('文件数据无效或超过 12 MiB')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > MAX_AGENT_FILE_BYTES || bytes.toString('base64') !== base64 || (origin !== undefined && !origins.has(origin))) throw new Error('文件数据无效或超过 12 MiB')
  return Object.freeze({ name, mime: mime.toLowerCase(), base64, ...(origin ? { origin } : {}) })
}

/** Own only the small public selection contract; raw adapter references cannot pass here. */
export function snapshotAgentFileRequest(input: AgentFileRequest): AgentFileRequest {
  dataRecord(input)
  if (Object.keys(input).some(key => !['extensions', 'sourceSeq', 'fileIndex', 'fileName', 'folderPath', 'fileUrl'].includes(key))) throw new Error('文件选择参数无效')
  const owned = JSON.parse(JSON.stringify(input)) as AgentFileRequest
  if (owned.extensions !== undefined && (!Array.isArray(owned.extensions) || owned.extensions.length < 1 || owned.extensions.length > 12 || owned.extensions.some(extension => typeof extension !== 'string' || !/^\.[a-z0-9]{1,10}$/u.test(extension)))) throw new Error('文件扩展名筛选无效')
  if (owned.extensions) Object.freeze(owned.extensions)
  for (const key of ['sourceSeq', 'fileIndex'] as const) if (owned[key] !== undefined && (!Number.isSafeInteger(owned[key]) || owned[key]! < 1)) throw new Error('文件序号无效')
  if (owned.fileName !== undefined) fileName(owned.fileName)
  for (const key of ['folderPath', 'fileUrl'] as const) if (owned[key] !== undefined && (typeof owned[key] !== 'string' || owned[key]!.length > (key === 'fileUrl' ? 2048 : 1024) || /[\u0000-\u001f\u007f]/u.test(owned[key]!))) throw new Error('文件选择参数无效')
  return Object.freeze(owned)
}

export function validateAgentFileListing(input: AgentFileListing): AgentFileListing {
  dataRecord(input)
  if (!input || !Array.isArray(input.files) || input.files.length > 2000 || !Number.isSafeInteger(input.totalFiles) || input.totalFiles < input.files.length || input.totalFiles > 2000 || typeof input.truncated !== 'boolean') throw new Error('文件目录无效或过大')
  const files = input.files.map(entry => {
    dataRecord(entry)
    const name = fileName(entry.name)
    if (typeof entry.folderPath !== 'string' || entry.folderPath.length > 1024 || /[\u0000-\u001f\u007f]/u.test(entry.folderPath) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('文件目录条目无效')
    return Object.freeze({ name, folderPath: entry.folderPath, size: entry.size })
  })
  return Object.freeze({ files: Object.freeze(files), totalFiles: input.totalFiles, truncated: input.truncated })
}
