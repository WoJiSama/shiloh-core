export interface PersonaReplyGuardContext { userText?: string; botNames?: string[]; onPatternHit?(pattern: string): void }
type Context = PersonaReplyGuardContext

/** One owner per host/tool keeps identity deflection rotation without filesystem state. */
export function createPersonaReplyGuard(ports: { isToneCorrectionMessage(text: string | undefined): boolean }) {
const { isToneCorrectionMessage } = ports
// 代码侧兜底坏模式表;config_default/message.yaml 的 personaGuard.badPatterns
// 是配置侧同名表,tests/personaPromptCharacterization.test.js 有漂移防护测试钉住两者一致。
const DEFAULT_BAD_PATTERNS = [
  "我是不是太啰嗦",
  "是不是说多了",
  "好像有点啰嗦",
  "扯远了",
  "作为AI",
  "作为一个AI",
  "我是AI",
  "我是一个AI",
  "很抱歉",
  "抱歉，我不能",
  "我无法满足",
  "我不能满足",
  "我不能帮你",
  "无法协助"
]
// 旧配置仍可能带着这些条目；删除否定片段会把能力边界改成承诺。
const LEGACY_REFUSAL_PATTERNS = new Set(["抱歉，我不能", "我无法满足", "我不能满足", "我不能帮你", "无法协助"])

const HARD_BOT_IDENTITY_DENIAL_RE = /(?:^|[，,。.!！?？；;\s])(?:(?:我)?(?:才|又|可|真)?(?:不是|不是什么)|我怎么可能是|谁是|哪是|哪有什么).{0,10}(?:机器人|AI|人工智能|bot)(?:啦|啊|呀|诶|哦|嘛|呢)?/gi
const HARD_HUMAN_IDENTITY_CLAIM_RE = /(?:我(?:可|就|当然)?是(?:个)?)?(?:活人|真人)(?:一个|一枚|本人)(?:啦|啊|呀|诶|哦|嘛|呢)?[😂🤣😅]*/g
const FIRST_PERSON_HUMAN_CLAIM_RE = /我(?:可|就|当然)?是(?:个)?(?:活人|真人)(?:啦|啊|呀|诶|哦|嘛|呢)?/g
// 模型可能从聊天历史里复读出旧版固定句式；被问身份时一并清掉，避免永远同一句
const CANNED_IDENTITY_MARKER_RE = /别给我扣(?:机器人)?帽子(?:…+|[。.!！]*)/g

function looksLikeBotIdentityChallenge(text = "", { botNames = [] }: { botNames?: string[] } = {}) {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content) return false
  const escapedNames = (Array.isArray(botNames) ? botNames : [botNames])
    .map(name => String(name || "").trim())
    .filter(Boolean)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const target = ["你", "妳", "希洛", "小希", ...escapedNames].join("|")
  const identity = "机器人|AI|人工智能|bot"
  return new RegExp(`(?:${target}).{0,16}(?:像|是|是不是|不就是|不会是|难道是|怎么.{0,4}像).{0,10}(?:${identity})`, "i").test(content) ||
    new RegExp(`(?:${target}).{0,16}(?:不是|不像).{0,8}(?:真人|活人)`, "i").test(content) ||
    new RegExp(`(?:${identity}).{0,8}(?:味|感).{0,8}(?:重|浓|足)|(?:${target}).{0,12}(?:${identity})(?:味|感)`, "i").test(content)
}

// 整条回复删掉否认后只剩语气词时，轮换取一句"轻巧带过、不硬辩"的话。
// 轮换（而非固定单句）保证连续多次被问也不会重复。
const IDENTITY_DEFLECTION_POOL = [
  "欸，怎么突然开始审我啦",
  "哈哈，被你这么一问我还真愣了一下",
  "你说是就是啦，聊天嘛",
  "打住打住，换个话题聊",
  "嗯？突然这么认真，搞得我怪紧张的",
  "这个问题先欠着，你猜猜看嘛"
]

let identityDeflectionCursor = 0

function nextIdentityDeflection() {
  const line = IDENTITY_DEFLECTION_POOL[identityDeflectionCursor]
  identityDeflectionCursor = (identityDeflectionCursor + 1) % IDENTITY_DEFLECTION_POOL.length
  return `${line}。`
}

const LEAD_NOISE_RE = /^[，,。.!！?？；;、~～\s…😂🤣😅😋❤]+/u

