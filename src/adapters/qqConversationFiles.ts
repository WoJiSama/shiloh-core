import { createHmac, randomUUID } from 'node:crypto'
import type { ConversationAddress } from '../contracts/agentBinding.js'
import type { ConversationFileCatalog, ConversationFileEntry, FileReadGuard } from '../contracts/agentFiles.js'
import { conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { qqId } from './qqIdentity.js'
import { ensureQqFileCurrent, qqFileBusId, qqFileName, QQ_FILE_MAX_BYTES } from './qqMessageFile.js'

type NativeCall = (action: string, params: Record<string, unknown>) => Promise<unknown>
interface FileEvidence {
  readonly id: string
  readonly busid?: string
  readonly name: string
  readonly folderPath: string
  readonly size: number
  readonly uploader?: string
  readonly time?: number
}
interface IssuedFile { readonly scope: string; readonly evidence: FileEvidence }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function fileId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined
}
function canonicalUser(value: unknown): string | undefined {
  const id = qqId(value)
  return id && (typeof value === 'number' || value === id) ? id : undefined
}
/** Verify the envelope and any explicit scope proofs without pretending optional fields exist. */
export function qqFileResponseData(value: unknown, target: ConversationAddress): Record<string, unknown> | undefined {
  const response = record(value), data = record(response.data)
  if (response.status !== 'ok' || response.retcode !== 0 || !response.data || Array.isArray(response.data) || typeof response.data !== 'object') return undefined
  for (const row of [response, data]) {
    if (row.self_id !== undefined && canonicalUser(row.self_id) !== target.account.id ||
        row.group_id !== undefined && canonicalUser(row.group_id) !== target.id) return undefined
  }
  return data
}
function evidenceOf(value: unknown, folderPath: string): FileEvidence | undefined {
  const row = record(value), id = fileId(row.file_id ?? row.id ?? row.fid), name = qqFileName(row.file_name ?? row.name)
  const rawBusId = row.busid ?? row.bus_id, busid = qqFileBusId(rawBusId), size = row.file_size ?? row.size
  const rawUploader = row.uploader ?? row.uploader_id ?? row.user_id, uploader = canonicalUser(rawUploader)
  const rawTime = row.upload_time ?? row.modify_time ?? row.time
  const time = typeof rawTime === 'number' && Number.isSafeInteger(rawTime) && rawTime > 0 && Number.isSafeInteger(rawTime * 1000) ? rawTime * 1000 : undefined
  if (!id || !name || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
      rawBusId != null && busid === undefined || rawUploader != null && uploader === undefined || rawTime != null && rawTime !== 0 && time === undefined) return undefined
  return { id, name, folderPath, size, ...(busid !== undefined ? { busid } : {}), ...(uploader ? { uploader } : {}), ...(time !== undefined ? { time } : {}) }
}
function entryOf(reference: string, file: FileEvidence): ConversationFileEntry {
  return Object.freeze({ reference, name: file.name, folderPath: file.folderPath, size: file.size,
    ...(file.uploader ? { uploadedBy: Object.freeze({ platform: 'qq', namespace: 'global', id: file.uploader }) } : {}),
    ...(file.time !== undefined ? { uploadedAt: file.time } : {}),
  })
}
function equalEvidence(a: FileEvidence, b: FileEvidence): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function equalEntry(a: ConversationFileEntry, b: ConversationFileEntry): boolean {
  return a.reference === b.reference && a.name === b.name && a.folderPath === b.folderPath && a.size === b.size && a.uploadedAt === b.uploadedAt &&
    a.uploadedBy?.platform === b.uploadedBy?.platform && a.uploadedBy?.namespace === b.uploadedBy?.namespace && a.uploadedBy?.id === b.uploadedBy?.id
}

