import type { DiceRoll } from '../../../contracts/dice.js'

export interface DiceExpressionLimits {
  readonly maxDiceCount: number
  readonly maxDiceSides: number
}

// Bound user-controlled recursive input before it can exhaust the JS call stack.
export const MAX_DICE_EXPRESSION_LENGTH = 16_384
export const MAX_DICE_EXPRESSION_DEPTH = 128

export function normalizeDiceExpression(expr = "") {
  return String(expr || "1d100")
    .replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[＋﹢]/g, "+")
    .replace(/[－﹣]/g, "-")
    .replace(/[＊×]/g, "*")
    .replace(/[／÷]/g, "/")
    .replace(/[％]/g, "%")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\bmod\b/gi, "%")
    // 梨骰算符（sealdice dicescript roll.peg _dicePearMod）：d20优势=2d20kh1、d20劣势=2d20kl1，支持繁体
    .replace(/(?<![\dd.])d(\d+)(优势|優勢)/gi, (_, sides) => `2d${sides}kh1`)
    .replace(/(?<![\dd.])d(\d+)(劣势|劣勢)/gi, (_, sides) => `2d${sides}kl1`)
    .replace(/\s+/g, "")
    .toLowerCase()
}

class DiceExpressionParser {
 rawExpr:string;comparison:{op:string;threshold:number}|null;expr:string;displayExpr:string;config:DiceExpressionLimits;random:()=>number;pos:number;depth:number;diceCount:number;detailParts:string[];
 lastDice:{count:number;sides:number;suffixText:string;rolls:number[];kept:number[];keptText:string}|null;lastDiceDetailIndex:number;
  constructor(expr:string, config:DiceExpressionLimits, random:()=>number) {
    if (String(expr || "1d100").length > MAX_DICE_EXPRESSION_LENGTH) throw new Error(`骰点表达式长度不能超过 ${MAX_DICE_EXPRESSION_LENGTH} 个字符`)
    if (typeof random !== "function") throw new TypeError("骰点随机源必须由调用方提供")
    let working = normalizeDiceExpression(expr)
    this.rawExpr = working
    // 兼容糖：骰池尾缀 aN（如 6d6a4）= 逐骰 >N 计数；仅在本来没有比较运算时转换
    if (!/[<>]/.test(working)) working = working.replace(/([\d)])a(\d+)$/, "$1>$2")
    // 尾部比较子句：d100<60 / 6d6>=4（全角＜＞已归一化），对最后一组骰子逐骰判定
    this.comparison = null
    const cmp = working.match(/(<=|>=|<|>)(\d+)$/)
    if (cmp) {
      this.comparison = { op: cmp[1]!, threshold: Number(cmp[2]!) }
      working = working.slice(0, cmp.index)
    }
    this.expr = working || "1d100"
    // 展示用：含 aN 糖转换与比较子句的完整写法
    this.displayExpr = this.comparison ? `${this.expr}${this.comparison.op}${this.comparison!.threshold}` : this.expr
    this.config = config
    this.random = random
    this.pos = 0
    this.depth = 0
    this.diceCount = 0
    this.detailParts = []
    this.lastDice = null
    this.lastDiceDetailIndex = -1
  }

  peek() {
    return this.expr[this.pos] || ""
  }

  consume(char:string) {
    if (this.peek() === char) {
      this.pos += 1
      return true
    }
    return false
  }

  readNumber() {
    const start = this.pos
    while (/\d/.test(this.peek())) this.pos += 1
    if (start === this.pos) return null
    return Number(this.expr.slice(start, this.pos))
  }

  parse() {
    if (!this.expr) throw new Error("骰点表达式不能为空")
    const value = this.parseExpression()
    if (this.pos !== this.expr.length) {
      throw new Error(`骰点表达式在「${this.expr.slice(this.pos)}」附近格式不正确`)
    }
    if (!Number.isFinite(value)) throw new Error("骰点结果无效")
    const base:DiceRoll = {
      expr: this.displayExpr.toUpperCase(),
      detail: this.detailParts.length ? this.detailParts.join("+") : String(Math.trunc(value)),
      total: Math.trunc(value)
    }
    if (!this.comparison) return base
    // 比较计数：对最后一组骰子的保留结果逐骰 ✓/✗；没有骰子时对总算术结果判定一次
    const compareOk = (v:number) => {
      if (this.comparison!.op === "<") return v < this.comparison!.threshold
      if (this.comparison!.op === "<=") return v <= this.comparison!.threshold
      if (this.comparison!.op === ">") return v > this.comparison!.threshold
      return v >= this.comparison!.threshold
    }
    const dice = this.lastDice?.kept?.length ? this.lastDice.kept : [Math.trunc(value)]
    const success = dice.filter(compareOk).length
    if (this.lastDice && this.lastDiceDetailIndex >= 0) {
      const markedKept = this.lastDice.kept.map(v => `${v}${compareOk(v) ? "✓" : "✗"}`).join("+")
      const inner = this.lastDice.rolls.join("+")
      const shown = this.lastDice.keptText
        ? `${inner}=>${markedKept}`
        : markedKept
      this.detailParts[this.lastDiceDetailIndex] = `${this.lastDice.count}D${this.lastDice.sides}${this.lastDice.suffixText}[${shown}]`
      base.detail = this.detailParts.join("+")
    }
    base.total = `成功 ${success}/${dice.length}`
    return base
  }

  parseExpression():number {
    let value = this.parseTerm()
    while (true) {
      if (this.consume("+")) value += this.parseTerm()
      else if (this.consume("-")) value -= this.parseTerm()
      else break
    }
    return value
  }

  parseTerm():number {
    let value = this.parseUnary()
    while (true) {
      if (this.consume("*")) value *= this.parseUnary()
      else if (this.consume("/")) {
        const right = this.parseUnary()
        if (right === 0) throw new Error("骰点表达式不能除以 0")
        value /= right
      } else if (this.consume("%")) {
        const right = this.parseUnary()
        if (right === 0) throw new Error("骰点表达式不能对 0 取余")
        value %= right
      } else break
    }
    return value
  }

  withDepth(read:()=>number):number {
    if (this.depth >= MAX_DICE_EXPRESSION_DEPTH) throw new Error(`骰点表达式嵌套层数不能超过 ${MAX_DICE_EXPRESSION_DEPTH}`)
    this.depth += 1
    try { return read() } finally { this.depth -= 1 }
  }

  parseUnary():number {
    if (this.consume("+")) return this.withDepth(() => this.parseUnary())
    if (this.consume("-")) return -this.withDepth(() => this.parseUnary())
    return this.parsePrimary()
  }

  parsePrimary():number {
    if (this.consume("(")) {
      return this.withDepth(() => {
        const value = this.parseExpression()
        if (!this.consume(")")) throw new Error("括号未闭合")
        return value
      })
    }
    const number = this.readNumber()
    if (this.consume("d")) return this.parseDice(number || 1)
    // 命运骰（sealdice dicescript RollFate）：每颗 -1/0/+1，默认 4 颗，符号序列展示
    if (this.peek() === "f") {
      this.pos += 1
      return this.parseFateDice(number === null ? 4 : number)
    }
    if (number !== null) return number
    if (this.peek() === "d") {
      this.pos += 1
      return this.parseDice(1)
    }
    throw new Error(`骰点表达式在「${this.expr.slice(this.pos)}」附近格式不正确`)
  }

  parseDice(count:number) {
    const sides = this.readNumber()
    if (sides===null||!Number.isInteger(sides)) throw new Error("骰子面数不能为空")
    if (!Number.isInteger(count) || count < 1 || count > this.config.maxDiceCount) throw new Error(`骰子数量必须是 1-${this.config.maxDiceCount}`)
    if (sides < 2 || sides > this.config.maxDiceSides) throw new Error(`骰子面数必须是 2-${this.config.maxDiceSides}`)
    this.diceCount += count
    if (this.diceCount > this.config.maxDiceCount) throw new Error(`单次最多掷 ${this.config.maxDiceCount} 颗骰子`)

    const rolls = Array.from({ length: count }, () => Math.floor(this.random() * sides) + 1)
    const suffix = this.parseDiceSuffix(count)
    let kept = [...rolls]
    let suffixText = ""
    if (suffix) {
      const sortedAsc = [...rolls].sort((a, b) => a - b)
      const n = Math.min(count, Math.max(0, suffix.n))
      if (suffix.type === "kh") kept = sortedAsc.slice(-n)
      if (suffix.type === "kl") kept = sortedAsc.slice(0, n)
      if (suffix.type === "dh") kept = sortedAsc.slice(0, Math.max(0, count - n))
      if (suffix.type === "dl") kept = sortedAsc.slice(n)
      if (suffix.type === "min") kept = rolls.map(v => Math.max(v, n))
      if (suffix.type === "max") kept = rolls.map(v => Math.min(v, n))
      suffixText = suffix.raw.toUpperCase()
    }
    const total = kept.reduce((sum, value) => sum + value, 0)
    const keptText = suffix ? `=>${kept.join("+")}` : ""
    this.lastDiceDetailIndex = this.detailParts.length
    this.lastDice = { count, sides, suffixText, rolls: [...rolls], kept: [...kept], keptText }
    this.detailParts.push(`${count}D${sides}${suffixText}[${rolls.join("+")}${keptText}]`)
    return total
  }

  parseFateDice(count:number) {
    if (!Number.isInteger(count) || count < 1 || count > this.config.maxDiceCount) {
      throw new Error(`命运骰数量必须是 1-${this.config.maxDiceCount}`)
    }
    this.diceCount += count
    if (this.diceCount > this.config.maxDiceCount) throw new Error(`单次最多掷 ${this.config.maxDiceCount} 颗骰子`)
    const rolls = Array.from({ length: count }, () => Math.min(2, Math.floor(this.random() * 3)) - 1)
    const symbols = rolls.map(value => (value === -1 ? "-" : value === 0 ? "0" : "+")).join("")
    const total = rolls.reduce((sum, value) => sum + value, 0)
    this.detailParts.push(`${count}F[${symbols}]`)
    return total
  }

  parseDiceSuffix(count:number) {
    const rest = this.expr.slice(this.pos)
    const match = rest.match(/^(kh|kl|dh|dl|min|max)(\d*)/)
    if (!match) return null
    const raw = match[0]
    this.pos += raw.length
    const defaultN = match[1]! === "kh" || match[1]! === "kl" || match[1]! === "dh" || match[1]! === "dl" ? 1 : count
    return { type: match[1]!, n: match[2]! ? Number(match[2]!) : defaultN, raw }
  }
}


/** Evaluate one expression with caller-owned limits and random source. */
export function rollDiceExpression(expr:string, limits:DiceExpressionLimits, random:()=>number):DiceRoll {
  return new DiceExpressionParser(expr || "1d100", limits, random).parse()
}

export function splitDiceRounds(text = "") {
  const raw = String(text || "").trim()
  const prefix = raw.match(/^(\d+)\s*#\s*(.+)$/)
  if (prefix) return { rounds: Math.max(1, Number(prefix[1]!) || 1), expr: prefix[2]!.trim() }
  const suffix = raw.match(/^(.+?)\s*#\s*(\d+)$/)
  if (suffix) return { rounds: Math.max(1, Number(suffix[2]!) || 1), expr: suffix[1]!.trim() }
  return { rounds: 1, expr: raw }
}