function isFillerOnlyText(text = "") {
  const stripped = String(text || "")
    .replace(/(?:哈+|嘻+|嘿+|呵+|嗯+|哼+|啊+|呀+|哦+|噢+|额+|呃+|欸+|诶+|emm+)+/gi, "")
    .replace(/[，,。.!！?？；;、~～\s…😂🤣😅😋❤]+/gu, "")
  return stripped.length < 2
}

function softenIdentityDenial(text = "", context: Context = {}) {
  let output = String(text || "")
  if (!looksLikeBotIdentityChallenge(context.userText, context)) return output
  if (!HARD_BOT_IDENTITY_DENIAL_RE.test(output) &&
    !HARD_HUMAN_IDENTITY_CLAIM_RE.test(output) &&
    !FIRST_PERSON_HUMAN_CLAIM_RE.test(output) &&
    !CANNED_IDENTITY_MARKER_RE.test(output)) return output

  HARD_BOT_IDENTITY_DENIAL_RE.lastIndex = 0
  HARD_HUMAN_IDENTITY_CLAIM_RE.lastIndex = 0
  FIRST_PERSON_HUMAN_CLAIM_RE.lastIndex = 0
  CANNED_IDENTITY_MARKER_RE.lastIndex = 0
  output = output
    // 只删"硬否认/活人宣称/旧固定句"片段，其余自然内容原样保留——
    // 回复的多样性来自模型本身，而不是这里再塞一句固定话术
    .replace(HARD_BOT_IDENTITY_DENIAL_RE, " ")
    .replace(HARD_HUMAN_IDENTITY_CLAIM_RE, " ")
    .replace(FIRST_PERSON_HUMAN_CLAIM_RE, " ")
    .replace(CANNED_IDENTITY_MARKER_RE, " ")
    .replace(/([，,、;；])[，,、;；\s]*([。.!！?？…])/g, "$2")
    .replace(/[，,、;；]{2,}/g, "，")
    .replace(/[ \t]{2,}/g, " ")
    .replace(LEAD_NOISE_RE, "")
    .replace(/[，,、;；~～\s]+$/g, "")
    .trim()

  if (output && !isFillerOnlyText(output)) return output
  return nextIdentityDeflection()
}

function deescalateToneCorrection(text = "", context: Context = {}) {
  if (!isToneCorrectionMessage(context.userText)) return String(text || "")

  const cleaned = String(text || "")
    .replace(/[😋❤♥💗💕💞😘🥰]+/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
  const sincerelyAcknowledges = /(?:你说得对|你说的对|确实|刚才).{0,30}(?:不对|过了|不舒服|顶着|收一下|改|注意)/.test(cleaned) ||
    /(?:我收一下|我改|我注意|不该这样|听着确实不舒服)/.test(cleaned)
  const keepsProvoking = /(?:你别教我做事|别气嘛|不跟你犟|你舍得嘛|凭啥|想得美|自己来|我又不是你保姆|你少来|嘿嘿|嘴快|急什么|开不起玩笑)/.test(cleaned)

  if (sincerelyAcknowledges && !keepsProvoking) return cleaned
  return "你说得对，刚才那几句有点顶着你说了，听着确实不舒服。我收一下。"
}

function removeUnpromptedIntimacy(text = "", context: Context = {}) {
  const output = String(text || "")
  // 只收住明确回应亲昵称呼的整句，不改写普通羞赧、转述或引用。
  if (/^(?:欸|嗯嗯?|诶)[，,、 \t]*别突然这么叫呀[，,、 \t]*(?:我)?有点不好意思(?:啦|欸)?[。！？!?…~～]*$/u.test(output)) {
    const name = context.botNames?.find(value => value.trim())?.trim() || "希洛"
    return `叫我${name}就好。`
  }
  // 代码、引用和被讨论的原话不是机器人对当前收件人的称呼。
  const literalSpans = [...output.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*\1[~`]*[ \t]*(?=\r?$)|(?![\s\S]))|(`+)[\s\S]*?\2|^[ \t]*>[^\n]*|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gm)]
    .map(match => ({start: match.index, end: match.index + match[0].length}))
  return output.replace(/([，,、][ \t]*)?(宝宝|宝贝|亲爱的|老婆|老公|哥哥|妹妹)([，,、 \t]*)/g,
    (match, separator: string | undefined, _nickname: string, _trailing: string, offset: number) => {
      const nameStart = offset + (separator?.length || 0)
      if (literalSpans.some(span => nameStart >= span.start && nameStart < span.end)) return match
      const before = output.slice(0, nameStart)
      const after = output.slice(offset + match.length)
      const startsAddress = /(?:^|[。.!！?？；;\n])[ \t]*(?:(?:欸|诶|嗯嗯?|哎|嘿|喂|好的?|好啦)[，,、 \t]*)?$/.test(before)
      const addressesRecipient = /^(?:你|妳|您|别|先|快|请|听我|跟我|等我|记得|放心|注意|我(?:在|帮|给|陪|说|想|觉得|没|不|会))/.test(after)
      if (startsAddress && addressesRecipient) return separator || ""

      const previousSentence = output.slice(0, offset).split(/[。.!！?？；;\n]/).at(-1)?.trim() || ""
      const endsAddress = /^(?:[。.!！?？~～…\n]|$)/.test(after)
      if (separator && endsAddress && (/[你妳您]/.test(previousSentence) || /^(?:晚安|早安|早上好|晚上好|知道了|好的?|好啦|没事的|放心吧)$/.test(previousSentence))) return ""
      // 无明确呼语证据时保留，例如“人家哥哥的钱包”或“哥哥，妹妹都来了”。
      return match
    })
}

