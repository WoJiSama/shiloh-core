import type { AgentMagnetSearchInput } from '../../../contracts/agentMagnetSearch.js'

export const AGENT_MAGNET_SEARCH_HELP = '磁力搜索\n.磁力 <关键词> [数量]\n默认 10 条，最多 20 条。只返回公开索引清单，不会自动下载。'

export function parseAgentMagnetSearchCommand(text: string): AgentMagnetSearchInput | { readonly help: true } | undefined {
  const match = /^[.。](?:磁力搜索|磁链搜索|磁力)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!match) return undefined
  const args = (match[1] ?? '').trim().split(/\s+/u).filter(Boolean)
  if (!args.length) return { help: true }
  let limit = 10
  if (args.length > 1 && /^\d+$/u.test(args.at(-1)!)) limit = Math.max(1, Math.min(20, Number(args.pop()) || 10))
  return { keyword: args.join(' '), limit }
}
