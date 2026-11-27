import { executeDiceDeck, formatDiceDeck, normalizeDiceDeck, pickDeckCard } from '../domain/diceDeck.js'
import type { Deck, DeckContext } from '../domain/diceDeck.js'
export type { Deck, DeckContext } from '../domain/diceDeck.js'
export interface DeckOptions {decksDir?:string;logger?:{warn?(message:string):void}|undefined}
import fs from "fs"
import path from "path"
import YAML from "yaml"

import { secureDiceInt } from "./diceRandom.js"

// 牌堆系统：sealdice ext_deck.go 的 JS 移植（差异对照报告 差异7）。
// 支持社区 seal 格式（JSON/YAML：顶层键=牌组名，_ 前缀为元数据或隐藏牌组）。
// 抽取语义：{牌组}/{牌组} 嵌套不放回（单次命令内）、{%牌组} 放回、::N:: 权重、
// {player}/{self} 特殊变量、[牌组] 方括号嵌套、深度上限防死循环。

export class DeckManager {
logger:DeckOptions["logger"];decksDir:string;decks:Deck[];loadedAt:number;lastError:string;
  constructor({ decksDir = "", logger }:DeckOptions = {}) {
    this.logger = logger
    this.decksDir = decksDir || this.resolveDefaultDecksDir()
    this.decks = []
    this.loadedAt = 0
    this.lastError = ""
  }

  resolveDefaultDecksDir() {
    return path.join(process.cwd(), "plugins/shiloh-plugin/config/decks")
  }

  /** 加载 decksDir 下全部 .json/.yaml/.yml 牌堆文件（幂等，返回牌堆数） */
  reload() {
    this.decks = []
    this.lastError = ""
    this.loadedAt = Date.now()
    if (!fs.existsSync(this.decksDir)) {
      fs.mkdirSync(this.decksDir, { recursive: true })
      return 0
    }
    for (const fileName of fs.readdirSync(this.decksDir).sort()) {
      if (!/\.(json|ya?ml)$/i.test(fileName)) continue
      const filePath = path.join(this.decksDir, fileName)
      try {
        const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "")
        const data = /\.json$/i.test(fileName) ? JSON.parse(raw) : YAML.parse(raw)
        const deck = this.normalizeDeck(data, fileName)
        if (deck) this.decks.push(deck)
      } catch (error) {
        this.lastError += `${fileName}: ${error instanceof Error?error.message:String(error)}; `
        this.logger?.warn?.(`[牌堆] 文件「${fileName}」解析失败: ${error instanceof Error?error.message:String(error)}`)
      }
    }
    return this.decks.length
  }

  /** seal 格式归一化：_ 前缀键为元数据/隐藏牌组 */
  normalizeDeck(data: unknown = {}, fileName = "") {
    return normalizeDiceDeck(data, fileName)
  }

  ensureLoaded() {
    if (!this.decks.length && !this.loadedAt) this.reload()
  }

  findDeck(deckName = "") {
    this.ensureLoaded()
    const target = String(deckName).trim()
    if (!target) return null
    return this.decks.find(deck => deck.items[target] && deck.command[target] !== false) || null
  }

  listDecks() {
    this.ensureLoaded()
    if (!this.decks.length) return `没有载入任何牌堆。把牌堆 json/yaml 放到 ${this.decksDir} 后发 .draw reload`
    return this.decks.map(deck => {
      const visible = Object.keys(deck.command).filter(k => deck.command[k])
      const meta = [deck.author ? `作者:${deck.author}` : "", deck.version ? `版本:${deck.version}` : ""].filter(Boolean).join(" ")
      return `- ${deck.name} ${meta} 牌组数量: ${visible.length}`.trim()
    }).join("\n")
  }

  listKeys(filter = "") {
    this.ensureLoaded()
    const keys = []
    for (const deck of this.decks) {
      for (const key of Object.keys(deck.command)) {
        if (deck.command[key] && key.includes(filter)) keys.push(key)
      }
    }
    if (!keys.length) return filter ? `没有包含「${filter}」的牌组` : "没有可用牌组"
    return `牌组关键字列表：\n${[...new Set(keys)].join("、")}`
  }

  searchDecks(keyword = "") {
    this.ensureLoaded()
    const hits = []
    for (const deck of this.decks) {
      for (const key of Object.keys(deck.command)) {
        if (deck.command[key] && key.toLowerCase().includes(String(keyword).toLowerCase())) {
          hits.push(`${deck.name}/${key}`)
        }
      }
    }
    return hits.length ? `找到 ${hits.length} 个：\n${hits.slice(0, 30).join("\n")}` : `未找到包含「${keyword}」的牌组`
  }

  descDeck(keyword = "") {
    this.ensureLoaded()
    const deck = this.decks.find(d => d.name.toLowerCase().includes(String(keyword).toLowerCase())) || this.findDeck(keyword)
    if (!deck) return "此关键字未找到牌堆"
    const visible = Object.keys(deck.command).filter(k => deck.command[k])
    return [
      `牌堆: ${deck.name}`,
      deck.author ? `作者: ${deck.author}` : "",
      deck.version ? `版本: ${deck.version}` : "",
      deck.date ? `时间: ${deck.date}` : "",
      `牌组数量: ${visible.length}`,
      `牌组: ${visible.join("/")}`
    ].filter(Boolean).join("\n")
  }

  /** 抽一张。ctx 为本次命令的执行上下文（不放回池挂在 ctx 上，命令结束即失效）。 */
  draw(deckName = "", ctx:DeckContext = {}) {
    this.ensureLoaded()
    const deck = this.findDeck(deckName)
    if (!deck) return { error: `牌组「${deckName}」不存在，可用 .draw keys 查看` }
    try {
      const text = this.executeDeck(deck, String(deckName).trim(), true, ctx, 0)
      return { text }
    } catch (error) {
      return { error: error instanceof Error?error.message:String(error) }
    }
  }

  pickFromList(list: string[] = []) {
    return pickDeckCard(list, secureDiceInt)
  }

  executeDeck(deck: Deck, deckName: string, useShufflePool: boolean, ctx: DeckContext, depth: number): string {
    return executeDiceDeck(deck, deckName, useShufflePool, ctx, depth, secureDiceInt)
  }

  formatDeckString(deck: Deck, input = "", ctx: DeckContext = {}, depth = 0) {
    return formatDiceDeck(deck, String(input), ctx, depth, secureDiceInt)
  }
}