/** References are issued by this connection, bounded in memory, and never encode a caller-supplied native ID. */
export function createQqConversationFiles() {
  const issued = new Map<string, IssuedFile>()
  let referenceKey = randomUUID()
  async function scan(target: ConversationAddress, guard: FileReadGuard, call: NativeCall): Promise<{ files: FileEvidence[]; truncated: boolean } | undefined> {
    const queue = [{ id: '', path: '/', depth: 0 }], folders = new Set<string>(), files: FileEvidence[] = []
    const identities = new Map<string, FileEvidence>()
    let visited = 0, excelFiles = 0, truncated = false
    while (queue.length) {
      const folder = queue.shift()!
      if (visited >= 100) { truncated = true; break }
      visited++
      await ensureQqFileCurrent(guard)
      const response = await call(folder.id ? 'get_group_files_by_folder' : 'get_group_root_files', {
        group_id: target.id, ...(folder.id ? { folder_id: folder.id } : {}),
      })
      await ensureQqFileCurrent(guard)
      const data = qqFileResponseData(response, target)
      if (!data) return undefined
      const rows = data.files ?? data.file_list ?? [], children = data.folders ?? data.folder_list ?? []
      if (!Array.isArray(rows) || !Array.isArray(children) || rows.length > 5000 || children.length > 1000) return undefined
      for (const row of rows) {
        const raw = record(row), name = qqFileName(raw.file_name ?? raw.name)
        if (!name) return undefined
        const file = evidenceOf(row, folder.path)
        if (!file) return undefined
        const key = `${folder.id}\u0000${file.id}\u0000${file.busid ?? ''}`
        const previous = identities.get(key)
        if (previous && !equalEvidence(previous, file)) return undefined
        if (previous) continue
        identities.set(key, file)
        const excel = /\.(?:xlsx|xlsm|xltx|xltm|xls|xlt)$/iu.test(name)
        if (files.length >= 2000 || excel && excelFiles >= 500) { truncated = true; continue }
        files.push(file)
        if (excel) excelFiles++
      }
      for (const value of children) {
        const child = record(value), id = fileId(child.folder_id ?? child.id), name = qqFileName(child.folder_name ?? child.name)
        if (!id || !name || name === '.' || name === '..') return undefined
        if (folders.has(id)) { truncated = true; continue }
        folders.add(id)
        if (folder.depth >= 5 || visited + queue.length >= 100) { truncated = true; continue }
        queue.push({ id, path: `${folder.path}${name}/`, depth: folder.depth + 1 })
      }
    }
    await ensureQqFileCurrent(guard)
    return { files, truncated }
  }
  return {
    clear() { issued.clear(); referenceKey = randomUUID() },
    async list(target: ConversationAddress, guard: FileReadGuard, call: NativeCall): Promise<ConversationFileCatalog | undefined> {
      const result = await scan(target, guard, call)
      if (!result) return undefined
      const scope = conversationAddressKey(target)
      // Bound references across repeated listings without revoking entries issued during this listing.
      while (issued.size > 4000) issued.delete(issued.keys().next().value!)
      const files = result.files.map(file => {
        const reference = `qq:group-file:${createHmac('sha256', referenceKey).update(scope).update('\u0000').update(JSON.stringify(file)).digest('base64url')}`
        issued.set(reference, { scope, evidence: file })
        return entryOf(reference, file)
      })
      return Object.freeze({ target, observedAt: Date.now(), files: Object.freeze(files), truncated: result.truncated })
    },
    async verify(target: ConversationAddress, entry: ConversationFileEntry, guard: FileReadGuard, call: NativeCall): Promise<{ entry: ConversationFileEntry; file: FileEvidence } | undefined> {
      const previous = issued.get(entry.reference)
      if (!previous || previous.scope !== conversationAddressKey(target) || !equalEntry(entry, entryOf(entry.reference, previous.evidence)) || previous.evidence.size > QQ_FILE_MAX_BYTES) return undefined
      const snapshot = Object.freeze({ ...entry, ...(entry.uploadedBy ? { uploadedBy: Object.freeze({ ...entry.uploadedBy }) } : {}) })
      const fresh = await scan(target, guard, call)
      const file = fresh?.files.find(file => equalEvidence(file, previous.evidence))
      if (!file || !equalEntry(entry, snapshot)) return undefined
      return { entry: entryOf(entry.reference, file), file }
    },
  }
}
