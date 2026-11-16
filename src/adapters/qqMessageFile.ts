import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { AgentFileBytes, FileReadGuard } from '../contracts/agentFiles.js'
import type { MessageResource } from '../contracts/platformMessage.js'
import { isPublicAddress } from '../modules/shared/infrastructure/publicAddress.js'

export const QQ_FILE_MAX_BYTES = 12 * 1024 * 1024
const prefix = 'qq:file:'
export interface QqFileIdentity { readonly id: string; readonly busid?: string; readonly name: string }

function opaque(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined
}
export function qqFileBusId(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof text === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(text) && Number.isSafeInteger(Number(text)) ? text : undefined
}
export function qqFileName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && value.trim() && !/[\u0000-\u001f\u007f/\\]/u.test(value) ? value : undefined
}
/** Retain the platform ID even when `file` contains only a display filename or a URL. */
export function qqFileResource(item: Record<string, unknown>, data: Record<string, unknown>): MessageResource | undefined {
  const name = qqFileName(item.name ?? data.name ?? item.file_name ?? data.file_name ?? item.file ?? data.file)
  const explicit = item.file_id ?? data.file_id ?? item.fid ?? data.fid
  const legacy = item.file ?? data.file
  const id = opaque(explicit) ?? (explicit == null && typeof legacy === 'string' && legacy !== name &&
    !/^(?:https?:|file:|base64:|[./\\])/iu.test(legacy) ? opaque(legacy) : undefined)
  const rawBusId = item.busid ?? data.busid ?? item.bus_id ?? data.bus_id
  const busid = qqFileBusId(rawBusId)
  if (!id || !name || rawBusId != null && busid === undefined) return undefined
  return { kind: 'reference', value: prefix + Buffer.from(JSON.stringify({ id, name, ...(busid !== undefined ? { busid } : {}) })).toString('base64url') }
}
export function parseQqFileResource(resource: MessageResource | undefined): QqFileIdentity | undefined {
  if (resource?.kind !== 'reference' || !resource.value.startsWith(prefix) || resource.value.length > 10_000) return undefined
  try {
    const encoded = resource.value.slice(prefix.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>, id = opaque(row.id), name = qqFileName(row.name), busid = qqFileBusId(row.busid)
    return id && name && (row.busid === undefined || busid !== undefined) ? { id, name, ...(busid !== undefined ? { busid } : {}) } : undefined
  } catch { return undefined }
}

/** Every uncooperative policy/DNS promise is raced against the operation's cancellation. */
export async function qqFileActive<T>(guard: FileReadGuard, operation: () => Promise<T>): Promise<T> {
  if (guard.signal.aborted || !guard.isCurrent()) throw new Error('QQ file read cancelled')
  let abort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error('QQ file read cancelled'))
      guard.signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => {
        if (guard.signal.aborted || !guard.isCurrent()) throw new Error('QQ file read cancelled')
        return operation()
      }).then(resolve, reject)
    })
  } finally { if (abort) guard.signal.removeEventListener('abort', abort) }
}
export async function ensureQqFileCurrent(guard: FileReadGuard): Promise<void> {
  if (guard.ensureCurrent) await qqFileActive(guard, () => guard.ensureCurrent!())
  if (guard.signal.aborted || !guard.isCurrent()) throw new Error('QQ file read cancelled')
}
export async function authorizeQqFile(guard: FileReadGuard, authorize: () => Promise<boolean>): Promise<boolean> {
  await ensureQqFileCurrent(guard)
  const allowed = await qqFileActive(guard, authorize)
  await ensureQqFileCurrent(guard)
  return allowed
}

