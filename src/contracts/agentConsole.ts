import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

export type AgentConsoleJson = null | boolean | number | string | readonly AgentConsoleJson[] | { readonly [key: string]: AgentConsoleJson }
export type AgentConsoleMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type AgentConsoleAuthAction = 'setup' | 'login' | 'logout' | 'password'

/** Console identities are issued by the authentication service, never from request bodies. */
export interface AgentConsolePrincipal {
  readonly id: string
  readonly username: string | null
  readonly via: 'session' | 'token'
}

/** Only the authentication service receives browser cookies or the console token. */
export interface AgentConsoleCredentials {
  readonly token: string
  readonly cookie: string
}

export interface AgentConsoleGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  /** Services must call this again immediately before committing or dispatching a mutation. */
  ensureCurrent(): void
}

export interface AgentConsoleContext extends AgentConsoleGuard {
  readonly principal: AgentConsolePrincipal
  /** A current, complete host binding, including account, connection, agent, persona and revision.
   * Conversation services derive storage/native targets from this field, never a legacy bare group/body alias. */
  readonly binding?: AgentBindingSnapshot
}

export interface AgentConsoleAuthState {
  readonly hasUser: boolean
  readonly username: string | null
  readonly tokenWorks: boolean
  readonly via: 'session' | 'token' | null
}

export interface AgentConsoleAuthResult {
  readonly username?: string
  readonly message?: string
  /** An opaque Set-Cookie value. It is never included in a JSON response or service request. */
  readonly cookie?: string
}

export interface AgentConsoleAuthPort {
  state(credentials: AgentConsoleCredentials, guard: AgentConsoleGuard): Promise<AgentConsoleAuthState>
  authenticate(credentials: AgentConsoleCredentials, guard: AgentConsoleGuard): Promise<AgentConsolePrincipal | undefined>
  run(action: AgentConsoleAuthAction, body: Readonly<Record<string, AgentConsoleJson>>, credentials: AgentConsoleCredentials,
    context: AgentConsoleGuard & { readonly principal?: AgentConsolePrincipal }): Promise<AgentConsoleAuthResult>
  authorize(principal: AgentConsolePrincipal, operation: string, binding: AgentBindingSnapshot | undefined,
    guard: AgentConsoleGuard): Promise<'allowed' | 'denied' | 'unavailable'>
  /** Synchronous session/token revocation check; the HTTP layer also rechecks after every await. */
  isCurrent(principal: AgentConsolePrincipal): boolean
}

export interface AgentConsoleRequest {
  readonly method: AgentConsoleMethod
  readonly pathname: string
  readonly params: Readonly<Record<string, string>>
  /** Authentication and binding selectors are removed before dispatch. */
  readonly query: Readonly<Record<string, string>>
  readonly body: AgentConsoleJson
  /** For existing multipart/image handlers. Content is bounded and credentials are not forwarded. */
  readonly bytes?: Uint8Array
  readonly contentType?: string
}

declare const committedResponseBrand: unique symbol
/** Opaque server-local evidence. A JSON flag or a structurally identical object is never evidence. */
export interface AgentConsoleCommittedResponse {
  readonly kind: 'committed-json'
  readonly [committedResponseBrand]: true
  readonly status?: number
}

/** Only the persistence owner holds the separate signing capability. */
export interface AgentConsoleCommitPort {
  open(context: AgentConsoleContext, request: AgentConsoleRequest, operation: string, authority: AgentConsoleGuard,
    checkResponse: (serialized: string) => void): void
  isCommitted(value: unknown): value is AgentConsoleCommittedResponse
  verify(value: AgentConsoleCommittedResponse, context: AgentConsoleContext, consume?: boolean): { readonly body: string; readonly status: number }
  close(context: AgentConsoleContext): void
}

export type AgentConsoleResponse = AgentConsoleCommittedResponse | {
  readonly kind: 'json'
  readonly value: AgentConsoleJson
  readonly status?: number
} | {
  readonly kind: 'bytes'
  readonly value: Uint8Array
  readonly contentType: string
  readonly status?: number
}

