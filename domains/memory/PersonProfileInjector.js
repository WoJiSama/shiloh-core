import { pluginBridge } from '../../utils/pluginBridge.js'
import { createPersonProfileClass } from '../../dist/backend/modules/memory/application/personProfileInjector.js'
import { lazyRedis } from '../../utils/simulationRuntime.js'
import { createPersonMemoryStore } from '../../dist/backend/modules/memory/infrastructure/personMemoryStore.js'

import {readScopedPersonProfile,filterScopedProfileMessages} from '../../dist/backend/modules/memory/infrastructure/personProfileRuntime.js'
const personMemory = () => createPersonMemoryStore({redis:lazyRedis()})

export const PersonProfileInjector = createPersonProfileClass({
  getConfig: () => pluginBridge.instance?.config || {},
  getPersonaFor: event => pluginBridge.instance?.getPersonaFor?.(event) || null,
  getMessages: (type, groupId) => pluginBridge.sharedState?.messageManager?.getMessages?.(type, groupId) || Promise.resolve([]),
  getCrossGroupProfile: (userId,context) => readScopedPersonProfile(personMemory(),userId,context),
  filterRecentMessages: (groupId,messages,viewer) => filterScopedProfileMessages(personMemory(),groupId,messages,viewer),
})
export const personProfileInjector = new PersonProfileInjector()
