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
  // The first handler to claim a message owns it. Later handlers, including
  // model dispatch in the inbox consumer, must not observe a claimed message.
  const ordered = [handlers.games, handlers.bilibiliQuality, handlers.magnetSearch,
    handlers.torrent, handlers.mediaRelay, handlers.musicExtraction]

  return {
    async dispatch(message: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
      for (const handle of ordered) if (await handle(message, binding)) return true
      return false
    },
  }
}
