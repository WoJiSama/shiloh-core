import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

interface Context { signal: AbortSignal; isCurrent(): boolean; ensureCurrent?(): Promise<void> }
const valid = (value: unknown): value is string => typeof value === 'string' && /^[\x20-\x7e]{1,32768}$/u.test(value)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failure = () => new Error('音乐凭据存储不可用')
async function current(context: Context) {
  context.signal.throwIfAborted()
  if (!context.isCurrent()) throw failure()
  await context.ensureCurrent?.()
  context.signal.throwIfAborted()
  if (!context.isCurrent()) throw failure()
}

/** Host-private state for the explicitly configured music-service credential, never conversation memory. */
export async function openAgentMusicCookieStore(dataDir: string, seed: string) {
  if (!seed) return { cookie: '', async save(_cookie: string, _context: Context): Promise<void> { throw failure() } }
  if (!valid(seed)) throw failure()
  const directory = path.join(dataDir, 'music-credentials'), file = path.join(directory, 'qq-music.json'), seedHash = hash(seed)
  async function ensureDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw failure()
  }
  await ensureDirectory()
  let cookie = seed
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 128 * 1024) throw failure()
      const stored: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw failure()
      const row = stored as Record<string, unknown>
      if (Object.keys(row).some(key => !['version', 'seedHash', 'cookie'].includes(key)) || row.version !== 1 || typeof row.seedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.seedHash) || !valid(row.cookie)) throw failure()
      if (row.seedHash === seedHash) cookie = row.cookie
    } finally { await handle.close() }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw failure()
  }
  return { cookie, async save(next: string, context: Context) {
    if (!valid(next)) throw failure()
    await current(context)
    await ensureDirectory()
    const temporary = path.join(directory, `.qq-music-${randomUUID()}.json`)
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, seedHash, cookie: next }) + '\n', { mode: 0o600, flag: 'wx' })
      await current(context)
      await fs.rename(temporary, file)
    } catch { throw failure() } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  } }
}
