import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { AgentDiagnosticEvent } from '../../../contracts/agentDiagnostics.js'
import { parseAgentDiagnosticEvent } from './agentOperationJournal.js'
import { captureSynchronousGuardCheck, ensureSynchronousGuard } from '../domain/synchronousGuard.js'
import type { SynchronousGuard } from '../domain/synchronousGuard.js'

export type AgentJournalReadGuard = SynchronousGuard
export interface AgentJournalReadResult {
  readonly events: readonly AgentDiagnosticEvent[]
  readonly truncated: boolean
  readonly invalidRecords: number
}
export interface AgentJournalReadOptions {
  readonly dataDir: string
  readonly guard: AgentJournalReadGuard
  readonly allowsText?: (text: string) => boolean
  readonly maxEvents?: number
  readonly maxReadBytes?: number
  readonly maxFiles?: number
  readonly traceId?: string
}

const filePattern = /^\d{4}-\d{2}-\d{2}\.\d{6}\.ndjson$/u
const MiB = 1024 * 1024, maxLine = 8192
const failure = () => new Error('操作日志读取不可用')
function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw failure()
  return result
}

/** Read a fixed, bounded tail without mutating or repairing the writer's files. */
export async function readAgentOperationJournal(options: AgentJournalReadOptions): Promise<AgentJournalReadResult> {
  const traceId = options.traceId
  if (traceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(traceId)) throw failure()
  const traceMarker = traceId ? Buffer.from(JSON.stringify(traceId)) : undefined
  const limit = integer(options.maxEvents, 2000, 1, 10000), budget = integer(options.maxReadBytes, (traceId ? 16 : 4) * MiB, maxLine, 16 * MiB)
  const maximumFiles = integer(options.maxFiles, 14, 1, 128), dataDir = path.resolve(options.dataDir), directory = path.join(dataDir, 'operations')
  const guard = options.guard, captured = captureSynchronousGuardCheck(guard, () => { throw failure() })
  const current = captured ?? (() => ensureSynchronousGuard(guard, () => { throw failure() }))
  let rootIdentity: { dev: number; ino: number } | undefined, directoryIdentity: { dev: number; ino: number } | undefined
  async function directories(): Promise<void> {
    current()
    const root = await fs.lstat(dataDir); current()
    const own = await fs.lstat(directory); current()
    if (!root.isDirectory() || root.isSymbolicLink() || !own.isDirectory() || own.isSymbolicLink() || (own.mode & 0o777) !== 0o700 ||
        rootIdentity && (rootIdentity.dev !== root.dev || rootIdentity.ino !== root.ino) ||
        directoryIdentity && (directoryIdentity.dev !== own.dev || directoryIdentity.ino !== own.ino)) throw failure()
    rootIdentity ??= { dev: root.dev, ino: root.ino }; directoryIdentity ??= { dev: own.dev, ino: own.ino }
  }
  try {
    await directories()
    const entries = await fs.readdir(directory); current()
    if (entries.length > 4096) throw failure()
    const names = entries.filter(name => filePattern.test(name)).sort().reverse()
    let remaining = budget, invalidRecords = 0, truncated = names.length > maximumFiles
    const events: AgentDiagnosticEvent[] = []
    for (const name of names.slice(0, maximumFiles)) {
      if (events.length >= limit || remaining <= 0) { truncated = true; break }
      await directories()
      const filename = path.join(directory, name)
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        current()
        const stat = await handle.stat(); current()
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * MiB) throw failure()
        const actual = await fs.lstat(filename); current()
        if (actual.isSymbolicLink() || stat.dev !== actual.dev || stat.ino !== actual.ino) throw failure()
        const length = Math.min(stat.size, remaining), start = stat.size - length, buffer = Buffer.alloc(length)
        let position = 0
        while (position < length) {
          const read = await handle.read(buffer, position, length - position, start + position); current()
          if (!read.bytesRead) throw failure()
          position += read.bytesRead
        }
        remaining -= length
        let first = 0, end = buffer.length
        if (start > 0) { first = buffer.indexOf(10) + 1; truncated = true; if (first === 0) first = end }
        // A concurrently appended unfinished record is outside this read snapshot.
        if (end && buffer[end - 1] !== 10) { end = buffer.lastIndexOf(10) + 1; truncated = true }
        let lineEnd = end - 1, attempts = 0
        while (lineEnd >= first) {
          if (events.length >= limit || attempts++ >= (traceMarker ? 100_000 : 10_000)) { truncated = true; break }
          const previous = lineEnd > 0 ? buffer.lastIndexOf(10, lineEnd - 1) : -1, lineStart = Math.max(first, previous + 1)
          try {
            if (lineEnd > lineStart) {
              if (lineEnd - lineStart > maxLine) throw failure()
              const bytes = buffer.subarray(lineStart, lineEnd)
              if (!traceMarker || bytes.includes(traceMarker)) {
                const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
                if (options.allowsText?.(line) === false) throw failure()
                const event = parseAgentDiagnosticEvent(JSON.parse(line))
                if (!traceId || event.traceId === traceId) events.push(event)
              }
            }
          } catch { invalidRecords++ }
          lineEnd = previous
        }
        const after = await handle.stat(); current()
        const visible = await fs.lstat(filename); current()
        if (after.size < stat.size || after.dev !== stat.dev || after.ino !== stat.ino || visible.isSymbolicLink() ||
            visible.dev !== stat.dev || visible.ino !== stat.ino || visible.nlink !== 1 || (visible.mode & 0o777) !== 0o600) throw failure()
      } finally { await handle.close() }
      current()
    }
    await directories()
    current()
    return Object.freeze({ events: Object.freeze(events), truncated, invalidRecords })
  } catch {
    // Authorization/cancellation errors retain their fixed host error classification.
    current()
    throw failure()
  }
}