/** Each installed operation names its permission and scope explicitly. No plugin proxy or fallback is installed. */
export interface AgentConsoleService {
  readonly operation: string
  readonly method: AgentConsoleMethod
  /** Exact path, with optional whole-segment :parameters; /api/auth and /api/bindings are reserved. */
  readonly path: string
  readonly scope: 'global' | 'conversation'
  readonly body?: 'json' | 'bytes'
  readonly maxBodyBytes?: number
  /** An absent handler is a known capability awaiting host wiring and returns 503. */
  handle?(request: AgentConsoleRequest, context: AgentConsoleContext): Promise<AgentConsoleResponse>
}

/** Existing non-proxy operations. The standalone host supplies real handlers or leaves them explicitly unavailable. */
export const AGENT_CONSOLE_SERVICES: readonly AgentConsoleService[] = Object.freeze([
  ['GET', '/api/workspace', 'workspace.read'],
  ['GET', '/api/overview', 'overview.read'],
  ['GET', '/api/overview/accounts', 'accounts.read'],
  ['GET', '/api/overview/stats', 'stats.read'],
  ['GET', '/api/sentinel', 'sentinel.read'],
  ['GET', '/api/apps', 'apps.read'],
  ['POST', '/api/accounts/action', 'accounts.action'],
  ['POST', '/api/accounts/add', 'accounts.add'],
  ['GET', '/api/bot/stats', 'bot-stats.read'],
  ['GET', '/api/groups', 'groups.read'],
  ['GET', '/api/identities', 'identities.read'],
  ['GET', '/api/observe/summary', 'observe.read'],
  ['GET', '/api/config/:kind', 'config.read'],
  ['PUT', '/api/config/:kind', 'config.write'],
  ['GET', '/api/config-state', 'config-state.read'],
  ['GET', '/api/configuration/catalog', 'configuration.read'],
  ['POST', '/api/configuration/preview', 'configuration.preview'],
  ['POST', '/api/configuration/commit', 'configuration.commit'],
  ['GET', '/api/groups/:groupId/admin', 'group-admin.read', 'conversation'],
  ['PUT', '/api/groups/:groupId/admin', 'group-admin.write', 'conversation'],
  ['GET', '/api/pipeline/jobs', 'pipeline.read'],
  ['GET', '/api/persona/library', 'persona.read'],
  ['PUT', '/api/persona/library', 'persona.write'],
  ['GET', '/api/persona/accounts', 'persona-accounts.read'],
  ['GET', '/api/persona/assignments', 'persona-assignments.read'],
  ['PUT', '/api/persona/assignments', 'persona-assignments.write'],
  ['GET', '/api/ai/config', 'providers.read'],
  ['PUT', '/api/ai/config', 'providers.write'],
  ['POST', '/api/ai/probe', 'providers.probe'],
  ['POST', '/api/ai/probe-provider', 'providers.probe-provider'],
  ['GET', '/api/image/providers', 'images.providers'],
  ['GET', '/api/image/history', 'images.history'],
  ['POST', '/api/image/cancel', 'images.cancel'],
  ['POST', '/api/image/generate', 'images.generate', 'global', 'bytes'],
  ['POST', '/api/image/edit', 'images.edit', 'global', 'bytes'],
  ['GET', '/img/qrcode/:container', 'accounts.qrcode'],
  ['GET', '/img/:name', 'images.read'],
  ['GET', '/api/style/overview', 'style.read'],
  ['POST', '/api/style/block-word', 'style.block-word', 'conversation'],
  ['POST', '/api/style/remove-rule', 'style.remove-rule'],
  ['GET', '/api/tokens/summary', 'tokens.summary'],
  ['GET', '/api/tokens/series', 'tokens.series'],
  ['GET', '/api/tokens/recent', 'tokens.recent'],
  ['GET', '/api/simulation/overview', 'simulation.read'],
  ['GET', '/api/simulation/group', 'simulation.group-read', 'conversation'],
  ['POST', '/api/simulation/group', 'simulation.group-write', 'conversation'],
  ['POST', '/api/simulation/budget-default', 'simulation.budget-default'],
  ['GET', '/api/person-profiles', 'profiles.read'],
  ['POST', '/api/person-profiles/delete', 'profiles.delete', 'conversation'],
  ['POST', '/api/person-profiles/delete-field', 'profiles.delete-field', 'conversation'],
  ['GET', '/api/trusteeship/overview', 'trusteeship.read'],
  ['POST', '/api/trusteeship/commitment-cancel', 'commitments.cancel', 'conversation'],
  ['POST', '/api/trusteeship/delegated-delete', 'delegated.delete', 'conversation'],
  ['POST', '/api/trusteeship/faillog-clear', 'commitments.clear-failures'],
  ['GET', '/api/health/alerts', 'health.read'],
  ['GET', '/api/life/overview', 'life.read'],
  ['POST', '/api/life/rhythm', 'life.rhythm'],
  ['GET', '/api/games/turtle-soup/overview', 'turtle-soup.read'],
  ['GET', '/api/games/turtle-soup/candidates', 'turtle-soup.candidates'],
  ['GET', '/api/games/turtle-soup/rejected', 'turtle-soup.rejected'],
  ['POST', '/api/games/turtle-soup/puzzles/:id/audit', 'turtle-soup.audit'],
  ['PUT', '/api/games/turtle-soup/puzzles/:id/status', 'turtle-soup.status'],
  ['POST', '/api/games/turtle-soup/generate', 'turtle-soup.generate'],
  ['POST', '/api/games/turtle-soup/puzzles/:id/repair', 'turtle-soup.repair'],
  ['POST', '/api/games/turtle-soup/candidates/:id/recover', 'turtle-soup.recover'],
  ['POST', '/api/games/turtle-soup/puzzles/:id/score', 'turtle-soup.score'],
  ['DELETE', '/api/games/turtle-soup/puzzles/:id', 'turtle-soup.delete'],
  // These API shapes are retained; the standalone host must supply its own account/policy services.
  ['GET', '/api/qzone/bots', 'qzone.accounts'],
  ['POST', '/api/qzone/publish', 'qzone.publish'],
].map(([method, servicePath, operation, scope, body]) => Object.freeze({
  method: method as AgentConsoleMethod, path: servicePath!, operation: operation!, scope: (scope ?? 'global') as 'global' | 'conversation',
  ...(body ? { body: body as 'bytes', maxBodyBytes: 20 * 1024 * 1024 } : {}),
})))

