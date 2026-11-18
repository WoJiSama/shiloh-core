import { createRequire } from 'node:module'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentBilibiliAuthService, AgentBilibiliAuthSession } from '../../../contracts/agentBilibiliAuth.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { bilibiliGuard } from './agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import { createAgentBilibiliAuthHttp } from './agentBilibiliAuthHttp.js'
import { bilibiliAuthDiagnostic, bilibiliAuthFailure, bilibiliAuthOwner, openAgentBilibiliAuthVault, validBilibiliCredential } from './agentBilibiliAuthVault.js'

export interface AgentBilibiliAuthServiceOptions {
  readonly directory: string
  readonly isLeaseCurrent: () => boolean
  readonly registerSecrets: (values: readonly string[]) => void
  readonly lookup?: AgentBilibiliLookup
  readonly request?: AgentBilibiliRequest
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  readonly timeoutMs?: number
  readonly now?: () => number
}
const qr = createRequire(import.meta.url)('qrcode') as { toBuffer(value: string, options: { type: 'png'; margin: number; width: number }): Promise<Buffer> }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw bilibiliAuthFailure(); return value as Record<string, unknown> }
const cleanUrl = (value: unknown): URL => {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value) || !/^https:\/\/[^/:@?#]+\//u.test(value)) throw bilibiliAuthFailure()
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw bilibiliAuthFailure()
  return url
}

