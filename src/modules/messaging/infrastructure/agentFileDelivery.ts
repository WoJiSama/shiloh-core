import type { AgentFileUpload, FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import { validateAgentFileBytes } from '../../content/infrastructure/agentFileBytes.js'
import { isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

/** Own only file bytes. A host cannot smuggle a target, local path or provider reference into an upload. */
export function validateAgentFileUpload(input: AgentFileUpload): AgentFileUpload {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !['name', 'mime', 'base64'].includes(String(key)))) throw new Error('文件上传参数无效')
  const owned = validateAgentFileBytes(input)
  if (owned.name === '.' || owned.name === '..') throw new Error('文件上传名称无效')
  return Object.freeze({ name: owned.name, mime: owned.mime, base64: owned.base64 })
}

/** Keep an upload's evidence separate from an ordinary reply's message ID. */
export function normalizeFileDeliveryReceipt(value: unknown): FileDeliveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown' }
  const receipt = value as Record<string, unknown>
  if (receipt.state === 'failed') return { state: 'failed', code: typeof receipt.code === 'string' ? receipt.code.slice(0, 128) : null }
  if (receipt.state !== 'uploaded' || typeof receipt.fileId !== 'string' || !receipt.fileId.trim() ||
      receipt.fileId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(receipt.fileId)) return { state: 'unknown' }
  if (receipt.messageId !== undefined && (!isPlatformIdentifier(receipt.messageId) || receipt.messageId === '0')) return { state: 'unknown' }
  return { state: 'uploaded', fileId: receipt.fileId, ...(receipt.messageId ? { messageId: receipt.messageId as string } : {}) }
}

/** Text file bodies pass the same output policy as text replies; binary producers must validate before rendering. */
export function agentFileUploadText(file: AgentFileUpload): string | undefined {
  if (!file.mime.startsWith('text/') && !/^(?:application\/(?:json|xml|javascript|x-python-code)|[^/]+\/[^/]+\+(?:json|xml))$/u.test(file.mime) &&
      !/\.(?:txt|md|csv|tsv|html?|xml|json|[cm]?js|tsx?|jsx|py|yaml|yml|log|ini|css)$/iu.test(file.name)) return undefined
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.base64, 'base64'))
}
