export interface Deck {
  name: string
  author: string
  version: string
  date: string
  fileName: string
  items: Record<string, string[]>
  command: Record<string, boolean>
}

export interface DeckContext {
  playerName?: string
  selfName?: string
  pools?: Record<string, string[]>
  maxDraws?: number
  maxDepth?: number
  maxTextLength?: number
}

type Roll = (maximum: number) => number
const weightPrefix = /^::(\d+)::/u

export function normalizeDiceDeck(data: unknown, fileName = ''): Deck | null {
  const items: Record<string, string[]> = Object.create(null)
  const command: Record<string, boolean> = Object.create(null)
  const meta = { name: fileName.replace(/\.(json|ya?ml)$/i, ''), author: '', version: '', date: '' }
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  for (const [key, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue
    if (key === '_name' || key === '_title') meta.name = String(value[0] ?? meta.name)
    else if (key === '_author') meta.author = String(value[0] ?? '')
    else if (key === '_version') meta.version = String(value[0] ?? '')
    else if (key === '_date') meta.date = String(value[0] ?? '')
    else {
      items[key] = value.map(String)
      command[key] = !key.startsWith('_')
    }
  }
  return Object.keys(items).length ? { ...meta, fileName, items, command } : null
}

function weightedCard(value: string) {
  const match = weightPrefix.exec(value)
  return { weight: match ? Math.max(1, Number(match[1])) : 1, text: match ? value.slice(match[0].length) : value }
}

export function pickDeckCard(list: string[], roll: Roll): string {
  const weighted = list.map(weightedCard)
  const total = weighted.reduce((sum, item) => sum + item.weight, 0)
  let cursor = roll(Math.max(1, total))
  for (const item of weighted) {
    cursor -= item.weight
    if (cursor <= 0) return item.text
  }
  return weighted.at(-1)?.text ?? ''
}

export function executeDiceDeck(deck: Deck, name: string, usePool: boolean, ctx: DeckContext, depth: number, roll: Roll): string {
  if (depth > (ctx.maxDepth ?? 2000) || ctx.maxDraws !== undefined && --ctx.maxDraws < 0) throw new Error('抽取嵌套超出上限，疑似死循环')
  const group = deck.items[name]
  if (!group?.length) throw new Error(`牌组「${name}」为空，请检查格式`)
  let text: string
  if (usePool) {
    ctx.pools ??= Object.create(null) as Record<string, string[]>
    const poolKey = `${deck.name}/${name}`
    let pool = ctx.pools[poolKey]
    if (!pool?.length) {
      pool = []
      for (const value of group) {
        const { weight, text } = weightedCard(value)
        for (let index = 0; index < weight; index++) pool.push(text)
      }
      ctx.pools[poolKey] = pool
    }
    text = pool.splice(roll(pool.length) - 1, 1)[0] ?? ''
  } else text = pickDeckCard(group, roll)
  return formatDiceDeck(deck, text, ctx, depth + 1, roll)
}

export function formatDiceDeck(deck: Deck, input: string, ctx: DeckContext, depth: number, roll: Roll): string {
  function draw(name: string, usePool: boolean) {
    if (!Object.hasOwn(deck.items, name)) return `<%未知牌组-${name}%>`
    try { return executeDiceDeck(deck, name, usePool, ctx, depth, roll) }
    catch { return `<%抽取错误-${name}%>` }
  }
  function replace(source: string, pattern: RegExp, replacement: (token: string) => string) {
    let text = source
    const matches = [...source.matchAll(pattern)]
    for (let index = matches.length - 1; index >= 0; index--) {
      const match = matches[index]!
      text = text.slice(0, match.index) + replacement(match[0]) + text.slice(match.index + match[0].length)
      if (ctx.maxTextLength !== undefined && text.length > ctx.maxTextLength) throw new Error('抽取文字超出上限')
    }
    return text
  }
  const braces = replace(input, /\{[$%]?[^{}]+\}/gu, token => {
    if (token === '{player}') return ctx.playerName || '未知用户'
    if (token === '{self}') return ctx.selfName || '骰娘'
    const sign = token[1]
    return draw(token.slice(sign === '$' || sign === '%' ? 2 : 1, -1), sign !== '%')
  })
  return replace(braces, /\[[^\[\]{$}]+\]/gu, token => draw(token.slice(1, -1), true))
}
