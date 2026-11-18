import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {RuleActor,RuleStored,RuleGroupState,RuleSession,RuleAudit,RuleSnapshot,RuleCampaign,RuleStatusState} from '../../../contracts/rulePack.js'
import type {DiceRulePack,RuleField,RuleAction,RuleCommand} from '../../../contracts/diceRuleSchema.js'
import type {ExpressionOptions} from './DiceRuleExpression.js'
import {evaluateDiceRuleExpression} from './DiceRuleExpression.js'
import {rollDiceExpression} from '../domain/diceExpression.js'
import type {AgentDiceCompiledRulePackage} from './agentDiceRulePackages.js'
import {runAgentDiceSeal,type AgentDiceSealState} from './agentDiceSeal.js'
import {isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import {readAgentDicePrivateOrigin,type AgentDicePrivateOrigin} from './agentDicePrivateDelivery.js'

export type AgentDiceRulePermission='player'|'gm'|'admin'|'master'
export type AgentDiceRuleCapability=AgentDiceRulePermission|'delegate'|'hidden'|'card'
export interface AgentDiceRuleContext {
  readonly source:{readonly messageId:string;readonly authorId:string;readonly at:number}
  readonly actor:{readonly id:string;readonly name:string}
  readonly members:readonly {readonly id:string;readonly name:string}[]
  readonly groupId:string
  readonly botUserId?:string
  readonly mentions?:readonly {readonly id:string;readonly name?:string}[]
  readonly replyAuthorId?:string
  readonly logActive?:boolean
  /** Present only when the durable host binds this evaluation to a real source. */
  readonly privateOrigin?:AgentDicePrivateOrigin
  /** Host ceiling. Stored GM grants apply only inside their producing package. */
  allows(permission:AgentDiceRuleCapability,subjectId?:string):boolean
}
export type AgentDiceRuleEffect={readonly kind:'public';readonly text:string;readonly eventIndex?:number}|
  {readonly kind:'private';readonly recipientId:string;readonly text:string;readonly deliveryId?:string;readonly packId?:string;readonly origin?:AgentDicePrivateOrigin;readonly requiredPermission?:'player'|'gm'}|
  {readonly kind:'card';readonly subjectId:string;readonly name:string}|
  {readonly kind:'log';readonly operation:'start'|'stop';readonly ownershipId:string;readonly title?:string}
export interface AgentDiceRuleEvent {readonly kind:'rule_event'|'card_change'|'dice_result';readonly [key:string]:unknown}
export type AgentDiceRuleCards=Record<string,{key:string;name:string;attrs:Record<string,number>;skills:Record<string,number>}>
export interface AgentDiceRulesState {version:1;packs:Record<string,{players:Record<string,RuleStored>;group:RuleGroupState;seal?:AgentDiceSealState}>}
export interface AgentDiceRulesResult {readonly matched:boolean;readonly state:AgentDiceRulesState;readonly effects:readonly AgentDiceRuleEffect[];readonly events:readonly AgentDiceRuleEvent[];readonly cards?:AgentDiceRuleCards}
type RulePack=DiceRulePack & {__functions?:ExpressionOptions['customFunctions']}
interface RuleSender {card?:string;nickname?:string}
interface RuleDraft {key:string;actor:RuleActor;original:RuleStored|null|undefined;stored:RuleStored;attr:Record<string,unknown>;inventory:Record<string,unknown>;abilities:Record<string,unknown>;commit(value:RuleStored):void;group?:boolean}
interface RuleDescription {id:string;name:string;kind:string;attr:Record<string,unknown>;derived:Record<string,unknown>;statuses:Record<string,RuleStatusState>;inventory:Record<string,unknown>;abilities:Record<string,unknown>}
interface RuleContext {arg:Record<string,unknown>;attr:Record<string,unknown>;derived:Record<string,unknown>;roll:Record<string,{expr:string;total:number;detail:string}>;table:Record<string,unknown>;let:Record<string,unknown>;result:string;group:{id:string|number};shared:Record<string,unknown>;session:RuleSession;inventory:Record<string,unknown>;abilities:Record<string,unknown>;target:RuleDescription|null;opposed:{actor:number;target:number;result:string;winner:string;margin:number}|null;status?:RuleStatusState|null}
interface RuleRuntime {state:AgentDiceRulesState;request:AgentDiceRuleContext;pack:RulePack;command?:RuleCommand;ruleState:RuleGroupState;actorDraft:RuleDraft;entityDrafts:Map<string,RuleDraft>;groupStored:RuleStored;args:Record<string,unknown>;context:RuleContext;random:()=>number;randomSeed?:string;defaultTarget:RuleDescription|null;auditActions:Record<string,unknown>[]}
interface RuleResult {text:string;privateMessages?:{deliveryId:string;userId:string;text:string;origin?:AgentDicePrivateOrigin;requiredPermission?:'player'|'gm'}[];auditId?:string;packId?:string;groupCardUpdates?:{userId:string;name:string}[]}
interface EvalOptions {allowDice?:boolean;remainingDice?:number|null;random?:()=>number;status?:RuleStatusState|null}
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sanitizeRuleOutput=(value:unknown)=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,'').replace(/\[CQ:/giu,'［CQ:')
const actorStorageKey=(actor:RuleActor)=>`${actor.kind}:${actor.id}`
const selfActor=(ctx:AgentDiceRuleContext):RuleActor=>({kind:'member',id:ctx.actor.id,name:ctx.actor.name,role:'member',self:true})
const roleLabel=(role:string)=>({player:'玩家',gm:'GM',admin:'管理员',master:'宿主维护者'}[role]??role)
function getRulePermission(ctx:AgentDiceRuleContext,state:RuleGroupState):AgentDiceRulePermission {
  if(ctx.allows('master',ctx.actor.id))return 'master'
  if(ctx.allows('admin',ctx.actor.id))return 'admin'
  if(ctx.allows('gm',ctx.actor.id)||state.roles[ctx.actor.id]==='gm'&&ctx.allows('player',ctx.actor.id))return 'gm'
  if(!ctx.allows('player',ctx.actor.id))throw new Error('当前来源没有规则执行授权')
  return 'player'
}
function requireRulePermission(ctx:AgentDiceRuleContext,state:RuleGroupState,required='player') {
  const levels:Record<string,number>={player:1,gm:2,admin:3,master:4},actual=getRulePermission(ctx,state)
  if((levels[actual]??0)<(levels[required]??Infinity))throw new Error(`此操作需要${roleLabel(required)}权限`)
  return actual
}
async function resolveRuleActor(ctx:AgentDiceRuleContext,raw:unknown,state:RuleGroupState,allowedKinds=['self']):Promise<RuleActor> {
  const token=String(raw??'').trim(),allowed=new Set(allowedKinds)
  const accept=(actor:RuleActor)=>{if(!allowed.has(actor.self?'self':actor.kind))throw new Error('目标类型不在命令允许范围');return actor}
  if(!token||['self','me','我','自己'].includes(token.toLowerCase()))return accept(selfActor(ctx))
  let wanted=token
  if(['reply','回复'].includes(token.toLowerCase())){if(!ctx.replyAuthorId)throw new Error('没有已验证引用来源');wanted=ctx.replyAuthorId}
  const id=/^(?:user:|member:)(.+)$/iu.exec(wanted)?.[1]??/^(?:qq:)?([0-9]{5,20})$/iu.exec(wanted)?.[1]??/^<@!?([^>]+)>$/u.exec(wanted)?.[1]??/^\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]$/iu.exec(wanted)?.[1]
  const npcKey=token.replace(/^npc:/iu,'')
  const npc=Object.entries(state.npcs).find(([key,value])=>key===npcKey||value.name===npcKey)
  if(npc&&!id)return accept({kind:'npc',id:npc[0],name:npc[1].name,role:'npc',self:false})
  const matches=ctx.members.filter(member=>id?member.id===id:member.id===wanted||member.name===wanted)
  if(matches.length!==1)throw new Error(matches.length?'目标名称有歧义':'目标不属于当前已验证成员')
  const member=matches[0]!
  return accept({kind:'member',id:member.id,name:member.name,role:'member',self:member.id===ctx.actor.id})
}
async function getRuleGmRecipients(ctx:AgentDiceRuleContext,state:RuleGroupState) {
  return ctx.members.filter(member=>ctx.allows('player',member.id)&&(ctx.allows('gm',member.id)||ctx.allows('admin',member.id)||ctx.allows('master',member.id)||state.roles[member.id]==='gm')).map(member=>member.id)
}
function sanitizeAuditValue(value:unknown,depth=0):unknown {
  if(depth>5)return '[depth-limit]'
  if(value===null||['string','number','boolean'].includes(typeof value))return value
  if(Array.isArray(value))return value.slice(0,50).map(item=>sanitizeAuditValue(item,depth+1))
  if(!value||typeof value!=='object')return String(value)
  return Object.fromEntries(Object.entries(value).slice(0,100).map(([key,item])=>[key,sanitizeAuditValue(item,depth+1)]))
}
function decodeRuleActor(value:unknown):RuleActor {const actor=record(value);if(typeof actor.id!=='string'||typeof actor.kind!=='string'||typeof actor.name!=='string')throw new Error('团务目标无效');return {id:actor.id,kind:actor.kind,name:actor.name,role:String(actor.role??'member'),self:actor.self===true}}

const BUILTIN_CARD_ALIASES = new Set(["卡", "card"])
const BUILTIN_SET_ALIASES = new Set(["设", "set"])
const BUILTIN_GET_ALIASES = new Set(["查", "get"])
const BUILTIN_CLEAR_ALIASES = new Set(["删", "clear"])
const BUILTIN_ROLE_ALIASES = new Set(["权限", "role", "roles"])
const BUILTIN_NPC_ALIASES = new Set(["npc"])
const BUILTIN_GROUP_CARD_ALIASES = new Set(["群卡", "groupcard"])
const BUILTIN_GROUP_SET_ALIASES = new Set(["群设", "groupset"])
const BUILTIN_GROUP_GET_ALIASES = new Set(["群查", "groupget"])
const BUILTIN_SESSION_ALIASES = new Set(["团务", "session"])
const BUILTIN_CAMPAIGN_ALIASES = new Set(["战役", "campaign", "群组"])
const BUILTIN_INITIATIVE_ALIASES = new Set(["先攻", "init"])
const BUILTIN_STATUS_ALIASES = new Set(["状态", "status"])
const BUILTIN_ITEM_ALIASES = new Set(["物品", "item", "inventory"])
const BUILTIN_ABILITY_ALIASES = new Set(["技能", "ability", "abilities", "spell"])
const BUILTIN_AUDIT_ALIASES = new Set(["审计", "audit"])
const BUILTIN_DELIVERY_ALIASES = new Set(["投递", "delivery"])
const MAX_AUDIT_RECORDS = 200
const MAX_PRIVATE_DELIVERIES = 100


function normalizeText(value:unknown = "") {
  return String(value ?? "").trim()
}

function cloneJson<T>(value:T):T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeCommandText(value = "") {
  const text = normalizeText(value)
  return text.startsWith("。") ? `.${text.slice(1)}` : text
}

function parseQuotedTokens(value = "") {
  const text = String(value || "")
  const tokens = []
  let current = ""
  let quote = ""
  let escaping = false
  for (const ch of text) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === "\\" && quote) {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ""
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (quote) throw new Error("参数中的引号没有闭合")
  if (current) tokens.push(current)
  return tokens
}

function matchTextAlias(text:unknown, aliases:string[] = []) {
  const source = String(text || "")
  const ordered = [...new Set(aliases.map(String))].sort((a, b) => b.length - a.length)
  for (const alias of ordered) {
    if (!source.toLowerCase().startsWith(alias.toLowerCase())) continue
    const rest = source.slice(alias.length)
    if (!rest || /^\s/.test(rest) || /[^A-Za-z]/.test(alias[alias.length - 1] || "") || /^[^A-Za-z]/.test(rest)) {
      return { alias, rest: rest.trim() }
    }
  }
  return null
}

