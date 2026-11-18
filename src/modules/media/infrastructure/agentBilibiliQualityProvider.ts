import { types } from 'node:util'
import type { AgentBilibiliQualityProvider, AgentBilibiliQualityRequest, AgentPreparedBilibiliQuality } from '../../../contracts/agentBilibiliQuality.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import { bilibiliFailure, bilibiliGuard } from './agentBilibiliRelayHttp.js'
import { createAgentBilibiliRelayProviderWithProfile } from './agentBilibiliRelayProvider.js'
import type { AgentBilibiliRelayProviderOptions } from './agentBilibiliRelayProvider.js'
import { validateAgentMediaShare } from './agentBilibiliRelayReference.js'

export type AgentBilibiliSearchAttachmentProviderOptions = Omit<AgentBilibiliRelayProviderOptions, 'authCookie' | 'autoAuthorizedRetry'>
export interface AgentBilibiliQualityProviderOptions extends AgentBilibiliSearchAttachmentProviderOptions {
  /** Trusted host authorization. Credentials never enter a request, plan or result. */
  readonly credential: (context: AgentMediaResourceContext) => string | Promise<string>
}

function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw bilibiliFailure()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw bilibiliFailure()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw bilibiliFailure()
    result[key] = descriptor.value
  }
  return result
}

function configuration(input: unknown, authorized: boolean) {
  try {
    const row = data(input, ['directory', 'artifacts', 'allowsText', 'secrets', 'lookup', 'request', 'thumbnail', 'timeoutMs', 'diagnostics', ...(authorized ? ['credential'] : [])])
    if (typeof row.directory !== 'string' || !row.directory.startsWith('/') || !row.artifacts || typeof row.artifacts !== 'object' || types.isProxy(row.artifacts)) throw bilibiliFailure()
    for (const key of ['stage', 'open']) {
      const descriptor = Object.getOwnPropertyDescriptor(row.artifacts, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw bilibiliFailure()
    }
    for (const key of ['allowsText', 'lookup', 'request', 'thumbnail', 'credential']) {
      const value = row[key]
      if (value !== undefined && (typeof value !== 'function' || types.isProxy(value))) throw bilibiliFailure()
    }
    if (authorized && typeof row.credential !== 'function' || row.timeoutMs !== undefined &&
        (typeof row.timeoutMs !== 'number' || !Number.isSafeInteger(row.timeoutMs) || row.timeoutMs < 1 || row.timeoutMs > 600_000)) throw bilibiliFailure()
    let diagnostics: AgentBilibiliRelayProviderOptions['diagnostics']
    if (row.diagnostics !== undefined) {
      const observer = row.diagnostics
      if (!observer || typeof observer !== 'object' || types.isProxy(observer) || ![Object.prototype, null].includes(Object.getPrototypeOf(observer))) throw bilibiliFailure()
      const descriptor = Object.getOwnPropertyDescriptor(observer, 'emit')
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw bilibiliFailure()
      const emit = descriptor.value
      diagnostics = Object.freeze({ emit: event => Reflect.apply(emit, observer, [event]) })
    }
    let secrets: string[] | undefined
    if (row.secrets !== undefined) {
      if (!Array.isArray(row.secrets) || types.isProxy(row.secrets) || Object.getPrototypeOf(row.secrets) !== Array.prototype || row.secrets.length > 256 ||
          Reflect.ownKeys(row.secrets).length !== row.secrets.length + 1) throw bilibiliFailure()
      secrets = []
      for (let index = 0; index < row.secrets.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(row.secrets, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length > 32_768) throw bilibiliFailure()
        secrets.push(descriptor.value)
      }
    }
    const { credential, secrets: _secrets, diagnostics: _diagnostics, ...base } = row
    return { options: Object.freeze({ ...base, ...(secrets ? { secrets: Object.freeze(secrets) } : {}), ...(diagnostics ? { diagnostics } : {}) }) as unknown as AgentBilibiliSearchAttachmentProviderOptions,
      credential: credential as AgentBilibiliQualityProviderOptions['credential'] }
  } catch { throw bilibiliFailure() }
}

/** Explicit authorized extraction; every playback request uses this invocation's credential. */
export function createAgentBilibiliQualityProvider(input: AgentBilibiliQualityProviderOptions): AgentBilibiliQualityProvider {
  const { options, credential } = configuration(input, true)
  const diagnose = (code: string, context?: AgentMediaResourceContext) => {
    let outcome: 'failed' | 'cancelled' = 'failed'
    if (context) { try { if (context.signal.aborted || !context.isCurrent()) outcome = 'cancelled' } catch { outcome = 'cancelled' } }
    const event = { stage: 'runtime' as const, operation: 'bilibili_quality_provider', outcome, code }
    try { if (options.diagnostics) { options.diagnostics.emit(event); return } } catch { /* Observer failure cannot change provider authority. */ }
    try { console.error(`[Agent] runtime/bilibili_quality_provider ${outcome} ${code}`) } catch { /* No remaining writable observer. */ }
  }
  const release = async (prepared: AgentPreparedBilibiliQuality) => {
    try { await prepared.release() } catch { diagnose('prepared_release_failed') }
  }
  return Object.freeze({ async prepare(input: AgentBilibiliQualityRequest, context: AgentMediaResourceContext): Promise<AgentPreparedBilibiliQuality> {
    let guard: ReturnType<typeof bilibiliGuard> | undefined
    let phase: 'request_invalid' | 'credential_unavailable' | 'quality_prepare_unavailable' = 'request_invalid'
    try {
      const row = data(input, ['share', 'quality'])
      if (typeof row.quality !== 'number' || !Number.isSafeInteger(row.quality) || row.quality < 1 || row.quality > 127) throw bilibiliFailure()
      const share = validateAgentMediaShare(row.share)
      if (share.provider !== 'bilibili') throw bilibiliFailure()
      guard = bilibiliGuard(context, 90 * 60 * 1000)
      await guard.ensure()
      phase = 'credential_unavailable'
      const cookie = await guard.wait(Promise.resolve().then(() => credential(guard!.context)))
      await guard.ensure()
      if (typeof cookie !== 'string' || !cookie) throw bilibiliFailure()
      phase = 'quality_prepare_unavailable'
      const provider = createAgentBilibiliRelayProviderWithProfile({ ...options, authCookie: cookie }, { mode: 'quality', quality: row.quality })
      const result = await guard.wait(provider.prepare(share, guard.context), release)
      try { await guard.ensure(); return result } catch { await release(result); throw bilibiliFailure() }
    } catch { diagnose(phase, context); throw bilibiliFailure() }
    finally { guard?.close() }
  } })
}

/** Optional future search attachment, fixed at anonymous qn16 / two 30MiB segments. */
export function createAgentBilibiliSearchAttachmentProvider(input: AgentBilibiliSearchAttachmentProviderOptions): AgentMediaRelayProvider {
  const { options } = configuration(input, false)
  const provider = createAgentBilibiliRelayProviderWithProfile(options, { mode: 'attachment', quality: 16 })
  return Object.freeze({ async prepare(share: AgentMediaShare, context: AgentMediaResourceContext) {
    const result = await provider.prepare(share, context)
    return Object.freeze({ status: result.status, pageUrl: result.pageUrl, infoText: result.infoText, plan: result.plan, release: result.release })
  } })
}
