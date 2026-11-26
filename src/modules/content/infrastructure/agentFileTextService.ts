import { fork, execFile } from 'node:child_process'
import type { ChildProcess, ForkOptions } from 'node:child_process'
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { AgentFileTextError, fileTextArchiveEntry, isFileTextErrorCode, MAX_FILE_TEXT_BYTES, nativeFormats, pagination, fileTextPage } from './agentFileTextTypes.js'
import type { AgentFileTextRequest, AgentFileTextPage, FileTextNativeFormat } from './agentFileTextTypes.js'
import { fileTextZipBudget } from './agentFileTextZip.js'
import type { FileTextZipBudget } from './agentFileTextZip.js'

export type AgentFileTextContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export interface AgentFileTextService { extract(input: AgentFileTextRequest, context: AgentFileTextContext): Promise<AgentFileTextPage> }
export interface AgentFileTextServiceOptions {
  readonly nativeFormats?: readonly FileTextNativeFormat[]
  /** Includes queued time and authorization; can only shorten the twenty second deadline. */
  readonly timeoutMs?: number
  readonly maxQueued?: number
  readonly zipBudget?: Partial<FileTextZipBudget>
  /** Trusted test/host seam. Never exposed to model parameters or file contents. */
  readonly childFactory?: (url: URL, options: ForkOptions) => ChildProcess
}
const unavailable = () => new AgentFileTextError()
function current(context: AgentFileTextContext, signal: AbortSignal) {
  try { return !signal.aborted && !context.signal.aborted && context.isCurrent() } catch { return false }
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable())
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, () => { signal.removeEventListener('abort', abort); reject(unavailable()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
}
interface Job {
  readonly input: AgentFileTextRequest & { offset: number; limit: number }
  readonly context: AgentFileTextContext
  readonly signal: AbortSignal
  resolve(page: AgentFileTextPage): void
  reject(error: Error): void
  cleanup(): void
  authority?: Promise<void>
  preparation?: Promise<void>
  directory?: string
  child?: ChildProcess
  closed?: Promise<void>
  ending: boolean
  reserved: boolean
  received: boolean
}
function childEnvironment(directory: string): NodeJS.ProcessEnv {
  return { PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
}
async function stopChild(child: ChildProcess, closed: Promise<void>) {
  if (child.pid) {
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()))
      child.kill('SIGKILL')
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  await closed
}
/** A single detached parser process group, four bounded waiters, and no cross-turn text or file caches. */
export function createAgentFileTextService(options: AgentFileTextServiceOptions = {}): AgentFileTextService {
  const enabled = nativeFormats(options.nativeFormats), budget = fileTextZipBudget(options.zipBudget)
  const timeoutMs = options.timeoutMs ?? 20_000, maxQueued = options.maxQueued ?? 4
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000 || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 4) throw unavailable()
  const childFactory = options.childFactory ?? ((url, config) => fork(url, [], config))
  const queue: Job[] = []; let active = false
  async function authorize(job: Job) {
    if (!current(job.context, job.signal)) throw unavailable()
    if (!job.authority) {
      const checking = bounded(Promise.resolve().then(async () => {
        if (!current(job.context, job.signal)) throw unavailable()
        await job.context.ensureCurrent?.()
        if (!current(job.context, job.signal)) throw unavailable()
      }), job.signal)
      job.authority = checking
      void checking.finally(() => { if (job.authority === checking) delete job.authority }).catch(() => {})
    }
    await job.authority
  }
  async function finish(job: Job, error?: AgentFileTextError, page?: AgentFileTextPage) {
    if (job.ending) return
    job.ending = true
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1)
    try {
      // Cancellation during temp creation must wait for ownership before deleting it.
      await job.preparation?.catch(() => {})
      if (job.child && job.closed) await stopChild(job.child, job.closed)
      if (job.directory) await rm(job.directory, { recursive: true, force: true, maxRetries: 2 })
      if (!current(job.context, job.signal) || error || !page) job.reject(current(job.context, job.signal) && error ? error : unavailable())
      else job.resolve(page)
    } catch { job.reject(unavailable()) }
    finally { job.cleanup(); if (job.reserved) active = false; pump() }
  }
  async function run(job: Job) {
    try {
      await authorize(job); if (job.ending) return
      job.preparation = (async () => {
        job.directory = await mkdtemp(path.join(tmpdir(), 'bl-agent-file-'))
        await chmod(job.directory, 0o700)
        await writeFile(path.join(job.directory, 'input'), job.input.bytes, { mode: 0o600, flag: 'wx' })
      })()
      await job.preparation
      if (job.ending) return
      await authorize(job); if (job.ending) return
      const child = childFactory(new URL('./agentFileTextChild.js', import.meta.url), {
        cwd: job.directory!, env: childEnvironment(job.directory!), detached: true, execArgv: ['--max-old-space-size=256'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
      })
      job.child = child
      job.closed = new Promise(resolve => child.once('close', () => resolve()))
      child.once('error', () => { void finish(job, unavailable()) })
      child.once('close', () => { if (!job.received) void finish(job, unavailable()) })
      child.once('message', (raw: unknown) => {
        job.received = true
        void (async () => {
          if (job.ending) return
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unavailable()
          const value = raw as Record<string, unknown>
          if (value.ok !== true) {
            await finish(job, new AgentFileTextError(isFileTextErrorCode(value.code) ? value.code : 'invalid')); return
          }
          const page = fileTextPage(value.page, job.input.offset, job.input.limit)
          await authorize(job)
          await finish(job, undefined, page)
        })().catch(() => { void finish(job, unavailable()) })
      })
      child.send({ source: job.input.source, archiveEntry: job.input.archiveEntry, offset: job.input.offset, limit: job.input.limit,
        nativeFormats: enabled, zipBudget: budget }, error => { if (error) void finish(job, unavailable()) })
      if (!current(job.context, job.signal)) void finish(job, unavailable())
    } catch { void finish(job, unavailable()) }
  }
  function pump() {
    if (active) return
    const job = queue.shift(); if (!job) return
    if (job.ending) { pump(); return }
    active = true; job.reserved = true; void run(job)
  }
  return {
    async extract(input, context) {
      if (!input || !(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_FILE_TEXT_BYTES || !input.source ||
          typeof input.source.name !== 'string' || !input.source.name.trim() || input.source.name.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(input.source.name) ||
          typeof input.source.mime !== 'string' || input.source.mime.length > 128 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(input.source.mime) ||
          input.source.origin !== undefined && !['current', 'reply', 'recent', 'group_file', 'explicit'].includes(input.source.origin)) throw unavailable()
      const page = pagination(input)
      const archiveEntry = fileTextArchiveEntry(input.archiveEntry)
      const owned = { bytes: Uint8Array.from(input.bytes), source: Object.freeze({ name: input.source.name, mime: input.source.mime,
        ...(input.source.origin ? { origin: input.source.origin } : {}) }), ...(archiveEntry === undefined ? {} : { archiveEntry }), ...page }
      if (!current(context, context.signal) || active && queue.length >= maxQueued) throw unavailable()
      return await new Promise<AgentFileTextPage>((resolve, reject) => {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
        const abort = () => { void finish(job, unavailable()) }
        const timer = setInterval(() => { if (!job.ending) void authorize(job).catch(abort) }, 25)
        const job: Job = { input: owned, context, signal, resolve, reject, ending: false, reserved: false, received: false,
          cleanup() { clearInterval(timer); signal.removeEventListener('abort', abort) } }
        signal.addEventListener('abort', abort, { once: true }); queue.push(job)
        if (signal.aborted) abort(); else pump()
      })
    },
  }
}
