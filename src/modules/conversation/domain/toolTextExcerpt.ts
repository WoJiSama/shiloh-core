import { extractSearchTerms } from './agentIntelligence.js'
import { sanitizeUnicodeText, splitUnicodeText } from '../../models/domain/unicodeText.js'

/** Keep verbatim excerpts, with gaps explicit and the original order preserved. */
export function excerptToolText(text: string, limit: number, query: string): string {
  if (text.length <= limit) return text
  return excerptLabeledSources(text, limit, query) ?? excerptRange(text, limit, query)
}

export function excerptLabeledSources(text: string, limit: number, query: string): string | undefined {
  const labels = [...text.matchAll(/^(?:来源|出处|source)[：:][ \t]*(https?:\/\/[^\s<>]{1,1024})[ \t]*\r?$/gimu)]
  if (labels.length < 2 || labels.length > 8 || new Set(labels.map(label => label[1])).size !== labels.length) return
  const blocks = labels.map((label, index) => ({ label: label[0].trim(), body: text.slice(label.index + label[0].length, labels[index + 1]?.index).trim() }))
  if (blocks.some(block => block.body.length < 16)) return
  const preamble = text.slice(0, labels[0]!.index).trim()
  // The introduction is independent of any specific source. Preserve it only when already short.
  const header = preamble && preamble.length <= 150 ? `${preamble}\n\n` : ''
  const sectionLimit = Math.floor((limit - header.length - blocks.reduce((total, block) => total + block.label.length + 3, 0)) / blocks.length)
  if (sectionLimit < 224) return
  return header + blocks.map(block => `${block.label}\n${block.body.length <= sectionLimit ? block.body : excerptRange(block.body, sectionLimit, query)}`).join('\n\n')
}

function excerptRange(text: string, limit: number, query: string): string {
  const headSize = Math.floor(limit / 4), tailSize = Math.floor(limit / 3)
  const head = sanitizeUnicodeText(text.slice(0, headSize))
  const tail = sanitizeUnicodeText(text.slice(-tailSize))
  const start = '【开头】\n', end = '\n【末尾节选】\n', selected = '\n【相关原文节选】\n'
  const omitted = '\n【其余资料已省略，不能视为已查全】'
  const middleLimit = limit - head.length - tail.length - start.length - end.length - selected.length - omitted.length
  const matches = relevantExcerpts(text.slice(headSize, -tailSize), query)
  const middle = sanitizeUnicodeText(matches.join('\n…\n').slice(0, middleLimit))
  return start + head + (middle ? selected + middle : '') + end + tail + omitted
}

function relevantExcerpts(text: string, query: string): string[] {
  const terms = extractSearchTerms(query)
  if (!terms.length) return []
  const matches: { chunk: string; index: number; score: number }[] = []
  let index = 0
  for (const line of text.split(/\n+|(?<=[。！？!?])\s*/u)) {
    for (const chunk of splitUnicodeText(line.trim(), 240)) {
      index++
      const lower = chunk.toLowerCase()
      const score = terms.reduce((count, term) => count + (lower.includes(term) ? term.length : 0), 0)
      if (!score || matches.length === 3 && score < matches[2]!.score) continue
      matches.push({ chunk, index, score })
      matches.sort((a, b) => b.score - a.score || b.index - a.index)
      if (matches.length > 3) matches.pop()
    }
  }
  return matches.sort((a, b) => a.index - b.index).map(match => match.chunk)
}
