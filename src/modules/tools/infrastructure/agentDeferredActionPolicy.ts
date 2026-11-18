import { randomUUID } from 'node:crypto'
import type {
  AgentDeferredActionAuthorization, AgentDeferredActionAuthorizationRequest, AgentDeferredActionDefinition,
  AgentDeferredActionGrant, AgentDeferredAuthorizationCheck, AgentDeferredAuthorizationGuard, AgentDeferredExecutorKind,
} from '../../../contracts/agentDeferredAction.js'
import { agentBindingIdentity, agentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { assertDeferredGrant, deferredActionHash, freezeDeferredAction } from '../../commitments/infrastructure/agentDeferredActionData.js'

export interface AgentDeferredActionRule {
  readonly id: string
  /** Change this to revoke every delegation previously issued under the rule. */
  readonly revision: string
  readonly bindingIdentity: string
  readonly scopeKey: string
  readonly creatorIds: readonly string[]
  readonly tool: string
  readonly executor: AgentDeferredExecutorKind
  readonly definitionId: string
  readonly maxDelayMs: number
  /** Time allowed for a due task to run, independent of its scheduling distance. Defaults to five minutes. */
  readonly executionWindowMs?: number
}
export interface AgentDeferredActionPolicyConfig {
  readonly enabled?: boolean
  readonly rules?: readonly AgentDeferredActionRule[]
}
export interface AgentDeferredActionPolicyOptions {
  getConfig(): AgentDeferredActionPolicyConfig | undefined
  resolveDefinition(name: string): AgentDeferredActionDefinition | undefined
  mode(target: AgentDeferredActionAuthorizationRequest['binding']['target']): 'simulation' | 'text' | 'private' | undefined
  /** Dynamic ordinary visibility and disabled-tool rules still apply; extraTools alone grants no delegation. */
  isToolAllowed(request: AgentDeferredActionAuthorizationRequest): boolean
  /** Check actual creation intent/authority or the explicit migration approval record, and fresh identity,
   * privacy/source availability. Never infer a current human/admin from the persisted creator. */
  verifyAuthority(input: {
    readonly phase: 'create' | 'execute'
    readonly request: AgentDeferredActionAuthorizationRequest
    readonly grant?: AgentDeferredActionGrant
    readonly signal: AbortSignal
    /** Recheck before every QQ, storage or other external query in this authorization operation. */
    isCurrent(): boolean
  }): Promise<AgentDeferredAuthorizationCheck>
  now?(): number
}

const maxDelay = 365 * 86_400_000

function validRule(rule: AgentDeferredActionRule): boolean {
  return !!rule && typeof rule.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(rule.id) &&
    typeof rule.revision === 'string' && !!rule.revision.trim() && rule.revision.length <= 256 &&
    typeof rule.bindingIdentity === 'string' && !!rule.bindingIdentity && rule.bindingIdentity.length <= 8192 &&
    typeof rule.scopeKey === 'string' && !!rule.scopeKey && rule.scopeKey.length <= 8192 &&
    Array.isArray(rule.creatorIds) && rule.creatorIds.length > 0 && rule.creatorIds.length <= 128 &&
    rule.creatorIds.every(isPlatformIdentifier) && new Set(rule.creatorIds).size === rule.creatorIds.length &&
    typeof rule.tool === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(rule.tool) &&
    ['builtin', 'custom', 'mcp'].includes(rule.executor) && typeof rule.definitionId === 'string' &&
    !!rule.definitionId.trim() && rule.definitionId.length <= 512 &&
    Number.isSafeInteger(rule.maxDelayMs) && rule.maxDelayMs >= 1000 && rule.maxDelayMs <= maxDelay &&
    (rule.executionWindowMs === undefined || Number.isSafeInteger(rule.executionWindowMs) && rule.executionWindowMs >= 1000 && rule.executionWindowMs <= 86_400_000)
}

function sameSource(left: AgentDeferredActionGrant['source'], right: AgentDeferredActionGrant['source']): boolean {
  if (left.kind === 'message' && right.kind === 'message') return left.messageId === right.messageId && left.at === right.at
  if (left.kind === 'migration' && right.kind === 'migration') return left.id === right.id && left.sourceHash === right.sourceHash &&
    left.authorizedBy === right.authorizedBy && left.at === right.at
  return false
}

/** Deliberately disabled unless the host supplies exact rules and both live authorization checks. */
export function createAgentDeferredActionPolicy(ports: AgentDeferredActionPolicyOptions): AgentDeferredActionAuthorization {
  const now = () => ports.now?.() ?? Date.now()
  function ruleFor(request: AgentDeferredActionAuthorizationRequest, grant?: AgentDeferredActionGrant): AgentDeferredActionRule | undefined {
    try {
      const config = ports.getConfig(), at = now(), { binding, creator, action, source } = request
      if (config?.enabled !== true || !Array.isArray(config.rules) || config.rules.length > 128 ||
        !config.rules.every(validRule) || new Set(config.rules.map(rule => rule.id)).size !== config.rules.length ||
        binding.source !== 'configured' || !isConversationAddress(binding.target) || binding.target.kind !== 'group' ||
        ports.mode(binding.target) !== 'simulation' || !isPlatformIdentifier(creator.id) ||
        creator.platform !== binding.target.account.platform || creator.namespace !== binding.target.account.namespace ||
        !Number.isSafeInteger(request.dueAt) || request.dueAt <= 0 || !Number.isSafeInteger(source.at) || source.at <= 0 || source.at > at + 60_000 ||
        !ports.isToolAllowed(request)) return undefined
      freezeDeferredAction(action)
      if (source.kind === 'message') {
        if (!isPlatformIdentifier(source.messageId) || !grant && (typeof request.requestText !== 'string' || !request.requestText.trim())) return undefined
      } else if (source.kind === 'migration') {
        if (!isPlatformIdentifier(source.id) || !/^[a-f0-9]{64}$/u.test(source.sourceHash) ||
          !isPlatformIdentifier(source.authorizedBy)) return undefined
      } else return undefined
      const definition = ports.resolveDefinition(action.tool)
      if (!definition || definition.name !== action.tool || definition.executor !== action.executor || definition.definitionId !== action.definitionId ||
        !definition.isCurrent() || !definition.validate(action.params)) return undefined
      const rules = config.rules.filter(rule => rule.bindingIdentity === agentBindingIdentity(binding) && rule.scopeKey === agentConversationKey(binding) && rule.creatorIds.includes(creator.id) &&
        rule.tool === action.tool && rule.executor === action.executor && rule.definitionId === action.definitionId &&
        (!grant || rule.id === grant.ruleId && rule.revision === grant.ruleRevision))
      if (rules.length !== 1) return undefined
      const rule = rules[0]!
      if (grant) {
        assertDeferredGrant(grant, action, agentBindingIdentity(binding), creator, agentConversationKey(binding))
        if (!sameSource(grant.source, source) || grant.dueAt !== request.dueAt || grant.issuedAt > at ||
          grant.expiresAt <= at || grant.expiresAt !== Math.max(grant.issuedAt, request.dueAt) + (rule.executionWindowMs ?? 300_000) ||
          request.dueAt > grant.issuedAt + rule.maxDelayMs) return undefined
      } else if (request.dueAt > at + rule.maxDelayMs || source.kind === 'message' && request.dueAt <= at) return undefined
      return { ...rule, creatorIds: [...rule.creatorIds] }
    } catch { return undefined }
  }
  const isCurrent = (grant: AgentDeferredActionGrant, request: AgentDeferredActionAuthorizationRequest) => !!ruleFor(request, grant)
  function captureAuthorization(check: () => boolean, supplied?: AgentDeferredAuthorizationGuard) {
    const controller = new AbortController(), signal = supplied ? AbortSignal.any([controller.signal, supplied.signal]) : controller.signal
    const current = () => {
      let allowed = false
      try { allowed = !signal.aborted && supplied?.isCurrent() !== false && check() } catch { /* Fail closed. */ }
      if (!allowed) controller.abort()
      return allowed
    }
    return { signal, isCurrent: current, release: () => controller.abort() }
  }
  return {
    isCurrent,
    async issue(request, supplied) {
      const rule = ruleFor(request)
      if (!rule) return undefined
      const guard = captureAuthorization(() => {
        const current = ruleFor(request)
        return !!current && current.id === rule.id && current.revision === rule.revision && current.maxDelayMs === rule.maxDelayMs &&
          (current.executionWindowMs ?? 300_000) === (rule.executionWindowMs ?? 300_000)
      }, supplied)
      try {
        if (!guard.isCurrent()) return undefined
        const checked = await ports.verifyAuthority({ phase: 'create', request, signal: guard.signal, isCurrent: guard.isCurrent })
        if (checked !== 'allowed' || !guard.isCurrent()) return undefined
        const issuedAt = now()
        return Object.freeze({
          version: 1 as const, id: randomUUID(), ruleId: rule.id, ruleRevision: rule.revision,
          bindingIdentity: agentBindingIdentity(request.binding), scopeKey: agentConversationKey(request.binding), creator: Object.freeze({ ...request.creator }),
          actionHash: deferredActionHash(request.action), source: Object.freeze({ ...request.source }),
          issuedAt, expiresAt: Math.max(issuedAt, request.dueAt) + (rule.executionWindowMs ?? 300_000), dueAt: request.dueAt,
        })
      } catch { return undefined }
      finally { guard.release() }
    },
    async check(grant, request, supplied) {
      const guard = captureAuthorization(() => isCurrent(grant, request), supplied)
      try {
        if (!guard.isCurrent()) return 'denied'
        const checked = await ports.verifyAuthority({ phase: 'execute', request, grant, signal: guard.signal, isCurrent: guard.isCurrent })
        if (!guard.isCurrent()) return 'denied'
        return checked === 'allowed' || checked === 'unavailable' ? checked : 'denied'
      } catch { return guard.isCurrent() ? 'unavailable' : 'denied' }
      finally { guard.release() }
    },
  }
}
