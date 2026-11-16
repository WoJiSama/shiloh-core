import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { douyinFailure, douyinGuard } from './agentDouyinRelayHttp.js'

export interface AgentDouyinNativeOptions { readonly cwd: string; readonly signal: AbortSignal; readonly timeoutMs: number; readonly maxOutputBytes: number }
/** Host-only runtime hook; command and arguments are constructed solely by Core. */
export type AgentDouyinNative = (command: 'ffmpeg' | 'ffprobe', args: readonly string[], options: AgentDouyinNativeOptions) => Promise<{ readonly stdout: string }>
export const nativeAgentDouyinCommand: AgentDouyinNative = (command, args, options) => new Promise((resolve, reject) => {
  let result: { stdout: string } | undefined, failed = false, callbackDone = false, closed = false
  const finish = () => { if (closed && callbackDone) { if (failed || options.signal.aborted || !result) reject(douyinFailure()); else resolve(result) } }
  const child = execFile(command, [...args], { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs, killSignal: 'SIGKILL',
    encoding: 'utf8', maxBuffer: options.maxOutputBytes, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: options.cwd } },
  (error, stdout) => { failed = !!error; callbackDone = true; if (!error && Buffer.byteLength(stdout) <= options.maxOutputBytes) result = { stdout }; finish() })
  child.on('error', () => { failed = true })
  child.once('close', () => { closed = true; finish() })
})

export async function douyinRunNative(native: AgentDouyinNative | undefined, command: 'ffmpeg' | 'ffprobe', args: readonly string[], cwd: string,
  parent: ReturnType<typeof douyinGuard>, timeoutMs: number) {
  const guard = douyinGuard(parent.context, timeoutMs)
  const operation = Promise.resolve().then(() => { guard.check(); return (native ?? nativeAgentDouyinCommand)(command, args, { cwd, signal: guard.signal, timeoutMs, maxOutputBytes: 128 * 1024 }) })
  try { const result = await guard.wait(operation); await guard.ensure(); if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > 128 * 1024) throw douyinFailure(); return result.stdout }
  finally { guard.close(); await operation.catch(() => {}) }
}

export async function douyinFile(file: string, maximum: number) {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum || await realpath(file) !== file) throw douyinFailure()
  return before
}
export async function* douyinFileChunks(file: string, maximum: number, guard: ReturnType<typeof douyinGuard>) {
  await guard.ensure()
  const before = await douyinFile(file, maximum)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw douyinFailure()
    let at = 0
    while (at < stat.size) {
      await guard.ensure()
      const bytes = Buffer.alloc(Math.min(1024 * 1024, stat.size - at)), read = await guard.wait(handle.read(bytes, 0, bytes.length, at))
      if (!read.bytesRead) throw douyinFailure()
      at += read.bytesRead; yield bytes.subarray(0, read.bytesRead)
    }
    const after = await handle.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw douyinFailure()
  } finally { await handle.close() }
}

const ffmpeg = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '268435456', '-threads', '2', '-filter_threads', '1']
const input = (format: string, file: string): string[] => ['-protocol_whitelist', 'file,pipe', '-f', format, ...(format === 'image2' ? ['-pattern_type', 'none'] : []), '-i', file]
export async function douyinConvertImage(file: string, output: string, native: AgentDouyinNative | undefined, guard: ReturnType<typeof douyinGuard>) {
  await douyinFile(file, 32 * 1024 * 1024)
  await douyinRunNative(native, 'ffmpeg', [...ffmpeg, ...input('image2', file), '-frames:v', '1', '-vf', 'scale=2048:2048:force_original_aspect_ratio=decrease',
    '-q:v', '3', '-fs', String(32 * 1024 * 1024), '-y', output], path.dirname(file), guard, 60_000)
  await douyinFile(output, 32 * 1024 * 1024); await chmod(output, 0o400)
}
export async function douyinThumbnail(file: string, output: string, native: AgentDouyinNative | undefined, guard: ReturnType<typeof douyinGuard>, mime = 'video/mp4') {
  await douyinFile(file, 512 * 1024 * 1024)
  await douyinRunNative(native, 'ffmpeg', [...ffmpeg, ...input(mime === 'video/webm' ? 'matroska' : mime === 'video/x-flv' ? 'flv' : 'mov', file), '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4',
    '-fs', String(32 * 1024 * 1024), '-y', output], path.dirname(file), guard, 30_000)
  await douyinFile(output, 32 * 1024 * 1024); await chmod(output, 0o400)
}
export async function douyinSlideshow(images: readonly string[], audio: string, audioFormat: string, output: string, native: AgentDouyinNative | undefined, guard: ReturnType<typeof douyinGuard>) {
  if (!images.length || images.length > 20) throw douyinFailure()
  await douyinFile(audio, 32 * 1024 * 1024)
  const text = await douyinRunNative(native, 'ffprobe', ['-v', 'error', '-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe', '-f', audioFormat,
    '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], path.dirname(audio), guard, 15_000)
  if (!/^\d+(?:\.\d+)?\s*$/u.test(text)) throw douyinFailure()
  const seconds = Number(text.trim())
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw douyinFailure()
  const perImage = Math.min(10, Math.max(2, seconds / images.length)), inputs: string[] = []
  for (const file of images) {
    await douyinFile(file, 32 * 1024 * 1024)
    inputs.push('-loop', '1', '-t', perImage.toFixed(2), ...input('image2', file))
  }
  inputs.push(...input(audioFormat, audio))
  const filters = images.map((_value, index) => `[${index}:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[i${index}]`).join(';')
  await douyinRunNative(native, 'ffmpeg', [...ffmpeg, ...inputs, '-filter_complex_threads', '1', '-filter_complex', `${filters};${images.map((_value, index) => `[i${index}]`).join('')}concat=n=${images.length}:v=1:a=0[v]`,
    '-map', '[v]', '-map', `${images.length}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-t', String(Math.min(seconds, images.length * perImage)), '-movflags', '+faststart',
    '-fs', String(512 * 1024 * 1024), '-y', output], path.dirname(audio), guard, 180_000)
  await douyinFile(output, 512 * 1024 * 1024); await chmod(output, 0o400)
  // -fs can stop an otherwise successful encode early. Validate the complete expected
  // programme before publishing the slideshow; a valid container header is insufficient.
  const probe = await douyinRunNative(native, 'ffprobe', ['-v', 'error', '-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe', '-f', 'mov',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', output], path.dirname(output), guard, 15_000)
  let result: { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[] }
  try { result = JSON.parse(probe) as typeof result } catch { throw douyinFailure() }
  const expected = Math.min(seconds, images.length * perImage), actual = Number(result.format?.duration), streams = result.streams
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.25 || !Array.isArray(streams) || streams.length !== 2 ||
    !streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264' && stream.width === 720 && stream.height === 1280) ||
    !streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac')) throw douyinFailure()
}
