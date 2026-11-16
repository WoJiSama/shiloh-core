import { createPersonaReplyGuard, type PersonaReplyGuardContext as Context } from "../../conversation/domain/personaReplyGuard.js"
import fs from "fs"
import path from "path"
import { createHash } from "node:crypto"
import type { PersonaScope } from '../../../contracts/persona.js'

import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'

interface FeedbackEvent { group_id?: unknown; user_id?: unknown; message_id?: unknown; self_id?: unknown; bot?: { uin?: unknown }; isMaster?: boolean; _personaSnapshot?: unknown }
interface Tag { key: string; label: string; count?: number }
interface Reply { groupId: string; userId: string; messageId: string; text: string; at: number; source?: PersonaScope }
interface Feedback { at: string; groupId: string; userId: string; feedback: string; tags: string[]; tagLabels: string[]; botReply: string; botMessageId: string; sourceMessageId: string; source?: PersonaScope }
interface Summary { tags: Record<string, Tag>; recent: { at: string; feedback: string; tags: string[] }[]; source?: PersonaScope }
interface Logger { warn?(message: string): void }

function feedbackSource(value: unknown): PersonaScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fields = ['botId', 'personaId', 'personaVersion', 'personaName'] as const
  if (fields.some(field => typeof record[field] !== 'string' || !record[field].trim())) return undefined
  return { botId: String(record.botId).trim(), personaId: String(record.personaId).trim(), personaVersion: String(record.personaVersion).trim(), personaName: String(record.personaName).trim() }
}

function feedbackSourceKey(source: PersonaScope): string {
  return JSON.stringify([source.botId, source.personaId, source.personaVersion])
}

