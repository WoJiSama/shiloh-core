import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext } from '../contracts/agentConsole.js'
import { AgentManagementError } from '../contracts/agentManagement.js'
import type { AgentManagementContext, AgentManagementModules } from '../contracts/agentManagement.js'
import type { StandaloneAgentConsoleServicesPorts } from './standaloneAgentConsoleServices.js'
import { captureSynchronousGuardCheck, createSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'

export type AgentConsoleManagementModules = AgentManagementModules

/** Adapts authenticated host requests to neutral Core management, without exporting console principals to modules. */
export function createStandaloneAgentConsoleManagement(options: {
  readonly management: AgentConsoleManagementModules
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize' | 'isCurrent'>
  readonly observeCurrent?: (check: () => boolean) => boolean
}): Pick<StandaloneAgentConsoleServicesPorts, 'profiles' | 'trusteeship'> {
  const observe = options.observeCurrent ?? ((check: () => boolean) => check())
  function authority(context: AgentConsoleContext): AgentManagementContext {
    const fail = (): never => { throw new AgentConsoleError('conflict') }
    const captured = captureSynchronousGuardCheck(context, fail)
    const isCurrent = () => {
      try { return !context.signal.aborted && context.isCurrent() && options.auth.isCurrent(context.principal) }
      catch { return false }
    }
    const parent = captured ? createSynchronousGuard(context.signal, () => {
      captured()
      let current = false
      try { current = options.auth.isCurrent(context.principal) } catch { return fail() }
      if (!current) fail()
    }, fail) : { signal: context.signal, isCurrent, ensureCurrent() { context.ensureCurrent(); if (!isCurrent()) fail() } }
    return {
      ...parent, ...(context.binding ? { binding: context.binding } : {}),
      ...(context.profileForget ? { profileForget: context.profileForget } : {}),
      async authorize(operation, binding, guard) {
        const checkParent = captureSynchronousGuardCheck(parent, fail), checkChild = captureSynchronousGuardCheck(guard, fail)
        const scoped = checkParent && checkChild ? createSynchronousGuard(context.signal, () => {
          const accepted = observe(() => {
            checkParent()
            checkChild()
            return true
          })
          if (!accepted) fail()
        }, fail) : { signal: context.signal, isCurrent: () => parent.isCurrent() && guard.isCurrent(),
          ensureCurrent() { parent.ensureCurrent(); guard.ensureCurrent() } }
        scoped.ensureCurrent()
        const decision = await options.auth.authorize(context.principal, operation, binding, scoped)
        scoped.ensureCurrent()
        return decision
      },
    }
  }
  async function invoke<T>(context: AgentConsoleContext, action: (guard: AgentManagementContext) => Promise<T>): Promise<T> {
    const guard = authority(context)
    guard.ensureCurrent()
    try {
      const result = await action(guard)
      guard.ensureCurrent()
      return result
    } catch (error) {
      if (error instanceof AgentManagementError) throw new AgentConsoleError(error.code)
      throw error
    }
  }
  const { profiles, trusteeship } = options.management
  return {
    profiles: {
      list: context => invoke(context, guard => profiles.list(guard)),
      remove: (userId, context) => invoke(context, guard => profiles.remove(userId, guard)),
      removeField: (userId, field, value, context) => invoke(context, guard => profiles.removeField(userId, field, value, guard)),
    },
    trusteeship: {
      overview: context => invoke(context, guard => trusteeship.overview(guard)),
      cancelCommitment: (scopeKey, id, context) => invoke(context, guard => trusteeship.cancelCommitment(scopeKey, id, guard)),
      deleteDelegated: (scopeKey, id, context) => invoke(context, guard => trusteeship.deleteDelegated(scopeKey, id, guard)),
      clearFailLog: context => invoke(context, guard => trusteeship.clearFailLog(guard)),
    },
  }
}
