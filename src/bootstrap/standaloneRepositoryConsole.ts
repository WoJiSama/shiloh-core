import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleJson, AgentConsoleService } from '../contracts/agentConsole.js'
import type { ConversationAddress } from '../contracts/agentBinding.js'
import { decodeRepositoryCatalog } from '../modules/knowledge/infrastructure/repositoryCatalog.js'
import type { openRepositoryKnowledge } from '../modules/knowledge/infrastructure/repositoryKnowledge.js'

export function createStandaloneRepositoryConsole(service: Awaited<ReturnType<typeof openRepositoryKnowledge>>,
  isBound: (target: ConversationAddress) => boolean): AgentConsoleService[] {
  const route = (operation: string) => AGENT_CONSOLE_SERVICES.find(row => row.operation === operation)!
  const response = () => ({ kind: 'json' as const, value: { revision: service.catalog.revision(),
    catalog: service.catalog.get(), status: service.status() } as unknown as AgentConsoleJson })
  return [
    { ...route('project-knowledge.read'), async handle(request) {
      if (Object.keys(request.query).length) throw new AgentConsoleError('invalid_request')
      return response()
    } },
    { ...route('project-knowledge.write'), maxBodyBytes: 192 * 1024, async handle(request, context) {
      const body = request.body as Record<string, unknown>
      if (Object.keys(request.query).length || Object.keys(body).length !== 2 ||
        typeof body.revision !== 'string' || !/^[0-9a-f]{64}$/u.test(body.revision)) throw new AgentConsoleError('invalid_request')
      let next
      try { next = decodeRepositoryCatalog(body.catalog, isBound) }
      catch { throw new AgentConsoleError('invalid_request') }
      if (!await service.replace(body.revision, next, context.ensureCurrent)) throw new AgentConsoleError('conflict')
      context.ensureCurrent()
      return response()
    } },
    { ...route('project-knowledge.refresh'), maxBodyBytes: 512, async handle(request, context) {
      if (Object.keys(request.query).length || Object.keys(request.body as object).length) throw new AgentConsoleError('invalid_request')
      if (!request.params.repoId || !await service.refresh(request.params.repoId, context.ensureCurrent)) throw new AgentConsoleError('not_found')
      return { kind: 'json', status: 202, value: { accepted: true } }
    } },
  ]
}
