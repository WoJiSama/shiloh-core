import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentGroupLogArtifact } from '../../../contracts/agentGroupLog.js'
import { MAX_AGENT_GROUP_LOG_BYTES, validateAgentGroupLogArtifact } from '../../media/infrastructure/agentGroupLogArtifact.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { renderLogHtml, renderLogText, type LogExportLine, type LogExportSession } from '../domain/logExport.js'

export { MAX_AGENT_GROUP_LOG_BYTES, validateAgentGroupLogArtifact }
export { renderLogText, renderLogHtml, resolveLogForExport } from '../domain/logExport.js'
export type { LogExportLine, LogExportSession, LogExportOptions, LogExportGroup } from '../domain/logExport.js'
export type { AgentGroupLogArtifact } from '../../../contracts/agentGroupLog.js'

/** Trusted structured source only. This renderer does not grant source visibility or command authority. */
export interface AgentGroupLogDocument {
  readonly title?: string
  readonly startedAt?: string
  readonly endedAt?: string
}
export interface AgentGroupLogRenderOptions {
  /** Defaults to the existing 8 MiB export budget; may be 1 through 100 MiB. */
  readonly maxBytes?: number
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
}
const fail = () => new Error('团录来源、内容或完整文件预算未通过验证')
function wellFormed(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++at)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw fail()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw fail()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail()
    result[key] = descriptor.value
  }
  return result
}

/** Fixed escaped templates produce a complete owned TXT/HTML file without local paths or URLs. */
export function createAgentGroupLogRenderer(options: AgentGroupLogRenderOptions = {}) {
  const config = object(options, ['maxBytes', 'secrets', 'allowsText'])
  const maximum = config.maxBytes === undefined ? 8 * 1024 * 1024 : config.maxBytes
  if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1024 * 1024 || maximum > MAX_AGENT_GROUP_LOG_BYTES ||
      config.allowsText !== undefined && typeof config.allowsText !== 'function') throw fail()
  let secrets: readonly string[] = []
  if (config.secrets !== undefined) {
    if (types.isProxy(config.secrets) || !Array.isArray(config.secrets) || Object.getPrototypeOf(config.secrets) !== Array.prototype ||
        config.secrets.length > 256 || Reflect.ownKeys(config.secrets).length !== config.secrets.length + 1) throw fail()
    secrets = Array.from({ length: config.secrets.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(config.secrets, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length > 32768) throw fail()
      return descriptor.value as string
    })
  }
  const secretCheck = createAgentSecretTextCheck(secrets)
  const allowsText = config.allowsText as ((value: string) => boolean) | undefined
  const safe = (value: string) => { if (!secretCheck(value) || allowsText && allowsText(value) !== true) throw fail() }
  return function render(document: AgentGroupLogDocument, rows: readonly LogExportLine[], format: 'txt' | 'html' = 'txt'): Readonly<AgentGroupLogArtifact> {
    try {
      if (!['txt', 'html'].includes(format)) throw fail()
      let inputBytes = 0
      const text = (input: unknown, max: number): string => {
        if (typeof input !== 'string' || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input) ||
            !wellFormed(input)) throw fail()
        inputBytes += Buffer.byteLength(input)
        if (inputBytes > maximum) throw fail()
        safe(input); return input
      }
      const source = object(document, ['title', 'startedAt', 'endedAt'])
      const log: LogExportSession = Object.freeze(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, text(value, key === 'title' ? 80 : 64)])))
      if (types.isProxy(rows) || !Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 200_000 ||
          Reflect.ownKeys(rows).length !== rows.length + 1) throw fail()
      const logical: string[] = [log.title ?? '', log.startedAt ?? '', log.endedAt ?? '']
      const lines = Array.from({ length: rows.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(rows, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail()
        const row = object(descriptor.value, ['at', 'name', 'userId', 'content', 'type'])
        if (typeof row.content !== 'string' || row.type !== undefined && !['message', 'dice_result', 'dice_rule'].includes(row.type as string)) throw fail()
        const value: LogExportLine = Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) =>
          [key, text(value, key === 'content' ? maximum : key === 'name' ? 256 : key === 'userId' ? 200 : 64)])))
        logical.push(value.at ?? '', value.name ?? '', value.userId ?? '', value.content ?? '', value.type ?? '')
        return value
      })
      // Check joined source as well as fields, so markup or row boundaries cannot hide a known secret.
      safe(logical.join('')); safe(logical.join('\n'))
      const rendered = (format === 'html' ? renderLogHtml : renderLogText)(log, lines, { maxBytes: maximum })
      safe(rendered)
      const bytes = Buffer.from(rendered, 'utf8'), prefix = Array.from((log.title || 'coc-log').replace(/[\\/:*?"<>|\s\u0000-\u001f\u007f-\u009f]+/gu, '_')).slice(0, 50).join('')
      const name = `${prefix}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${format}`
      safe(name)
      return validateAgentGroupLogArtifact({ name, mime: format === 'html' ? 'text/html' : 'text/plain', base64: bytes.toString('base64') })
    } catch { throw fail() }
  }
}
