import { createHash, randomUUID } from 'node:crypto'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleCommittedResponse, AgentConsoleCommitPort, AgentConsoleContext, AgentConsoleGuard, AgentConsoleJson, AgentConsoleRequest } from '../contracts/agentConsole.js'
import { agentConversationKey } from '../modules/runtime/domain/agentBindings.js'

const fail = (): never => { throw new AgentConsoleError('conflict') }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const principal = (context: AgentConsoleContext) => JSON.stringify(context.principal)
const requestDigest = (request: AgentConsoleRequest) => digest(JSON.stringify([request.method, request.pathname, request.params, request.query, request.body]))
function targetFor(operation: string, request: AgentConsoleRequest, context: AgentConsoleContext): string {
  if (context.binding) {
    const { target } = context.binding
    if (operation === 'group-admin.write' && request.method === 'PUT' && target.kind === 'group' &&
        request.params.groupId === target.id && request.pathname === '/api/groups/' + target.id + '/admin') return 'group-admin:' + agentConversationKey(context.binding)
    return fail()
  }
  if (operation === 'config.write' && request.method === 'PUT' && request.pathname === '/api/config/' + request.params.kind) return 'config:' + request.params.kind
  if (operation === 'providers.write' && request.method === 'PUT' && request.pathname === '/api/ai/config') return 'provider:' + (request.body as Record<string, AgentConsoleJson>).configKey
  if (operation === 'persona.write' && request.method === 'PUT' && request.pathname === '/api/persona/library') return 'templates'
  if (operation === 'persona-assignments.write' && request.method === 'PUT' && request.pathname === '/api/persona/assignments') return 'assignments'
  if (operation === 'configuration.commit' && request.method === 'POST' && request.pathname === '/api/configuration/commit') return 'configuration'
  if (operation === 'accounts.add' && request.method === 'POST' && request.pathname === '/api/accounts/add') return 'accounts:add'
  return fail()
}
interface RequestRecord {
  readonly nonce: string
  readonly principal: string
  readonly request: AgentConsoleRequest
  readonly digest: string
  readonly operation: string
  readonly authority: AgentConsoleGuard
  readonly checkResponse: (serialized: string) => void
  closed: boolean
  writing: boolean
  release?: () => void
  receipt?: AgentConsoleCommittedResponse
}
interface Receipt {
  readonly context: AgentConsoleContext
  readonly nonce: string
  readonly principal: string
  readonly operation: string
  readonly target: string
  readonly before: string
  readonly after: string
  readonly processEpoch: string
  readonly body: string
  readonly digest: string
  readonly verifyTransition: () => boolean
  consumed: boolean
}
/** Creates a pair of capabilities. The host receives only `port`; persistence retains `writer`. */
export function createStandaloneAgentConsoleCommitCoordinator() {
  const requests = new WeakMap<AgentConsoleContext, RequestRecord>(), receipts = new WeakMap<object, Receipt>()
  const current = (context: AgentConsoleContext) => {
    const record = requests.get(context)
    if (!record || record.closed || context.signal.aborted || record.authority.signal.aborted || record.principal !== principal(context) || record.digest !== requestDigest(record.request)) return fail()
    record.authority.ensureCurrent()
    if (!record.authority.isCurrent()) return fail()
    return record
  }
  const port = Object.freeze<AgentConsoleCommitPort>({
    open(context, request, operation, authority, checkResponse) {
      if (requests.has(context)) return fail()
      authority.ensureCurrent()
      requests.set(context, { nonce: randomUUID(), principal: principal(context), request, digest: requestDigest(request), operation, authority, checkResponse, closed: false, writing: false })
    },
    isCommitted(value): value is AgentConsoleCommittedResponse { return !!value && typeof value === 'object' && receipts.has(value) },
    verify(value, context, consume = false) {
      const request = current(context), receipt = receipts.get(value)
      if (!receipt || receipt.consumed || receipt.context !== context || receipt.nonce !== request.nonce || receipt.principal !== request.principal ||
          receipt.operation !== request.operation || receipt.target !== targetFor(request.operation, request.request, context) || receipt.before === receipt.after ||
          receipt.digest !== digest(JSON.stringify([receipt.processEpoch, receipt.before, receipt.after, 200, 'application/json', receipt.body])) || !receipt.verifyTransition()) return fail()
      request.checkResponse(receipt.body)
      current(context)
      if (!receipt.verifyTransition()) return fail()
      if (consume) receipt.consumed = true
      return { body: receipt.body, status: 200 }
    },
    close(context) {
      const request = requests.get(context)
      if (!request || request.closed) return
      request.closed = true
      if (request.receipt) receipts.delete(request.receipt)
      try { request.release?.() } finally { requests.delete(context) }
    },
  })
  const writer = {
    begin(context: AgentConsoleContext, operation: string, target: string, before: string, payload: unknown, release: () => void) {
      const record = current(context)
      context.ensureCurrent()
      if (record.writing || record.operation !== operation || targetFor(operation, record.request, context) !== target ||
          digest(JSON.stringify(payload)) !== digest(JSON.stringify(record.request.body))) return fail()
      record.writing = true; record.release = release
      let committed = false
      return {
        // The sealed request/session/host authority survives this request's own
        // execution retirement; it never grants access to a different request.
        ensureAuthority() { current(context) },
        preflight(value: AgentConsoleJson) { current(context); context.ensureCurrent(); record.checkResponse(JSON.stringify(value)) },
        markCommitted() { committed = true },
        complete(after: string, processEpoch: string, value: AgentConsoleJson, verifyTransition: () => boolean): AgentConsoleCommittedResponse {
          if (!committed || before === after || record.receipt) return fail()
          const body = JSON.stringify(value)
          const result = Object.freeze({ kind: 'committed-json' }) as AgentConsoleCommittedResponse
          receipts.set(result, { context, nonce: record.nonce, principal: record.principal, operation, target, before, after, processEpoch,
            body, digest: digest(JSON.stringify([processEpoch, before, after, 200, 'application/json', body])), verifyTransition, consumed: false })
          record.receipt = result
          return result
        },
      }
    },
  }
  return { port, writer }
}