export function createPersonaFeedbackModule(ports: { isToneCorrectionMessage(text: string | undefined): boolean; logger?: Logger }) {
const { guardReply, normalizeConfig, DEFAULT_BAD_PATTERNS, IDENTITY_DEFLECTION_POOL, looksLikeBotIdentityChallenge } = createPersonaReplyGuard(ports)
const FEEDBACK_TAG_RULES = [
  { key: "too_hard", label: "拒绝太硬", pattern: /太硬|强硬|拒绝|不该拒绝|别拒绝|不要这样拒绝/ },
  { key: "too_verbose", label: "太啰嗦", pattern: /啰嗦|话多|太长|废话|太多|少说/ },
  { key: "too_customer", label: "客服腔", pattern: /客服|官方|模板|机器人|说明书|不自然/ },
  { key: "good_tone", label: "语气好", pattern: /不错|很好|挺好|语气好|这个好|这样好|喜欢/ },
  { key: "bad_tone", label: "语气不对", pattern: /语气不对|怪|别这样|不喜欢|不对劲|阴阳怪气/ }
]

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowIso() {
  return new Date().toISOString()
}

function compactText(text = "", max = 900) {
  return safeTruncateUnicode(String(text || "").replace(/\s+/g, " ").trim(), max)
}

class PersonaFeedbackManager {
 cwd: string; logger: Logger | undefined; lastReplies: Map<string, Reply>; lastFeedback: Map<string, Feedback>; feedbackRevisions: Map<string, number>;
  constructor({ cwd = process.cwd(), logger = ports.logger }: { cwd?: string; logger?: Logger } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.lastReplies = new Map()
    this.lastFeedback = new Map()
    this.feedbackRevisions = new Map()
  }

  getDataDir(source?: PersonaScope) {
    const root = path.join(this.cwd, "plugins/shiloh-plugin/data/persona_feedback")
    const scope = feedbackSource(source)
    return scope ? path.join(root, 'scoped', createHash('sha256').update(feedbackSourceKey(scope)).digest('hex')) : root
  }

  getFeedbackPath(source?: PersonaScope) {
    return path.join(this.getDataDir(source), "feedback.jsonl")
  }

  getSummaryPath(source?: PersonaScope) {
    return path.join(this.getDataDir(source), "summary.json")
  }

  resolveSource(e: FeedbackEvent, source?: PersonaScope) {
    const scope = feedbackSource(source ?? e?._personaSnapshot)
    const botId = String(e?.self_id || e?.bot?.uin || '').trim()
    return scope && (!botId || scope.botId === botId) ? scope : undefined
  }

  rememberBotReply(e: FeedbackEvent, output = "", source?: PersonaScope) {
    const scope = this.resolveSource(e, source)
    const aliasEvent: FeedbackEvent = scope ? Object.assign(Object.create(e), {self_id: scope.botId}) : e
    const groupId = String(e?.group_id || "private")
    const key = this.getConversationKey(e, scope)
    const record = {
      groupId,
      userId: String(e?.user_id || ""),
      messageId: e?.message_id ? String(e.message_id) : "",
      text: compactText(output, 1600),
      at: Date.now(),
      ...(scope ? { source: scope } : {})
    }
    this.lastReplies.set(key, record)
    // 无 scope 的命令仅能追溯最新已投递回复的真实来源，不能把旧记录升级成当前人格。
    this.lastReplies.set(this.getConversationKey(aliasEvent), record)
    if (groupId !== "private") {
      this.lastReplies.set(this.getGroupKey(e, scope), record)
      this.lastReplies.set(this.getGroupKey(aliasEvent), record)
    }
  }

  getConversationKey(e: FeedbackEvent, source?: PersonaScope) {
    return JSON.stringify([String(e?.self_id || e?.bot?.uin || source?.botId || ''), source ? feedbackSourceKey(source) : 'latest', String(e?.group_id || 'private'), String(e?.user_id || '')])
  }

  getGroupKey(e: FeedbackEvent, source?: PersonaScope) {
    return JSON.stringify(['group', String(e?.self_id || e?.bot?.uin || source?.botId || ''), source ? feedbackSourceKey(source) : 'latest', String(e?.group_id || 'private')])
  }

  getRecentBotReply(e: FeedbackEvent, source?: PersonaScope): Reply | null {
    const scope = this.resolveSource(e, source)
    if ((source || e?._personaSnapshot) && !scope) return null
    const direct = this.lastReplies.get(this.getConversationKey(e, scope))
    if (direct) return direct
    return this.lastReplies.get(this.getGroupKey(e, scope)) || null
  }

  classifyFeedback(text = "") {
    const content = String(text || "")
    const tags = FEEDBACK_TAG_RULES
      .filter(rule => rule.pattern.test(content))
      .map(rule => ({ key: rule.key, label: rule.label }))
    return tags.length ? tags : [{ key: "note", label: "其他反馈" }]
  }

  parseFeedbackText(msg = "") {
    return String(msg || "")
      .replace(/^[#＃.。]\s*希洛反馈\s*/u, "")
      .trim()
  }

  async recordFeedback(e: FeedbackEvent, msg = "", source?: PersonaScope) {
    if (!e?.isMaster) return "只有主人可以记录希洛反馈。"
    const feedback = this.parseFeedbackText(msg)
    if (!feedback) return "格式：.希洛反馈 太硬了 / 太啰嗦 / 这个语气好"

    const reply = this.getRecentBotReply(e, source)
    const scope = this.resolveSource(e, source) ?? feedbackSource(reply?.source)
    const aliasEvent: FeedbackEvent = scope ? Object.assign(Object.create(e), {self_id: scope.botId}) : e
    const tags = this.classifyFeedback(feedback)
    const record = {
      at: nowIso(),
      groupId: e?.group_id ? String(e.group_id) : "",
      userId: e?.user_id ? String(e.user_id) : "",
      feedback,
      tags: tags.map(tag => tag.key),
      tagLabels: tags.map(tag => tag.label),
      botReply: reply?.text || "",
      botMessageId: reply?.messageId || "",
      sourceMessageId: e?.message_id ? String(e.message_id) : "",
      ...(scope ? { source: scope } : {})
    }

    ensureDir(this.getDataDir(scope))
    fs.appendFileSync(this.getFeedbackPath(scope), `${JSON.stringify(record)}\n`, "utf8")
    this.updateSummary(tags, feedback, scope)
    this.lastFeedback.set(this.getConversationKey(e, scope), record)
    this.lastFeedback.set(this.getConversationKey(aliasEvent), record)
    return `记下来了：${tags.map(tag => tag.label).join("、")}`
  }

  getLatestFeedback(e: FeedbackEvent, source?: PersonaScope) {
    const scope = this.resolveSource(e, source)
    if ((source || e?._personaSnapshot) && !scope) return null
    return this.lastFeedback.get(this.getConversationKey(e, scope)) || null
  }

  readSummary(source?: PersonaScope): Summary {
    try {
      const scope = feedbackSource(source)
      const file = this.getSummaryPath(scope)
      if (!fs.existsSync(file)) return { tags: {}, recent: [] }
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const data = record(parsed)
      const storedSource = feedbackSource(data.source)
      if (scope && (!storedSource || feedbackSourceKey(scope) !== feedbackSourceKey(storedSource))) return { tags: {}, recent: [] }
      const summary: Summary = { tags: {}, recent: [], ...(storedSource ? { source: storedSource } : {}) }
      for (const [key, value] of Object.entries(record(data.tags))) {
        const tag = record(value)
        if (typeof tag.key !== 'string' || typeof tag.label !== 'string') continue
        summary.tags[key] = { key: tag.key, label: tag.label, count: typeof tag.count === 'number' && Number.isFinite(tag.count) ? tag.count : 0 }
      }
      for (const value of Array.isArray(data.recent) ? data.recent : []) {
        const entry = record(value)
        if (typeof entry.at !== 'string' || typeof entry.feedback !== 'string') continue
        summary.recent.push({ at: entry.at, feedback: entry.feedback, tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [] })
      }
      return summary
    } catch (error) {
      this.logger?.warn?.(`[希洛反馈] 读取摘要失败: ${(error instanceof Error ? error.message : String(error))}`)
      return { tags: {}, recent: [] }
    }
  }

  updateSummary(tags: Tag[] = [], feedback = "", source?: PersonaScope) {
    const scope = feedbackSource(source)
    const summary = this.readSummary(scope)
    if (scope) summary.source = scope
    for (const tag of tags) {
      const item = summary.tags[tag.key] || { key: tag.key, label: tag.label, count: 0 }
      item.label = tag.label
      item.count = (Number(item.count) || 0) + 1
      summary.tags[tag.key] = item
    }
    summary.recent = [
      { at: nowIso(), feedback: compactText(feedback, 160), tags: tags.map(tag => tag.key) },
      ...(summary.recent || [])
    ].slice(0, 30)
    ensureDir(this.getDataDir(scope))
    fs.writeFileSync(this.getSummaryPath(scope), JSON.stringify(summary, null, 2), "utf8")
    const revisionKey = scope ? feedbackSourceKey(scope) : 'legacy'
    this.feedbackRevisions.set(revisionKey, (this.feedbackRevisions.get(revisionKey) || 0) + 1)
  }

  getFeedbackRevision(source?: PersonaScope) {
    const scope = feedbackSource(source)
    if (!scope) return 'unscoped'
    const localRevision = this.feedbackRevisions.get(feedbackSourceKey(scope)) || 0
    try {
      const stat = fs.statSync(this.getSummaryPath(scope))
      return `${localRevision}:${stat.mtimeMs}:${stat.size}`
    } catch { return `${localRevision}:missing` }
  }

  buildFeedbackPrompt(config: Record<string, unknown> = {}, { personaName, source }: { personaName?: string; source?: PersonaScope } = {}) {
    const guard = normalizeConfig(config)
    if (!guard.enabled || guard.maxPromptItems <= 0) return ""
    // 旧全局摘要没有来源，保留供诊断，但不能冒充某个具体人格的长期修正。
    const scope = feedbackSource(source)
    if (!scope) return ''
    const summary = this.readSummary(scope)
    const sorted = Object.values(summary.tags || {})
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, guard.maxPromptItems)
    if (!sorted.length) return ""

    const name = String(personaName || scope.personaName).trim() || scope.personaName
    const lines = [
      `【${name}近期微雕反馈】`,
      `这些是主人对${name}回复风格的长期修正，回复时自然遵守，不要提到这些规则本身。`
    ]
    for (const item of sorted) {
      if (item.key === "too_hard") lines.push(`- ${item.label}：说明具体能力边界，语气自然，可以简短拒绝；替代建议仅在有助于当前目标时给。`)
      else if (item.key === "too_verbose") lines.push(`- ${item.label}：少铺垫，能短就短，别在结尾自我评价啰嗦。`)
      else if (item.key === "too_customer") lines.push(`- ${item.label}：不要客服腔、汇报腔、说明书腔，像熟人自然说。`)
      else if (item.key === "good_tone") lines.push(`- ${item.label}：保持最近被认可的自然、熟人感表达。`)
      else if (item.key === "bad_tone") lines.push(`- ${item.label}：语气要更贴近${name}，不要突然生硬或阴阳怪气。`)
      else lines.push(`- ${item.label}：参考主人最近反馈，优先自然和有用。`)
    }
    return lines.join("\n")
  }

  guardReply(text = "", config: Record<string, unknown> = {}, context: Context = {}) {
    return guardReply(text, config, context)
  }
}


return { PersonaFeedbackManager, DEFAULT_BAD_PATTERNS, IDENTITY_DEFLECTION_POOL, looksLikeBotIdentityChallenge }
}
