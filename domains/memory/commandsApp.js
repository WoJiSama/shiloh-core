import common from '../../../../lib/common/common.js'
import { createMemoryCommands } from '../../dist/backend/modules/memory/infrastructure/memoryCommands.js'
import { globalStyleLearnerManager } from './GlobalStyleLearnerManager.js'
import { personaFeedbackManager } from './PersonaFeedbackManager.js'
import { getSharedMemoryManager, getSharedConfig } from '../../core/runtime/sharedRuntime.js'
import { pluginBridge } from '../../utils/pluginBridge.js'
export const MemoryCommandsPlugin = createMemoryCommands({
  PluginBase: plugin,
  globalStyleLearnerManager,
  personaFeedbackManager,
  getSharedMemoryManager,
  getSharedConfig,
  getPersonaSnapshotFor:event=>pluginBridge.instance?.getPersonaSnapshotFor?.(event),
  restoreBinding:(event,expected)=>pluginBridge.instance?.restoreDeferredAgentBinding?.(event,expected) ?? 'unavailable',
  logger: globalThis.logger,
  makeForwardMsg: common.makeForwardMsg
})