function getOwnPath(root:unknown, reference:unknown) {
  let value = root
  for (const part of String(reference || "").split(".")) {
    if (!part || value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined
    value = (value as Record<string,unknown>)[part]
  }
  return value
}

function renderRuleTemplate(template:unknown, context:unknown, { strict = true } = {}) {
  return String(template || "").replace(/\{([^{}]+)\}/g, (_, reference) => {
    const value = getOwnPath(context, reference.trim())
    if (value === undefined) {
      if (strict) throw new Error(`模板变量不存在：${reference.trim()}`)
      return ""
    }
    if (Array.isArray(value)) return value.join("、")
    return value === null ? "" : String(value)
  })
}


function resolveDefaultValue(value:unknown, sender:RuleSender) {
  if (typeof value !== "string") return value
  return value
    .replaceAll("{sender.card}", sender.card || sender.nickname || "")
    .replaceAll("{sender.nickname}", sender.nickname || sender.card || "")
}

function previewValue(definition:Partial<RuleField> = {}) {
  if (definition.default !== undefined) return resolveDefaultValue(definition.default, { card: "示例角色", nickname: "示例角色" })
  if (definition.type === "string") return "示例"
  if (definition.type === "boolean") return false
  const value = Math.max(Number(definition.min) || 0, 0)
  return definition.max !== undefined ? Math.min(value, Number(definition.max)) : value
}

function convertInputValue(raw:unknown, definition:RuleField, path = "value") {
  if (definition.type === "string") return String(raw)
  if (definition.type === "boolean") {
    const normalized = String(raw).toLowerCase()
    if (["true", "1", "yes", "on", "是", "开"].includes(normalized)) return true
    if (["false", "0", "no", "off", "否", "关"].includes(normalized)) return false
    throw new Error(`${path} 必须是布尔值`)
  }
  if (definition.type === "enum") {
    const candidate = (definition.enum || []).find(item => String(item) === String(raw))
    if (candidate === undefined) throw new Error(`${path} 可选值：${(definition.enum || []).join("、")}`)
    return candidate
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || (definition.type === "integer" && !Number.isInteger(value))) throw new Error(`${path} 必须是${definition.type === "integer" ? "整数" : "数字"}`)
  return value
}

function validateFieldValue(value:unknown, definition:RuleField, path:string) {
  if (definition.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} 必须是整数`)
  if (definition.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} 必须是有限数字`)
  if (definition.type === "string" && typeof value !== "string") throw new Error(`${path} 必须是字符串`)
  if (definition.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`)
  if (["integer", "number"].includes(definition.type)) {
    if (definition.min !== undefined && Number(value) < definition.min) throw new Error(`${path} 不能小于 ${definition.min}`)
    if (definition.max !== undefined && Number(value) > definition.max) throw new Error(`${path} 不能大于 ${definition.max}`)
  }
  if (definition.max_length && Array.from(String(value)).length > definition.max_length) throw new Error(`${path} 长度不能超过 ${definition.max_length}`)
  if (Array.isArray(definition.enum) && !definition.enum.some(item => typeof item === typeof value && item === value)) throw new Error(`${path} 可选值：${definition.enum.join("、")}`)
  return value
}

function drawTable(definition:RulePack['tables'][string]|undefined, random:()=>number) {
 const entries=(definition?.entries||[]).map(entry=>typeof entry==='string'?{text:entry}:entry)
 const total=entries.reduce((sum,entry)=>sum+Math.max(1,Number(entry.weight)||1),0)
 let cursor=Math.floor(random()*total)
 for(const entry of entries){const weight=Math.max(1,Number(entry.weight)||1);if(cursor<weight)return {text:String(entry.text||''),value:entry.value??null,tags:entry.tags||[]};cursor-=weight}
 const entry=entries[entries.length-1];return {text:String(entry?.text||''),value:entry?.value??null,tags:entry?.tags||[]}
}

// 海豹扩展命令 help 的统一脚注:指路标准命令与完整帮助
const SEAL_HELP_FOOTER = [
  "── 常用相关命令 ──",
  ".nn 新名字 - 改自己的骰娘昵称并同步QQ群名片（需先 .sn on 开启同步）",
  ".sn on/off - 开/关「角色卡名自动同步为群名片」",
  ".sn dh - 应用本包名片模板（希望/HP/压力/护甲即时刷新到群名片）",
  ".sn gm - 应用GM恐惧值名片模板",
  ".st 属性=值 - 录入/增减角色属性（录入后名片即时刷新）；.pc - 人物卡管理",
  ".set 规则名 - 切换本群默认规则（如 .set dh）",
  "完整命令列表：.骰娘帮助    本群已启用规则包：.骰规则列表"
].join("\n")



class RuleEvaluator {
  readonly effects:AgentDiceRuleEffect[]=[]
  readonly events:AgentDiceRuleEvent[]=[]
  readonly config={maxDiceCount:10000,maxDiceSides:100000000,maxRounds:1000}
  readonly iso:string
  private sequence=0
  constructor(readonly state:AgentDiceRulesState,readonly request:AgentDiceRuleContext,readonly random:()=>number,readonly cards:AgentDiceRuleCards){this.iso=new Date(request.source.at).toISOString()}
  packState(pack:RulePack){
    return this.state.packs[pack.id]??= {players:{},group:{roles:{},npcs:{},group:{values:{}},session:{active:false,title:'',round:0,turn:0,phase:'idle',initiative:[],current:null},audit:[],privateDeliveries:[],sessions:[],campaigns:{},activeCampaignId:'',snapshots:[]}}
  }
  auditId(){return sha([this.request.source.messageId,this.request.source.authorId,this.request.source.at,++this.sequence]).slice(0,32)}
  invocationRandom(){return {seed:sha(this.request.source),random:this.random}}
  recordEvent(request:AgentDiceRuleContext,data:{content:string;auditId?:string;packId?:string;command?:string;visibility?:string;result?:string;tags?:string[]},_state?:AgentDiceRulesState,_config?:unknown){
    this.events.push({kind:'rule_event',source:{...request.source},...data})
    return Promise.resolve()
  }
  buildPersistentValues(pack:RulePack, stored:RuleStored|null|undefined, sender:RuleSender) {
    const values = stored && typeof stored.values === "object" && stored.values ? { ...stored.values } : {}
    const fields = pack.character?.fields || {}
    for (const [id, definition] of Object.entries(fields)) {
      if (definition.formula !== undefined) continue
      if (definition.persistent === false) {
        delete values[id]
        if (definition.default !== undefined) values[id] = resolveDefaultValue(definition.default, sender)
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(values, id) && definition.default !== undefined) values[id] = resolveDefaultValue(definition.default, sender)
    }
    return values
  }

  buildStoredValues(pack:RulePack, values:Record<string,unknown>) {
    const stored = { ...(values || {}) }
    for (const [id, definition] of Object.entries(pack.character?.fields || {})) {
      if (definition.persistent === false) delete stored[id]
    }
    return stored
  }

  applyMigration(pack:RulePack, stored:RuleStored|null|undefined, sender:RuleSender, { scope = "character" } = {}) {
    const current:RuleStored = stored && typeof stored === "object" ? { ...stored, values: { ...(stored.values || {}) } } : { values: {} }
    const targetVersion = pack.compatibility?.package_version || "1.0.0"
    let version = current._packageVersion
    if (version && version !== targetVersion) {
      const visited = new Set()
      while (version !== targetVersion) {
        if (visited.has(version)) throw new Error(`规则数据迁移存在循环：${[...visited, version].join(" -> ")}`)
        visited.add(version)
        const migration = (pack.compatibility?.migrations || []).find(item => item.from === version)
        if (!migration) throw new Error(`规则数据仍是 ${version}，但 ${targetVersion} 没有从该版本出发的迁移；已停止访问，原数据未改写`)
        const rename = scope === "group" ? migration.rename_group_fields : migration.rename_fields
        const defaults = scope === "group" ? migration.add_group_defaults : migration.add_defaults
        for (const [oldId, newId] of Object.entries(rename || {})) {
          if (Object.prototype.hasOwnProperty.call(current.values, oldId) && !Object.prototype.hasOwnProperty.call(current.values, newId)) current.values[newId] = current.values[oldId]
          delete current.values[oldId]
        }
        for (const [id, value] of Object.entries(defaults || {})) {
          if (!Object.prototype.hasOwnProperty.call(current.values, id)) current.values[id] = value
        }
        version = migration.to || targetVersion
        if (visited.size > 20) throw new Error("规则数据迁移步骤超过 20，已停止访问")
      }
    }
    if (scope === "character") current.values = this.buildPersistentValues(pack, current, sender)
    current._packageVersion = targetVersion
    return current
  }

  evaluate(source:unknown, context:unknown, pack:RulePack, { allowDice = false, remainingDice = null, random = this.random }:EvalOptions = {}) {
    return evaluateDiceRuleExpression(typeof source === "string" ? source : String(source), context, {
      diceSets: pack.dice_sets || {},
      rollStandard: expression => {const roll=rollDiceExpression(expression, this.config, random);return {...roll,total:Number(roll.total)}},
      random,
      customFunctions: pack.__functions || null,
      maxDiceCount: remainingDice ?? pack.limits?.max_dice_count ?? this.config.maxDiceCount,
      maxLength: pack.limits?.max_expression_length || 512
    })
  }

  computeDerived(pack:RulePack, attr:Record<string,unknown>, extraContext:Record<string,unknown>&{__random?:()=>number} = {}, fields = pack.character?.fields || {}) {
    const derived:Record<string,unknown> = {}
    const visiting = new Set()
    const resolve = (id:string):unknown => {
      if (Object.prototype.hasOwnProperty.call(derived, id)) return derived[id]
      const definition = fields[id]
      if (!definition || definition.formula === undefined) throw new Error(`未知派生字段 ${id}`)
      if (visiting.has(id)) throw new Error(`派生字段循环依赖：${[...visiting, id].join(" -> ")}`)
      visiting.add(id)
      const proxy = new Proxy(derived, {
        get: (target, key) => typeof key === "string" && !Object.prototype.hasOwnProperty.call(target, key) && fields[key]?.formula !== undefined ? resolve(key) : typeof key==='string'?target[key]:undefined,
        has: (target, key) => Object.prototype.hasOwnProperty.call(target, key) || typeof key==='string'&&fields[key]?.formula !== undefined,
        getOwnPropertyDescriptor: (target, key) => Object.prototype.hasOwnProperty.call(target, key)
          ? Object.getOwnPropertyDescriptor(target, key)
          : typeof key==='string'&&fields[key]?.formula !== undefined ? { enumerable: true, configurable: true, value: resolve(key) } : undefined
      })
      const value = this.evaluate(definition.formula, { ...extraContext, attr, derived: proxy }, pack, { random: extraContext.__random || this.random }).value
      visiting.delete(id)
      derived[id] = validateFieldValue(value, definition, `derived.${id}`)
      return derived[id]
    }
    for (const [id, definition] of Object.entries(fields)) if (definition.formula !== undefined) resolve(id)
    return derived
  }

  buildGroupStored(pack:RulePack, ruleState:RuleGroupState, sender:RuleSender) {
    const definitions = pack.group?.fields || {}
    const stored = this.applyMigration(pack, ruleState.group, sender, { scope: "group" })
    for (const [id, definition] of Object.entries(definitions)) {
      if (definition.formula !== undefined) continue
      if (definition.persistent === false) {
        delete stored.values[id]
        if (definition.default !== undefined) stored.values[id] = resolveDefaultValue(definition.default, sender)
      } else if (!Object.prototype.hasOwnProperty.call(stored.values, id) && definition.default !== undefined) {
        stored.values[id] = resolveDefaultValue(definition.default, sender)
      }
    }
    return stored
  }

  buildInventoryContext(pack:RulePack, stored:Pick<RuleStored,"inventory">|undefined) {
    const inventory = stored?.inventory || {}
    const result:Record<string,Record<string,number|boolean>> = {}
    for (const id of Object.keys(pack.items || {})) {
      const current = inventory[id] || {quantity:0}
      result[id] = { quantity: Math.max(0, Number(current.quantity) || 0), equipped: Boolean(current.equipped) }
    }
    return result
  }

  buildAbilityContext(pack:RulePack, stored:Pick<RuleStored,"abilities">|undefined) {
    const abilities = stored?.abilities || {}
    const result:Record<string,Record<string,number|boolean>> = {}
    for (const id of Object.keys(pack.abilities || {})) {
      const current = abilities[id] || {rank:0,cooldown:0}
      result[id] = {
        learned: Boolean(current.learned),
        rank: Math.max(0, Number(current.rank) || 0),
        cooldown: Math.max(0, Number(current.cooldown) || 0),
        uses: Math.max(0, Number(current.uses) || 0)
      }
    }
    return result
  }

  getEntityDraft(_state:AgentDiceRulesState, request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, actor:RuleActor):RuleDraft {
    const players=this.packState(pack).players
    const npc=actor.kind==='npc'?ruleState.npcs[actor.id]:undefined
    if(actor.kind==='npc'&&!npc)throw new Error('NPC 不存在')
    if(actor.kind!=='npc'&&!request.members.some(member=>member.id===actor.id))throw new Error('目标成员已失效')
    const card=actor.kind==='npc'?undefined:(this.cards[actor.id]??={key:'默认',name:actor.name,attrs:{},skills:{}})
    const storageKey=JSON.stringify([actor.id,card?.key??'默认'])
    const original=actor.kind==='npc'?npc?.ruleData:players[storageKey]
    if(card)actor={...actor,name:card.name||actor.name}
    const stored=this.applyMigration(pack,original,{card:actor.name,nickname:actor.name})
    stored.statuses={...(stored.statuses??{})};stored.inventory={...(stored.inventory??{})};stored.abilities={...(stored.abilities??{})}
    return {key:actorStorageKey(actor),actor:{...actor},original,stored,attr:{...stored.values},
      inventory:this.buildInventoryContext(pack,stored),abilities:this.buildAbilityContext(pack,stored),
      commit:value=>{
        if(npc)npc.ruleData=value;else players[storageKey]=value
        if(JSON.stringify(original)!==JSON.stringify(value))this.events.push({kind:'card_change',source:{...request.source},
          packId:pack.id,subjectId:actor.id,slotHash:sha(storageKey),content:'规则人物卡已更新。'})
      }}
  }

  describeDraft(pack:RulePack, draft:RuleDraft, shared:Record<string,unknown>, session:RuleSession, random:()=>number):RuleDescription {
    const derived = this.computeDerived(pack, draft.attr, { shared, inventory: draft.inventory, abilities: draft.abilities, session, __random: random })
    return {
      id: draft.actor.id,
      name: draft.actor.name,
      kind: draft.actor.kind,
      attr: draft.attr,
      derived,
      statuses: draft.stored.statuses || {},
      inventory: draft.inventory,
      abilities: draft.abilities
    }
  }

  async parseArguments(command:RuleCommand, raw:string, request:AgentDiceRuleContext, ruleState:RuleGroupState) {
    const tokens = parseQuotedTokens(raw)
    const result:Record<string,unknown> = {}
    let cursor = 0
    for (const definition of command.arguments || []) {
      if (definition.type === "actor") {
        const allowed = definition.allowed || ["self"]
        const rawValues = definition.multiple === true
          ? tokens.slice(cursor)
          : tokens[cursor] === undefined ? [] : [tokens[cursor]]
        cursor += definition.multiple === true ? rawValues.length : rawValues.length ? 1 : 0
        if (!rawValues.length) {
          if (definition.required) throw new Error(`缺少参数：${definition.label || definition.id}`)
          if (allowed.includes("self")) result[definition.id] = definition.multiple ? [await resolveRuleActor(request, "self", ruleState, allowed)] : await resolveRuleActor(request, "self", ruleState, allowed)
          continue
        }
        const actors:RuleActor[] = []
        for (const token of rawValues) {
          const actor = await resolveRuleActor(request, token, ruleState, allowed)
          if (!actors.some(item => actorStorageKey(item) === actorStorageKey(actor))) actors.push(actor)
        }
        result[definition.id] = definition.multiple ? actors : actors[0]
        continue
      }
      let rawValue
      if (definition.rest) {
        rawValue = tokens.slice(cursor).join(" ")
        cursor = tokens.length
      } else rawValue = tokens[cursor++]
      if (rawValue === undefined || rawValue === "") {
        if (definition.required) throw new Error(`缺少参数：${definition.label || definition.id}`)
        if (definition.default !== undefined) result[definition.id] = definition.default
        continue
      }
      const value = convertInputValue(rawValue, definition, `arg.${definition.id}`)
      if (["integer", "number"].includes(definition.type)) {
        if (definition.min !== undefined && Number(value) < definition.min) throw new Error(`${definition.label || definition.id} 不能小于 ${definition.min}`)
        if (definition.max !== undefined && Number(value) > definition.max) throw new Error(`${definition.label || definition.id} 不能大于 ${definition.max}`)
      }
      result[definition.id] = value
    }
    if (cursor < tokens.length) throw new Error(`多余参数：${tokens.slice(cursor).join(" ")}`)
    return result
  }

  refreshRuleContext(pack:RulePack, runtime:RuleRuntime, targetDraft:RuleDraft|null = null, status:RuleStatusState|null = null) {
    const shared = runtime.groupStored.values
    const session = runtime.ruleState.session
    const actor = this.describeDraft(pack, runtime.actorDraft, shared, session, runtime.random)
    const target = targetDraft ? this.describeDraft(pack, targetDraft, shared, session, runtime.random) : runtime.defaultTarget
    runtime.context.attr = actor.attr
    runtime.context.derived = actor.derived
    runtime.context.inventory = actor.inventory
    runtime.context.abilities = actor.abilities
    runtime.context.shared = shared
    runtime.context.session = session
    runtime.context.target = target || null
    runtime.context.status = status || null
    return { actor, target }
  }

  getActionDrafts(action:RuleAction, runtime:RuleRuntime) {
    const scope = action.scope || "actor"
    if (scope === "actor") return [runtime.actorDraft]
    if (scope === "group") return [{
      key: "group",
      actor: { kind: "group", id: String(runtime.context.group.id), name: "群共享状态",role:"group",self:false },
      container:{},original:undefined,abilities:{},commit:()=>{},
      attr: runtime.groupStored.values,
      stored: runtime.groupStored,
      inventory: {},
      group: true
    }]
    const value = runtime.args[action.target||""]
    const actors = (Array.isArray(value) ? value : value ? [value] : []).map(decodeRuleActor)
    if (!actors.length) throw new Error(`目标参数 ${action.target} 为空`)
    return actors.map(actor => {
      const draft = runtime.entityDrafts.get(actorStorageKey(actor))
      if (!draft) throw new Error(`目标状态没有加载：${actor.name || actor.id}`)
      return draft
    })
  }

  evaluateActionValue(source:unknown, pack:RulePack, runtime:RuleRuntime, targetDraft:RuleDraft|undefined, options:EvalOptions = {}) {
    this.refreshRuleContext(pack, runtime, targetDraft?.group ? null : targetDraft, options.status)
    return this.evaluate(source, runtime.context, pack, { ...options, random: runtime.random }).value
  }

  applyValueAction(pack:RulePack, action:RuleAction, runtime:RuleRuntime, draft:RuleDraft, options:EvalOptions = {}) {
    const fields = draft.group ? pack.group?.fields || {} : pack.character?.fields || {}
    const definition = fields[action.field||""]
    if (!definition || definition.formula !== undefined) throw new Error(`字段 ${action.field} 不可写入`)
    const before = draft.attr[action.field||""]
    if (action.op === "clear") {
      delete draft.attr[action.field||""]
      if (definition.default !== undefined) draft.attr[action.field||""] = resolveDefaultValue(definition.default, { card: draft.actor.name, nickname: draft.actor.name })
    } else if (action.op === "clamp") {
      const min = Number(this.evaluateActionValue(action.min, pack, runtime, draft, options))
      const max = Number(this.evaluateActionValue(action.max, pack, runtime, draft, options))
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`字段 ${action.field} 的 clamp 范围无效`)
      draft.attr[action.field||""] = Math.min(max, Math.max(min, Number(before)))
    } else {
      const value = this.evaluateActionValue(action.value, pack, runtime, draft, options)
      if (action.op === "set") draft.attr[action.field||""] = value
      else if (action.op === "add") draft.attr[action.field||""] = Number(before) + Number(value)
      else if (action.op === "subtract") draft.attr[action.field||""] = Number(before) - Number(value)
      else if (action.op === "min") draft.attr[action.field||""] = Math.min(Number(before), Number(value))
      else if (action.op === "max") draft.attr[action.field||""] = Math.max(Number(before), Number(value))
    }
    validateFieldValue(draft.attr[action.field||""], definition, `${draft.group ? "shared" : "attr"}.${action.field}`)
    if (!draft.group) draft.stored.values = this.buildStoredValues(pack, draft.attr)
    return { before, after: draft.attr[action.field||""] }
  }

  async applyStatusAction(pack:RulePack, action:RuleAction, runtime:RuleRuntime, draft:RuleDraft, depth:number) {
    if (draft.group) throw new Error("状态不能作用于群共享字段")
    const definition = pack.statuses?.[action.status||""]
    if (!definition) throw new Error(`未知状态 ${action.status}`)
    draft.stored.statuses ||= {}
    const previous = draft.stored.statuses[action.status||""] ? { ...draft.stored.statuses[action.status||""]! } : null
    if (action.op === "remove_status") {
      if (previous && definition.on_expire?.length) {
        await this.applyActionList(pack, definition.on_expire, { ...runtime, actorDraft: draft }, depth + 1, { status: { id: action.status, ...previous } })
      }
      delete draft.stored.statuses[action.status||""]
      return { before: previous, after: null }
    }
    const stacks = Math.max(1, Math.trunc(Number(action.stacks === undefined ? 1 : this.evaluateActionValue(action.stacks, pack, runtime, draft))))
    const durationSource = action.duration ?? definition.default_duration
    const duration = durationSource === undefined ? null : Math.max(1, Math.trunc(Number(this.evaluateActionValue(durationSource, pack, runtime, draft))))
    const maxStacks = Math.max(1, Number(definition.max_stacks) || 1)
    const current = {
      stacks: Math.min(maxStacks, Math.max(0, Number(previous?.stacks) || 0) + stacks),
      duration: duration ?? previous?.duration ?? null,
      appliedAt: previous?.appliedAt || this.iso,
      source: runtime.actorDraft.actor.id
    }
    draft.stored.statuses[action.status||""] = current
    if (definition.on_apply?.length) {
      await this.applyActionList(pack, definition.on_apply, { ...runtime, actorDraft: draft }, depth + 1, { status: { id: action.status, ...current } })
    }
    return { before: previous, after: { ...current } }
  }

  applyItemAction(pack:RulePack, action:RuleAction, runtime:RuleRuntime, draft:RuleDraft) {
    if (draft.group) throw new Error("物品不能作用于群共享字段")
    const definition = pack.items?.[action.item||""]
    if (!definition) throw new Error(`未知物品 ${action.item}`)
    draft.stored.inventory ||= {}
    const previous = draft.stored.inventory[action.item||""] ? { ...draft.stored.inventory[action.item||""]! } : { quantity: 0, equipped: false }
    const current = { ...previous }
    if (["add_item", "remove_item"].includes(action.op)) {
      const quantity = Math.max(1, Math.trunc(Number(action.quantity === undefined ? 1 : this.evaluateActionValue(action.quantity, pack, runtime, draft))))
      current.quantity += action.op === "add_item" ? quantity : -quantity
      if (current.quantity < 0) throw new Error(`${definition.label || action.item} 数量不足`)
      const max = definition.stackable === false ? 1 : Math.max(1, Number(definition.max_quantity) || 1000000)
      if (current.quantity > max) throw new Error(`${definition.label || action.item} 数量不能超过 ${max}`)
      if (current.quantity === 0) current.equipped = false
    } else if (action.op === "equip") {
      if (current.quantity < 1) throw new Error(`没有可装备的 ${definition.label || action.item}`)
      if (definition.slot) {
        for (const [itemId, itemState] of Object.entries(draft.stored.inventory)) {
          if (itemId !== action.item && itemState?.equipped && pack.items?.[itemId]?.slot === definition.slot) itemState.equipped = false
        }
      }
      current.equipped = true
    } else current.equipped = false
    if (current.quantity === 0) delete draft.stored.inventory[action.item||""]
    else draft.stored.inventory[action.item||""] = current
    draft.inventory = this.buildInventoryContext(pack, draft.stored)
    return { before: previous, after: current.quantity === 0 ? null : { ...current } }
  }

  applyAbilityAction(pack:RulePack, action:RuleAction, runtime:RuleRuntime, draft:RuleDraft) {
    if (draft.group) throw new Error("能力不能作用于群共享字段")
    const definition = pack.abilities?.[action.ability||""]
    if (!definition) throw new Error(`未知能力 ${action.ability}`)
    draft.stored.abilities ||= {}
    const previous = draft.stored.abilities[action.ability||""] ? { ...draft.stored.abilities[action.ability||""]! } : { learned: false, rank: 0, cooldown: 0, uses: 0 }
    let current = { ...previous }
    if (action.op === "learn_ability") {
      const rank = Math.max(1, Math.trunc(Number(action.rank === undefined ? Math.max(1, current.rank || 1) : this.evaluateActionValue(action.rank, pack, runtime, draft))))
      const maxRank = Math.max(1, Number(definition.max_rank) || 1)
      if (rank > maxRank) throw new Error(`${definition.label || action.ability} 等级不能超过 ${maxRank}`)
      current = { ...current, learned: true, rank }
    } else if (action.op === "forget_ability") {
      delete draft.stored.abilities[action.ability||""]
      draft.abilities = this.buildAbilityContext(pack, draft.stored)
      return { before: previous, after: null }
    } else if (action.op === "reset_ability") {
      if (!current.learned) throw new Error(`尚未学习 ${definition.label || action.ability}`)
      current.cooldown = 0
    } else {
      if (!current.learned) throw new Error(`尚未学习 ${definition.label || action.ability}`)
      if (Number(current.cooldown) > 0) throw new Error(`${definition.label || action.ability} 仍有 ${current.cooldown} 回合冷却`)
      if (definition.resource_field) {
        const resourceDraft = definition.resource_scope === "group"
          ? { group: true, attr: runtime.groupStored.values, actor: { kind: "group", id: String(runtime.context.group.id), name: "群共享状态" } }
          : draft
        const fields = definition.resource_scope === "group" ? pack.group?.fields || {} : pack.character?.fields || {}
        const fieldDefinition = fields[definition.resource_field]
        const before = Number(resourceDraft.attr[definition.resource_field])
        const cost = Math.max(0, Number(definition.resource_cost) || 0)
        if (!Number.isFinite(before) || before < cost) throw new Error(`${fieldDefinition?.label || definition.resource_field} 不足，需要 ${cost}`)
        resourceDraft.attr[definition.resource_field] = before - cost
        validateFieldValue(resourceDraft.attr[definition.resource_field], fieldDefinition!, `${definition.resource_scope === "group" ? "shared" : "attr"}.${definition.resource_field}`)
        runtime.auditActions.push({ op: "ability_cost", scope: definition.resource_scope || "actor", target: sanitizeAuditValue(resourceDraft.actor), field: definition.resource_field, before, after: resourceDraft.attr[definition.resource_field] })
      }
      current.cooldown = Math.max(0, Number(definition.cooldown) || 0)
      current.uses = Math.max(0, Number(current.uses) || 0) + 1
    }
    draft.stored.abilities[action.ability||""] = current
    draft.abilities = this.buildAbilityContext(pack, draft.stored)
    return { before: previous, after: { ...current } }
  }

  async applyActionList(pack:RulePack, actions:RuleAction[]|undefined, runtime:RuleRuntime, depth = 0, options:EvalOptions = {}) {
    if (!actions?.length) return
    if (depth > 8) throw new Error("状态或事件动作递归超过 8 层")
    for (const action of actions) {
      for (const draft of this.getActionDrafts(action, runtime)) {
        if (action.when !== undefined && !Boolean(this.evaluateActionValue(action.when, pack, runtime, draft, options))) continue
        let change
        if (["set", "add", "subtract", "min", "max", "clamp", "clear"].includes(action.op)) change = this.applyValueAction(pack, action, runtime, draft, options)
        else if (["add_status", "remove_status"].includes(action.op)) change = await this.applyStatusAction(pack, action, runtime, draft, depth)
        else if (["add_item", "remove_item", "equip", "unequip"].includes(action.op)) change = this.applyItemAction(pack, action, runtime, draft)
        else change = this.applyAbilityAction(pack, action, runtime, draft)
        runtime.auditActions.push({
          op: action.op,
          scope: action.scope || "actor",
          target: { kind: draft.actor.kind, id: draft.actor.id, name: draft.actor.name },
          field: action.field || action.status || action.item || action.ability,
          ...record(sanitizeAuditValue(change))
        })
        this.refreshRuleContext(pack, runtime, draft.group ? null : draft, options.status)
      }
    }
  }

  async executeCommand(request:AgentDiceRuleContext, pack:RulePack, command:RuleCommand, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    requireRulePermission(request, ruleState, command.permission || "player")
    const invocationRandom = this.invocationRandom()
    const random = invocationRandom.random
    const sender = { card: request.actor.name || "", nickname: request.actor.name || "" }
    const actorDraft = this.getEntityDraft(state, request, pack, ruleState, selfActor(request))
    const args = await this.parseArguments(command, raw, request, ruleState)
    const entityDrafts = new Map([[actorDraft.key, actorDraft]])
    for (const definition of command.arguments || []) {
      if (definition.type !== "actor") continue
      const values = Array.isArray(args[definition.id]) ? args[definition.id] : args[definition.id] ? [args[definition.id]] : []
      for (const candidate of Array.isArray(values)?values:[]) {
        const actor=decodeRuleActor(candidate)
        const key = actorStorageKey(actor)
        if (!entityDrafts.has(key)) entityDrafts.set(key, this.getEntityDraft(state, request, pack, ruleState, actor))
      }
    }
    const groupStored = this.buildGroupStored(pack, ruleState, sender)
    const rawGroupId = request.groupId
    const numericGroupId = Number(rawGroupId)
    const firstTargetActor = [...entityDrafts.values()].find(draft => draft.key !== actorDraft.key) || null
    const context:RuleContext = {
      arg: args,
      attr: actorDraft.attr,
      derived: {},
      roll: {},
      table: {},
      let: {},
      group: { id: Number.isSafeInteger(numericGroupId) ? numericGroupId : String(rawGroupId) },
      shared: groupStored.values,
      session: ruleState.session,
      inventory: actorDraft.inventory,
      abilities: actorDraft.abilities,
      target: null,
      opposed: null,
      result: ""
    }
    const runtime:RuleRuntime = {
      state,
      request,
      pack,
      command,
      ruleState,
      actorDraft,
      entityDrafts,
      groupStored,
      args,
      context,
      random,
      defaultTarget: firstTargetActor ? this.describeDraft(pack, firstTargetActor, groupStored.values, ruleState.session, random) : null,
      auditActions: []
    }
    this.refreshRuleContext(pack, runtime, firstTargetActor)
    let diceUsed = 0
    const maxDiceCount = pack.limits?.max_dice_count || config.maxDiceCount
    for (const [id, expression] of Object.entries(command.rolls || {})) {
      const evaluation = this.evaluate(expression, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      if (typeof evaluation.value !== "number" || !Number.isFinite(evaluation.value)) throw new Error(`roll.${id} 必须得到数值`)
      diceUsed += evaluation.diceCount
      if (diceUsed > maxDiceCount) throw new Error(`骰子总数超过上限 ${maxDiceCount}`)
      context.roll[id] = { expr: String(expression), total: evaluation.value, detail: evaluation.traces.join(" + ") || String(evaluation.value) }
    }
    for (const [id, tableId] of Object.entries(command.draws || {})) context.table[id] = drawTable(pack.tables[String(tableId)], random)
    for (const [id, expression] of Object.entries(command.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value

    if (command.opposed) {
      const targetValue = args[command.opposed.target]
      if (Array.isArray(targetValue)) throw new Error("对抗检定只支持一个目标")
      const targetDraft = targetValue ? entityDrafts.get(actorStorageKey(decodeRuleActor(targetValue))) : null
      if (!targetDraft) throw new Error("对抗检定目标不存在")
      this.refreshRuleContext(pack, runtime, targetDraft)
      const actorEvaluation = this.evaluate(command.opposed.actor_value, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      diceUsed += actorEvaluation.diceCount
      const targetEvaluation = this.evaluate(command.opposed.target_value, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      diceUsed += targetEvaluation.diceCount
      if (diceUsed > maxDiceCount) throw new Error(`骰子总数超过上限 ${maxDiceCount}`)
      const actorValue = Number(actorEvaluation.value)
      const targetNumber = Number(targetEvaluation.value)
      if (!Number.isFinite(actorValue) || !Number.isFinite(targetNumber)) throw new Error("对抗值必须是有限数字")
      const mode = command.opposed.mode || "higher"
      let result = actorValue === targetNumber ? command.opposed.tie || "tie" : mode === "higher" ? (actorValue > targetNumber ? "actor" : "target") : (actorValue < targetNumber ? "actor" : "target")
      const winner = result === "actor" ? actorDraft.actor.name : result === "target" ? targetDraft.actor.name : "平手"
      context.opposed = { actor: actorValue, target: targetNumber, result, winner, margin: Math.abs(actorValue - targetNumber) }
    }

    let branch = null
    for (const candidate of command.branches || []) {
      if (candidate.when === undefined || Boolean(this.evaluate(candidate.when, context, pack, { random }).value)) {
        branch = candidate
        break
      }
    }
    if (branch) {
      context.result = branch.result || ""
      for (const [id, expression] of Object.entries(branch.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value
    }
    await this.applyActionList(pack, [...(command.actions || []), ...(branch?.actions || [])], runtime)
    this.refreshRuleContext(pack, runtime, firstTargetActor)
    const identityContext = { ...context, sender }
    const actorTemplate = pack.identity?.display_name || "{sender.card}"
    let actor = ""
    try {
      actor = renderRuleTemplate(actorTemplate, identityContext).trim()
    } catch {}
    if (!actor) actor = renderRuleTemplate(pack.identity?.fallback || "{sender.card}", identityContext, { strict: false }).trim()
    if (!actor) actor = actorDraft.actor.name || sender.nickname || String(request.actor.id || "调查员")
    const groupCardUpdates = []
    if (pack.identity?.sync_group_card === true && actorDraft.actor.self) {
      const cardTemplate = pack.identity.group_card || pack.identity.display_name || "{sender.card}"
      const cardName = sanitizeRuleOutput(renderRuleTemplate(cardTemplate, identityContext, { strict: false })).trim().slice(0, 60)
      if (cardName) groupCardUpdates.push({ userId: String(request.actor.id || ""), name: cardName })
    }
    const outputContext = { ...context, actor, sender, command: { label: command.label || command.id }, message: "" }
    const template = branch?.output ?? command.output ?? pack.templates?.[command.template||""]
    const output = sanitizeRuleOutput(renderRuleTemplate(template, outputContext))
    const maxOutput = pack.limits?.max_output_length || 2000
    if (Array.from(output).length > maxOutput) throw new Error(`规则输出超过 ${maxOutput} 字符上限`)
    const visibility = command.visibility || "public"
    const auditId = this.auditId()
    let text = output
    let privateMessages:NonNullable<RuleResult["privateMessages"]> = []
    if (visibility !== "public") {
      const recipients = visibility === "private" ? [String(request.actor.id || "")] : await getRuleGmRecipients(request, ruleState)
      if (!recipients.length) throw new Error("没有找到可接收私密结果的 GM 或管理员")
      const publicTemplate = command.public_output || "{actor}进行了一次暗骰，结果已发送给有权限的接收者。"
      text = sanitizeRuleOutput(renderRuleTemplate(publicTemplate, outputContext))
      const queued = this.queuePrivateRuleResult(request, pack, ruleState, output, text, { recipients, auditId,requiredPermission:visibility==='private'?'player':'gm' })
      privateMessages = queued.privateMessages
    }
    for (const draft of entityDrafts.values()) {
      draft.stored.values = this.buildStoredValues(pack, draft.attr)
      draft.commit(draft.stored)
    }
    for (const [id, definition] of Object.entries(pack.group?.fields || {})) if (definition.persistent === false) delete groupStored.values[id]
    ruleState.group = groupStored
    const audit = {
      id: auditId,
      at: this.iso,
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command: command.id,
      visibility,
      invoker: { id: String(request.actor.id || ""), name: actor },
      targets: [...entityDrafts.values()].filter(draft => draft.key !== actorDraft.key).map(draft => ({ kind: draft.actor.kind, id: draft.actor.id, name: draft.actor.name })),
      seed: invocationRandom.seed,
      args: sanitizeAuditValue(args),
      rolls: sanitizeAuditValue(context.roll),
      tables: sanitizeAuditValue(context.table),
      opposed: sanitizeAuditValue(context.opposed),
      result: context.result,
      tags: Array.isArray(branch?.tags) ? [...branch.tags] : [],
      actions: runtime.auditActions,
      output
    }
    this.appendRuleAudit(ruleState,audit)
    await Promise.resolve()

    await this.recordEvent(request, {
      content: text,
      auditId,
      packId: pack.id,
      command: command.id,
      visibility:visibility==='public'?'public':'private',
      result: visibility === "public" ? context.result : "[private]",
      tags: visibility==='public'&&Array.isArray(branch?.tags) ? [...branch.tags] : []
    }, state, config)
    return { text, privateMessages, auditId, packId: pack.id, groupCardUpdates }
  }

  findField(pack:RulePack, raw:string) {
    const text = normalizeText(raw)
    return Object.entries(pack.character?.fields || {}).find(([id, definition]) => id === text || definition.label === text) || null
  }

  splitBuiltinTarget(raw = "") {
    const tokens = parseQuotedTokens(raw)
    const first = tokens[0] || ""
    const isSelector = /^(?:(?:self|me|我|自己|reply|回复)$|qq:\d+|(?:user|member|npc):.+|\d{5,20}$|<@!?[^>]+>|\[CQ:at,)/iu.test(first)
    return isSelector ? { selector: first, rest: tokens.slice(1).join(" ") } : { selector: "self", rest: String(raw || "").trim() }
  }

  async handleCardOperation(request:AgentDiceRuleContext, pack:RulePack, operation:string, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const parsed = this.splitBuiltinTarget(raw)
    const target = await resolveRuleActor(request, parsed.selector, ruleState, ["self", "member", "npc"])
    const permission = getRulePermission(request, ruleState)
    if (!target.self && !["gm", "admin", "master"].includes(permission)) throw new Error("只有 GM、群管理员或主人可以直接查看或修改其他角色的人物卡")
    const draft = this.getEntityDraft(state, request, pack, ruleState, target)
    const attr = draft.attr
    const fields = pack.character?.fields || {}
    if (operation === "card") {
      const derived = this.computeDerived(pack, attr, { shared: ruleState.group?.values || {}, inventory: draft.inventory,abilities:draft.abilities, session: ruleState.session })
      const rows = []
      for (const [id, definition] of Object.entries(fields)) {
        if (definition.secret) continue
        const value = definition.formula === undefined ? attr[id] : derived[id]
        rows.push(`${definition.label || id}(${id})：${value ?? "未设置"}${definition.formula !== undefined ? " [派生]" : ""}`)
      }
      const secretCount = Object.values(fields).filter(definition => definition.secret).length
      return `${pack.name} / ${draft.actor.name}\n${rows.join("\n") || "暂无公开字段"}${secretCount ? `\n${secretCount} 个秘密字段未在群内展示；GM 可用「查 字段」私聊查看。` : ""}`
    }
    if (operation === "get") {
      const found = this.findField(pack, parsed.rest)
      if (!found) throw new Error(`没有找到字段：${normalizeText(parsed.rest)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可见`)
      const value = definition.formula === undefined ? attr[id] : this.computeDerived(pack, attr, { shared: ruleState.group?.values || {}, inventory: draft.inventory,abilities:draft.abilities, session: ruleState.session })[id]
      if (definition.secret) {
        const result = this.queuePrivateRuleResult(request, pack, ruleState, `${definition.label || id}(${id})=${value ?? "未设置"}`, `${draft.actor.name} 的秘密字段结果已私聊发送。`)
        await Promise.resolve()
        return result
      }
      return `${definition.label || id}(${id})=${value ?? "未设置"}`
    }
    if (operation === "set") {
      const source = parsed.rest
      const matcher = /([a-z][a-z0-9_]{0,47})\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
      const updates = []
      let secretTouched = false
      let consumed = 0
      let match
      while ((match = matcher.exec(source))) {
        if (source.slice(consumed, match.index).trim()) throw new Error(`无法识别人物卡设置：${source.slice(consumed, match.index).trim()}`)
        const id = match[1]!
        const definition = fields[id]
        if (!definition) throw new Error(`未知字段：${id}`)
        if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可修改`)
        if (definition.secret) secretTouched = true
        if (definition.formula !== undefined) throw new Error(`派生字段 ${id} 不能直接设置`)
        if (definition.persistent === false) throw new Error(`临时字段 ${id} 只能由规则命令在本次执行中修改`)
        const value = convertInputValue(match[2] ?? match[3] ?? match[4], definition, `attr.${id}`)
        validateFieldValue(value, definition, `attr.${id}`)
        attr[id] = value
        updates.push(`${definition.label || id}=${value}`)
        consumed = matcher.lastIndex
      }
      if (!updates.length) throw new Error("格式：.规则前缀 设 field=value；包含空格的值请加引号")
      if (source.slice(consumed).trim()) throw new Error(`无法识别人物卡设置：${source.slice(consumed).trim()}`)
      draft.stored.values = this.buildStoredValues(pack, attr)
      draft.commit(draft.stored)
      const result = secretTouched
        ? this.queuePrivateRuleResult(request, pack, ruleState, `已更新 ${draft.actor.name} 的 ${pack.name} 人物卡：${updates.join("，")}`, `${draft.actor.name} 的秘密人物卡字段已更新，具体值已私聊发送。`)
        : `已更新 ${draft.actor.name} 的 ${pack.name} 人物卡：${updates.join("，")}`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "card_set", result, {
        targets: [draft.actor],
        actions: updates.map(update => ({ op: "set_field", target: draft.actor.id, field: update.split("=")[0], value: secretTouched ? "[private]" : update.split("=").slice(1).join("=") }))
      })
    }
    if (operation === "clear") {
      const found = this.findField(pack, parsed.rest)
      if (!found) throw new Error(`没有找到字段：${normalizeText(parsed.rest)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可修改`)
      if (definition.formula !== undefined) throw new Error(`派生字段 ${id} 没有可删除的存储值`)
      if (definition.persistent === false) throw new Error(`临时字段 ${id} 没有可删除的持久值`)
      delete attr[id]
      if (definition.default !== undefined) attr[id] = resolveDefaultValue(definition.default, { card: draft.actor.name, nickname: draft.actor.name })
      draft.stored.values = this.buildStoredValues(pack, attr)
      draft.commit(draft.stored)
      const result = definition.secret
        ? this.queuePrivateRuleResult(request, pack, ruleState, `已清除 ${definition.label || id}，当前值为 ${attr[id] ?? "未设置"}`, `${draft.actor.name} 的秘密字段已清除，当前值已私聊发送。`)
        : `已清除 ${definition.label || id}，当前值为 ${attr[id] ?? "未设置"}`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "card_clear", result, {
        targets: [draft.actor],
        actions: [{ op: "clear_field", target: draft.actor.id, field: id, value: definition.secret ? "[private]" : attr[id] }]
      })
    }
    throw new Error("未知人物卡操作")
  }

  async handleRoleOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    if (!tokens.length || ["list", "列表", "show"].includes(tokens[0]!.toLowerCase())) {
      const rows = Object.entries(ruleState.roles).map(([id, role]) => `${id}：${roleLabel(role)}`)
      return `当前规则角色：\n${rows.join("\n") || "尚未指定 GM；群主和管理员仍具有管理权限。"}`
    }
    requireRulePermission(request, ruleState, "admin")
    if (["set", "设置", "add", "添加"].includes(tokens[0]!.toLowerCase())) tokens.shift()
    const role = String(tokens.shift() || "").toLowerCase()
    if (!["gm", "player"].includes(role)) throw new Error("格式：权限 设置 gm @成员；可设置 gm 或 player")
    const selector = tokens.shift()
    if (!selector) throw new Error("请指定成员")
    const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member"])
    if (actor.kind !== "member") throw new Error("只有群成员可以分配规则角色")
    if (role === "gm") ruleState.roles[actor.id] = "gm"
    else delete ruleState.roles[actor.id]
    const result = `已将 ${actor.name} 的规则角色设置为${roleLabel(role)}。`
    return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "role_set", result, {
      targets: [actor], actions: [{ op: "set_role", target: actor.id, value: role }]
    })
  }

  async handleNpcOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "列表", "show"].includes(action)) {
      const rows = Object.values(ruleState.npcs).map(npc => `${npc.id}：${npc.name}`)
      return `NPC 列表：\n${rows.join("\n") || "暂无 NPC"}`
    }
    requireRulePermission(request, ruleState, "gm")
    if (["create", "add", "创建", "新增"].includes(action)) {
      const id = String(tokens.shift() || "")
      const name = tokens.join(" ").trim()
      if (!/^[a-z][a-z0-9_-]{1,47}$/.test(id)) throw new Error("NPC ID 必须以小写字母开头，只含小写字母、数字、下划线或连字符")
      if (!name) throw new Error("格式：npc 创建 <id> <名称>")
      if (ruleState.npcs[id]) throw new Error(`NPC 已存在：${id}`)
      ruleState.npcs[id] = { id, name: name.slice(0, 60), ruleData: null, createdAt: this.iso, createdBy: String(request.actor.id || "") }
      const draft = this.getEntityDraft(state, request, pack, ruleState, { kind: "npc", id, name, role: "npc", self: false })
      draft.commit(draft.stored)
      const result = `已创建 NPC：${id}（${name.slice(0, 60)}）`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "npc_create", result, {
        targets: [{ kind: "npc", id, name: name.slice(0, 60) }], actions: [{ op: "create_npc", target: id }]
      })
    }
    if (["delete", "del", "remove", "删除"].includes(action)) {
      const id = String(tokens.shift() || "").replace(/^npc:/i, "")
      if (!ruleState.npcs[id]) throw new Error(`NPC 不存在：${id}`)
      const name = ruleState.npcs[id].name || id
      delete ruleState.npcs[id]
      ruleState.session.initiative = ruleState.session.initiative.filter(item => !(item.kind === "npc" && item.id === id))
      if (ruleState.session.current?.kind === "npc" && ruleState.session.current?.id === id) ruleState.session.current = null
      const result = `已删除 NPC：${name}`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "npc_delete", result, {
        targets: [{ kind: "npc", id, name }], actions: [{ op: "delete_npc", target: id }]
      })
    }
    if (["card", "卡"].includes(action)) return await this.handleCardOperation(request, pack, "card", `npc:${tokens.shift() || ""}`)
    if (["set", "设"].includes(action)) return await this.handleCardOperation(request, pack, "set", `npc:${tokens.shift() || ""} ${tokens.join(" ")}`)
    if (["get", "查"].includes(action)) return await this.handleCardOperation(request, pack, "get", `npc:${tokens.shift() || ""} ${tokens.join(" ")}`)
    throw new Error("NPC 命令：npc 列表 / 创建 id 名称 / 删除 id / 卡 id / 设 id field=value")
  }

  async handleGroupFieldOperation(request:AgentDiceRuleContext, pack:RulePack, operation:string, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const permission = getRulePermission(request, ruleState)
    const stored = this.buildGroupStored(pack, ruleState, { card: request.actor.name || "", nickname: request.actor.name || "" })
    const attr = stored.values
    const fields = pack.group?.fields || {}
    const find = (value:unknown) => Object.entries(fields).find(([id, definition]) => id === normalizeText(value) || definition.label === normalizeText(value)) || null
    if (operation === "card") {
      const derived = this.computeDerived(pack, attr, { session: ruleState.session }, fields)
      const rows = Object.entries(fields).filter(([, definition]) => !definition.secret).map(([id, definition]) => {
        const value = definition.formula === undefined ? attr[id] : derived[id]
        return `${definition.label || id}(${id})：${value ?? "未设置"}${definition.formula !== undefined ? " [派生]" : ""}`
      })
      const secretCount = Object.values(fields).filter(definition => definition.secret).length
      return `${pack.name} 群共享状态：\n${rows.join("\n") || "未定义公开共享字段"}${secretCount ? `\n${secretCount} 个秘密群字段未在群内展示；GM 可用「群查 字段」私聊查看。` : ""}`
    }
    if (operation === "get") {
      const found = find(raw)
      if (!found) throw new Error(`没有找到群字段：${normalizeText(raw)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可见`)
      const value = definition.formula === undefined ? attr[id] : this.computeDerived(pack, attr, { session: ruleState.session }, fields)[id]
      if (definition.secret) {
        const result = this.queuePrivateRuleResult(request, pack, ruleState, `${definition.label || id}(${id})=${value ?? "未设置"}`, "秘密群字段结果已私聊发送。")
        await Promise.resolve()
        return result
      }
      return `${definition.label || id}(${id})=${value ?? "未设置"}`
    }
    requireRulePermission(request, ruleState, "gm")
    const source = String(raw || "")
    const matcher = /([a-z][a-z0-9_]{0,47})\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
    const updates = []
    let secretTouched = false
    let consumed = 0
    let match
    while ((match = matcher.exec(source))) {
      if (source.slice(consumed, match.index).trim()) throw new Error(`无法识别群字段设置：${source.slice(consumed, match.index).trim()}`)
      const definition = fields[match[1]!]
      if (!definition || definition.formula !== undefined || definition.persistent === false) throw new Error(`群字段 ${match[1]} 不可直接设置`)
      if (definition.secret) secretTouched = true
      const value = convertInputValue(match[2] ?? match[3] ?? match[4], definition, `shared.${match[1]}`)
      validateFieldValue(value, definition, `shared.${match[1]}`)
      attr[match[1]!] = value
      updates.push(`${definition.label || match[1]}=${value}`)
      consumed = matcher.lastIndex
    }
    if (!updates.length || source.slice(consumed).trim()) throw new Error("格式：群设 field=value；包含空格的值请加引号")
    ruleState.group = stored
    const result = secretTouched
      ? this.queuePrivateRuleResult(request, pack, ruleState, `已更新群共享状态：${updates.join("，")}`, "秘密群共享字段已更新，具体值已私聊发送。")
      : `已更新群共享状态：${updates.join("，")}`
    return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "group_set", result, {
      actions: updates.map(update => ({ op: "set_group_field", field: update.split("=")[0], value: secretTouched ? "[private]" : update.split("=").slice(1).join("=") }))
    })
  }

  createLifecycleRuntime(state:AgentDiceRulesState, request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, actor:RuleActor, sharedGroupStored:RuleStored|null = null) {
    const randomState = this.invocationRandom()
    const actorDraft = this.getEntityDraft(state, request, pack, ruleState, actor)
    const groupStored = sharedGroupStored || this.buildGroupStored(pack, ruleState, { card: request.actor.name || "", nickname: request.actor.name || "" })
    const rawGroupId = request.groupId
    const numericGroupId = Number(rawGroupId)
    const runtime:RuleRuntime = {
      state,
      request,
      pack,
      ruleState,
      actorDraft,
      entityDrafts: new Map([[actorDraft.key, actorDraft]]),
      groupStored,
      args: {},
      context: {
        arg: {}, attr: actorDraft.attr, derived: {}, roll: {}, table: {}, let: {}, result: "",
        group: { id: Number.isSafeInteger(numericGroupId) ? numericGroupId : String(rawGroupId) },
        shared: groupStored.values, session: ruleState.session, inventory: actorDraft.inventory, abilities: actorDraft.abilities, target: null, opposed: null, status: null
      },
      random: randomState.random,
      randomSeed: randomState.seed,
      defaultTarget: null,
      auditActions: []
    }
    this.refreshRuleContext(pack, runtime)
    return runtime
  }

  commitLifecycleRuntime(pack:RulePack, runtime:RuleRuntime) {
    for (const draft of runtime.entityDrafts.values()) {
      draft.stored.values = this.buildStoredValues(pack, draft.attr)
      draft.commit(draft.stored)
    }
    for (const [id, definition] of Object.entries(pack.group?.fields || {})) if (definition.persistent === false) delete runtime.groupStored.values[id]
    runtime.ruleState.group = runtime.groupStored
  }

  appendRuleAudit(ruleState:RuleGroupState, record:RuleAudit) {
    ruleState.audit ||= []
    ruleState.audit.push({...record,source:{...this.request.source}})
    if (ruleState.audit.length > MAX_AUDIT_RECORDS) ruleState.audit.splice(0, ruleState.audit.length - MAX_AUDIT_RECORDS)
  }

  async finishDirectBuiltinMutation(request:AgentDiceRuleContext, pack:RulePack, state:AgentDiceRulesState, ruleState:RuleGroupState, command:string, result:string|RuleResult, { targets = [], actions = [] }:{targets?:Pick<RuleActor,"kind"|"id"|"name">[];actions?:Record<string,unknown>[]} = {}) {
    const auditId = (typeof result==='object'?result.auditId:undefined) || this.auditId()
    const visibility = result && typeof result === "object" && result.privateMessages?.length ? "private" : "public"
    const publicText = sanitizeRuleOutput(typeof result === "object" ? result.text : result)
    this.appendRuleAudit(ruleState, {
      id: auditId,
      at: this.iso,
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command,
      visibility,
      invoker: { id: String(request.actor.id || ""), name: request.actor.name || request.actor.name || String(request.actor.id || "") },
      targets: sanitizeAuditValue(targets),
      seed: "",
      actions: sanitizeAuditValue(actions),
      output: visibility === "public" ? publicText : "[private]"
    })
    const config = this.config
    await Promise.resolve()
    await this.recordEvent(request, { content: publicText, auditId, packId: pack.id, command, visibility }, state, config)

    if (result && typeof result === "object") return { ...result, auditId, packId: pack.id }
    return publicText
  }

  queuePrivateRuleResult(request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, privateText:string, publicText:string, { recipients = null, auditId = this.auditId(),requiredPermission='gm' }:{recipients?:string[]|null;auditId?:string;requiredPermission?:'player'|'gm'} = {}) {
    const targets = [...new Set((recipients || [String(request.actor.id || "")]).map(String).filter(id=>request.members.some(member=>member.id===id)&&request.allows('player',id)))]
    if (!targets.length) throw new Error("没有找到可接收私密结果的成员")
    ruleState.privateDeliveries ||= []
    const privateMessages = targets.map(userId => {
      const deliveryId = `${auditId}:${userId}`
      const message = {
        deliveryId,
        userId,
        text: `【${pack.name}私密结果】\n${privateText}\n审计编号：${auditId}`,
        createdAt: this.iso,
        attempts: 0,
        lastError: "",
        requiredPermission,
        ...(request.privateOrigin?{origin:readAgentDicePrivateOrigin(request.privateOrigin)}:{}),
        // A returned intent may be dispatched after this draft commits. Until the
        // host settles that exact delivery, another source cannot replay it.
        state: "unknown" as const
      }
      ruleState.privateDeliveries.push(message)
      return { deliveryId, userId, text: message.text,requiredPermission,...(request.privateOrigin?{origin:readAgentDicePrivateOrigin(request.privateOrigin)}:{}) }
    })
    if (ruleState.privateDeliveries.length > MAX_PRIVATE_DELIVERIES) {
      ruleState.privateDeliveries.splice(0, ruleState.privateDeliveries.length - MAX_PRIVATE_DELIVERIES)
    }
    return { text: sanitizeRuleOutput(publicText), privateMessages, auditId, packId: pack.id }
  }

  async settlePrivateDeliveries(groupId:string|number|undefined, packId:string, outcomes:{deliveryId:string;ok:boolean;state?:"sent"|"failed"|"unknown";error?:string}[] = []) {
    if (!groupId || !packId || !outcomes.length) return
    const config = this.config
    await (async () => {
      const state = this.state
      const ruleState = state.packs[packId]?.group
      if (!ruleState?.privateDeliveries) return
      const outcomeMap = new Map(outcomes.map(item => [item.deliveryId, item]))
      ruleState.privateDeliveries = ruleState.privateDeliveries.filter(delivery => {
        const outcome = outcomeMap.get(delivery.deliveryId)
        if (!outcome) return true
        const outcomeState=outcome.state||(outcome.ok?"sent":"failed")
        if (outcomeState==="sent") return false
        delivery.state=outcomeState
        delivery.attempts = (Number(delivery.attempts) || 0) + 1
        delivery.lastAttemptAt = this.iso
        delivery.lastError = String(outcome.error || "私聊发送失败").slice(0, 200)
        return true
      })
      await Promise.resolve()
    })()
  }

  async handleDeliveryOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    requireRulePermission(request, ruleState, "gm")
    const action = String(parseQuotedTokens(raw).shift() || "status").toLowerCase()
    const pending = ruleState.privateDeliveries || []
    const gmRecipients=new Set(await getRuleGmRecipients(request,ruleState))
    const retryable=pending.filter(item=>item.state==='failed'&&(!request.privateOrigin||record(item).origin!==undefined)&&request.members.some(member=>member.id===item.userId)&&request.allows('player',item.userId)&&
      (record(item).requiredPermission==='player'||gmRecipients.has(item.userId)))
    const unknownCount=pending.length-retryable.length
    if (["status", "list", "状态", "列表"].includes(action)) return `待重试私密投递：${retryable.length} 条；待核实或授权未满足：${unknownCount} 条（禁止重复发送）。重试：.${pack.id} 投递 重试`
    if (["retry", "重试"].includes(action)) {
      if (!retryable.length) return unknownCount?"私密投递结果或当前接收授权待核实，为避免重复发送已禁止重放。":"当前没有待重试的私密结果。"
      const privateMessages = retryable.slice(0, 20).map(item => {
        const origin=record(item).origin
        item.state='unknown'
        return { deliveryId: item.deliveryId, userId: item.userId, text: item.text,requiredPermission:record(item).requiredPermission==='player'?'player' as const:'gm' as const,
          ...(origin===undefined?{}:{origin:readAgentDicePrivateOrigin(origin)}) }
      })
      return { text: `正在重试 ${privateMessages.length} 条私密结果；失败项会继续保留。`, privateMessages, packId: pack.id }
    }
    throw new Error("投递命令：投递 状态 / 投递 重试")
  }

  async runRuleEvent(pack:RulePack, eventName:string, runtime:RuleRuntime) {
    await this.applyActionList(pack, pack.events?.[eventName] || [], runtime)
  }

  async tickActorStatuses(pack:RulePack, tick:string, runtime:RuleRuntime) {
    const statuses = runtime.actorDraft.stored.statuses ||= {}
    for (const [statusId, currentValue] of Object.entries({ ...statuses })) {
      const definition = pack.statuses?.[statusId]
      if (!definition || (definition.tick || "manual") !== tick) continue
      let current = { ...currentValue }
      if (definition.on_tick?.length) await this.applyActionList(pack, definition.on_tick, runtime, 0, { status: { id: statusId, ...current } })
      if (!statuses[statusId]) continue
      current = { ...statuses[statusId] }
      if (current.duration !== null && current.duration !== undefined) current.duration = Math.max(0, Number(current.duration) - 1)
      if (current.duration === 0) {
        if (definition.on_expire?.length) await this.applyActionList(pack, definition.on_expire, runtime, 0, { status: { id: statusId, ...current } })
        delete statuses[statusId]
        runtime.auditActions.push({ op: "expire_status", scope: "actor", target: sanitizeAuditValue(runtime.actorDraft.actor), field: statusId, before: currentValue, after: null })
      } else statuses[statusId] = current
    }
    this.refreshRuleContext(pack, runtime)
  }

  tickActorAbilities(pack:RulePack, runtime:RuleRuntime) {
    const abilities = runtime.actorDraft.stored.abilities ||= {}
    for (const [abilityId, currentValue] of Object.entries(abilities)) {
      const before = Math.max(0, Number(currentValue.cooldown) || 0)
      if (before < 1) continue
      currentValue.cooldown = before - 1
      runtime.auditActions.push({
        op: "ability_cooldown",
        scope: "actor",
        target: sanitizeAuditValue(runtime.actorDraft.actor),
        field: abilityId,
        before,
        after: currentValue.cooldown
      })
    }
    runtime.actorDraft.abilities = this.buildAbilityContext(pack, runtime.actorDraft.stored)
    this.refreshRuleContext(pack, runtime)
  }

  async finishBuiltinMutation(request:AgentDiceRuleContext, pack:RulePack, state:AgentDiceRulesState, ruleState:RuleGroupState, runtime:RuleRuntime, command:string, text:string, options:{logState?:AgentDiceRulesState} = {}) {
    return await this.finishBuiltinBatch(request, pack, state, ruleState, [runtime], command, text, options)
  }

  async finishBuiltinBatch(request:AgentDiceRuleContext, pack:RulePack, state:AgentDiceRulesState, ruleState:RuleGroupState, runtimes:RuleRuntime[], command:string, text:string, options:{logState?:AgentDiceRulesState} = {}) {
    for (const runtime of runtimes) this.commitLifecycleRuntime(pack, runtime)
    const auditId = this.auditId()
    this.appendRuleAudit(ruleState, {
      id: auditId,
      at: this.iso,
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command,
      visibility: "public",
      invoker: { id: String(request.actor.id || ""), name: request.actor.name || request.actor.name || String(request.actor.id || "") },
      targets: runtimes.map(runtime => ({ kind: runtime.actorDraft.actor.kind, id: runtime.actorDraft.actor.id, name: runtime.actorDraft.actor.name })),
      seed: runtimes.map(runtime => runtime.randomSeed).join(","),
      actions: runtimes.flatMap(runtime => runtime.auditActions),
      output: text
    })
    const config = this.config
    await Promise.resolve()
    await this.recordEvent(request, { content: text, auditId, packId: pack.id, command, visibility: "public" }, options.logState || state, config)

    return text
  }

  ensureActiveCampaign(request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState) {
    ruleState.campaigns ||= {}
    let id = ruleState.activeCampaignId
    const active = id ? ruleState.campaigns[id] : undefined
    if (active && active.status !== "archived") return active
    id = "default"
    ruleState.campaigns[id] ||= {
      id,
      name: `${pack.name} 默认战役`,
      status: "active",
      createdAt: this.iso,
      createdBy: String(request.actor.id || ""),
      members: {},
      chapters: [],
      records: [],
      sessions: []
    }
    ruleState.activeCampaignId = id
    return ruleState.campaigns[id]!
  }

  formatCampaign(campaign:RuleCampaign|undefined) {
    if (!campaign) return "当前没有选中的战役。"
    const chapter = [...(campaign.chapters || [])].reverse().find(item => !item.endedAt)
    return [
      `战役：${campaign.name}（${campaign.id}）`,
      `状态：${campaign.status || "active"}；当前章节：${chapter?.title || "无"}`,
      `登记角色：${Object.keys(campaign.members || {}).length}；场次：${(campaign.sessions || []).length}；记录：${(campaign.records || []).length}`
    ].join("\n")
  }

  async handleCampaignOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "status").toLowerCase()
    if (["list", "列表"].includes(action)) {
      const rows = Object.values(ruleState.campaigns || {}).map(item => `${item.id}：${item.name} [${item.status || "active"}]${ruleState.activeCampaignId === item.id ? " [当前]" : ""}`)
      return `战役列表：\n${rows.join("\n") || "暂无；创建：战役 创建 <id> <名称>"}`
    }
    if (["status", "show", "状态", "查看"].includes(action)) return this.formatCampaign(ruleState.campaigns?.[ruleState.activeCampaignId])
    if (["register", "join", "登记", "加入"].includes(action)) {
      const campaign = this.ensureActiveCampaign(request, pack, ruleState)
      const selector = tokens.shift() || "self"
      const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member"])
      if (!actor.self) requireRulePermission(request, ruleState, "gm")
      const character = tokens.join(" ").trim().slice(0, 80) || actor.name
      campaign.members[actor.id] = { userId: actor.id, name: actor.name, character, joinedAt: this.iso }
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_register", `已登记：${actor.name} → ${character}`, { targets: [actor], actions: [{ op: "register_character", target: actor.id, value: character }] })
    }
    requireRulePermission(request, ruleState, "gm")
    if (["create", "new", "创建", "新建"].includes(action)) {
      const id = String(tokens.shift() || "").toLowerCase()
      const name = tokens.join(" ").trim()
      if (!/^[a-z][a-z0-9_-]{1,47}$/.test(id)) throw new Error("战役 ID 必须以小写字母开头，只含小写字母、数字、下划线或连字符")
      if (!name) throw new Error("格式：战役 创建 <id> <名称>")
      if (ruleState.campaigns[id]) throw new Error(`战役已存在：${id}`)
      ruleState.campaigns[id] = { id, name: name.slice(0, 80), status: "active", createdAt: this.iso, createdBy: String(request.actor.id || ""), members: {}, chapters: [], records: [], sessions: [] }
      ruleState.activeCampaignId = id
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_create", `已创建并选中战役：${name.slice(0, 80)}（${id}）`, { actions: [{ op: "create_campaign", target: id }] })
    }
    if (["use", "select", "使用", "选择", "切换"].includes(action)) {
      const id = String(tokens.shift() || "")
      const campaign = ruleState.campaigns?.[id]
      if (!campaign) throw new Error(`战役不存在：${id}`)
      if (campaign.status === "archived") throw new Error(`战役 ${id} 已归档；请先恢复`)
      if (ruleState.session.active) throw new Error("当前场次进行中，不能切换战役")
      ruleState.activeCampaignId = id
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_select", `已切换到战役：${campaign.name}（${id}）`, { actions: [{ op: "select_campaign", target: id }] })
    }
    let campaign = this.ensureActiveCampaign(request, pack, ruleState)
    if (["chapter", "章节"].includes(action)) {
      const operation = String(tokens.shift() || "list").toLowerCase()
      campaign.chapters ||= []
      if (["list", "列表"].includes(operation)) return `章节：\n${campaign.chapters.map((item, index) => `${index + 1}. ${item.title}${item.endedAt ? " [已结束]" : " [进行中]"}`).join("\n") || "无"}`
      if (["start", "new", "开始", "新建"].includes(operation)) {
        if (campaign.chapters.some(item => !item.endedAt)) throw new Error("已有进行中的章节，请先结束")
        const title = tokens.join(" ").trim().slice(0, 100)
        if (!title) throw new Error("格式：战役 章节 开始 <标题>")
        const chapter = { id: `chapter-${this.auditId().slice(0,20)}`, title, startedAt: this.iso, startedBy: String(request.actor.id || ""), endedAt: "" }
        campaign.chapters.push(chapter)
        return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_chapter_start", `章节已开始：${title}`, { actions: [{ op: "start_chapter", target: chapter.id }] })
      }
      if (["end", "stop", "结束"].includes(operation)) {
        const chapter = [...campaign.chapters].reverse().find(item => !item.endedAt)
        if (!chapter) throw new Error("当前没有进行中的章节")
        chapter.endedAt = this.iso
        return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_chapter_end", `章节已结束：${chapter.title}`, { actions: [{ op: "end_chapter", target: chapter.id }] })
      }
      throw new Error("章节命令：战役 章节 列表 / 开始 <标题> / 结束")
    }
    if (["record", "note", "记录", "线索", "手记"].includes(action)) {
      const type = action === "线索" ? "clue" : action === "手记" ? "note" : String(tokens.shift() || "note").toLowerCase()
      if (!new Set(["note", "clue", "file", "link"]).has(type)) throw new Error("记录类型支持 note、clue、file、link")
      const content = tokens.join(" ").trim().slice(0, 1000)
      if (!content) throw new Error("格式：战役 记录 <note|clue|file|link> <内容>")
      const record = { id: `record-${this.auditId().slice(0,20)}`, type, content, at: this.iso, by: String(request.actor.id || "") }
      campaign.records ||= []
      campaign.records.push(record)
      if (campaign.records.length > 500) campaign.records.splice(0, campaign.records.length - 500)
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "campaign_record", `已记录${type === "clue" ? "线索" : type === "file" ? "文件" : type === "link" ? "链接" : "手记"}：${content}`, { actions: [{ op: "add_campaign_record", target: record.id, value: type }] })
    }
    if (["archive", "归档", "restore", "恢复"].includes(action)) {
      const restore = ["restore", "恢复"].includes(action)
      const targetId = String(tokens.shift() || campaign.id)
      const targetCampaign = ruleState.campaigns?.[targetId]
      if (!targetCampaign) throw new Error(`战役不存在：${targetId}`)
      if (!restore && ruleState.session.active) throw new Error("当前场次进行中，不能归档战役")
      campaign = targetCampaign
      campaign.status = restore ? "active" : "archived"
      if (!restore && ruleState.activeCampaignId === campaign.id) ruleState.activeCampaignId = ""
      if (restore) ruleState.activeCampaignId = campaign.id
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, restore ? "campaign_restore" : "campaign_archive", `战役已${restore ? "恢复" : "归档"}：${campaign.name}`, { actions: [{ op: restore ? "restore_campaign" : "archive_campaign", target: campaign.id }] })
    }
    throw new Error("战役命令：列表 / 创建 <id> <名称> / 使用 <id> / 登记 <目标> [角色名] / 章节 / 记录 / 归档 / 恢复")
  }

  formatSessionStatus(ruleState:RuleGroupState) {
    const session = ruleState.session
    const current = session.current ? `${session.current.name}（${session.current.kind}:${session.current.id}）` : "无"
    return [
      `团务：${session.active ? "进行中" : "未开始"}`,
      `战役：${session.campaignId || ruleState.activeCampaignId || "未选择"}；暂停：${session.paused ? "是" : "否"}`,
      `标题：${session.title || "未命名"}`,
      `轮次：${session.round || 0}；回合：${session.turn || 0}；阶段：${session.phase || "idle"}`,
      `当前行动者：${current}`,
      `先攻项：${session.initiative.length}；历史场次：${ruleState.sessions?.length || 0}；快照：${ruleState.snapshots?.length || 0}`
    ].join("\n")
  }

  createSessionSnapshot(_state:AgentDiceRulesState, request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, name=''):RuleSnapshot {
    return {id:`snapshot-${this.auditId()}`,name:name.trim().slice(0,80)||`快照 ${this.iso}`,createdAt:this.iso,createdBy:request.actor.id,
      group:cloneJson(ruleState.group),npcs:cloneJson(ruleState.npcs),session:cloneJson(ruleState.session),players:cloneJson(this.packState(pack).players)}
  }
  restoreSessionSnapshot(_state:AgentDiceRulesState, _request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, snapshot:RuleSnapshot) {
    ruleState.group=cloneJson(snapshot.group);ruleState.npcs=cloneJson(snapshot.npcs);ruleState.session=cloneJson(snapshot.session)
    this.packState(pack).players=cloneJson(snapshot.players)
  }

  async handleSessionOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "status").toLowerCase()
    if (["status", "show", "状态", "查看"].includes(action)) return this.formatSessionStatus(ruleState)
    if (["history", "历史", "场次"].includes(action)) {
      const rows = [...(ruleState.sessions || [])].reverse().slice(0, 20).map((item, index) => `${index + 1}. ${item.title || "未命名"}｜${item.startedAt || ""} → ${item.endedAt || ""}｜战役 ${item.campaignId || "default"}`)
      return `历史场次：\n${rows.join("\n") || "暂无"}`
    }
    requireRulePermission(request, ruleState, "gm")
    if (["pause", "暂停"].includes(action)) {
      if (!ruleState.session.active) throw new Error("当前没有进行中的团务")
      if (ruleState.session.paused) throw new Error("团务已经暂停")
      ruleState.session.previousPhase = ruleState.session.phase || "setup"
      ruleState.session.paused = true
      ruleState.session.phase = "paused"
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "session_pause", `团务已暂停：${ruleState.session.title || "未命名"}`, { actions: [{ op: "pause_session" }] })
    }
    if (["resume", "恢复", "继续"].includes(action)) {
      if (!ruleState.session.active || !ruleState.session.paused) throw new Error("当前没有暂停中的团务")
      ruleState.session.paused = false
      ruleState.session.phase = ruleState.session.previousPhase || (ruleState.session.current ? "turn_start" : "setup")
      delete ruleState.session.previousPhase
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "session_resume", `团务已恢复：${ruleState.session.title || "未命名"}`, { actions: [{ op: "resume_session" }] })
    }
    if (["snapshot", "快照"].includes(action)) {
      const snapshot = this.createSessionSnapshot(state, request, pack, ruleState, tokens.join(" "))
      ruleState.snapshots ||= []
      ruleState.snapshots.push(snapshot)
      if (ruleState.snapshots.length > 10) ruleState.snapshots.splice(0, ruleState.snapshots.length - 10)
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "session_snapshot", `已创建团务快照：${snapshot.name}（${snapshot.id}）`, { actions: [{ op: "create_snapshot", target: snapshot.id }] })
    }
    if (["restore-snapshot", "回退", "恢复快照"].includes(action)) {
      if (ruleState.session.active && !ruleState.session.paused) throw new Error("进行中的团务必须先暂停，才能回退快照")
      const selector = String(tokens.shift() || "1")
      const snapshots = [...(ruleState.snapshots || [])].reverse()
      const snapshot = /^\d+$/.test(selector) ? snapshots[Number(selector) - 1] : snapshots.find(item => item.id === selector || item.name === selector)
      if (!snapshot) throw new Error(`没有找到快照：${selector}`)
      this.restoreSessionSnapshot(state, request, pack, ruleState, snapshot)
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "session_restore_snapshot", `已回退到团务快照：${snapshot.name}`, { actions: [{ op: "restore_snapshot", target: snapshot.id }] })
    }
    const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, selfActor(request))
    if (["start", "new", "开始", "新建"].includes(action)) {
      if (ruleState.session.active) throw new Error(`团务已经开始：${ruleState.session.title || "未命名"}`)
      const campaign = this.ensureActiveCampaign(request, pack, ruleState)
      let logMessage='当前已有团录或归属尚未确认，结束团务时不会自动停止它。'
      ruleState.session.logOwned=request.logActive===false
      if(request.logActive===false){
        const ownershipId=sha(['agent-dice-log:v1',pack.id,request.privateOrigin?.operationId??request.source.messageId,request.groupId,request.source.authorId])
        record(ruleState.session).logOwnershipId=ownershipId
        this.effects.push({kind:'log',operation:'start',ownershipId,title:tokens.join(' ').trim()||pack.name})
        logMessage='团录开启请求已随本次团务产生；实际效果由宿主确认。'
      }else delete record(ruleState.session).logOwnershipId
      ruleState.session.active = true
      ruleState.session.campaignId = campaign.id
      ruleState.session.paused = false
      ruleState.session.title = tokens.join(" ").trim().slice(0, 80) || `${pack.name}-${this.iso.slice(0, 10)}`
      ruleState.session.startedAt = this.iso
      ruleState.session.startedBy = String(request.actor.id || "")
      ruleState.session.endedAt = ""
      ruleState.session.round = 0
      ruleState.session.turn = 0
      ruleState.session.phase = "setup"
      ruleState.session.current = null
      ruleState.session.initiative = []
      await this.runRuleEvent(pack, "session_start", runtime)
      const text = `团务已开始：${ruleState.session.title}`
      await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "session_start", text)
      return `${text}\n${logMessage}`
    }
    if (["end", "stop", "结束", "停止"].includes(action)) {
      if (!ruleState.session.active) throw new Error("当前没有进行中的团务")
      await this.runRuleEvent(pack, "session_end", runtime)
      const title = ruleState.session.title || "未命名"
      const ownershipId=record(ruleState.session).logOwnershipId
      const ownedLog = ruleState.session.logOwned === true&&typeof ownershipId==='string'&&/^[a-f0-9]{64}$/u.test(ownershipId)
      let logMessage='已有团录保持开启。'
      if(ownedLog){this.effects.push({kind:'log',operation:'stop',ownershipId:ownershipId as string});logMessage='本次团务创建的团录停止请求已产生。'}
      ruleState.session.active = false
      ruleState.session.endedAt = this.iso
      ruleState.session.phase = "ended"
      ruleState.session.current = null
      ruleState.sessions ||= []
      const sessionRecord = {
        ...cloneJson(ruleState.session),
        id: `session-${this.auditId().slice(0,20)}`,
        title,
        campaignId: ruleState.session.campaignId || ruleState.activeCampaignId || "default",
        startedAt: ruleState.session.startedAt || "",
        endedAt: ruleState.session.endedAt,
        startedBy: ruleState.session.startedBy || "",
        logFile: ruleState.session.logFile || "",
        initiative: [...(ruleState.session.initiative || [])]
      }
      ruleState.sessions.push(sessionRecord)
      const campaign = ruleState.campaigns?.[sessionRecord.campaignId]
      if (campaign) {
        campaign.sessions ||= []
        campaign.sessions.push(sessionRecord.id)
      }
      if (ruleState.sessions.length > 50) ruleState.sessions.splice(0, ruleState.sessions.length - 50)
      const text = `团务已结束：${title}`
      await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "session_end", text)
      return `${text}\n${logMessage}`
    }
    throw new Error("团务命令：状态 / 开始 [标题] / 暂停 / 恢复 / 快照 [名称] / 回退 <序号|ID> / 历史 / 结束")
  }

  initiativeActor(entry:RuleSession["initiative"][number]) {
    return { kind: entry.kind, id: String(entry.id), name: entry.name || String(entry.id), role: entry.role || (entry.kind === "npc" ? "npc" : "member"), self: false }
  }

  formatInitiative(ruleState:RuleGroupState) {
    const session = ruleState.session
    if (!session.initiative.length) return "当前先攻列表为空。"
    return [
      `第 ${session.round || 0} 轮 / 回合 ${session.turn || 0}`,
      ...session.initiative.map((item, index) => `${session.current?.kind === item.kind && String(session.current?.id) === String(item.id) ? "→" : "  "}${index + 1}. ${item.name} ${item.value}`)
    ].join("\n")
  }

  getOrCreateLifecycleRuntime(runtimes:RuleRuntime[], state:AgentDiceRulesState, request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, actor:RuleActor, sharedGroupStored:RuleStored) {
    const key = actorStorageKey(actor)
    const existing = runtimes.find(runtime => runtime.actorDraft.key === key)
    if (existing) return existing
    const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, actor, sharedGroupStored)
    runtimes.push(runtime)
    return runtime
  }

  async tickInitiativeStatuses(state:AgentDiceRulesState, request:AgentDiceRuleContext, pack:RulePack, ruleState:RuleGroupState, tick:string, sharedGroupStored:RuleStored, runtimes:RuleRuntime[]) {
    const seen = new Set()
    for (const entry of ruleState.session.initiative) {
      const actor = this.initiativeActor(entry)
      const key = actorStorageKey(actor)
      if (seen.has(key)) continue
      seen.add(key)
      const runtime = this.getOrCreateLifecycleRuntime(runtimes, state, request, pack, ruleState, actor, sharedGroupStored)
      await this.tickActorStatuses(pack, tick, runtime)
    }
  }

  async handleInitiativeOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) return this.formatInitiative(ruleState)
    requireRulePermission(request, ruleState, "gm")
    if (["add", "set", "添加", "设置"].includes(action)) {
      const selector = tokens.shift()
      const value = Number(tokens.shift())
      if (!selector || !Number.isFinite(value)) throw new Error("格式：先攻 添加 <目标> <数值>")
      const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member", "npc"])
      const item = { kind: actor.kind, id: actor.id, name: actor.name, role: actor.role, value }
      const index = ruleState.session.initiative.findIndex(old => old.kind === item.kind && String(old.id) === String(item.id))
      if (index >= 0) ruleState.session.initiative[index] = item
      else ruleState.session.initiative.push(item)
      const result = `已设置先攻：${actor.name} ${value}`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "initiative_set", result, {
        targets: [actor], actions: [{ op: "set_initiative", target: actor.id, value }]
      })
    }
    if (["remove", "delete", "del", "删除"].includes(action)) {
      const actor = await resolveRuleActor(request, tokens.shift(), ruleState, ["self", "member", "npc"])
      if (ruleState.session.current?.kind === actor.kind && String(ruleState.session.current?.id) === String(actor.id)) {
        throw new Error("当前行动者正在回合中，不能直接删除；请先执行下一回合或结束先攻")
      }
      const before = ruleState.session.initiative.length
      ruleState.session.initiative = ruleState.session.initiative.filter(item => !(item.kind === actor.kind && String(item.id) === String(actor.id)))
      if (before === ruleState.session.initiative.length) throw new Error(`${actor.name} 不在先攻列表中`)
      const result = `已从先攻列表移除：${actor.name}`
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "initiative_remove", result, {
        targets: [actor], actions: [{ op: "remove_initiative", target: actor.id }]
      })
    }
    if (["clear", "清空"].includes(action)) {
      if (ruleState.session.current) throw new Error("战斗正在进行，不能直接清空先攻；请先结束先攻")
      const removed = ruleState.session.initiative.map(item => this.initiativeActor(item))
      ruleState.session.initiative = []
      ruleState.session.current = null
      ruleState.session.round = 0
      ruleState.session.turn = 0
      ruleState.session.phase = ruleState.session.active ? "setup" : "idle"
      return await this.finishDirectBuiltinMutation(request, pack, state, ruleState, "initiative_clear", "先攻列表已清空。", {
        targets: removed, actions: [{ op: "clear_initiative", count: removed.length }]
      })
    }
    if (["start", "开始"].includes(action)) {
      if (!ruleState.session.initiative.length) throw new Error("先攻列表为空")
      if (!ruleState.session.active) throw new Error("正式团务尚未开始；请先执行「团务 开始 标题」")
      if (ruleState.session.paused) throw new Error("团务已暂停；请先执行「团务 恢复」")
      if (ruleState.session.current || ["turn_start", "turn_end", "round_start", "round_end"].includes(ruleState.session.phase)) {
        throw new Error("战斗先攻已经开始，重复开始会重复结算生命周期；请使用「先攻 下一回合」或先结束")
      }
      ruleState.session.initiative.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "zh-CN"))
      ruleState.session.round = 1
      ruleState.session.turn = 1
      ruleState.session.phase = "turn_start"
      ruleState.session.current = { ...ruleState.session.initiative[0]! }
      const shared = this.buildGroupStored(pack, ruleState, { card: request.actor.name || "", nickname: request.actor.name || "" })
      const runtimes:RuleRuntime[] = []
      const currentRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, request, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      await this.runRuleEvent(pack, "round_start", currentRuntime)
      await this.tickInitiativeStatuses(state, request, pack, ruleState, "round_start", shared, runtimes)
      await this.runRuleEvent(pack, "turn_start", currentRuntime)
      this.tickActorAbilities(pack, currentRuntime)
      await this.tickActorStatuses(pack, "turn_start", currentRuntime)
      const text = `战斗开始。第 1 轮，${ruleState.session.current.name} 行动。`
      return await this.finishBuiltinBatch(request, pack, state, ruleState, runtimes, "initiative_start", text)
    }
    if (["next", "下一位", "下一个", "下一回合"].includes(action)) {
      if (!ruleState.session.current || !ruleState.session.initiative.length) throw new Error("战斗尚未开始")
      if (ruleState.session.paused) throw new Error("团务已暂停；请先执行「团务 恢复」")
      const shared = this.buildGroupStored(pack, ruleState, { card: request.actor.name || "", nickname: request.actor.name || "" })
      const runtimes:RuleRuntime[] = []
      const currentActor = ruleState.session.current
      const currentIndex = ruleState.session.initiative.findIndex(item => item.kind === currentActor.kind && String(item.id) === String(currentActor.id))
      const oldRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, request, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      ruleState.session.phase = "turn_end"
      await this.runRuleEvent(pack, "turn_end", oldRuntime)
      await this.tickActorStatuses(pack, "turn_end", oldRuntime)
      const wrapped = currentIndex < 0 || currentIndex >= ruleState.session.initiative.length - 1
      if (wrapped) {
        ruleState.session.phase = "round_end"
        await this.runRuleEvent(pack, "round_end", oldRuntime)
        await this.tickInitiativeStatuses(state, request, pack, ruleState, "round_end", shared, runtimes)
        ruleState.session.round = Math.max(1, Number(ruleState.session.round) || 1) + 1
      }
      const nextIndex = wrapped ? 0 : currentIndex + 1
      ruleState.session.turn = Math.max(0, Number(ruleState.session.turn) || 0) + 1
      ruleState.session.current = { ...ruleState.session.initiative[nextIndex]! }
      const nextRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, request, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      if (wrapped) {
        ruleState.session.phase = "round_start"
        await this.runRuleEvent(pack, "round_start", nextRuntime)
        await this.tickInitiativeStatuses(state, request, pack, ruleState, "round_start", shared, runtimes)
      }
      ruleState.session.phase = "turn_start"
      await this.runRuleEvent(pack, "turn_start", nextRuntime)
      this.tickActorAbilities(pack, nextRuntime)
      await this.tickActorStatuses(pack, "turn_start", nextRuntime)
      const text = `${wrapped ? `第 ${ruleState.session.round} 轮开始。` : ""}${ruleState.session.current.name} 行动。`
      return await this.finishBuiltinBatch(request, pack, state, ruleState, runtimes, "initiative_next", text)
    }
    if (["end", "stop", "结束"].includes(action)) {
      ruleState.session.current = null
      ruleState.session.phase = ruleState.session.active ? "setup" : "idle"
      const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, selfActor(request))
      return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "initiative_end", "战斗先攻已结束，列表仍保留。")
    }
    throw new Error("先攻命令：先攻 列表 / 添加 <目标> <值> / 删除 <目标> / 开始 / 下一回合 / 结束 / 清空")
  }

  formatActorStatuses(pack:RulePack, draft:RuleDraft) {
    const rows = Object.entries(draft.stored.statuses || {}).map(([id, value]) => {
      const definition = pack.statuses?.[id]
      return `${definition?.label || id}(${id})：层数 ${value.stacks || 1}，持续 ${value.duration ?? "永久"}`
    })
    return `${draft.actor.name} 的状态：\n${rows.join("\n") || "无"}`
  }

  async handleStatusOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const selector = tokens.shift() || "self"
      const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member", "npc"])
      const draft = this.getEntityDraft(state, request, pack, ruleState, actor)
      return this.formatActorStatuses(pack, draft)
    }
    requireRulePermission(request, ruleState, "gm")
    const selector = tokens.shift()
    if (!selector) throw new Error("请指定目标")
    const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member", "npc"])
    const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, actor)
    if (["add", "添加", "施加"].includes(action)) {
      const status = tokens.shift() || ""
      if (!pack.statuses?.[status]) throw new Error(`未知状态：${status || ""}`)
      const duration = tokens[0] === undefined ? undefined : Number(tokens.shift())
      const stacks = tokens[0] === undefined ? undefined : Number(tokens.shift())
      if (duration !== undefined && (!Number.isInteger(duration) || duration < 1)) throw new Error("持续时间必须是正整数")
      if (stacks !== undefined && (!Number.isInteger(stacks) || stacks < 1)) throw new Error("层数必须是正整数")
      await this.applyActionList(pack, [{ op: "add_status", status, ...(duration === undefined ? {} : { duration }), ...(stacks === undefined ? {} : { stacks }) }], runtime)
      const current = runtime.actorDraft.stored.statuses?.[status]
      if (!current) throw new Error(`状态施加失败：${status}`)
      const text = `已给 ${actor.name} 添加状态 ${pack.statuses[status]!.label || status}：层数 ${current.stacks}，持续 ${current.duration ?? "永久"}`
      return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "status_add", text)
    }
    if (["remove", "delete", "删除", "解除"].includes(action)) {
      const status = tokens.shift() || ""
      if (!runtime.actorDraft.stored.statuses?.[status]) throw new Error(`${actor.name} 没有状态 ${status || ""}`)
      await this.applyActionList(pack, [{ op: "remove_status", status }], runtime)
      const text = `已移除 ${actor.name} 的状态 ${pack.statuses?.[status]?.label || status}`
      return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "status_remove", text)
    }
    if (["tick", "结算", "推进"].includes(action)) {
      await this.tickActorStatuses(pack, "manual", runtime)
      const text = `已结算 ${actor.name} 的手动状态。\n${this.formatActorStatuses(pack, runtime.actorDraft)}`
      return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, "status_tick", text)
    }
    throw new Error("状态命令：状态 列表 [目标] / 添加 <目标> <状态> [持续] [层数] / 删除 <目标> <状态> / 结算 <目标>")
  }

  formatActorInventory(pack:RulePack, draft:RuleDraft) {
    const rows = Object.entries(draft.stored.inventory || {}).filter(([, value]) => Number(value.quantity) > 0).map(([id, value]) => {
      const definition = pack.items?.[id]
      return `${definition?.label || id}(${id}) x${value.quantity}${value.equipped ? ` [已装备${definition?.slot ? `:${definition?.slot}` : ""}]` : ""}`
    })
    return `${draft.actor.name} 的物品：\n${rows.join("\n") || "无"}`
  }

  async handleItemOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const actor = await resolveRuleActor(request, tokens.shift() || "self", ruleState, ["self", "member", "npc"])
      return this.formatActorInventory(pack, this.getEntityDraft(state, request, pack, ruleState, actor))
    }
    const selector = tokens.shift()
    const item = tokens.shift() || ""
    if (!selector || !pack.items?.[item]) throw new Error("请指定有效目标和物品 ID")
    const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member", "npc"])
    const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, actor)
    const operations:Record<string,string> = { add: "add_item", 添加: "add_item", remove: "remove_item", delete: "remove_item", 删除: "remove_item", equip: "equip", 装备: "equip", unequip: "unequip", 卸下: "unequip", use: "use_item", 使用: "use_item" }
    const operation = operations[action]
    if (!operation) throw new Error("物品命令：物品 列表 [目标] / 添加 <目标> <物品> [数量] / 删除 / 装备 / 卸下 / 使用")
    if (!actor.self || ["add_item", "remove_item"].includes(operation)) requireRulePermission(request, ruleState, "gm")
    const quantity = tokens[0] === undefined ? undefined : Number(tokens.shift())
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) throw new Error("数量必须是正整数")
    const definition = pack.items[item]!
    if (operation === "use_item") {
      const current = runtime.actorDraft.stored.inventory?.[item]
      if (!current || Number(current.quantity) < 1) throw new Error(`没有可使用的 ${definition?.label || item}`)
      if (definition.on_use?.length) await this.applyActionList(pack, definition.on_use, runtime)
      if (definition.consumable === true) await this.applyActionList(pack, [{ op: "remove_item", item, quantity: 1 }], runtime)
      runtime.auditActions.push({ op: "use_item", scope: "actor", target: sanitizeAuditValue(actor), field: item, before: current.quantity, after: definition.consumable === true ? current.quantity - 1 : current.quantity })
    } else {
      const beforeEquipped = runtime.actorDraft.stored.inventory?.[item]?.equipped === true
      if (operation === "equip" && beforeEquipped) throw new Error(`${definition?.label || item} 已经装备`)
      if (operation === "unequip" && !beforeEquipped) throw new Error(`${definition?.label || item} 尚未装备`)
      await this.applyActionList(pack, [{ op: operation, item, ...(quantity === undefined ? {} : { quantity }) }], runtime)
      const hook = operation === "equip" ? definition.on_equip : operation === "unequip" ? definition.on_unequip : null
      if (hook?.length) await this.applyActionList(pack, hook, runtime)
    }
    const text = `${actor.name}：${operation === "add_item" ? "获得" : operation === "remove_item" ? "失去" : operation === "equip" ? "装备" : operation === "unequip" ? "卸下" : "使用"} ${definition?.label || item}${quantity ? ` x${quantity}` : ""}`
    return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, `item_${operation}`, text)
  }

  formatActorAbilities(pack:RulePack, draft:RuleDraft) {
    const rows = Object.entries(draft.stored.abilities || {}).filter(([, value]) => value.learned).map(([id, value]) => {
      const definition = pack.abilities?.[id]
      return `${definition?.label || id}(${id})：等级 ${value.rank || 1}，冷却 ${value.cooldown || 0}，使用 ${value.uses || 0} 次${definition?.kind === "spell" ? " [法术]" : " [技能]"}`
    })
    return `${draft.actor.name} 的技能/法术：\n${rows.join("\n") || "无"}`
  }

  async handleAbilityOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const config = this.config
    const state = this.state
    const ruleState = this.packState(pack).group
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const actor = await resolveRuleActor(request, tokens.shift() || "self", ruleState, ["self", "member", "npc"])
      return this.formatActorAbilities(pack, this.getEntityDraft(state, request, pack, ruleState, actor))
    }
    let selector = "self"
    let ability
    if (["use", "cast", "使用", "施放"].includes(action) && tokens.length === 1) ability = tokens.shift()
    else {
      selector = tokens.shift() || "self"
      ability = tokens.shift()
    }
    if (!ability || !pack.abilities?.[ability]) throw new Error(`未知技能或法术：${ability || ""}`)
    const actor = await resolveRuleActor(request, selector, ruleState, ["self", "member", "npc"])
    const useAction = ["use", "cast", "使用", "施放"].includes(action)
    const definition = pack.abilities[ability]!
    const resourceFields = definition.resource_scope === "group" ? pack.group?.fields : pack.character?.fields
    const secretResource = definition.resource_field && resourceFields?.[definition.resource_field]?.secret === true
    if (!useAction || !actor.self || secretResource) requireRulePermission(request, ruleState, "gm")
    const runtime = this.createLifecycleRuntime(state, request, pack, ruleState, actor)
    const operation = useAction ? "use_ability" : ["learn", "学习"].includes(action) ? "learn_ability" : ["forget", "遗忘"].includes(action) ? "forget_ability" : ["reset", "重置"].includes(action) ? "reset_ability" : ""
    if (!operation) throw new Error("技能命令：技能 列表 [目标] / 学习 <目标> <能力> [等级] / 遗忘 / 使用 [目标] <能力> / 重置")
    const rank = operation === "learn_ability" && tokens[0] !== undefined ? Number(tokens.shift()) : undefined
    if (rank !== undefined && (!Number.isInteger(rank) || rank < 1)) throw new Error("技能等级必须是正整数")
    await this.applyActionList(pack, [{ op: operation, ability, ...(rank === undefined ? {} : { rank }) }], runtime)
    if (operation === "use_ability" && definition.on_use?.length) await this.applyActionList(pack, definition.on_use, runtime)
    const label = pack.abilities[ability]!.label || ability
    const verb = operation === "learn_ability" ? "学习" : operation === "forget_ability" ? "遗忘" : operation === "use_ability" ? "使用" : "重置"
    const text = `${actor.name}${verb}了${label}${rank ? `（等级 ${rank}）` : ""}。`
    return await this.finishBuiltinMutation(request, pack, state, ruleState, runtime, `ability_${operation}`, text)
  }

  async handleAuditOperation(request:AgentDiceRuleContext, pack:RulePack, raw:string) {
    const state = this.state
    const ruleState = this.packState(pack).group
    requireRulePermission(request, ruleState, "gm")
    const count = Math.max(1, Math.min(20, Number(String(raw || "").match(/\d+/)?.[0]) || 5))
    const records = ruleState.audit.slice(-count).reverse()
    if (!records.length) return "当前还没有结构化审计记录。"
    const recordValue=(value:unknown):Record<string,unknown> => record(value)
    const output=records.map(record => {
      const rolls = Object.entries(recordValue(record.rolls)).map(([id, value]) => { const roll=recordValue(value);return `${id}=${roll.detail || roll.total}` }).join("；")
      const targets = (Array.isArray(record.targets) ? record.targets : []).map(target => {const value=recordValue(target);return value.name || value.id}).join("、") || "无"
      return [
        `[${record.id}] ${String(record.at || "").replace("T", " ").slice(0, 19)}`,
        `命令：${record.command}；执行者：${record.invoker?.name || record.invoker?.id || "未知"}；目标：${targets}`,
        `可见性：${record.visibility || "public"}；种子：${record.seed || "无"}`,
        rolls ? `骰点：${rolls}` : "",
        record.opposed ? `对抗：${JSON.stringify(record.opposed)}` : "",
        `动作数：${Array.isArray(record.actions) ? record.actions.length : 0}；结果：${record.result || "无"}`
      ].filter(Boolean).join("\n")
    }).join("\n\n")
    // Audit may include hidden rolls. Even an authorized GM receives details
    // privately; group logs receive only this fixed notice.
    return this.queuePrivateRuleResult(request,pack,ruleState,output,'规则审计已发送给当前有权限的请求者。')
  }

  async executeInvocation(request:AgentDiceRuleContext, invocation:{pack:RulePack;rest:string;prefix:string}):Promise<string|RuleResult> {
    const pack = invocation.pack
    const rest = invocation.rest
    if (!rest) {
      return [
        `${pack.name}（.${invocation.prefix}）`,
        ...pack.commands.map(command => `.${invocation.prefix} ${(command.aliases || [command.id])[0]}${(command.arguments || []).map(arg => ` <${arg.label || arg.id}>`).join("")} - ${command.description || command.label || command.id}`),
        `人物卡：.${invocation.prefix} 卡 [目标] / 设 [目标] field=value / 查 [目标] field / 删 [目标] field`,
        `团务：权限 / npc / 群卡 / 群设 / 群查 / 战役 / 团务 / 先攻 / 状态 / 物品 / 技能 / 审计 / 投递`,
        ...(pack.identity?.sync_group_card === true
          ? [`名片同步：发送 .sn on 把数值显示到群名片（需机器人是群管理；.sn off 恢复原名）`]
          : []),
        `战役支持角色登记、章节和记录；团务支持暂停、恢复、历史、快照与回退。`
      ].join("\n")
    }
    const builtins:[Set<string>,string][] = [
      [BUILTIN_CARD_ALIASES, "card"], [BUILTIN_SET_ALIASES, "set"], [BUILTIN_GET_ALIASES, "get"], [BUILTIN_CLEAR_ALIASES, "clear"]
    ]
    for (const [aliases, operation] of builtins) {
      const matched = matchTextAlias(rest, [...aliases])
      if (matched) return await this.handleCardOperation(request, pack, operation, matched.rest)
    }
    const serviceBuiltins:[Set<string>,(raw:string)=>Promise<string|RuleResult>][] = [
      [BUILTIN_ROLE_ALIASES, raw => this.handleRoleOperation(request, pack, raw)],
      [BUILTIN_NPC_ALIASES, raw => this.handleNpcOperation(request, pack, raw)],
      [BUILTIN_GROUP_CARD_ALIASES, raw => this.handleGroupFieldOperation(request, pack, "card", raw)],
      [BUILTIN_GROUP_SET_ALIASES, raw => this.handleGroupFieldOperation(request, pack, "set", raw)],
      [BUILTIN_GROUP_GET_ALIASES, raw => this.handleGroupFieldOperation(request, pack, "get", raw)],
      [BUILTIN_CAMPAIGN_ALIASES, raw => this.handleCampaignOperation(request, pack, raw)],
      [BUILTIN_SESSION_ALIASES, raw => this.handleSessionOperation(request, pack, raw)],
      [BUILTIN_INITIATIVE_ALIASES, raw => this.handleInitiativeOperation(request, pack, raw)],
      [BUILTIN_STATUS_ALIASES, raw => this.handleStatusOperation(request, pack, raw)],
      [BUILTIN_ITEM_ALIASES, raw => this.handleItemOperation(request, pack, raw)],
      [BUILTIN_ABILITY_ALIASES, raw => this.handleAbilityOperation(request, pack, raw)],
      [BUILTIN_AUDIT_ALIASES, raw => this.handleAuditOperation(request, pack, raw)],
      [BUILTIN_DELIVERY_ALIASES, raw => this.handleDeliveryOperation(request, pack, raw)]
    ]
    for (const [aliases, handler] of serviceBuiltins) {
      const matched = matchTextAlias(rest, [...aliases])
      if (matched) return await handler(matched.rest)
    }
    let commandMatch = null
    for (const command of pack.commands) {
      const matched = matchTextAlias(rest, command.aliases)
      if (!matched) continue
      if (!commandMatch || matched.alias.length > commandMatch.matched.alias.length) commandMatch = { command, matched }
    }
    if (commandMatch) {
      const { command, matched } = commandMatch
      const checkpoint=command.error_output?{state:cloneJson(this.state),cards:cloneJson(this.cards),effects:this.effects.length,events:this.events.length,sequence:this.sequence}:undefined
      try {
        return await this.executeCommand(request, pack, command, matched.rest)
      } catch (error) {
        if (command.error_output) {
          const text = renderRuleTemplate(command.error_output, { message: error instanceof Error ? error.message : String(error) }, { strict: false })
          if (text&&checkpoint) {
            // An error template turns the failure into a successful response;
            // its draft must still have the same rollback semantics as a throw.
            this.state.packs=checkpoint.state.packs
            for(const key of Object.keys(this.cards))delete this.cards[key]
            Object.assign(this.cards,checkpoint.cards)
            this.effects.length=checkpoint.effects
            this.events.length=checkpoint.events
            this.sequence=checkpoint.sequence
            return text
          }
        }
        throw error
      }
    }
    throw new Error(`没有找到 ${pack.name} 子命令：${rest.split(/\s+/)[0]}。发送 .${invocation.prefix} 查看帮助`)
  }

}

