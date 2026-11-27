import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sha = /^[a-f0-9]{64}$/u
const job = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const duration = 24 * 60 * 60_000
export const engineeringDigest = (text: string) => createHash('sha256').update(text).digest('hex')
export interface EngineeringSource {
  readonly file: string
  readonly from: number
  readonly count: number
  readonly digest: string
}

export function createEngineeringCheckpoint(jobs: string, commit?: string) {
  const identity = (agent: string, task: string) => engineeringDigest(JSON.stringify([agent, task, commit]))
  const file = (id: string) => path.join(jobs, `investigation-${id}.checkpoint`)
  async function load(agent: string, id: string, task: string): Promise<{ round: number; sources: EngineeringSource[]; summarized: boolean } | undefined> {
    if (!commit || !job.test(id)) return
    const filename = file(id)
    try {
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 12_000 || Date.now() - info.mtimeMs > duration) return
      const value = JSON.parse(await readFile(filename, 'utf8'))
      if (value.schema !== 1 || value.key !== identity(agent, task) || !Number.isSafeInteger(value.round) || value.round < 1 || value.round >= 32 ||
          (value.summarized !== undefined && typeof value.summarized !== 'boolean') ||
          !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 12 || !value.sources.every((item: EngineeringSource) =>
            item && typeof item.file === 'string' && item.file.length <= 500 && /^src\/(?:[^/\\]+\/)*[^/\\]+\.ts$/u.test(item.file) &&
            !item.file.split('/').includes('..') && Number.isSafeInteger(item.from) && item.from > 0 && Number.isSafeInteger(item.count) &&
            item.count > 0 && item.count <= 140 && sha.test(item.digest))) return
      return { round: value.round, sources: value.sources, summarized: value.summarized === true }
    } catch { return }
  }
  return {
    load,
    async save(agent: string, id: string, task: string, round: number, sources: readonly EngineeringSource[], summarized: boolean, ensure: () => Promise<void>) {
      if (!commit || !job.test(id) || !sources.length || round >= 32) return
      const filename = file(id), temporary = filename + '.' + randomUUID() + '.tmp'
      await ensure()
      try {
        await writeFile(temporary, JSON.stringify({ schema: 1, key: identity(agent, task), round, sources: sources.slice(-12), summarized }), { flag: 'wx', mode: 0o600 })
        await ensure()
        await rename(temporary, filename)
      } finally { await rm(temporary, { force: true }) }
    },
    async remove(id: string) { if (commit && job.test(id)) await rm(file(id), { force: true }) },
  }
}