export interface AgentConsolePorts {
  readonly auth: AgentConsoleAuthPort
  readonly services: readonly AgentConsoleService[]
  readonly bindings: {
    list(): readonly AgentBindingSnapshot[]
    resolve(target: ConversationAddress): AgentBindingSnapshot | undefined
  }
  /** The live host/IPC authority, independent of plugin globals and raw Redis keys. */
  readonly authority: { readonly signal: AbortSignal; isCurrent(): boolean }
  /** Execution configuration retirement must not terminate authentication or its own committed response. */
  readonly execution?: { readonly signal: AbortSignal; isCurrent(): boolean }
  readonly commits?: AgentConsoleCommitPort
  /** Reuse the host's credential filter. Returning false suppresses the entire response. */
  allowsResponse(body: string | Uint8Array, contentType: string): boolean
}

export type AgentConsoleErrorCode = 'unauthorized' | 'forbidden' | 'invalid_request' | 'conflict' | 'unavailable' |
  'not_found' | 'method_not_allowed' | 'body_too_large' | 'request_failed' | 'commit_outcome_unknown' | 'configuration_recovery_required' | 'candidate_stale'

/** Fixed public diagnostics prevent credentials or upstream exception text reaching the browser. */
export class AgentConsoleError extends Error {
  constructor(readonly code: AgentConsoleErrorCode) { super(code) }
}
