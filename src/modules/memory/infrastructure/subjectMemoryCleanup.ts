import type { AgentSourceMemoryCleanupGuard, AgentSourceMemoryPartitionCleanupReceipt, AgentSourceMemoryPurgeSubject } from '../../../contracts/sourceMemoryCleanup.js'
import { conversationCleanupCurrent, conversationCleanupSelector, ensureConversationCleanup, parseConversationCleanup,
  CONVERSATION_CLEANUP_MAX_BYTES, CONVERSATION_CLEANUP_MAX_SELECTORS, type ConversationCleanupSelector } from './conversationMemoryCleanup.js'

export interface SubjectCleanupStorage {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export const cleanupExpected = (value: string | null): [string, string] => [value === null ? '0' : '1', value ?? '']
const publish = `local current=redis.call('GET',KEYS[1])
if (current or false)~=(ARGV[1]=='1' and ARGV[2] or false) then return 0 end
redis.call('SET',KEYS[1],ARGV[3]); return 1`
const fail = (): never => { throw new Error('来源记忆清理水位或存储不可用') }

/** A permanent, content-free author cutoff. Store writes must CAS this same key. */
export function createSubjectMemoryCleanup(redis: SubjectCleanupStorage, key: string, id: string) {
  return {
    async purge(input: AgentSourceMemoryPurgeSubject, guard: AgentSourceMemoryCleanupGuard,
      work: (selector: ConversationCleanupSelector, authorize: () => Promise<void>, counts: { removedRecords: number; removedPartitions: number }) => Promise<void>): Promise<AgentSourceMemoryPartitionCleanupReceipt> {
      const selector = conversationCleanupSelector(input)
      let published = false, authorizationFailed = false
      const counts = { removedRecords: 0, removedPartitions: 0 }
      const authorize = async () => {
        try { await ensureConversationCleanup(guard) }
        catch (error) { authorizationFailed = true; throw error }
      }
      const receipt = (cleanup: 'completed' | 'unknown') => ({ id, cleanup, ...counts })
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          await authorize()
          const raw = await redis.get(key), fences = parseConversationCleanup(raw)
          await authorize()
          const prior = fences.entries.find(entry => entry.id === selector.id)
          if (!prior && fences.entries.length >= CONVERSATION_CLEANUP_MAX_SELECTORS) fail()
          const entries = prior ? fences.entries.map(entry => entry.id === selector.id ? { ...entry, through: Math.max(entry.through, selector.through) } : entry) : [...fences.entries, selector]
          const next = prior && prior.through >= selector.through ? raw! : JSON.stringify({ version: 1, entries })
          if (next.length > CONVERSATION_CLEANUP_MAX_BYTES) fail()
          const result = await redis.eval(publish, { keys: [key], arguments: [...cleanupExpected(raw), next] })
          if (result === 1) { published = true; break }
          if (result !== 0) fail()
        }
        if (!published) fail()
        await authorize()
        await work(selector, authorize, counts)
        await authorize()
        return receipt('completed')
      } catch (error) {
        if (!published || authorizationFailed || !conversationCleanupCurrent(guard)) throw error
        await authorize()
        return receipt('unknown')
      }
    },
  }
}
