import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { AgentMediaArtifact, AgentMediaArtifactLease } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { bilibiliFailure, bilibiliGuard } from './agentBilibiliRelayHttp.js'

/** Trusted runtime hook: both paths are provider-created inside a private directory. */
export type AgentBilibiliThumbnail = (inputFile: string, outputFile: string, signal: AbortSignal) => Promise<void>
const nativeThumbnail: AgentBilibiliThumbnail = (input, output, signal) => new Promise((resolve, reject) => {
  const format = input.endsWith('.flv') ? 'flv' : input.endsWith('.webm') ? 'matroska' : 'mov'
  const child = execFile('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', output],
  { timeout: 30_000, signal, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }, error => { if (error) reject(bilibiliFailure()); else resolve() })
  child.on('error', () => {})
})

export async function prepareBilibiliThumbnail(artifact: AgentMediaArtifact, options: {
  directory: string; artifacts: AgentMediaArtifactStore; guard: ReturnType<typeof bilibiliGuard>; thumbnail?: AgentBilibiliThumbnail
}): Promise<AgentMediaArtifactLease> {
  let directory = '', reader: Awaited<ReturnType<AgentMediaArtifactStore['open']>> | undefined
  const guard = bilibiliGuard(options.guard.context, 30_000)
  try {
    await guard.ensure()
    const parent = await guard.wait(realpath(options.directory)), parentStat = await guard.wait(lstat(parent))
    if (!parentStat.isDirectory()) throw bilibiliFailure()
    directory = await guard.wait(mkdtemp(path.join(parent, 'bilibili-thumb-')), late => rm(late, { recursive: true, force: true }))
    await chmod(directory, 0o700)
    const input = path.join(directory, `input${artifact.mime === 'video/x-flv' ? '.flv' : artifact.mime === 'video/webm' ? '.webm' : '.mp4'}`), output = path.join(directory, 'cover.jpg')
    const file = await guard.wait(open(input, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), late => late.close())
    try {
      reader = await guard.wait(options.artifacts.open(artifact, guard.context), late => late.close())
      for await (const bytes of reader.chunks) {
        await guard.ensure(); let at = 0
        while (at < bytes.length) { const written = await guard.wait(file.write(bytes, at, bytes.length - at)); if (written.bytesWritten < 1) throw bilibiliFailure(); at += written.bytesWritten }
      }
      await guard.ensure()
    } finally { await file.close(); await reader?.close(); reader = undefined }
    await chmod(input, 0o400)
    await guard.ensure()
    await guard.wait((options.thumbnail ?? nativeThumbnail)(input, output, guard.signal))
    await guard.ensure()
    const result = await guard.wait(lstat(output))
    if (!result.isFile() || result.isSymbolicLink() || result.nlink !== 1 || result.size < 1 || result.size > 32 * 1024 * 1024 || await realpath(output) !== output) throw bilibiliFailure()
    await chmod(output, 0o400)
    const lease = await guard.wait(options.artifacts.stage({ kind: 'image', mime: 'image/jpeg', chunks: (async function* () {
      const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await handle.stat()
        if (!actual.isFile() || actual.dev !== result.dev || actual.ino !== result.ino || actual.size !== result.size) throw bilibiliFailure()
        let at = 0
        while (at < result.size) {
          await guard.ensure(); const bytes = Buffer.alloc(Math.min(1024 * 1024, result.size - at))
          const read = await guard.wait(handle.read(bytes, 0, bytes.length, at))
          if (read.bytesRead < 1) throw bilibiliFailure(); at += read.bytesRead; yield bytes.subarray(0, read.bytesRead)
        }
      } finally { await handle.close() }
    })() }, guard.context), late => late.release())
    try { await guard.ensure(); return lease } catch { await lease.release(); throw bilibiliFailure() }
  } catch { throw bilibiliFailure() }
  finally { guard.close(); await reader?.close().catch(() => {}); if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}) }
}
