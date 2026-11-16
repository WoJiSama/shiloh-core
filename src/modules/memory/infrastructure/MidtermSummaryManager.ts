import { subscribeArchiveRecords } from './archiveHookRegistry.js'
import type {PersonMemoryStore,PersonMemorySource} from '../../../contracts/personMemory.js'
import {createPersonMemorySourceFilter,canReadUnattributedMemory} from './personMemoryContext.js'
interface ArchiveRecord {group_id?:unknown;archive_kind?:string;sender?:{user_id?:unknown;card?:string;nickname?:string};user_id?:unknown;timestamp?:number;raw_message?:unknown;msg?:unknown;message_id?:unknown;source_bot_id?:string;source_persona_id?:string}
interface Archive {formatRecord(record:ArchiveRecord,options:{compact:boolean;maxTextLength:number}):string;getBaseDir():string;recordMessage(event:unknown,options?:unknown):Promise<ArchiveRecord|null>}
interface MemoryAi {memoryAiUrl?:string;memoryAiApikey?:string;memoryAiModel?:string}
interface Logger {warn?(message:string):void;info?(message:string):void}
interface Summary {summary:string;updated_at:number;covered_until_ts:number;updates:number;redaction_cutoff?:number}
interface Line {ts:number;name:string;text:string;source?:PersonMemorySource;botId?:string;personaId?:string}
interface BufferState {lines:Line[];timer:ReturnType<typeof setTimeout>|null;updating:boolean;queued:boolean}
interface Options {baseDir?:string;archiveManager?:Archive|null;config?:Partial<typeof DEFAULT_MIDTERM_CONFIG>;memoryAiConfig?:MemoryAi;logger?:Logger;personMemory?:PersonMemoryStore}
function isSummary(value:unknown):value is Summary {if(!value||typeof value!=='object')return false;const row=value as Record<string,unknown>;return typeof row.summary==='string'&&['updated_at','covered_until_ts','updates'].every(key=>typeof row[key]==='number'&&Number.isFinite(row[key]))}
// 中期记忆:每群一份滚动"主线摘要",补 60 分钟原文窗口与长期 RAG 之间的叙事空档。
// 借鉴 MaiBot/A-Memorix 的会话摘要思路,做薄:单一摘要、便宜模型、追加式更新。
// 链路:归档写入钩子 → 内存缓冲攒批(防抖) → 合并旧摘要生成新摘要 → 落盘 JSON → 提示词层注入。
import fs from "node:fs"
import { sideLLMCall } from "../../../adapters/sideLLM.js"
import path from "node:path"

const CHAT_TIMEOUT_MS = 30000

export const DEFAULT_MIDTERM_CONFIG = {
  enabled: true,
  minMessages: 15,          // 攒够多少条新消息才触发一次摘要更新
  debounceMs: 20000,        // 达到阈值后防抖等待(继续攒批,减少调用)
  maxSummaryChars: 500,     // 摘要长度上限
  bufferMaxLines: 200,      // 单群未消化缓冲上限(超出先截断,防呆群爆内存)
  retentionDays: 3,         // 摘要保留天数(过期的主线自然过期)
  model: ""                 // 留空用 memoryAiConfig.memoryAiModel
}

export function normalizeMidtermConfig(raw:Partial<typeof DEFAULT_MIDTERM_CONFIG> = {}) {
  const config = { ...DEFAULT_MIDTERM_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) }
  config.enabled = config.enabled !== false
  config.minMessages = Math.max(4, Number(config.minMessages) || 15)
  config.debounceMs = Math.max(5000, Number(config.debounceMs) || 20000)
  config.maxSummaryChars = Math.max(120, Number(config.maxSummaryChars) || 500)
  config.bufferMaxLines = Math.max(50, Number(config.bufferMaxLines) || 200)
  config.retentionDays = Math.max(1, Number(config.retentionDays) || 3)
  config.model = String(config.model || "").trim()
  return config
}

