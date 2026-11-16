import {createChatTurnDurabilityModule} from '../dist/backend/modules/conversation/application/chatTurnDurability.js'
import {findQqAccount} from '../dist/backend/adapters/qqIdentity.js'
export const {buildChatTurnKey,serializeChatTurnEnvelope,rebuildChatTurnEvent,createChatTurnDurability}=createChatTurnDurabilityModule({
 getBot:selfId=>selfId ? findQqAccount(globalThis.Bot,selfId) : globalThis.Bot,
 getRedis:()=>globalThis.redis,
 logger:globalThis.logger
})
