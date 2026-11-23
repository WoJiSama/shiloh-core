import path from 'node:path'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext } from '../contracts/agentConsole.js'
import type { AgentManagementBindings } from '../contracts/agentManagement.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import { readCachedGroupNames } from '../modules/platform/infrastructure/groupNames.js'
import { agentBindingToken, agentConversationKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'

export function createStandaloneAgentConsoleDirectory(options: {
  readonly dataDir: string
  readonly bindings: AgentManagementBindings
  readonly adapters: readonly PlatformConnectionAdapter[]
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly allowsText: (text: string) => boolean
}) {
  const groupNames = readCachedGroupNames(path.join(options.dataDir, 'legacy-source'))
  const adapters = new Map(options.adapters.map(adapter => [adapter.id, adapter]))
  function label(value: string | undefined, id: string) {
    const name = value?.trim()
    return name && name !== id && name.length <= 128 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) && options.allowsText(name)
      ? name : undefined
  }
  const accountName = (adapter: PlatformConnectionAdapter) => label(adapter.botName, adapter.account.id)
  function conversationName(binding: AgentBindingSnapshot) {
    const { target } = binding, adapter = adapters.get(binding.connectionId)
    if (!adapter || platformAccountKey(adapter.account) !== platformAccountKey(target.account)) return undefined
    const live = label(adapter.conversationName?.(target), target.id)
    const legacy = target.kind === 'group' && target.account.platform === 'qq' && target.account.namespace === 'global'
      ? groupNames.get(target.id) : undefined
    return live ?? label(legacy, target.id)
  }

  async function visibleBindings(context: AgentConsoleContext) {
    const rows = []
    for (const binding of options.bindings.list()) {
      const allowed = await options.auth.authorize(context.principal, 'bindings.read', binding, context)
      context.ensureCurrent()
      if (allowed === 'unavailable') throw new AgentConsoleError('unavailable')
      if (allowed === 'allowed') rows.push({ binding, bindingToken: agentBindingToken(binding) })
    }
    context.ensureCurrent()
    for (const { binding, bindingToken } of rows) {
      const current = options.bindings.resolve(binding.target)
      if (!current || agentBindingToken(current) !== bindingToken) throw new AgentConsoleError('conflict')
    }
    return rows
  }

  async function readGroups(context: AgentConsoleContext) {
    return (await visibleBindings(context)).flatMap(({ binding, bindingToken }) => {
      if (binding.target.kind !== 'group') return []
      const { id: groupId, account } = binding.target
      const name = conversationName(binding)
      return [{ id: groupId, scopeKey: agentConversationKey(binding), bindingToken, agentId: binding.agentId,
        connectionId: binding.connectionId, account, bots: [account.id], ...(name ? { name } : {}) }]
    })
  }

  async function readAccounts(context: AgentConsoleContext) {
    const access = await options.auth.authorize(context.principal, 'connections.read', undefined, context)
    context.ensureCurrent()
    if (access === 'unavailable') throw new AgentConsoleError('unavailable')
    const visible = access === 'allowed' ? undefined :
      new Set((await visibleBindings(context)).map(({ binding }) => platformAccountKey(binding.target.account)))
    return options.adapters.filter(adapter => !visible || visible.has(platformAccountKey(adapter.account))).map(adapter => {
      const nickname = accountName(adapter)
      return { id: adapter.account.id, connectionId: adapter.id, account: adapter.account,
        connected: adapter.isReady(), ...(nickname ? { name: nickname } : {}) }
    })
  }

  return {
    conversationName,
    visibleBindings,
    accountName,
    groups: readGroups,
    accounts: readAccounts,
    async read(context: AgentConsoleContext) {
      const [groups, accounts] = await Promise.all([readGroups(context), readAccounts(context)])
      context.ensureCurrent()
      return { groups, bots: accounts }
    },
  }
}
