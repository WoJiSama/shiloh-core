import type { SimulationSection, SimRuntimeConfig } from '../../../contracts/simulation.js'
import { defaultSimRuntimeConfig } from '../domain/simConfig.js'
import { decodeSimulationAddressKey, isQqSimulationAddress } from './simulationAddress.js'
import type { SimGroupOverrides } from './simSessionStore.js'

export function seedSimulationOverrides(section: SimulationSection): SimGroupOverrides {
  const groups = Array.isArray(section.groups) ? section.groups.map(String) : []
  return { explicitEnabled: groups, disabled: [], budgetCaps: {}, turnCaps: {} }
}

export function resolveSimulationGroupConfig(section: SimulationSection, overrides: SimGroupOverrides | null, groupId?: string): SimRuntimeConfig {
  const config = defaultSimRuntimeConfig(section)
  if (overrides) {
    Object.assign(config.budget.groups, overrides.budgetCaps)
    Object.assign(config.turn.groups, overrides.turnCaps)
    if (overrides.budgetDefaultCny !== undefined) config.budget.dailyCostCny = overrides.budgetDefaultCny
  }
  const address = groupId ? decodeSimulationAddressKey(groupId) : null
  if (groupId && address && isQqSimulationAddress(address)) {
    const cost = config.budget.groups[groupId] ?? config.budget.groups[address.id]
    const turns = config.turn.groups[groupId] ?? config.turn.groups[address.id]
    if (cost !== undefined) config.budget.groups[groupId] = cost
    if (turns !== undefined) config.turn.groups[groupId] = turns
  }
  return config
}

export function simulationGroupOverride(overrides: SimGroupOverrides, groupId: string): boolean | undefined {
  for (const id of [groupId, qqGroupFallback(groupId)]) {
    if (!id) continue
    if (overrides.disabled.includes(id)) return false
    if (overrides.explicitEnabled.includes(id)) return true
  }
  return undefined
}

function qqGroupFallback(groupId: string): string | undefined {
  const address = decodeSimulationAddressKey(groupId)
  return address && isQqSimulationAddress(address) ? address.id : undefined
}
