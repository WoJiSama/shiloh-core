import { excerptLabeledSources, excerptToolText } from '../../conversation/domain/toolTextExcerpt.js'
import { sanitizeUnicodeText } from '../../models/domain/unicodeText.js'
import { classifyCharacterResult } from './characterState.js'

const excerptTools = new Set(['searchInformationTool', 'webParserTool'])
const excerptLimit = 3_200
const earlierExcerptLimit = 1_024

export interface SimulationActionReceipt {
  readonly evidenceRef: string
  readonly status: 'succeeded' | 'failed' | 'unknown'
  readonly goalId?: string
}

interface SimulationToolResultInput {
  name: string
  content: string
  query: string
  receipt?: SimulationActionReceipt
  allowsText?: (text: string) => boolean
}

function formatReceipt(receipt: SimulationActionReceipt | undefined): string {
  return receipt ? `【运行时行动回执】${JSON.stringify(receipt)}` : ''
}

function resultBody(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      if (row.kind === 'tool_outcome' && typeof row.content === 'string') return row.content
      if (typeof row.ok === 'boolean' && typeof row.result === 'string') return row.result
    }
  } catch { /* Plain-text tool result. */ }
  return text
}

export function projectSimulationToolResult(input: SimulationToolResultInput & { maxChars: number }): { content: string; truncated: boolean } {
  const { content, receipt, allowsText } = input
  const receiptLine = formatReceipt(receipt)
  const suffix = receiptLine ? `\n${receiptLine}` : ''
  const limit = excerptTools.has(input.name) ? Math.min(input.maxChars, excerptLimit) : input.maxChars
  const full = content + suffix
  if (full.length <= limit) return { content: full, truncated: false }

  const blocked = { content: `error: 工具正文未通过宿主检查${suffix}`, truncated: true }
  try {
    if (allowsText?.(content) === false) return blocked
    let projected: string
    if (excerptTools.has(input.name)) {
      const status = receipt?.status ?? classifyCharacterResult(content)
      const prefix = `【工具结果状态：${status}】\n${receiptLine ? `${receiptLine}\n` : ''}`
        projected = prefix + excerptToolText(resultBody(content), limit - prefix.length, input.query)
    } else {
      const omitted = '\n【其余工具正文已省略】'
      projected = sanitizeUnicodeText(content.slice(0, limit - suffix.length - omitted.length)) + omitted + suffix
    }
    return allowsText?.(projected) === false ? blocked : { content: projected, truncated: true }
  } catch { return blocked }
}

/** Fold only text already shown to the model, using the original execution status and receipt. */
export function prepareEarlierSimulationRead(input: SimulationToolResultInput & { shown: string }): {
  excerpt?: string; sourceKey?: string; sameRead?: string
} | undefined {
  const { name, content, shown, receipt, query, allowsText } = input
  if (!excerptTools.has(name) || (receipt?.status ?? classifyCharacterResult(content)) !== 'succeeded' || shown.startsWith('error:')) return
  const receiptLine = formatReceipt(receipt)
  let body = shown.replace(/^【工具结果状态：succeeded】\n/u, '')
  if (receiptLine && body.startsWith(receiptLine + '\n')) body = body.slice(receiptLine.length + 1)
  if (receiptLine && body.endsWith('\n' + receiptLine)) body = body.slice(0, -receiptLine.length - 1)
  body = resultBody(body)
  const sourcePattern = /^(?:来源|出处|source)[：:][^\r\n]+/gimu
  const sources = [...body.matchAll(sourcePattern)]
  const originalSources = resultBody(content).match(sourcePattern)?.length ?? 0
  if (sources.length > 1 || originalSources > 1) {
    if (sources.length !== originalSources) return {}
    const prefix = ['【较早工具资料，仅供参考】', receiptLine].filter(Boolean).join('\n') + '\n'
    const split = excerptLabeledSources(body, earlierExcerptLimit - prefix.length, query)
    try { return split && allowsText?.(prefix + split) !== false ? { excerpt: prefix + split } : {} } catch { return {} }
  }
  const source = sources[0]
  const sameRead = source && originalSources === 1 && /^\s*(?:来源|出处|source)[：:]\s*https?:\/\/\S+\s*$/iu.test(source[0]) ? {
    sourceKey: name + '\n' + source[0] + '\n' + content,
    sameRead: `【同一来源的相同正文见本轮较新的工具结果】\n${[source[0], receiptLine].filter(Boolean).join('\n')}`,
  } : {}
  if (shown.length <= earlierExcerptLimit) return sameRead
  const prefix = ['【较早工具资料，仅供参考】', receiptLine, source?.[0]].filter(Boolean).join('\n') + '\n'
  const available = earlierExcerptLimit - prefix.length
  if (available < 512) return sameRead
  if (source) body = (body.slice(0, source.index) + body.slice(source.index + source[0].length)).trim()

  const excerpt = prefix + excerptToolText(body, available, query)
  try {
    if (allowsText?.(excerpt) === false || sameRead.sameRead && allowsText?.(sameRead.sameRead) === false) return {}
  } catch { return {} }
  return excerpt.length < shown.length ? { ...sameRead, excerpt } : sameRead
}
