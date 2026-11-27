import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentDiagnosticInput, AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'

const sweepIntervalMs = 60_000
const retentionMs = 10 * sweepIntervalMs
const ownerFile = '.file-text-owner'
const jobName = /^read-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const marker = (name: string) => `agent-file-text-v1 ${name}\n`
const unavailable = () => new Error('文件解析临时目录不可用')
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const sameDirectory = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino

export interface AgentFileTextTemporaryDirectory {
  readonly path: string
  remove(): Promise<void>
}

/** Only the standalone instance lease holder may create or reap marked parser workspaces. */
export function createAgentFileTextWorkspace(options: {
  dataDir: string
  instance: string
  isLeaseCurrent(): boolean
  diagnostics?: Pick<AgentDiagnostics, 'emit'>
}) {
  const base = path.resolve(options.dataDir), instance = createHash('sha256').update(options.instance).digest('hex').slice(0, 32)
  const rootName = `.agent-file-text-${instance}`, uid = process.getuid?.()
  const active = new Map<string, Promise<void>>()
  let pinned: { directory: string; stat: Stats } | undefined
  let sweeping: Promise<void> | undefined, closed = false
  const privateDirectory = (stat: Stats) => stat.isDirectory() && stat.uid === uid && (stat.mode & 0o7777) === 0o700
  const owned = () => {
    if (!options.isLeaseCurrent()) throw unavailable()
  }
  const emit = (event: AgentDiagnosticInput) => {
    try { options.diagnostics?.emit(event) }
    catch { /* Observing cleanup must not prevent future sweeps. */ }
  }
  const report = (step: 'file_temp_create' | 'file_temp_scan' | 'file_temp_remove', error: unknown) =>
    emit({ stage: 'host', operation: 'file_text_cleanup', outcome: 'failed',
      code: step === 'file_temp_create' ? 'file_text_temp_unavailable' : 'file_text_cleanup_failed', details: { step }, error })
  const statIfPresent = async (directory: string) => {
    try { return await lstat(directory) } catch (error) { if (errno(error) !== 'ENOENT') throw error }
  }

  async function root(create: boolean) {
    owned()
    const parent = await lstat(base)
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) throw unavailable()
    const directory = path.join(await realpath(base), rootName)
    let stat = await statIfPresent(directory)
    if (!stat && create && !pinned) {
      owned()
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (errno(error) !== 'EEXIST') throw error }
      stat = await lstat(directory)
    }
    if (!stat && !pinned) return undefined
    if (!stat || !privateDirectory(stat) || await realpath(directory) !== directory ||
        pinned && (directory !== pinned.directory || !sameDirectory(pinned.stat, stat))) throw unavailable()
    owned()
    return pinned ??= { directory, stat }
  }

  async function remove(directory: string, original: Stats, cutoff?: number) {
    const parent = await root(false), current = await statIfPresent(directory)
    if (!current) return false
    if (!parent || path.dirname(directory) !== parent.directory || !privateDirectory(current) || current.dev !== parent.stat.dev ||
        !sameDirectory(original, current)) throw unavailable()
    if (cutoff !== undefined && (current.mtimeMs > cutoff || active.has(directory))) return false
    // Keep ownership evidence until all parser data is gone, including across a second crash during cleanup.
    for (const name of await readdir(directory)) {
      if (name === ownerFile) continue
      owned()
      await rm(path.join(directory, name), { recursive: true, force: true, maxRetries: 2 })
    }
    owned()
    await rm(path.join(directory, ownerFile), { force: true })
    await rmdir(directory)
    return true
  }

  async function hasMarker(directory: string, expected: string) {
    const file = await open(path.join(directory, ownerFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (errno(error) !== 'ENOENT' && errno(error) !== 'ELOOP') throw error
    })
    if (!file) return false
    try {
      const stat = await file.stat(), bytes = Buffer.alloc(Buffer.byteLength(expected))
      return stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size === bytes.length &&
        (await file.read(bytes)).bytesRead === bytes.length && bytes.toString('utf8') === expected
    } finally { await file.close() }
  }

  function sweep() {
    if (closed || !options.isLeaseCurrent()) return Promise.resolve()
    return sweeping ??= (async () => {
      let removed = false
      const parent = await root(false)
      if (!parent) return
      const cutoff = Date.now() - retentionMs
      for (const name of await readdir(parent.directory)) {
        if (closed || !options.isLeaseCurrent()) break
        if (!jobName.test(name)) continue
        const directory = path.join(parent.directory, name)
        if (active.has(directory)) continue
        try {
          const stat = await statIfPresent(directory)
          if (stat && privateDirectory(stat) && stat.dev === parent.stat.dev && stat.mtimeMs <= cutoff &&
              await hasMarker(directory, marker(name)) && await remove(directory, stat, cutoff)) removed = true
        } catch (error) { if (options.isLeaseCurrent()) report('file_temp_remove', error) }
      }
      if (removed) emit({ stage: 'host', operation: 'file_text_cleanup', outcome: 'succeeded', code: 'file_text_orphans_removed' })
    })().catch(error => { if (options.isLeaseCurrent()) report('file_temp_scan', error) }).finally(() => { sweeping = undefined })
  }
  const timer = setInterval(() => { void sweep() }, sweepIntervalMs)
  timer.unref?.()

  return {
    sweep,
    async create(): Promise<AgentFileTextTemporaryDirectory> {
      let directory: string | undefined, stat: Stats | undefined, release: (() => void) | undefined
      try {
        if (closed) throw unavailable()
        const parent = await root(true)
        if (!parent || closed) throw unavailable()
        const name = `read-${randomUUID()}`
        directory = path.join(parent.directory, name)
        active.set(directory, new Promise<void>(resolve => { release = resolve }))
        await mkdir(directory, { mode: 0o700 })
        stat = await lstat(directory)
        if (!privateDirectory(stat) || stat.dev !== parent.stat.dev) throw unavailable()
        await writeFile(path.join(directory, ownerFile), marker(name), { mode: 0o600, flag: 'wx' })
        owned()
        const file = directory, created = stat
        return { path: file, async remove() {
          try { await remove(file, created) }
          catch (error) { report('file_temp_remove', error); throw error }
          finally { active.delete(file); release?.() }
        } }
      } catch (error) {
        if (directory) {
          if (stat) await remove(directory, stat).catch(failure => report('file_temp_remove', failure))
          active.delete(directory)
          release?.()
        }
        report('file_temp_create', error)
        throw error
      }
    },
    async close() {
      closed = true
      clearInterval(timer)
      await Promise.all([sweeping, ...active.values()])
    },
  }
}