function formatClock(ts:unknown) {
  const date = new Date(Number(ts) || 0)
  if (Number.isNaN(date.getTime())) return "??:??"
  const pad = (n:number) => String(n).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const SUMMARY_SYSTEM_PROMPT = `你是群聊主线摘要器。把"已有摘要"与"新增群聊记录"合并成一份群聊主线摘要,给一个稍后回来的人补上"这群最近在聊什么"的上下文。
要求:
- 保留:正在进行的话题、谁在参与、未说完的事、重要决定、反复出现的梗
- 丢弃:寒暄、寒暄式表情、无上下文的碎片
- 按话题组织,不逐条罗列;人名保留
- 控制在规定字数内,超出时优先保留仍在进行的话题
- 只输出摘要正文,不要任何前缀、标题或解释`

export class MidtermSummaryManager {
 personMemory:PersonMemoryStore|undefined
 baseDir:string;archiveManager:Archive|null;config:typeof DEFAULT_MIDTERM_CONFIG;memoryAiConfig:MemoryAi;logger:Logger|undefined;buffers:Map<string,BufferState>;summaryCache:Map<string,Summary>;stats:{updates:number;llmCalls:number;llmFailures:number;linesSeen:number}
  constructor({ baseDir, archiveManager = null, config = {}, memoryAiConfig = {}, logger,personMemory }:Options = {}) {
    this.personMemory = personMemory
    this.baseDir = String(baseDir || "")
    this.archiveManager = archiveManager
    this.config = normalizeMidtermConfig(config)
    this.memoryAiConfig = memoryAiConfig || {}
    this.logger = logger
    this.buffers = new Map() // groupId -> { lines: [{ts, name, text}], timer, updating, queued }
    this.summaryCache = new Map() // groupId -> { summary, updated_at, covered_until_ts, updates }
    this.stats = { updates: 0, llmCalls: 0, llmFailures: 0, linesSeen: 0 }
  }

  usable() {
    const ai = this.memoryAiConfig || {}
    return Boolean(this.config.enabled &&
      ai.memoryAiUrl &&
      ai.memoryAiApikey &&
      !String(ai.memoryAiApikey).includes("sk-xxx"))
  }

  groupDir() {
    return path.join(this.baseDir, "group")
  }

  groupFile(groupId:string) {
    return path.join(this.groupDir(), `${groupId}.json`)
  }

  // ── 归档钩子:群消息进缓冲,攒够即防抖更新 ──
  onArchivedRecord(record:ArchiveRecord = {}) {
    if (!this.usable()) return
    if (!record.group_id || record.archive_kind === "notice") return
    const groupId = String(record.group_id)
    const line = this.recordToLine(record)
    if (!line) return
    this.stats.linesSeen++
    let buffer = this.buffers.get(groupId)
    if (!buffer) {
      buffer = { lines: [], timer: null, updating: false, queued: false }
      this.buffers.set(groupId, buffer)
    }
    buffer.lines.push(line)
    if (buffer.lines.length > this.config.bufferMaxLines) {
      buffer.lines = buffer.lines.slice(-this.config.bufferMaxLines)
    }
    if (buffer.lines.length >= this.config.minMessages && !buffer.timer && !buffer.updating) {
      buffer.timer = setTimeout(() => {
        buffer!.timer = null
        this.updateGroup(groupId).catch(error =>
          this.logger?.warn?.(`[中期记忆] 更新失败 group=${groupId}: ${error instanceof Error ? error.message : String(error)}`))
      }, this.config.debounceMs)
      buffer.timer.unref?.()
    }
  }

  recordToLine(record:ArchiveRecord = {}) {
    const userId = String(record.sender?.user_id || record.user_id || "")
    const text = this.archiveManager
      ? this.archiveManager.formatRecord(record, { compact: true, maxTextLength: 160 })
      : String(record.raw_message || record.msg || "")
    if (!text || text.length < 2 || text === "[非文本消息]") return null
    const name = String(record.sender?.card || record.sender?.nickname || userId || "?").slice(0, 16)
    const ts = Number(record.timestamp || 0)
    const source = record.message_id && userId && ts ? {scene:{kind:'group' as const,id:String(record.group_id)},authorId:userId,messageId:String(record.message_id),at:ts,excerpt:String(record.raw_message || record.msg || text)} : undefined
    return { ts, name, text: String(text).slice(0, 160),...(source ? {source} : {}),...(record.source_bot_id ? {botId:record.source_bot_id} : {}),...(record.source_persona_id ? {personaId:record.source_persona_id} : {}) }
  }

  async filterSummarySources(groupId:string,lines:Line[]) {
    if (!this.personMemory) return {lines,cutoff:0}
    let cutoff = 0, allowed = lines
    // The legacy summary is group-wide. Apply every observer's erasure policy;
    // source identity may narrow original lines, never the old aggregate.
    for (const identity of await this.personMemory.identities()) {
      const scene = {kind:'group' as const,id:groupId}
      const state = await this.personMemory.getSceneRedactions({identity,scene})
      cutoff = Math.max(cutoff,state.invalidatedAt)
      const filter = createPersonMemorySourceFilter(this.personMemory,identity)
      const next:Line[] = []
      for (const line of allowed) {
        if (line.ts <= cutoff) continue
        if (line.botId && line.botId !== identity.botId) {next.push(line);continue}
        if (line.personaId && line.personaId !== identity.personaId) {next.push(line);continue}
        if (line.source ? await filter(line.source,line.source.excerpt) : !cutoff && await canReadUnattributedMemory(this.personMemory,identity,scene)) next.push(line)
      }
      allowed = next
    }
    return {lines:allowed.filter(line => line.ts > cutoff),cutoff}
  }

  // ── 摘要更新:旧摘要 + 缓冲行 → 便宜模型 → 落盘 ──
  async updateGroup(groupId:string) {
    const key = String(groupId || "")
    if (!key || !this.usable()) return false
    const buffer = this.buffers.get(key)
    if (!buffer || !buffer.lines.length) return false
    if (buffer.updating) {
      buffer.queued = true
      return false
    }
    buffer.updating = true
    const lines = buffer.lines
    buffer.lines = []
    try {
      const checked = await this.filterSummarySources(key,lines)
      this.getSummaryPrompt(key,{after:checked.cutoff})
      const previous = this.loadSummary(key)
      const cutoff = previous?.redaction_cutoff || 0
      const allowed = checked.lines.filter(line => line.ts > cutoff)
      if (!allowed.length) return false
      const summary = await this.callSummarizer(previous?.summary || "", allowed)
      const rechecked = await this.filterSummarySources(key,allowed)
      if (rechecked.cutoff > cutoff || rechecked.lines.length !== allowed.length) return false
      // A deletion while the model was working invalidates its whole old input.
      if ((this.loadSummary(key)?.redaction_cutoff || 0) !== cutoff) return false
      const lastTs = allowed.reduce((max, line) => Math.max(max, line.ts), previous?.covered_until_ts || 0)
      const next = {
        summary,
        updated_at: Date.now(),
        covered_until_ts: lastTs,
        updates: (previous?.updates || 0) + 1,
        redaction_cutoff:cutoff
      }
      this.saveSummary(key, next)
      this.stats.updates++
      return true
    } catch (error) {
      // 失败时把消费掉的行还回缓冲头部,下次触发重试,不丢消息
      buffer.lines = [...lines, ...buffer.lines]
      this.stats.llmFailures++
      throw error
    } finally {
      buffer.updating = false
      if (buffer.queued && buffer.lines.length >= this.config.minMessages) {
        buffer.queued = false
        this.updateGroup(key).catch(error =>
          this.logger?.warn?.(`[中期记忆] 重试更新失败 group=${key}: ${error instanceof Error ? error.message : String(error)}`))
      } else {
        buffer.queued = false
      }
    }
  }

  async callSummarizer(previousSummary:string, lines:Line[]) {
    const ai = this.memoryAiConfig || {}
    const lineText = lines
      .map(line => `[${formatClock(line.ts)}] ${line.name}: ${line.text}`)
      .join("\n")
    const userPrompt = [
      `【已有摘要${previousSummary ? "" : "(暂无,从零开始)"}】`,
      previousSummary || "(空)",
      "",
      `【新增群聊记录】(${lines.length} 条)`,
      lineText,
      "",
      `请输出合并后的主线摘要,不超过 ${this.config.maxSummaryChars} 字。`
    ].join("\n")
    this.stats.llmCalls++
    const result = await sideLLMCall({
      url: ai.memoryAiUrl || "",
      apikey: ai.memoryAiApikey || "",
      model: this.config.model || ai.memoryAiModel || "gpt-4o-mini",
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      maxTokens: Math.ceil(this.config.maxSummaryChars * 2),
      timeoutMs: CHAT_TIMEOUT_MS
    })
    if (!result.ok) throw new Error(result.error)
    const content = result.content
    return content.length > this.config.maxSummaryChars
      ? content.slice(0, this.config.maxSummaryChars)
      : content
  }

  // ── 存取 ──
  loadSummary(groupId:string):Summary|null {
    const cached = this.summaryCache.get(String(groupId))
    if (cached) return cached
    try {
      const file = this.groupFile(groupId)
      if (!fs.existsSync(file)) return null
      const parsed:unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!isSummary(parsed)) return null
      this.summaryCache.set(String(groupId), parsed)
      return parsed
    } catch {
      return null
    }
  }

  saveSummary(groupId:string, data:Summary) {
    fs.mkdirSync(this.groupDir(), { recursive: true })
    fs.writeFileSync(this.groupFile(groupId), JSON.stringify(data, null, 2), "utf8")
    this.summaryCache.set(String(groupId), data)
  }

  // ── 提示词层输出:过期的摘要不注入 ──
  getSummaryPrompt(groupId:string,{after = 0}: {after?:number} = {}) {
    if (!this.usable()) return ""
    let data = this.loadSummary(groupId)
    if (after > (data?.redaction_cutoff || 0)) {
      data = {summary:'',updated_at:Date.now(),covered_until_ts:after,updates:0,redaction_cutoff:after}
      this.saveSummary(groupId,data)
      const buffer = this.buffers.get(String(groupId))
      if (buffer) buffer.lines = buffer.lines.filter(line => line.ts > after)
    }
    if (!data?.summary) return ""
    const ageMs = Date.now() - Number(data.updated_at || 0)
    if (ageMs > this.config.retentionDays * 24 * 3600 * 1000) return ""
    return `【本群近期主线】(截至 ${formatClock(data.updated_at)})\n${data.summary}`
  }

  // 过期清扫:删除超期摘要文件(主线自然过期)
  sweep() {
    let removed = 0
    try {
      const dir = this.groupDir()
      if (!fs.existsSync(dir)) return removed
      const cutoff = Date.now() - this.config.retentionDays * 24 * 3600 * 1000
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        const file = path.join(dir, entry.name)
        try {
          const stat = fs.statSync(file)
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(file)
            this.summaryCache.delete(entry.name.replace(/\.json$/, ""))
            removed++
          }
        } catch {}
      }
    } catch {}
    return removed
  }
}

