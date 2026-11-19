import type { AgentBindingSnapshot } from './agentBinding.js'

/** The owning character and current source/permissions remain fixed across every provider await. */
export interface AgentLifeThreadContext {
  readonly binding: AgentBindingSnapshot
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

/** Public-source observations only; persistence and character ownership belong to Core. */
export interface AgentLifeThreadProvider {
  resolve(input: { readonly title: string }, context: AgentLifeThreadContext): Promise<
    { ok: true; sourceId: string; title: string; episode?: number } | { ok: false; error: string }>
  sync(input: { readonly sourceId: string; readonly title: string; readonly lastEpisode?: number }, context: AgentLifeThreadContext): Promise<
    { newNotes: string[]; episode?: number } | { error: string }>
}
