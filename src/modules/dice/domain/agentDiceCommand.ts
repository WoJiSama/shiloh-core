import type { AgentDiceConfig } from '../../../contracts/agentDice.js'

export interface ResolvedAgentDiceConfig {
  readonly enabled: boolean
  readonly maxDiceCount: number
  readonly maxDiceSides: number
  readonly maxRounds: number
}
export function resolveAgentDiceConfig(input?: AgentDiceConfig): ResolvedAgentDiceConfig {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['enabled', 'maxDiceCount', 'maxDiceSides', 'maxRounds'].includes(key)) || typeof input.enabled !== 'boolean')) throw new Error('骰子配置无效')
  const resolved = { enabled: input?.enabled ?? false, maxDiceCount: input?.maxDiceCount ?? 100,
    maxDiceSides: input?.maxDiceSides ?? 100_000, maxRounds: input?.maxRounds ?? 20 }
  for (const [key, min, max] of [['maxDiceCount', 1, 10_000], ['maxDiceSides', 2, 100_000_000], ['maxRounds', 1, 1000]] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < min || resolved[key] > max) throw new Error('骰子配置无效')
  }
  return Object.freeze(resolved)
}
const command = /^[.。]\s*(?:r(?![A-Za-z])|roll)([\s\S]*)$/iu
/** A recognized but malformed command remains owned by the deterministic path. */
export function isAgentDiceCommand(text: string): boolean { return command.test(text.trim()) }
export function parseAgentDiceCommands(text: string): readonly string[] {
  const raw = text.trim()
  if (raw.length > 16_384) throw new Error('骰子命令过长')
  const parts = raw.split(/(?=[.。]\s*(?:r(?![A-Za-z])|roll))/iu).filter(Boolean)
  if (parts.length < 1 || parts.length > 5) throw new Error('骰子命令数量无效')
  return Object.freeze(parts.map(part => {
    const match = command.exec(part.trim())
    if (!match) throw new Error('骰子命令格式无效')
    return match[1]!.trim() || '1d100'
  }))
}