// ── 运行时单例:归档钩子 + 定期清扫 ──
let runtime:MidtermSummaryManager|null = null
let archiveHookInstalled = false
let restoreArchiveHook:(()=>void)|null = null
let sweepTimer:ReturnType<typeof setInterval>|null = null

export function getMidtermMemoryManager() {
  return runtime
}

export function installMidtermMemoryRuntime({ pluginSettings = {}, archiveManager = null, logger,personMemory }:{pluginSettings?:{midtermMemory?:Partial<typeof DEFAULT_MIDTERM_CONFIG>;memoryAiConfig?:MemoryAi};archiveManager?:Archive|null;logger?:Logger;personMemory?:PersonMemoryStore} = {}) {
  const config = normalizeMidtermConfig(pluginSettings.midtermMemory)
  const memoryAiConfig = pluginSettings.memoryAiConfig || {}
  const baseDir = archiveManager
    ? path.join(path.dirname(archiveManager.getBaseDir()), "midterm_memory")
    : ""
  const manager = new MidtermSummaryManager({
    baseDir,
    archiveManager,
    config,
    memoryAiConfig,
    ...(personMemory ? {personMemory} : {}),
    ...(logger ? {logger} : {})
  })
  if (!manager.usable() || !archiveManager) {
    if (archiveHookInstalled) detachMidtermHook()
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
    runtime = null
    return null
  }
  runtime = manager
  installMidtermHook(archiveManager)
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    try {
      const removed = runtime?.sweep?.() || 0
      if (removed) logger?.info?.(`[中期记忆] 清扫过期摘要 ${removed} 份`)
    } catch (error) {
      logger?.warn?.(`[中期记忆] 清扫失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 12 * 3600 * 1000)
  sweepTimer.unref?.()
  logger?.info?.(`[中期记忆] 就绪 model=${config.model || memoryAiConfig.memoryAiModel || "默认记忆模型"} minMessages=${config.minMessages} retention=${config.retentionDays}d`)
  return manager
}

function installMidtermHook(archiveManager:Archive) {
  detachMidtermHook()
  archiveHookInstalled = true
  restoreArchiveHook = subscribeArchiveRecords(archiveManager, record => { runtime?.onArchivedRecord(record) })
}

function detachMidtermHook() {
  restoreArchiveHook?.()
  restoreArchiveHook = null
  archiveHookInstalled = false
}

export function __resetMidtermMemoryForTest() {
  detachMidtermHook()
  runtime = null
  archiveHookInstalled = false
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}
