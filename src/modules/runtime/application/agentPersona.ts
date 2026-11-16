import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import { agentPersonaScopeId } from '../domain/agentBindings.js'

/** Resolve a reusable template and the role's separate, stable state identity. */
export function resolveConfiguredAgentPersona<T extends object>(binding: AgentBindingSnapshot, findPersona: (id: string) => T | null | undefined) {
  const selected = findPersona(binding.personaId)
  if (!selected) throw new Error('角色绑定引用的人设不存在')
  const scopeId = agentPersonaScopeId(binding.agentId)
  if (findPersona(scopeId)) throw new Error('角色状态标识与现有人设 ID 冲突')
  return { selected, scopeId }
}
