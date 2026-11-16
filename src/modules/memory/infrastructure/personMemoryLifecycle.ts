import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { PersonMemoryIdentity, PersonMemoryStore } from '../../../contracts/personMemory.js'
import { decodeQqRecall } from '../../../adapters/qqMessage.js'
import { personMemoryAddress, revokePersonMemorySourceForAccount } from './personMemoryContext.js'

type RecallIdentity = PersonMemoryIdentity | ((target: ConversationAddress) => PersonMemoryIdentity | undefined)

/** A recall is a durable source revocation even when archives are disabled or expired. */
export async function revokePersonMemoryNotice(store: PersonMemoryStore, event: Record<string,unknown>, currentIdentity?: RecallIdentity) {
  const recall = decodeQqRecall(event)
  if (!recall) return
  const { botId, scene } = personMemoryAddress(recall.target)
  let current: PersonMemoryIdentity | undefined
  try { current = typeof currentIdentity === 'function' ? currentIdentity(recall.target) : currentIdentity }
  catch { /* The current role is optional. Previously recorded sources still have to revoke. */ }
  await revokePersonMemorySourceForAccount(store, botId, scene, recall.messageId,
    current?.botId === botId ? current.personaId : undefined)
}