function dataCopy(value:unknown,depth=0,seen=new Set<object>()):unknown {
  if(value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||types.isProxy(value)||depth>32||seen.has(value))throw new Error('规则持久状态无效')
  const prototype=Object.getPrototypeOf(value)
  if(Array.isArray(value)?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new Error('规则持久状态无效')
  seen.add(value)
  try{
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors)
    if(Array.isArray(value)){
      if(keys.length!==value.length+1||value.length>10000)throw new Error('规则持久状态无效')
      return Array.from({length:value.length},(_,index)=>{
        const field=descriptors[index]
        if(!field||!('value'in field)||!field.enumerable)throw new Error('规则持久状态无效')
        return dataCopy(field.value,depth+1,seen)
      })
    }
    const result:Record<string,unknown>=Object.create(null)
    if(keys.length>10000)throw new Error('规则持久状态无效')
    for(const key of keys){
      const field=typeof key==='string'?descriptors[key]:undefined
      if(typeof key!=='string'||!field||!('value'in field)||!field.enumerable)throw new Error('规则持久状态无效')
      result[key]=dataCopy(field.value,depth+1,seen)
    }
    return result
  }finally{seen.delete(value)}
}
function checkedState(value:unknown):AgentDiceRulesState {
  if(value===undefined||value===null)return {version:1,packs:Object.create(null)}
  const copied=dataCopy(value) as Record<string,unknown>
  if(!copied||copied.version!==1||!copied.packs||typeof copied.packs!=='object'||Array.isArray(copied.packs)||
    Object.keys(copied).some(key=>!['version','packs'].includes(key)))throw new Error('规则持久状态无效')
  for(const pack of Object.values(copied.packs)){
    const entry=record(pack),group=record(entry.group)
    if(!entry.players||typeof entry.players!=='object'||Array.isArray(entry.players)||!entry.group||!group.roles||!group.npcs||!group.group||!group.session||
      !Array.isArray(group.audit)||!Array.isArray(group.privateDeliveries)||!Array.isArray(group.sessions)||!group.campaigns||
      typeof group.activeCampaignId!=='string'||!Array.isArray(group.snapshots))throw new Error('规则持久状态无效')
  }
  return copied as unknown as AgentDiceRulesState
}
function checkedCards(value:AgentDiceRuleCards|undefined,context:AgentDiceRuleContext):AgentDiceRuleCards {
  if(value===undefined)return Object.create(null) as AgentDiceRuleCards
  const copied=dataCopy(value) as AgentDiceRuleCards
  for(const [id,card]of Object.entries(copied)){
    if(!context.members.some(member=>member.id===id)||!card||typeof card!=='object'||Array.isArray(card)||!isPlatformIdentifier(card.key)||
      typeof card.name!=='string'||card.name.length>256||!card.attrs||typeof card.attrs!=='object'||Array.isArray(card.attrs)||
      !card.skills||typeof card.skills!=='object'||Array.isArray(card.skills)||
      ![...Object.values(card.attrs),...Object.values(card.skills)].every(value=>typeof value==='number'&&Number.isFinite(value)))throw new Error('规则人物卡桥接无效')
  }
  return copied
}
/** Settle only a host-confirmed attempt; private bodies are never exposed in group status. */
export function settleAgentDiceRuleDelivery(input:unknown,outcome:{packId:string;deliveryId:string;state:'sent'|'failed'|'unknown'}):AgentDiceRulesState {
  const state=checkedState(input),group=state.packs[outcome.packId]?.group
  if(!group)return state
  const item=group.privateDeliveries.find(item=>item.deliveryId===outcome.deliveryId)
  if(!item)return state
  if(outcome.state==='sent')group.privateDeliveries=group.privateDeliveries.filter(item=>item.deliveryId!==outcome.deliveryId)
  else {item.state=outcome.state;item.attempts++;item.lastError=outcome.state}
  return state
}
/** Neutral per-owner evaluator: drafts and effects only. The caller owns atomic source freezing and delivery. */
export function createAgentDiceRules(options:{packages?:readonly AgentDiceCompiledRulePackage[]}={}) {
  const packages=options.packages??[]
  if(!Array.isArray(packages)||packages.length>128||new Set(packages.map(item=>item.id)).size!==packages.length)throw new Error('规则包配置无效')
  const catalog={packages,definitionId:`agent-dice-rules:v1:${sha(packages.map(item=>[item.id,item.definitionId]).sort())}`}
  function invocation(command:string):{pkg:AgentDiceCompiledRulePackage;rest:string;prefix:string}|undefined {
    const normalized=normalizeCommandText(command)
    if(!normalized.startsWith('.'))return undefined
    const body=normalized.slice(1)
    for(const pkg of catalog.packages){
      const aliases=pkg.kind==='seal'?[...pkg.commands]:[pkg.id,...(pkg.pack.aliases??[])]
      const match=matchTextAlias(body,aliases)
      if(match)return {pkg,rest:match.rest,prefix:match.alias}
    }
    return undefined
  }
  return Object.freeze({definitionId:catalog.definitionId,
    isCandidate(command:string){return invocation(command)!==undefined},
    async evaluate(input:{state?:unknown;command:string;context:AgentDiceRuleContext;random:()=>number;cards?:AgentDiceRuleCards}):Promise<AgentDiceRulesResult>{
      const found=invocation(input.command),state=checkedState(input.state)
      if(!found)return {matched:false,state,effects:[],events:[]}
      const {context}=input
      if(!isPlatformIdentifier(context.source.messageId)||context.source.messageId==='0'||context.source.authorId!==context.actor.id||!Number.isSafeInteger(context.source.at)||context.source.at<=0||!Number.isFinite(new Date(context.source.at).getTime())||!context.groupId||
        !context.members.some(member=>member.id===context.actor.id)||!context.allows('player',context.actor.id))throw new Error('规则来源或成员授权无效')
      const random=()=>{const value=input.random();if(!Number.isFinite(value)||value<0||value>=1)throw new Error('规则随机源无效');return value}
      const cards=checkedCards(input.cards,context),evaluator=new RuleEvaluator(state,context,random,cards),pack=await found.pkg.instantiate(random,context.source.at)
      if(found.pkg.kind==='seal'){
        const saved=evaluator.packState(pack),originalCards=cloneJson(cards)
        const result=await runAgentDiceSeal({source:found.pkg.source,packId:found.pkg.id,command:found.prefix,args:found.rest,...(saved.seal?{state:saved.seal}:{}),
          context,random,players:saved.players,cards,...(found.pkg.scriptRunner?{scriptRunner:found.pkg.scriptRunner}:{})})
        if(!result.matched)return {matched:false,state:checkedState(input.state),effects:[],events:[],cards:checkedCards(input.cards,context)}
        saved.seal=result.state
        evaluator.effects.push(...result.effects)
        for(const [id,card]of Object.entries(cards))if(JSON.stringify(card)!==JSON.stringify(originalCards[id]))evaluator.events.push({
          kind:'card_change',packId:found.pkg.id,subjectId:id,source:{...context.source},slotHash:sha(JSON.stringify([id,card.key])),content:'规则人物卡已更新。'})
        evaluator.events.push({kind:'rule_event',packId:found.pkg.id,command:found.prefix,source:{...context.source},visibility:'public'})
      }else {
        const result=await evaluator.executeInvocation(context,{pack,rest:found.rest,prefix:found.prefix})
        const eventIndex=evaluator.events.length?evaluator.events.length-1:undefined
        const text=sanitizeRuleOutput(typeof result==='string'?result:result.text)
        if(typeof result==='object'){
          for(const item of result.privateMessages??[])evaluator.effects.push({kind:'private',recipientId:item.userId,text:item.text,deliveryId:item.deliveryId,packId:found.pkg.id,
            ...(item.origin?{origin:item.origin}:{}),...(item.requiredPermission?{requiredPermission:item.requiredPermission}:{})})
          for(const item of result.groupCardUpdates??[])evaluator.effects.push({kind:'card',subjectId:item.userId,name:item.name})
        }
        if(text)evaluator.effects.push({kind:'public',text,...(eventIndex===undefined?{}:{eventIndex})})
      }
      return {matched:true,state,effects:evaluator.effects,events:evaluator.events,cards}
    },
  })
}
