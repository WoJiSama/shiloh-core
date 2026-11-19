import { isDeepStrictEqual, types } from 'node:util'
import type { AgentToolContext } from '../../../contracts/agentTool.js'

type SourceContext = Pick<AgentToolContext, 'binding' | 'actor' | 'request' | 'signal' | 'isCurrent'>
type SourceGuard = SourceContext & { ensureCurrent(): Promise<void> }
type Owner = Readonly<{ guard: SourceGuard; identity: unknown; source: unknown }>
export type AgentToolSourceProof = (() => Promise<void>) & { matchesSource(source: unknown): boolean }
const owners = new WeakMap<SourceGuard['ensureCurrent'], Owner>()
const invalid = () => { throw new Error('工具请求来源已失效') }

function data(value: unknown, depth = 0): unknown {
  if (value === null || ['string', 'boolean', 'number', 'undefined'].includes(typeof value)) return value
  if (!value || typeof value !== 'object' || types.isProxy(value) || depth > 10) return invalid()
  const array = Array.isArray(value)
  if (![Object.prototype, null, ...(array ? [Array.prototype] : [])].includes(Object.getPrototypeOf(value))) return invalid()
  const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
  const keys = Reflect.ownKeys(value)
  if (keys.length > 1000) return invalid()
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (array && key === 'length') { Object.defineProperty(result, key, { value: field?.value }); continue }
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value') || array && !/^(?:0|[1-9]\d*)$/u.test(key)) return invalid()
    Object.defineProperty(result, key, { value: data(field.value, depth + 1), enumerable: true })
  }
  return result
}
function fields(context: SourceContext): Record<string, unknown> {
  if (!context || types.isProxy(context)) return invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of ['binding', 'actor', 'request', 'signal', 'isCurrent', 'ensureCurrent']) {
    const field = Object.getOwnPropertyDescriptor(context, key)
    if (!field || !Object.hasOwn(field, 'value')) return invalid()
    row[key] = field.value
  }
  return row
}
const identity = (row: Record<string, unknown>) => data([row.binding, row.actor, row.request])
function intact(context: SourceContext, owner: Owner): boolean {
  try {
    const row = fields(context)
    return row.signal === owner.guard.signal && row.isCurrent === owner.guard.isCurrent && row.ensureCurrent === owner.guard.ensureCurrent &&
      isDeepStrictEqual(identity(row), owner.identity)
  } catch { return false }
}

/** Core supplies its complete fresh source validator, including original bytes/time and privacy.
 * This brands ownership of that validator, never the result of a completed authorization. */
export function createAgentToolSourceGuard(context: SourceContext, ensureSource: () => Promise<void>): SourceGuard {
  const ensureCurrent = async () => { await ensureSource() }
  const guard = Object.freeze({ ...context, ensureCurrent })
  const snapshot = identity(fields(guard)) as [unknown, AgentToolContext['actor'], AgentToolContext['request']]
  const source = snapshot[1].kind === 'user' && snapshot[1].user && snapshot[2]
    ? data({ messageId: snapshot[2].messageId, author: snapshot[1].user }) : undefined
  const owner = Object.freeze({ guard, identity: snapshot, source })
  owners.set(ensureCurrent, owner)
  return guard
}

/** Copies retain the fast path only with the exact owned method tuple and source identity.
 * Capturing invokes no methods/getters; each returned invocation performs a fresh source read. */
export function captureAgentToolSourceGuard(context: AgentToolContext): AgentToolSourceProof | undefined {
  try {
    const row = fields(context), owner = typeof row.ensureCurrent === 'function' ? owners.get(row.ensureCurrent as SourceGuard['ensureCurrent']) : undefined
    if (!owner || !intact(context, owner)) return undefined
    const proof = async () => {
      if (owner.guard.signal.aborted || !intact(context, owner)) return invalid()
      await owner.guard.ensureCurrent()
      if (owner.guard.signal.aborted || !intact(context, owner)) return invalid()
    }
    return Object.freeze(Object.assign(proof, { matchesSource(source: unknown): boolean {
      try { return !owner.guard.signal.aborted && intact(context, owner) && owner.source !== undefined && isDeepStrictEqual(data(source), owner.source) }
      catch { return false }
    } }))
  } catch { return undefined }
}
