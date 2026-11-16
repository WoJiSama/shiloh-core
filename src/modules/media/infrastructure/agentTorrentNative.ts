import { spawn } from 'node:child_process'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'

export const torrentFailure = () => new Error('磁链处理失败：来源、权限、网络、完整性或资源限制不符合要求')
export const torrentTimeout = (value: number | undefined, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum

export function torrentGuard(context: AgentMediaResourceContext, timeoutMs: number) {
  if (!context || !(context.signal instanceof AbortSignal) || typeof context.isCurrent !== 'function' || context.ensureCurrent !== undefined && typeof context.ensureCurrent !== 'function') throw torrentFailure()
  const cancel = new AbortController(), signal = AbortSignal.any([context.signal, cancel.signal])
  const check = () => { if (signal.aborted || context.isCurrent() !== true) throw torrentFailure() }
  const wait = <T>(operation: Promise<T>, late?: (value: T) => unknown): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(torrentFailure()) }
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      try { if (settled) throw torrentFailure(); check(); settled = true; resolve(value) }
      catch { if (late) void Promise.resolve().then(() => late(value)).catch(() => {}); reject(torrentFailure()) }
    }, () => { settled = true; signal.removeEventListener('abort', abort); reject(torrentFailure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  let checking = false
  const watcher = setInterval(() => {
    try {
      check()
      if (context.ensureCurrent && !checking) { checking = true; void Promise.resolve().then(() => context.ensureCurrent!()).catch(() => cancel.abort()).finally(() => { checking = false }) }
    } catch { cancel.abort() }
  }, 20)
  const timer = setTimeout(() => cancel.abort(), timeoutMs); timer.unref(); watcher.unref()
  return { signal, wait, check, abort() { cancel.abort() },
    async ensure() { check(); if (context.ensureCurrent) await wait(Promise.resolve().then(() => context.ensureCurrent!())); check() },
    context: { signal, isCurrent: () => { try { check(); return true } catch { return false } }, ...(context.ensureCurrent ? { ensureCurrent: () => context.ensureCurrent!() } : {}) },
    close() { clearTimeout(timer); clearInterval(watcher); cancel.abort() } }
}

/** Trusted host hook. Resolve/reject only after the child has closed; honor signal. Never accept model-controlled executables. */
export type AgentTorrentCommand = (command: 'aria2c' | 'zip', args: readonly string[], options: {
  readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal
}) => Promise<void>

export const nativeAgentTorrentCommand: AgentTorrentCommand = (command, args, options) => new Promise((resolve, reject) => {
  if (!['aria2c', 'zip'].includes(command) || options.signal.aborted) { reject(torrentFailure()); return }
  let failed = false, count = 0
  const child = spawn(command, [...args], { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: options.cwd, TMPDIR: options.cwd } })
  const stop = () => { failed = true; child.kill('SIGKILL') }
  const output = (chunk: Buffer) => { count += chunk.length; if (count > 128 * 1024) stop() }
  child.stdout.on('data', output); child.stderr.on('data', output)
  child.on('error', () => { failed = true })
  const timer = setTimeout(stop, options.timeoutMs)
  options.signal.addEventListener('abort', stop, { once: true })
  if (options.signal.aborted) stop()
  child.once('close', code => {
    clearTimeout(timer); options.signal.removeEventListener('abort', stop)
    if (failed || code !== 0 || options.signal.aborted) reject(torrentFailure()); else resolve()
  })
})