/** One deadline covers source lookup, authorization, DNS, redirects and body streaming. */
export async function withQqFileRead<T>(source: FileReadGuard, read: (guard: FileReadGuard) => Promise<T>): Promise<T | undefined> {
  const cancel = new AbortController()
  const signal = AbortSignal.any([source.signal, cancel.signal, AbortSignal.timeout(20_000)])
  const isCurrent = () => {
    try { return !signal.aborted && source.isCurrent() } catch { return false }
  }
  const guard: FileReadGuard = { signal, isCurrent, ...(source.ensureCurrent ? { ensureCurrent: () => source.ensureCurrent!() } : {}) }
  const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
  try {
    await ensureQqFileCurrent(guard)
    const result = await read(guard)
    await ensureQqFileCurrent(guard)
    return result
  } catch { return undefined }
  finally { clearInterval(timer); cancel.abort() }
}

function fileUrl(value: string): URL | undefined {
  if (value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash ? url : undefined
  } catch { return undefined }
}
interface FileResponse { readonly bytes?: Buffer; readonly redirect?: string }
async function fetchFile(url: URL, address: LookupAddress, signal: AbortSignal): Promise<FileResponse | undefined> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, family: address.family, signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'application/octet-stream, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Accept-Encoding': 'identity' },
    }, resolve)
    request.once('error', reject)
    request.end()
  })
  const abort = () => response.destroy()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    const encoding = response.headers['content-encoding']
    if (encoding && encoding.toLowerCase() !== 'identity') return undefined
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const redirect = response.headers.location
      return typeof redirect === 'string' ? { redirect } : undefined
    }
    const length = response.headers['content-length']
    if (response.statusCode !== 200 || length !== undefined && (!/^\d+$/u.test(length) || Number(length) > QQ_FILE_MAX_BYTES)) return undefined
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (signal.aborted || size > QQ_FILE_MAX_BYTES) return undefined
      chunks.push(bytes)
    }
    return !signal.aborted && size > 0 ? { bytes: Buffer.concat(chunks, size) } : undefined
  } finally { signal.removeEventListener('abort', abort); response.destroy() }
}

/** URL authority comes only from a freshly checked OneBot file ID, never from a model parameter. */
export async function downloadQqFile(urlValue: string, name: string, guard: FileReadGuard, authorize: () => Promise<boolean>, dependencies: {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  request?: typeof fetchFile
} = {}): Promise<AgentFileBytes | undefined> {
  let url = fileUrl(urlValue)
  if (!url || !qqFileName(name)) return undefined
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!await authorizeQqFile(guard, authorize)) return undefined
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    const literal = isIP(host)
    const addresses = literal ? [{ address: host, family: literal }] :
      await qqFileActive(guard, () => (dependencies.lookup ?? (hostname => lookup(hostname, { all: true })))(host))
    if (!addresses.length || addresses.length > 64 || addresses.some(value => isIP(value.address) !== value.family || !isPublicAddress(value.address))) return undefined
    const address = addresses.find(value => value.family === 4) ?? addresses[0]!
    if (!await authorizeQqFile(guard, authorize)) return undefined
    const result = await qqFileActive(guard, () => (dependencies.request ?? fetchFile)(url!, address, guard.signal))
    if (!result) return undefined
    if (result.redirect !== undefined) {
      if (redirects === 3) return undefined
      const next = fileUrl(new URL(result.redirect, url).href)
      if (!next || url.protocol === 'https:' && next.protocol !== 'https:') return undefined
      url = next
      continue
    }
    if (!result.bytes || result.bytes.length > QQ_FILE_MAX_BYTES || !await authorizeQqFile(guard, authorize)) return undefined
    const extension = name.toLowerCase().split('.').pop()
    const mime = extension === 'xltx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.template' :
      extension === 'xltm' ? 'application/vnd.ms-excel.template.macroEnabled.12' :
      extension === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
      extension === 'xlsm' ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : extension === 'xls' ? 'application/vnd.ms-excel' :
      extension === 'csv' ? 'text/csv' : extension === 'tsv' ? 'text/tab-separated-values' : 'application/octet-stream'
    return { name, mime, base64: result.bytes.toString('base64') }
  }
  return undefined
}
