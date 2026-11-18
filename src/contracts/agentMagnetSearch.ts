import type { AgentMediaResourceContext } from './agentMediaRelay.js'

export interface AgentMagnetSearchConfig { readonly enabled: boolean }
export interface AgentMagnetSearchInput { readonly keyword: string; readonly limit?: number }
/** Public index metadata only. Neither search entry point can download or select a delivery target. */
export interface AgentMagnetSearchProvider {
  search(input: AgentMagnetSearchInput, context: AgentMediaResourceContext): Promise<string>
}
