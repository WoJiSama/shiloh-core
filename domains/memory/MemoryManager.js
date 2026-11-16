import { createMemoryManagerClass } from '../../dist/backend/modules/memory/infrastructure/memoryManager.js'
import { sideLLMCall } from '../../utils/sideLLM.js'
import { pluginBridge } from '../../utils/pluginBridge.js'
export const MemoryManager = createMemoryManagerClass({
  llm: { call: sideLLMCall, logger: globalThis.logger },
  logger: { warn: (...args) => globalThis.logger?.warn?.(...args), error: (...args) => globalThis.logger?.error?.(...args) },
  restoreBinding: (event, expected) => pluginBridge.instance?.restoreDeferredAgentBinding?.(event, expected) ?? 'unavailable',
  defaultRedis: {
    get: key => globalThis.redis.get(key),
    set: (...args) => globalThis.redis.set(...args),
    del: key => globalThis.redis.del(key),
    get mSet() { return globalThis.redis?.mSet?.bind(globalThis.redis) },
  }
})
