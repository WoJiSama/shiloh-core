import { statfs } from 'node:fs/promises'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { createAgentTraffic } from '../modules/runtime/infrastructure/agentTraffic.js'
import type { createStandaloneAgentConsoleDirectory } from './standaloneAgentConsoleDirectory.js'

const json = (value: unknown) => ({ kind: 'json' as const, value: JSON.parse(JSON.stringify(value)) as AgentConsoleJson })
export function createStandaloneAgentOperations(options: {
  readonly directory: ReturnType<typeof createStandaloneAgentConsoleDirectory>
  readonly traffic: ReturnType<typeof createAgentTraffic>
  readonly readiness: () => { ready: boolean; accounts: readonly { connectionId: string; state: string }[] }
  readonly journal: () => { degraded: boolean; written: number; failed: number }
  readonly dataDir: string
  readonly apps: Readonly<Record<string, boolean>>
}): AgentConsoleService[] {
  const handlers: Record<string, NonNullable<AgentConsoleService['handle']>> = {
    async 'overview.read'(_request, context) {
      return json({ ...await options.directory.read(context), readiness: options.readiness().ready })
    },
    async 'stats.read'(request, context) { return traffic(request, context) },
    async 'bot-stats.read'(request, context) { return traffic(request, context, true) },
    async 'sentinel.read'(_request, context) {
      const [accounts, disk] = await Promise.all([options.directory.accounts(context), statfs(options.dataDir)])
      context.ensureCurrent()
      const visible = new Set(accounts.map(row => row.connectionId))
      const state = options.readiness(), journal = options.journal()
      const availableMiB = Math.floor(disk.bavail * disk.bsize / 1048576)
      const alerts = [
        ...(!state.ready ? [{ code: 'core_pending' }] : []),
        ...(journal.degraded ? [{ code: 'journal_degraded' }] : []),
        ...(availableMiB < 2048 || disk.blocks > 0 && disk.bavail / disk.blocks < 0.05 ? [{ code: 'disk_low' }] : []),
        ...state.accounts.filter(row => visible.has(row.connectionId) && row.state !== 'ready').map(row => ({
          code: row.state === 'disconnected' ? 'qq_disconnected' : 'account_recovery', connectionId: row.connectionId,
        })),
      ]
      return json({ status: alerts.length ? 'degraded' : 'ready', alerts, availableMiB, journal })
    },
    async 'apps.read'(_request, context) {
      context.ensureCurrent()
      return json({ apps: Object.entries(options.apps).map(([name, enabled]) => ({ name, enabled })),
        ready: options.readiness().ready })
    },
  }
  async function traffic(request: AgentConsoleRequest, context: AgentConsoleContext, onlyAccount = false) {
    const days = Number(request.query.days ?? '7')
    const account = request.query.qq
    if (!Number.isInteger(days) || days < 1 || days > 30 || Object.keys(request.query).some(key => key !== 'days' && key !== 'qq') ||
        onlyAccount !== (account !== undefined) || account !== undefined && !/^[1-9]\d{4,11}$/u.test(account)) throw new AgentConsoleError('invalid_request')
    const visible = (await options.directory.visibleBindings(context)).map(row => row.binding)
    const bindings = account === undefined ? visible : visible.filter(row => row.target.account.id === account)
    const result = await options.traffic.list(bindings, days)
    context.ensureCurrent()
    return json({ ...result, timezone: 'Asia/Shanghai' })
  }
  return AGENT_CONSOLE_SERVICES.flatMap(service => Object.hasOwn(handlers, service.operation)
    ? [{ ...service, handle: handlers[service.operation]! }] : [])
}
