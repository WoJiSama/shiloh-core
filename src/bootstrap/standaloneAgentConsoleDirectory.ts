import path from 'node:path'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext } from '../contracts/agentConsole.js'
import type { AgentManagementBindings } from '../contracts/agentManagement.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import { readCachedGroupNames } from '../modules/platform/infrastructure/groupNames.js'
import { agentBindingToken, agentConversationKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'

export function createStandaloneAgentConsoleDirectory(options: {
  readonly dataDir: string
  readonly bindings: AgentManagementBindings
  readonly adapters: readonly PlatformConnectionAdapter[]
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly allowsText: (text: string) => boolean
}) {
  const groupNames = readCachedGroupNames(path.join(options.dataDir, 'legacy-source'))
  const label = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && options.allowsText(value) ? value : undefined

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
      const name = account.platform === 'qq' ? label(groupNames.get(groupId)) : undefined
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
      const nickname = adapter.botName === adapter.account.id ? undefined : label(adapter.botName)
      return { id: adapter.account.id, connectionId: adapter.id, account: adapter.account,
        connected: adapter.isReady(), ...(nickname ? { name: nickname } : {}) }
    })
  }

  return {
    groups: readGroups,
    accounts: readAccounts,
    async read(context: AgentConsoleContext) {
      const [groups, accounts] = await Promise.all([readGroups(context), readAccounts(context)])
      context.ensureCurrent()
      return { groups, bots: accounts }
    },
  }
}
