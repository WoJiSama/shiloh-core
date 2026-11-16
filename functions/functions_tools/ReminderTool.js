import {createReminderRuntime} from '../../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
import {mcpManager} from '../../utils/MCPClient.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
import {findQqAccount} from '../../dist/backend/adapters/qqIdentity.js'

export const {ReminderTool,checkPendingReminders}=createReminderRuntime({
  redis:globalThis.redis,logger:globalThis.logger,mcpManager,
  getBot:id=>id ? findQqAccount(globalThis.Bot,id) : globalThis.Bot,
  restoreBinding:(event,expected)=>pluginBridge.instance?.restoreDeferredAgentBinding?.(event,expected) ?? 'unavailable',
})
