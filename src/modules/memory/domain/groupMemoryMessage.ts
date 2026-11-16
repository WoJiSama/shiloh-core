import type { GroupMemoryMessage } from '../../../contracts/groupMemory.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'

/** Keep imported evidence identical to a later native capture of the same message. */
export function groupMemoryMessage(incoming: IncomingMessage & { messageId: string }): GroupMemoryMessage {
  return { messageId: incoming.messageId, authorId: incoming.sender.id, name: (incoming.senderName ?? '').slice(0, 24),
    text: incoming.text, at: incoming.occurredAt, mentions: [...new Set(incoming.mentions.map(user => user.id))].slice(0, 50),
    files: incoming.parts.flatMap(part => part.kind === 'file' && part.name && part.name.length <= 180 ? [{ name: part.name,
      ...(part.resource?.kind === 'reference' && part.resource.value.length <= 240 && !/^(?:[a-z]+:\/\/|\/|~|[a-z]:[\\/])/iu.test(part.resource.value)
        ? { reference: part.resource.value } : {}) }] : []).slice(0, 20),
  }
}
