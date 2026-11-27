import type { SimHistoryMessage } from '../../../contracts/simulation.js'
import { createHash } from 'node:crypto'
import { excerptContext } from '../../models/domain/requestContext.js'

const earlierReadBudgetBytes = 12 * 1024

interface ReadEntry {
  readonly index: number
  readonly round: number
  readonly bytes: number
  readonly excerpt?: string
  readonly sameRead?: string
  readonly sourceKey?: string
  readonly callId: string
  readonly savedBytes: number
  compacted: boolean
}

export function createSimulationReadContext(allowsText?: (content: string) => boolean) {
  const entries: ReadEntry[] = []
  let latestRound = 0

  return {
    note(index: number, round: number, shown: string, result: { excerpt?: string; sourceKey?: string; sameRead?: string }, callId: string) {
      latestRound = round
      const bytes = Buffer.byteLength(JSON.stringify(shown))
      const savedBytes = result.excerpt === undefined ? 0 : bytes - Buffer.byteLength(JSON.stringify(result.excerpt))
      const sourceKey = result.sourceKey ? createHash('sha256').update(result.sourceKey).digest('hex') : undefined
      entries.push({ index, round, bytes, callId, savedBytes, compacted: false,
        ...(result.excerpt ? { excerpt: result.excerpt } : {}), ...(sourceKey && result.sameRead ? { sourceKey, sameRead: result.sameRead } : {}) })
    },
    project(history: readonly SimHistoryMessage[]) {
      const earlier = entries.filter(entry => entry.round < latestRound)
      const latestSource = new Map<string, ReadEntry>()
      for (const entry of entries) if (entry.sourceKey) latestSource.set(entry.sourceKey, entry)
      const replacements = new Map<number, string>()
      let bytes = 0, repeatedReads = 0
      for (const entry of earlier) {
        const latest = entry.sourceKey && latestSource.get(entry.sourceKey)
        if (latest && latest !== entry && entry.sameRead) {
          const replacement = `${entry.sameRead}\n工具调用编号：${latest.callId}`
          if (Buffer.byteLength(JSON.stringify(replacement)) < entry.bytes && allowsText?.(replacement) !== false) {
            replacements.set(entry.index, replacement)
            repeatedReads++
          }
        }
        bytes += replacements.has(entry.index) ? Buffer.byteLength(JSON.stringify(replacements.get(entry.index))) : entry.bytes - (entry.compacted ? entry.savedBytes : 0)
      }
      for (const entry of earlier) {
        if (bytes <= earlierReadBudgetBytes) break
        if (replacements.has(entry.index) || entry.compacted || entry.savedBytes <= 0) continue
        entry.compacted = true
        bytes -= entry.savedBytes
      }
      let savedToolResultBytes = 0
      for (const entry of earlier) {
        if (!replacements.has(entry.index) && entry.compacted && entry.excerpt !== undefined) replacements.set(entry.index, entry.excerpt)
        const replacement = replacements.get(entry.index)
        if (replacement !== undefined) savedToolResultBytes += entry.bytes - Buffer.byteLength(JSON.stringify(replacement))
      }
      const byIndex = new Map(entries.map(entry => [entry.index, entry]))
      const messages = history.map(({ conversationUserId: _user, ...message }, index) => {
        const content = replacements.get(index)
        if (content !== undefined) return { ...message, content }
        const shorter = byIndex.get(index)?.excerpt
        return shorter === undefined ? message : excerptContext(message, shorter)
      })
      return { messages, compactedToolResults: replacements.size, savedToolResultBytes, repeatedReads }
    },
  }
}