/** QR creation and polling are explicit calls. Only the provider receives cookie text. */
export async function openAgentBilibiliAuthService(options: AgentBilibiliAuthServiceOptions): Promise<AgentBilibiliAuthService> {
  if (!options || typeof options.directory !== 'string' || typeof options.isLeaseCurrent !== 'function' || typeof options.registerSecrets !== 'function' ||
    options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 15_000)) throw bilibiliAuthFailure()
  const vault = await openAgentBilibiliAuthVault(options).catch(error => { bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_service', 'failed', 'auth_service_open_failed', error); throw bilibiliAuthFailure() }), lifetime = new AbortController(), active = new Set<Promise<unknown>>()
  const generations = new Map<string, number>(), sessions = new Map<string, AbortController>(), knownSecrets = new Set(options.secrets ?? [])
  const baseCheck = createAgentSecretTextCheck(options.secrets ?? []), now = options.now ?? Date.now
  const http = createAgentBilibiliAuthHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) })
  let closed = false
  const clock = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw bilibiliAuthFailure(); return at }
  const remember = (values: readonly string[]) => { if (values.some(value => typeof value !== 'string' || !value || value.length > 512_000)) throw bilibiliAuthFailure(); for (const value of values) knownSecrets.add(value); options.registerSecrets(values) }
  const inspect = (value: unknown, exempt: ReadonlySet<string>) => {
    const check = createAgentSecretTextCheck([...knownSecrets]), pending = [{ value, path: '', depth: 0 }]; let count = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++count > 1024 || next.depth > 12) throw bilibiliAuthFailure()
      if (exempt.has(next.path)) continue
      if (typeof next.value === 'string') { if (next.value.length > 8192 || !check(next.value) || options.allowsText?.(next.value) === false) throw bilibiliAuthFailure() }
      else if (Array.isArray(next.value)) throw bilibiliAuthFailure()
      else if (next.value && typeof next.value === 'object') for (const [key, item] of Object.entries(next.value)) { if (key.length > 128 || !check(key)) throw bilibiliAuthFailure(); pending.push({ value: item, path: next.path ? `${next.path}.${key}` : key, depth: next.depth + 1 }) }
    }
  }
  const generation = (owner: string) => generations.get(owner) ?? 0
  const cancelled = (code: 'auth_session_cancelled' | 'auth_session_replaced' | 'auth_logout_cancelled' | 'auth_service_closed') => bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_session', 'cancelled', code, { name: 'AbortError' })
  const revoke = (owner: string, code: 'auth_session_replaced' | 'auth_logout_cancelled') => { generations.set(owner, generation(owner) + 1); const controller = sessions.get(owner); if (controller && !controller.signal.aborted) { controller.abort(); cancelled(code) }; sessions.delete(owner) }
  function run<T>(kind: 'status' | 'credential' | 'logout' | 'start' | 'poll', context: AgentMediaResourceContext, operation: (guard: ReturnType<typeof bilibiliGuard>) => Promise<T>, extra?: { owner: string; revision: number; signal: AbortSignal }): Promise<T> {
    const pending = (async () => {
      let guard: ReturnType<typeof bilibiliGuard> | undefined
      let invalidated = false
      const current = () => {
        try { const value = !closed && !context.signal.aborted && options.isLeaseCurrent() && context.isCurrent() && (!extra || !extra.signal.aborted && generation(extra.owner) === extra.revision); if (!value) invalidated = true; return value }
        catch { invalidated = true; return false }
      }
      try {
        guard = bilibiliGuard({ signal: AbortSignal.any([context.signal, lifetime.signal, ...(extra ? [extra.signal] : [])]), isCurrent: current, ...(context.ensureCurrent ? { ensureCurrent: async () => { try { await context.ensureCurrent!() } catch (error) { invalidated = true; throw error } } } : {}) }, options.timeoutMs ?? 10_000)
        await guard.ensure(); const result = await operation(guard); await guard.ensure(); return result
      } catch (error) {
        const revoked = !current() || invalidated, timedOut = !revoked && guard?.signal.aborted === true
        bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_service', revoked ? 'cancelled' : 'failed', `auth_${kind}_${revoked ? 'cancelled' : timedOut ? 'timeout' : 'failed'}`, revoked ? { name: 'AbortError' } : timedOut ? { name: 'TimeoutError' } : error)
        throw bilibiliAuthFailure()
      } finally { guard?.close() }
    })()
    active.add(pending); void pending.finally(() => active.delete(pending)).catch(() => {}); return pending
  }
  const service: AgentBilibiliAuthService = {
    status(binding, context) { const owner = bilibiliAuthOwner(binding); return run('status', context, async guard => { const value = await vault.read(owner, guard.context); if (value) remember([value.cookie, ...value.cookie.split('; ').map(item => item.slice(item.indexOf('=') + 1))]); return value ? { authorized: true, updatedAt: value.updatedAt } : { authorized: false } }) },
    credential(binding, context) { const owner = bilibiliAuthOwner(binding); return run('credential', context, async guard => { const value = await vault.read(owner, guard.context); if (value) remember([value.cookie, ...value.cookie.split('; ').map(item => item.slice(item.indexOf('=') + 1))]); return value?.cookie }) },
    logout(binding, context) { const owner = bilibiliAuthOwner(binding); revoke(owner, 'auth_logout_cancelled'); return run('logout', context, guard => vault.remove(owner, guard.context)) },
    start(binding: AgentBindingSnapshot, context: AgentMediaResourceContext) {
      const owner = bilibiliAuthOwner(binding); revoke(owner, 'auth_session_replaced')
      const controller = new AbortController(), revision = generation(owner), extra = { owner, revision, signal: controller.signal }
      sessions.set(owner, controller)
      return run('start', context, async guard => {
        const payload = await http('generate', guard), data = object(payload.data), key = data.qrcode_key
        if (payload.code !== 0 || typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/u.test(key) || !baseCheck(key)) throw bilibiliAuthFailure()
        const url = cleanUrl(data.url)
        if (url.hostname !== 'passport.bilibili.com' || url.pathname !== '/h5-app/passport/login/scan' || url.searchParams.getAll('qrcode_key').length !== 1 || url.searchParams.get('qrcode_key') !== key || !baseCheck(url.href)) throw bilibiliAuthFailure()
        const keys = [...url.searchParams.keys()]
        if (new Set(keys).size !== keys.length || keys.some(name => !['qrcode_key', 'navhide', 'from', 'source'].includes(name))) throw bilibiliAuthFailure()
        remember([key, url.href]); inspect(payload, new Set(['data.qrcode_key', 'data.url']))
        const expiresAt = clock() + 170_000, image = await guard.wait(qr.toBuffer(url.href, { type: 'png', margin: 2, width: 480 }))
        if (!Buffer.isBuffer(image) || image.length > 256_000 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw bilibiliAuthFailure()
        const base64 = image.toString('base64'); remember([base64]); await guard.ensure()
        let state: 'waiting' | 'success' | 'expired' = 'waiting', polling = false
        const session: AgentBilibiliAuthSession = {
          image: Object.freeze({ mime: 'image/png', base64 }), expiresAt,
          cancel() { if (!controller.signal.aborted) { controller.abort(); cancelled('auth_session_cancelled') }; if (sessions.get(owner) === controller) sessions.delete(owner) },
          poll(pollContext) { return run('poll', pollContext, async pollGuard => {
            if (polling) throw bilibiliAuthFailure()
            if (state !== 'waiting') return state
            if (clock() >= expiresAt) { state = 'expired'; if (sessions.get(owner) === controller) sessions.delete(owner); return state }
            polling = true
            try {
              const result = await http('poll', pollGuard, key), response = object(result.data)
              if (result.code !== 0) throw bilibiliAuthFailure()
              if (response.code === 86090 || response.code === 86101 || response.code === 86038) {
                inspect(result, new Set()); if (response.code === 86038 || clock() >= expiresAt) { state = 'expired'; if (sessions.get(owner) === controller) sessions.delete(owner) }; return state
              }
              if (response.code !== 0) throw bilibiliAuthFailure()
              const callback = cleanUrl(response.url)
              if (callback.hostname !== 'passport.biligame.com' || callback.pathname !== '/crossDomain' || !baseCheck(callback.href)) throw bilibiliAuthFailure()
              const names = [...callback.searchParams.keys()]
              if (new Set(names).size !== names.length || names.some(name => !['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'Expires', 'gourl'].includes(name))) throw bilibiliAuthFailure()
              const parts = ['SESSDATA', 'bili_jct', 'DedeUserID'].map(name => callback.searchParams.get(name)), cookie = `SESSDATA=${parts[0]}; bili_jct=${parts[1]}; DedeUserID=${parts[2]}`
              if (parts.some(part => !part || !baseCheck(part)) || !validBilibiliCredential(cookie)) throw bilibiliAuthFailure()
              const refresh = response.refresh_token
              if (refresh !== undefined && (typeof refresh !== 'string' || refresh.length > 4096 || /[^\x21-\x7e]/u.test(refresh) || !baseCheck(refresh))) throw bilibiliAuthFailure()
              remember([callback.href, cookie, ...parts as string[], ...(typeof refresh === 'string' && refresh ? [refresh] : [])])
              inspect(result, new Set(['data.url', 'data.refresh_token']))
              if (clock() >= expiresAt) { state = 'expired'; if (sessions.get(owner) === controller) sessions.delete(owner); return state }
              await pollGuard.ensure(); await vault.save({ version: 1, owner, cookie, updatedAt: clock() }, pollGuard.context); await pollGuard.ensure()
              state = 'success'; if (sessions.get(owner) === controller) sessions.delete(owner); return state
            } finally { polling = false }
          }, extra) },
        }
        return Object.freeze(session)
      }, extra).catch(error => { controller.abort(); if (sessions.get(owner) === controller) sessions.delete(owner); throw error })
    },
    async close() { if (closed) return; closed = true; lifetime.abort(); for (const controller of sessions.values()) controller.abort(); sessions.clear(); cancelled('auth_service_closed'); await Promise.allSettled([...active]); try { await vault.close() } catch (error) { bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_cleanup', 'failed', 'auth_vault_close_failed', error); throw error } },
  }
  return Object.freeze(service)
}
export const createAgentBilibiliAuthService = openAgentBilibiliAuthService