function normalizeConfig(config: Record<string, unknown> = {}) {
  return {
    enabled: config.enabled !== false,
    // rewriteHardRefusal 是兼容字段；能力和拒绝语义不再通过删词或固定话术改写。
    stripSelfDoubt: config.stripSelfDoubt !== false,
    stripCustomerTone: config.stripCustomerTone !== false,
    avoidUnpromptedIntimacy: config.avoidUnpromptedIntimacy !== false,
    maxPromptItems: Math.max(0, Math.min(8, Number(config.maxPromptItems) || 4)),
    badPatterns: Array.isArray(config.badPatterns) && config.badPatterns.length
      ? config.badPatterns
      : DEFAULT_BAD_PATTERNS
  }
}

function guardReply(text = "", config: Record<string, unknown> = {}, context: Context = {}) {
    const guard = normalizeConfig(config)
    if (!guard.enabled) return String(text || "")
    let output = String(text || "").trim()
    if (!output) return ""

    if (guard.stripSelfDoubt) {
      output = output
        .replace(/(?:唔|呜|嗯|诶|欸|啊|呃|哎呀?|嘛|那个)?[，,、\s]*(?:我)?(?:是不是|好像|感觉)?(?:说(?:得|的)?有点多了|说多了|讲多了|说太多了|有点啰嗦|太啰嗦了?|有点话多|太话多了?|扯远了|跑题了)[。！？!?~～…\s]*/g, "")
        .trim()
    }

    if (guard.stripCustomerTone) {
      output = output
        .replace(/作为(?:一个)?(?:AI|人工智能|机器人|助手)[，,、\s]*/gi, "")
        .replace(/很抱歉[，,、\s]*/g, "")
        .replace(/抱歉[，,、\s]*/g, "")
        .replace(/请您/g, "你")
        .replace(/建议您/g, "可以")
        .replace(/希望(?:以上|这些|这).*?(?:帮到你|有帮助)[。.!！]*/g, "")
        .trim()
    }

    output = softenIdentityDenial(output, context)
    output = deescalateToneCorrection(output, context)
    if (guard.avoidUnpromptedIntimacy) output = removeUnpromptedIntimacy(output, context)

    for (const pattern of guard.badPatterns) {
      const needle = String(pattern || "").trim()
      if (!needle || LEGACY_REFUSAL_PATTERNS.has(needle)) continue
      if (output.includes(needle)) {
        output = output.split(needle).join("")
        // 可选命中回调:输出守卫管线用它做逐模式触发统计,作为规则退役依据;不传则零开销
        if (typeof context.onPatternHit === "function") {
          try { context.onPatternHit(needle) } catch { /* 统计回调不允许影响清理 */ }
        }
      }
    }

    return output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  }

return { guardReply, normalizeConfig, DEFAULT_BAD_PATTERNS, IDENTITY_DEFLECTION_POOL, looksLikeBotIdentityChallenge }
}
