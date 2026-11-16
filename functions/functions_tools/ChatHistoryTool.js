import {createChatHistoryTool} from '../../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
import {createPersonMemoryStore} from '../../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import {getSemanticMemoryRuntime} from '../../dist/backend/modules/memory/infrastructure/semanticRuntime.js'
import {messageArchiveManager} from '../../utils/MessageArchiveManager.js'
const stores=new WeakMap()
export const ChatHistoryTool=createChatHistoryTool({
 getBot:()=>globalThis.Bot||globalThis.bot,
 getPersonMemoryStore:()=>{
  const redis=globalThis.redis
  if(!redis||typeof redis.get!=='function'||typeof redis.set!=='function')return null
  if(!stores.has(redis))stores.set(redis,createPersonMemoryStore({redis}))
  return stores.get(redis)
 },
 getSemanticRuntime:getSemanticMemoryRuntime,
 getArchiveManager:()=>messageArchiveManager
})
