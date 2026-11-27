import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'

type MessageHandler = (message: IncomingMessage, binding: AgentBindingSnapshot) => Promise<boolean>

export function createAgentInboxDispatch(handlers: {
  readonly games: MessageHandler
  readonly bilibiliQuality: MessageHandler
  readonly magnetSearch: MessageHandler
  readonly torrent: MessageHandler
  readonly mediaRelay: MessageHandler
  readonly musicExtraction: MessageHandler
}) {
  const ordered = ['games', 'bilibiliQuality', 'magnetSearch', 'torrent', 'mediaRelay', 'musicExtraction'] as const

  async function claim(message: IncomingMessage, binding: AgentBindingSnapshot) {
    for (const name of ordered) if (await handlers[name](message, binding)) return name
    return undefined
  }

  return {
    claim,
    async dispatch(message: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
      return await claim(message, binding) !== undefined
    },
  }
}
