import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {DiceState,DiceUser,DiceGroup,DiceCard,DiceCheckOptions} from '../../../contracts/dice.js'
import {numericDiceTotal,decodeDiceState,diceError} from './diceDecoders.js'
import {resolveSealSkillName,sealSkillLookupKeys} from '../domain/sealSkillAliases.js'
import {SEAL_COC_DEFAULT_SKILLS} from '../domain/sealCocDefaults.js'
import {normalizeDiceExpression,rollDiceExpression,splitDiceRounds} from '../domain/diceExpression.js'
import {DEFAULT_TEMPLATES,DEFAULT_CHECK_LEVELS,DEFAULT_TEMP_INSANITY,DEFAULT_INDEFINITE_INSANITY,mergeDiceReplyConfig,pickCheckTemplate,pickJrrpComment,cocRankToCompareRank} from '../domain/diceReplyCatalog.js'
import type {DiceReplyInput} from '../domain/diceReplyCatalog.js'
import {DICE_COMMAND_RULES,stripDiceCommand,normalizeDiceCommandText} from './diceCommandPolicy.js'
import {isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import {executeDiceDeck,normalizeDiceDeck} from '../domain/diceDeck.js'

export interface AgentDiceBuiltinConfig extends DiceReplyInput { readonly enabled?:boolean;readonly maxDiceCount?:number;readonly maxDiceSides?:number;readonly maxRounds?:number;readonly defaultRule?:string;readonly allowHiddenRoll?:boolean;readonly timeZone?:string;readonly decks?:Readonly<Record<string,readonly string[]>> }
export interface AgentDiceBuiltinState { readonly version:1; readonly users:Record<string,DiceUser>; readonly scene:DiceGroup }
export interface AgentDiceBuiltinContext {
 readonly source:{readonly messageId:string;readonly authorId:string;readonly at:number}
 readonly actor:{readonly id:string;readonly name:string}
 readonly members:readonly {readonly id:string;readonly name:string}[]
 readonly mentions:readonly string[]
 readonly groupId:string
 readonly botUserId?:string
 readonly replyAuthorId?:string
 allows(permission:'player'|'delegate'|'hidden'|'admin'|'card',subjectId?:string):boolean
}
export type AgentDiceBuiltinEffect={readonly kind:'public';readonly text:string;readonly eventIndex?:number}|{readonly kind:'private';readonly recipientId:string;readonly text:string}|{readonly kind:'card';readonly subjectId:string;readonly name:string}|{readonly kind:'log';readonly operation:'start'|'stop';readonly ownershipId:string;readonly title?:string}
export interface AgentDiceBuiltinEvent {readonly kind:'dice_result'|'card_change';readonly source:AgentDiceBuiltinContext['source'];readonly actorId:string;readonly subjectIds:readonly string[];readonly visibility:'public'|'private';readonly command:string;readonly text?:string}
type Subject={readonly subjectId:string}
const COC_DEFAULT_SKILLS=SEAL_COC_DEFAULT_SKILLS
const stripCqMentions=(value:string)=>value.replace(/\[CQ:at,[^\]]+\]/giu,'').replace(/<@!?[^>]+>/gu,'').trim()
const storageIdentifier=(id:unknown):id is string=>isPlatformIdentifier(id)&&!['__proto__','constructor','prototype'].includes(id)
function safeNumber(value:unknown,fallback:number,min:number,max:number){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}
function normalizeSkillName(name=''){return String(name||'').trim().replace(/[：:=]\s*\d+$/u,'').trim()}
function formatUpdates(updates:[string,number][]=[]){return updates.map(([key,value])=>`${key}=${value}`).join('，')}
function renderTemplate(template:unknown,values:Record<string,unknown>={}){return String(template||'').replace(/\{([A-Za-z0-9_]+)\}/gu,(_,key:string)=>values[key]===undefined||values[key]===null?'':String(values[key]))}
function cleanJson<T>(value:T):T {
 const seen=new Set<unknown>()
 const copy=(value:unknown,depth:number):unknown=>{
  if(depth>24)throw new Error('骰子状态过深')
  if(value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))throw new Error('骰子状态必须是闭合JSON')
  const proto=Object.getPrototypeOf(value);if(Array.isArray(value)?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw new Error('骰子状态原型无效')
  const keys=Reflect.ownKeys(value);if(keys.some(key=>typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)))throw new Error('骰子字段无效')
  seen.add(value);try{
   if(Array.isArray(value)){if(value.length>4096||keys.length!==value.length+1)throw new Error('骰子数组无效');return Array.from({length:value.length},(_,index)=>{const field=Object.getOwnPropertyDescriptor(value,String(index));if(!field||!('value'in field)||!field.enumerable)throw new Error('骰子数组无效');return copy(field.value,depth+1)})}
   const out:Record<string,unknown>={};if(keys.length>4096)throw new Error('骰子字段过多');for(const key of keys as string[]){const field=Object.getOwnPropertyDescriptor(value,key)!;if(!('value'in field)||!field.enumerable)throw new Error('骰子状态访问器无效');out[key]=copy(field.value,depth+1)}return out
  }finally{seen.delete(value)}
 };return copy(value,0) as T
}
const defaults={enabled:true,maxDiceCount:100,maxDiceSides:100000,maxRounds:20,defaultRule:'0',allowHiddenRoll:false,timeZone:'Asia/Shanghai'}
type DiceConfig=typeof defaults & ReturnType<typeof mergeDiceReplyConfig> & {decks:Readonly<Record<string,readonly string[]>>}

const ATTR_ALIASES:Record<string,string> = {
  力量: "STR", str: "STR", STR: "STR",
  体质: "CON", con: "CON", CON: "CON",
  体型: "SIZ", siz: "SIZ", SIZ: "SIZ",
  敏捷: "DEX", dex: "DEX", DEX: "DEX",
  外貌: "APP", app: "APP", APP: "APP",
  智力: "INT", int: "INT", INT: "INT",
  意志: "POW", pow: "POW", POW: "POW",
  教育: "EDU", edu: "EDU", EDU: "EDU",
  幸运: "LUCK", luck: "LUCK", LUCK: "LUCK",
  理智: "SAN", san: "SAN", SAN: "SAN",
  hp: "HP", HP: "HP", mp: "MP", MP: "MP"
}

const DND_ATTRS = ["力量", "敏捷", "体质", "智力", "感知", "魅力"]
const COC_PRIMARY_ATTRS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU"]
const COC_DISPLAY_ATTRS = [...COC_PRIMARY_ATTRS, "LUCK", "SAN", "HP", "MP"]
const COC_ATTR_LABELS:Record<string,string> = {
  STR: "力量",
  CON: "体质",
  SIZ: "体型",
  DEX: "敏捷",
  APP: "外貌",
  INT: "智力",
  POW: "意志",
  EDU: "教育",
  LUCK: "幸运",
  SAN: "理智",
  HP: "体力",
  MP: "魔法"
}
const DND_NAMES = [
  "Alden", "Bran", "Cedric", "Daria", "Elara", "Finn", "Garrick", "Helena",
  "Iris", "Joran", "Kael", "Lyra", "Mira", "Nolan", "Orin", "Rhea",
  "Seren", "Talia", "Ulric", "Vera"
]

// .name 随机姓名库（中/英/日）
const NAME_BANKS:Record<string,{label:string;first:string[];last:string[]}> = {
  zh: {
    label: "中文",
    first: "伟芳娜秀敏静丽强磊军洋勇艳杰娟涛明超霞平刚玉兰凤洁梅琳云莲真雪荣佳嘉琼勤珍贞莉璐娅琦晶妍茜秋珊莎锦青倩婷婉娴瑾颖露瑶怡雁蓓仪荷丹蓉眉君琴蕊薇菁梦岚苑婕馨瑗韵融园艺咏卿聪澜纯毓悦昭冰爽琬茗羽希宁欣飘育滢馥筠柔竹凝晓欢霄枫芸菲寒伊亚宜可姬舒影荔枝思".split(""),
    last: "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常乔贺赖龚文".split("")
  },
  en: {
    label: "英文",
    first: ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Susan", "Richard", "Jessica", "Joseph", "Sarah", "Thomas", "Karen", "Charles", "Lisa", "Daniel", "Nancy", "Matthew", "Betty", "Anthony", "Sandra", "Mark", "Ashley", "Steven", "Emily", "Andrew", "Donna", "Joshua", "Michelle", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa", "Timothy", "Deborah", "Ronald", "Stephanie", "Jason", "Rebecca", "Edward", "Sharon", "Jeffrey", "Laura"],
    last: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris", "Murphy", "Cook", "Rogers", "Peterson", "Cooper"]
  },
  jp: {
    label: "日文",
    last: ["佐藤", "鈴木", "高橋", "田中", "渡辺", "伊藤", "山本", "中村", "小林", "加藤", "吉田", "山田", "佐々木", "中野", "松本", "井上", "木村", "林", "斎藤", "清水", "山口", "森", "阿部", "池田", "橋本", "石川", "山下", "中島", "石井", "小川", "藤田", "岡田", "村上", "長谷川", "近藤", "藤井", "青木", "福田", "西村", "藤本"],
    first: ["太郎", "花子", "一郎", "美咲", "健太", "陽菜", "翔太", "さくら", "大輔", "愛", "悠真", "結衣", "蓮", "陽菜", "樹", "芽衣", "翼", "千夏", "奏太", "美月", "和也", "朋美", "亮介", "由美", "拓海", "彩", "駿", "凛", "颯太", "智子", "陽介", "麻衣", "裕樹", "千尋", "淳", "奈々", "孝史", "美穂", "剛", "杏"]
  }
}


class NeutralBuiltin {
 readonly state:DiceState
 readonly effects:AgentDiceBuiltinEffect[]=[]
 readonly subjects=new Set<string>()
 static get DIFFICULTY_PREFIXES():Record<string,number>{return {'困难':2,'困難':2,'极难':3,'極難':3,'大成功':4,'常规':1,'常規':1}}
 constructor(readonly config:DiceConfig,readonly context:AgentDiceBuiltinContext,readonly random:()=>number,initial:AgentDiceBuiltinState|null){
  const state=initial?cleanJson(initial):{version:1 as const,users:{},scene:{}}
  if(state.version!==1||!state.users||!state.scene||Object.keys(state).some(key=>!['version','users','scene'].includes(key)))throw new Error('骰子状态版本无效')
  this.state=decodeDiceState({version:1,users:state.users,groups:{scene:state.scene}})
  if(canonical(this.state.users)!==canonical(state.users)||canonical(this.state.groups.scene)!==canonical(state.scene))throw new Error('骰子状态结构无效')
 }
 getConfig(){return this.config}
 readState(_config?:DiceConfig){return this.state}
 canManageGroupDice(_subject:Subject){return this.context.allows('admin')}
 rollInt(sides:number){const n=this.random();if(!Number.isSafeInteger(sides)||sides<1||!Number.isFinite(n)||n<0||n>=1)throw new Error('骰点随机源无效');return Math.floor(n*sides)+1}
 getTodayKey(date:Date,config=this.config){return new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}
 memberLabel(id:string){return '@'+(this.context.members.find(member=>member.id===id)?.name||id)}
 subjectName(subject:Subject){return this.context.members.find(member=>member.id===subject.subjectId)?.name||(subject.subjectId===this.context.actor.id?this.context.actor.name:subject.subjectId)}
 withSubject(_subject:Subject,id:string):Subject {
  if(!storageIdentifier(id)||id===this.context.botUserId||id!==this.context.actor.id&&(!this.context.members.some(member=>member.id===id)||!this.context.allows('delegate',id)))throw new Error('目标成员没有当前代骰授权')
  this.subjects.add(id);return {subjectId:id}
 }
 getMentionedUserIds(_subject:Subject){return [...this.context.mentions].filter(id=>id!==this.context.botUserId).map(id=>this.withSubject(_subject,id).subjectId)}
 resolveDelegate(subject:Subject){const id=this.getMentionedUserIds(subject)[0];return {subject:id?this.withSubject(subject,id):subject,delegated:!!id}}
 getUserName(subject:Subject){const user=this.state.users[subject.subjectId];return user?.nickname||this.subjectName(subject)||subject.subjectId}
 ensureUser(state:DiceState,subject:Subject){
  const id=this.withSubject(subject,subject.subjectId).subjectId
  const user=state.users[id]??={nickname:this.subjectName(subject),activeCard:'默认',cards:{'默认':{name:this.subjectName(subject),attrs:{},skills:{}}}}
  user.cards??={};user.activeCard||=Object.keys(user.cards)[0]||'默认';user.cards[user.activeCard]??={name:user.nickname||this.subjectName(subject),attrs:{},skills:{}}
  if(typeof user.locked==='boolean'){for(const card of Object.values(user.cards))if(card.locked===undefined)card.locked=user.locked;delete user.locked}
  return user
 }
 async setGroupCardName(subject:Subject,name:string,userId=subject.subjectId){
  this.withSubject(subject,userId);if(!this.context.allows('card',userId))throw new Error('平台名片修改未授权')
  const card=name.trim().slice(0,60);if(!card)throw new Error('名片不能为空');this.effects.push({kind:'card',subjectId:userId,name:card});return true
 }
 async syncAutoGroupCard(subject:Subject,name:string,state:DiceState|null=null,_config=this.config){
  if((state||this.state).groups.scene?.autoCardNames?.[subject.subjectId]?.enabled!==true)return ''
  if(!this.context.allows('card',subject.subjectId))return '\n人物卡已更新；群名片同步没有当前授权。'
  await this.setGroupCardName(subject,name);return '\n人物卡已更新，群名片同步已排队。'
 }
 async handleHiddenCheck(subject:Subject,raw='',options:DiceCheckOptions={}){
  if(!this.config.allowHiddenRoll||!this.context.allows('hidden',this.context.actor.id))throw new Error('暗骰未获得显式授权')
  const normalized=normalizeDiceExpression(raw.trim())
  const expression=!raw.trim()||/^(\d+#)?[0-9dklhmaxinop+\-*/%().]+(#\d+)?$/u.test(normalized)
  const result=expression?this.handleRoll(subject,raw||'1d100'):this.handleCheck(subject,raw,options)
  this.effects.push({kind:'private',recipientId:this.context.actor.id,text:renderTemplate(this.config.templates.hiddenPrivate,{name:this.getUserName(subject),result})})
  // The private result is never interpolated into a public template, even if a host template asks for it.
  return `${this.getUserName(subject)} 进行了一次暗骰，结果仅私聊发送。`
 }

async handleSetOption(subject:Subject, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = "scene"
    state.groups[groupId] ||= {}
    const text = String(raw || "").trim()
    if (!text) {
      const group = state.groups[groupId]
      return `当前设置：默认骰 d${group.defaultDiceSides || 100}；规则 ${group.system || "coc"}`
    }
    if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以修改当前群骰娘设置。"
    const diceMatch = text.match(/^(?:d|骰子|默认骰)\s*(\d+)$/i) || text.match(/^(\d+)$/)
    if (diceMatch) {
      const sides = Math.max(2, Math.min(100000000, Number(diceMatch[1])))
      state.groups[groupId].defaultDiceSides = sides
      return `默认骰已设置为 d${sides}。`
    }
    if (/^(coc|coc7|dnd|dnd5e)$/i.test(text)) {
      state.groups[groupId].system = text.toLowerCase()
      return `当前群规则系统已设置为：${state.groups[groupId].system}`
    }
    return "set 命令：.set d20 / .set coc / .set dnd"
  }

async handleSn(subject:Subject, raw = "") {
    const text = String(raw || "").trim()
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = "scene"
    const userId = String(subject.subjectId || "")
    state.groups[groupId] ||= {}
    state.groups[groupId].autoCardNames ||= {}
    const current = state.groups[groupId].autoCardNames[userId]
    if (/^(on|开启)$/i.test(text)) {
      const user = this.ensureUser(state, subject)
      const desired = String(user.cards?.[user.activeCard]?.name || user.nickname || this.subjectName(subject) || userId).slice(0, 60)
      try {
        await this.setGroupCardName(subject, desired)
      } catch (error) {
        return `自动群名片没有开启：${"平台名片效果不可用"}`
      }
      state.groups[groupId].autoCardNames[userId] = {
        enabled: true,
        original: current?.original || this.subjectName(subject) || "",
        updatedAt: new Date(this.context.source.at).toISOString()
      }
      return `自动群名片已开启，当前同步为：${desired}`
    }
    if (/^(off|关闭)$/i.test(text)) {
      if (!current?.enabled) return "自动群名片本来就是关闭的。"
      current.enabled = false
      current.updatedAt = new Date(this.context.source.at).toISOString()
      let suffix = ""
      if (current.original) {
        try {
          await this.setGroupCardName(subject, current.original)
          suffix = `，并恢复为：${current.original}`
        } catch (error) {
          suffix = `；自动同步已关闭，但原名恢复失败：${"平台名片效果不可用"}`
        }
      }
      return `自动群名片已关闭${suffix}`
    }
    // .sn <名字>（非模板名）：按 sealdice 直觉——设置骰娘昵称并立即同步一次群名片
    if (text) {
      const name = text.slice(0, 60)
      const user = this.ensureUser(state, subject)
      user.nickname = name
      let suffix = ""
      try {
        await this.setGroupCardName(subject, name)
        suffix = "，群名片已同步"
      } catch (error) {
        suffix = `；群名片同步失败：${"平台名片效果不可用"}（昵称已生效）`
      }
      return `骰娘昵称已设置为：${name}${suffix}\n（持续自动同步用 .sn on；规则包名片模板名仍优先按模板应用）`
    }
    return `自动群名片：${current?.enabled ? "开启" : "关闭"}\n命令：.sn on / .sn off / .sn <昵称>（改名并同步名片）`
  }

async applyBuiltinCardTemplate(subject:Subject, templateName = "") {
    const key = String(templateName || "").trim().toLowerCase()
    if (!["coc", "cocl", "dnd"].includes(key)) return null
    const state = this.readState()
    const card = this.getActiveCard(subject, state)
    const lookup = (...names:string[]) => {
      for (const name of names) {
        for (const bag of [card.attrs || {}, card.skills || {}]) {
          for (const [k, v] of Object.entries(bag)) {
            if (k.toLowerCase() === String(name).toLowerCase() && Number.isFinite(Number(v))) return Number(v)
          }
        }
      }
      return null
    }
    const show = (value:unknown) => (value === null ? "?" : value)
    const player = this.getUserName(subject)
    let text = null
    if (key === "coc") {
      text = `${player} SAN${show(lookup("SAN", "理智"))} HP${show(lookup("HP", "生命值"))}/${show(lookup("HPMAX", "hpmax", "生命值上限"))} DEX${show(lookup("DEX", "敏捷"))}`
    } else if (key === "cocl") {
      text = `${player} san${show(lookup("SAN", "理智"))} hp${show(lookup("HP", "生命值"))}/${show(lookup("HPMAX", "hpmax", "生命值上限"))} dex${show(lookup("DEX", "敏捷"))}`
    } else if (key === "dnd") {
      text = `${player} HP${show(lookup("hp", "生命值"))}/${show(lookup("hpmax", "生命值上限"))} AC${show(lookup("ac"))} DC${show(lookup("dc"))} PP${show(lookup("pp"))}`
    }
    if (text === null) return null
    await this.setGroupCardName(subject, text)
    return text
  }

handleDnd(subject:Subject, raw = "") {
    const config = this.getConfig()
    const count = Math.min(config.maxRounds, Math.max(1, Number(normalizeDiceExpression(raw).match(/\d+/)?.[0]) || 1))
    const rows = []
    for (let i = 0; i < count; i += 1) {
      const attrs = DND_ATTRS.map(name => [name, numericDiceTotal(this.rollExpression("4d6kh3", config).total)])
      rows.push(`${count > 1 ? `${i + 1}. ` : ""}${attrs.map(([k, v]) => `${k} ${v}`).join(" / ")}`)
    }
    return renderTemplate(config.templates.dnd, { attributes: rows.join("\n") })
  }

shouldUseDndCheck(subject:Subject, raw = "") {
    const state = this.readState()
    const groupId = "scene"
    const system = state.groups?.[groupId]?.system || ""
    return /^dnd/i.test(system) || /优势|劣势|adv|dis/i.test(String(raw || ""))
  }

handleDndCheck(subject:Subject, raw = "") {
    const text = String(raw || "").trim()
    let mode = "普通"
    if (/优势|adv/i.test(text)) mode = "优势"
    if (/劣势|dis/i.test(text)) mode = "劣势"
    const bonus = Number(text.match(/[+\-]\d+/)?.[0] || 0)
    const rolls = [this.rollInt(20)]
    if (mode !== "普通") rolls.push(this.rollInt(20))
    const picked = mode === "优势" ? Math.max(...rolls) : mode === "劣势" ? Math.min(...rolls) : rolls[0]!
    const label = text.replace(/优势|劣势|adv|dis|[+\-]\d+/gi, "").trim() || "检定"
    return `${this.getUserName(subject)} 进行 ${label}：${mode}${mode === "普通" ? "" : `[${rolls.join("/")}]`} 1D20=${picked}${bonus >= 0 ? "+" : ""}${bonus}=${picked + bonus}`
  }

async handleDndUtility(subject:Subject, command = "", raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const user = this.ensureUser(state, subject)
    const card = user.cards[user.activeCard]!
    if (!card.dnd && user.dnd) {
      card.dnd = user.dnd
      delete user.dnd
    }
    card.dnd ||= { buffs: [], spellSlots: {}, deathSaves: { success: 0, failure: 0 } }
    const dnd = card.dnd
    dnd.buffs ||= []
    dnd.spellSlots ||= {}
    dnd.deathSaves ||= { success: 0, failure: 0 }
    const cmd = String(command || "").toLowerCase()
    const text = String(raw || "").trim()
    if (cmd === "buff") {
      if (!text || /^(list|列表)$/i.test(text)) return `当前 Buff：${dnd.buffs.join("，") || "无"}`
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      if (/^(clr|clear|清空)$/i.test(text)) dnd.buffs = []
      else dnd.buffs.push(text.slice(0, 80))
      return `当前 Buff：${dnd.buffs.join("，") || "无"}`
    }
    if (cmd === "ss") {
      const m = text.match(/^(\d+)\s+(\d+)(?:\s*\/\s*(\d+))?$/)
      if (m) {
        if (this.isCardLocked(card)) return this.lockedCardReply(card)
        dnd.spellSlots[m[1]!] = { current: Number(m[2]!), max: Number(m[3]! ?? m[2]!) }
      }
      const slots = Object.entries(dnd.spellSlots).map(([lv, value]) => {
        const slot = typeof value === "object" ? value : { current: Number(value) || 0, max: Number(value) || 0 }
        return `${lv}环:${slot.current}/${slot.max}`
      }).join("，") || "未记录"
      return `法术位：${slots}`
    }
    if (cmd === "cast") {
      const level = String(text.match(/\d+/)?.[0] || "")
      if (!level) return "格式：.cast 环数"
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const rawSlot = dnd.spellSlots[level]
      const slot = typeof rawSlot === "object" ? rawSlot : { current: Number(rawSlot) || 0, max: Number(rawSlot) || 0 }
      const left = Number(slot.current || 0)
      if (left <= 0) return `${level}环法术位不足。`
      slot.current = left - 1
      dnd.spellSlots[level] = slot
      return `已消耗 ${level} 环法术位，剩余 ${slot.current}/${slot.max}。`
    }
    if (cmd === "longrest") {
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      dnd.deathSaves = { success: 0, failure: 0 }
      for (const [level, value] of Object.entries(dnd.spellSlots)) {
        const slot = typeof value === "object" ? value : { current: Number(value) || 0, max: Number(value) || 0 }
        slot.current = slot.max
        dnd.spellSlots[level] = slot
      }
      return "长休完成：死亡豁免已清空，已记录法术位恢复到上限。"
    }
    if (cmd === "ds") {
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const roll = this.rollInt(20)
      if (roll === 1) dnd.deathSaves.failure += 2
      else if (roll === 20) dnd.deathSaves.success = 3
      else if (roll >= 10) dnd.deathSaves.success += 1
      else dnd.deathSaves.failure += 1
      return `死亡豁免：1D20=${roll}；成功 ${dnd.deathSaves.success}/3，失败 ${dnd.deathSaves.failure}/3`
    }
    return "DND 命令：.buff / .ss / .cast / .longrest / .ds"
  }

handleNameDnd(subject:Subject, raw = "") {
    const count = Math.min(20, Math.max(1, Number(normalizeDiceExpression(raw).match(/\d+/)?.[0]) || 1))
    const names = []
    for (let i = 0; i < count; i += 1) names.push(DND_NAMES[this.rollInt(DND_NAMES.length) - 1])
    return `DND 随机姓名：${names.join("、")}`
  }

handleName(subject:Subject, raw = "") {
    const text = String(raw || "").trim()
    let lang = "zh"
    let rest = text
    const langMatch = rest.match(/^(en|english|英文|jp|ja|jpn|日文|日语|zh|cn|chinese|中文)\s*/i)
    if (langMatch) {
      const word = langMatch[1]!.toLowerCase()
      lang = /^(en|english|英文)/i.test(word) || word === "英文" ? "en" : /^(jp|ja|jpn)/i.test(word) || /日/.test(word) ? "jp" : "zh"
      rest = rest.slice(langMatch[0].length)
    }
    const count = Math.min(20, Math.max(1, Number(rest.match(/\d+/)?.[0]) || 5))
    const bank = NAME_BANKS[lang] || NAME_BANKS.zh!
    const names = []
    for (let i = 0; i < count; i += 1) {
      if (lang === "en") {
        names.push(`${bank.first[this.rollInt(bank.first.length) - 1]} ${bank.last[this.rollInt(bank.last.length) - 1]}`)
      } else if (lang === "jp") {
        names.push(`${bank.last[this.rollInt(bank.last.length) - 1]} ${bank.first[this.rollInt(bank.first.length) - 1]}`)
      } else {
        names.push(`${bank.last[this.rollInt(bank.last.length) - 1]}${bank.first[this.rollInt(bank.first.length) - 1]}`)
      }
    }
    return `随机姓名（${bank.label}）：${names.join("、")}`
  }

async handleObserve(subject:Subject, action = "") {
    const config = this.getConfig()
    const groupId = "scene"
    const userId = String(subject.subjectId || "")
    const name = this.getUserName(subject)
    const state = this.readState(config)
    state.groups[groupId] ||= {}
    const group = state.groups[groupId]
    group.observers ||= []
    const text = String(action || "").trim().toLowerCase()
    if (/^(on|obon|进入|加入|旁观)$/.test(text)) {
      if (group.observers.includes(userId)) return `${name} 已经在旁观中了。`
      group.observers.push(userId)
      return `${name} 已进入旁观模式。之后你的骰点命令会被静默，不再打扰跑团；用 .oboff 恢复。`
    }
    if (/^(off|oboff|exit|退出|取消|恢复)$/.test(text)) {
      if (!group.observers.includes(userId)) return `${name} 当前不在旁观模式。`
      group.observers = group.observers.filter(id => id !== userId)
      return `${name} 已退出旁观模式，骰点恢复正常。`
    }
    if (/^(list|ls|名单|列表|查看)$/.test(text)) {
      if (!group.observers.length) return "当前群没有旁观者。"
      const names = group.observers.map(id => this.readState().users?.[id]?.nickname || id)
      return `旁观名单（${group.observers.length} 人）：${names.join("、")}`
    }
    if (/^(clr|clear|清空)$/.test(text)) {
      if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以清空旁观名单。"
      group.observers = []
      return "旁观名单已清空。"
    }
    return [
      "旁观模式：",
      ".obon - 进入旁观（我的骰点将被静默）",
      ".oboff - 退出旁观",
      ".ob list - 查看旁观名单",
      ".ob clr - 清空名单（管理员）"
    ].join("\n")
  }

async handleInitiativeRoll(subject:Subject, raw = "") {
    const name = this.getUserName(subject)
    const bonus = Number(String(raw || "").match(/[+\-]?\d+/)?.[0] || 0)
    const roll = this.rollInt(20)
    const total = roll + bonus
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = "scene"
    state.groups[groupId] ||= {}
    state.groups[groupId].initiative ||= []
    const item = { name, value: total, userId: String(subject.subjectId || "") }
    const index = state.groups[groupId].initiative.findIndex(old => old.userId && old.userId === item.userId)
    if (index >= 0) state.groups[groupId].initiative[index] = item
    else state.groups[groupId].initiative.push(item)
    return `${name} 先攻：1D20[${roll}]${bonus >= 0 ? "+" : ""}${bonus}=${total}\n已写入当前群先攻列表。`
  }

async handleInitiative(subject:Subject, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = "scene"
    state.groups[groupId] ||= {}
    state.groups[groupId].initiative ||= []
    const list = state.groups[groupId].initiative
    const text = String(raw || "").trim()
    if (!text || /^(list|列表|show)$/i.test(text)) {
      if (!list.length) return "当前先攻列表为空。"
      return `先攻列表：\n${list.sort((a, b) => b.value - a.value).map((item, i) => `${i + 1}. ${item.name} ${item.value}`).join("\n")}`
    }
    if (/^(clr|clear|清空)$/i.test(text)) {
      if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以清空先攻列表。"
      state.groups[groupId].initiative = []
      state.groups[groupId].initiativeTurn = null
      return "先攻列表已清空。"
    }
    if (/^(next|下一位|下一回合)$/i.test(text)) {
      if (!list.length) return "先攻列表为空，先用 .ri 掷先攻。"
      list.sort((a, b) => b.value - a.value)
      const turn = state.groups[groupId].initiativeTurn || {}
      const cursor = turn.name ? list.findIndex(item => item.name === turn.name) : -1
      let index = cursor + 1
      if (index >= list.length) index = 0
      const round = (Number(turn.round) || 0) + (cursor + 1 >= list.length || cursor < 0 ? 1 : 0)
      state.groups[groupId].initiativeTurn = { round, name: list[index]!.name }
      const order = list.map((item, i) => `${i === index ? "▶ " : ""}${i + 1}. ${item.name} ${item.value}`).join("\n")
      return `先攻 第${round}轮：轮到 ${list[index]!.name}（先攻 ${list[index]!.value}）行动\n${order}`
    }
    const del = text.match(/^(del|rm|删除)\s+(.+)$/i)
    if (del) {
      if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以删除先攻项。"
      state.groups[groupId].initiative = list.filter(item => item.name !== del[2]!.trim())
      return `已删除先攻项：${del[2]!.trim()}`
    }
    const match = text.match(/^(.+?)\s+([+\-]?\d+)$/)
    if (!match) return "先攻命令：.ri [修正] / .init 名字 数值 / .init list / .init clear"
    const item = { name: match[1]!.trim(), value: Number(match[2]!) }
    const existing = list.findIndex(old => old.name === item.name)
    if (existing >= 0) list[existing] = item
    else list.push(item)
    return `已加入先攻：${item.name} ${item.value}`
  }

handleRsr(subject:Subject, raw = "") {
    const items = String(raw || "").split(/[,\s，]+/).map(item => item.trim()).filter(Boolean)
    if (!items.length) return "格式：.rsr 选项A 选项B 选项C"
    return `随机选择：${items[this.rollInt(items.length) - 1]}`
  }

handleWw(subject:Subject, raw = "") {
    const text = String(raw || "").trim()
    const count = Math.min(100, Math.max(1, Number(text.match(/\d+/)?.[0]) || 1))
    const target = Number(text.match(/(?:>=|难度|tn)\s*(\d+)/i)?.[1] || 8)
    const again = Number(text.match(/(?:again|爆骰|a)\s*(\d+)/i)?.[1] || 0)
    // WoD 的再骰线只有 8/9/10；小阈值几乎都是误把计数语法（如 .ww 6a4）当 WoD 用，直接拦下引导
    if (again >= 2 && again <= 7) {
      return `WoD 没有 ${again}-again（再骰线只有 8/9/10）。\n如果你是想数「几颗骰子大于某数」，用比较计数：.r ${count}d10>${again}\nWoD 完整用法：.help ww`
    }
    const queue = Array.from({ length: count }, () => true)
    const rolls = []
    while (queue.length) {
      queue.shift()
      if (rolls.length >= this.getConfig().maxDiceCount) return `WoD 骰池触发的总骰数超过 ${this.getConfig().maxDiceCount}，已停止，未给出不完整结算。`
      const value = this.rollInt(10)
      rolls.push(value)
      if (again >= 2 && again <= 10 && value >= again) queue.push(true)
    }
    const rawSuccess = rolls.filter(v => v >= target).length
    const ones = rolls.filter(v => v === 1).length
    const success = Math.max(0, rawSuccess - ones)
    const outcome = rawSuccess === 0 && ones > 0 ? "大失败" : success > 0 ? `${success} 成功` : "失败"
    return `WoD 骰池 ${count}D10 难度${target}${again ? `（${again}-again）` : ""}：[${rolls.join(", ")}] 成功 ${rawSuccess} - 1点抵消 ${ones} = ${success}；${outcome}`
  }

handleDx(subject:Subject, raw = "") {
    const text = String(raw || "").trim()
    const nums = text.match(/\d+/g)?.map(Number) || []
    const count = Math.min(100, Math.max(1, nums[0] || 1))
    const critical = Math.min(10, Math.max(2, nums[1] || 10))
    let pool = count
    let total = 0
    const rounds = []
    let diceUsed = 0
    while (true) {
      diceUsed += pool
      if (diceUsed > this.getConfig().maxDiceCount) return `DX 暴击链总骰数超过 ${this.getConfig().maxDiceCount}，已停止，未给出不完整达成值。`
      const rolls = Array.from({ length: pool }, () => this.rollInt(10))
      rounds.push(rolls)
      const criticals = rolls.filter(value => value >= critical).length
      if (!criticals) {
        total += Math.max(...rolls)
        break
      }
      total += 10
      pool = criticals
    }
    return `DX 检定 ${count}D10 C${critical}：${rounds.map((rolls, index) => `第${index + 1}轮[${rolls.join(",")}]`).join(" → ")}；达成值 ${total}`
  }

handleEk(subject:Subject, raw = "") {
    const config = this.getConfig()
    const expr = String(raw || "").trim() || "1d100"
    const result = this.rollExpression(expr, config)
    return `永恒幻梦：${result.expr}=${result.detail}=${result.total}`
  }

handleEkgen(subject:Subject, raw = "") {
    const attrs = ["体魄", "灵巧", "感知", "意志", "学识", "魅力"].map(name => `${name} ${this.rollInt(6) + this.rollInt(6) + 3}`)
    return `永恒幻梦角色属性：\n${attrs.join(" / ")}`
  }

isCardLocked(card:DiceCard|undefined) {
    return card?.locked === true
  }

lockedCardReply(card:DiceCard|undefined) {
    return `人物卡「${card?.name || "当前人物卡"}」已锁定；请先用 .pc unlock 解锁后再修改。`
  }

getActiveCard(subject:Subject, state = this.readState()) {
    const user = this.ensureUser(state, subject)
    return user.cards[user.activeCard]!
  }

getTargetValue(skill:string, explicitValue:unknown, subject:Subject) {
    if (Number.isFinite(Number(explicitValue))) return Number(explicitValue)
    const state = this.readState()
    const card = this.getActiveCard(subject, state)
    const key = normalizeSkillName(skill)
    // sealdice 别名（读取侧候选键）：繁体/同义词（偵查/侦察/侦查）命中同一卡值；
    // 写入不归一，保证其他规则体系（如永恒幻梦的「知识」）的原样卡不被改写
    const lookupKeys = sealSkillLookupKeys(key)
    const fromCard = Number(lookupKeys.reduce<number|undefined>((found, k) =>
      found ?? card.skills?.[k] ?? card.attrs?.[ATTR_ALIASES[k] || k], undefined))
    if (Number.isFinite(fromCard)) return fromCard
    // sealdice coc7 语义：常规技能未录卡时按官方默认值判档
    for (const lookupKey of lookupKeys) {
      if (Object.prototype.hasOwnProperty.call(COC_DEFAULT_SKILLS, lookupKey)) {
        const preset = COC_DEFAULT_SKILLS[lookupKey]
        if (Number.isFinite(Number(preset))) return Number(preset)
      }
    }
    const attr = (name:string) => Number(card.attrs?.[ATTR_ALIASES[name] || name])
    // sealdice defaultsComputed：依赖属性的派生默认（属性缺失时不硬造）
    const computed:Record<string,()=>number> = {
      闪避: () => Number.isFinite(attr("DEX")) ? Math.floor(attr("DEX") / 2) : NaN,
      生命值上限: () => Number.isFinite(attr("CON")) && Number.isFinite(attr("SIZ")) ? Math.floor((attr("CON") + attr("SIZ")) / 10) : NaN,
      母语: () => attr("EDU"),
      理智上限: () => Number.isFinite(card.skills?.克苏鲁神话) || Number(card.skills?.克苏鲁神话) === 0 ? 99 - Number(card.skills.克苏鲁神话) : 99
    }
    if (Object.prototype.hasOwnProperty.call(computed, key)) {
      const derived = computed[key]!()
      if (Number.isFinite(derived)) return derived
    }
    return fromCard
  }

getGroupRule(subject:Subject, config = this.getConfig()) {
    const state = this.readState(config)
    return state.groups?.["scene"]?.rule || config.defaultRule || "coc7"
  }

normalizeCocRule(rule = "") {
    const text = String(rule || "").toLowerCase()
    if (/^[0-5]$/.test(text)) return text
    if (/coc7|默认|标准/.test(text)) return "0"
    if (/1\/5|五分之一|极难/.test(text)) return "0"
    if (/出1|大成功1|房规1|crit1/.test(text)) return "5"
    if (/nofumble|不大失败|无大失败/.test(text)) return "nofumble"
    return "0"
  }

isValidCocRule(rule = "") {
    const text = String(rule || "").trim().toLowerCase()
    return /^[0-5]$/.test(text) || /^(coc7|默认|标准|nofumble|不大失败|无大失败|crit1|大成功1|房规1)$/.test(text)
  }

splitRounds(text = "") {
    return splitDiceRounds(text)
  }

rollExpression(expr = "1d100", config = this.getConfig(), random = this.random) {
    return rollDiceExpression(expr || "1d100", config, typeof random === "function" ? random : this.random)
  }

rollD100(modifier = 0) {
    const ones = this.rollInt(10) - 1
    const tensBase = this.rollInt(10) - 1
    const tensList = [tensBase]
    const extra = Math.abs(Number(modifier) || 0)
    if(!Number.isSafeInteger(extra)||extra>=this.config.maxDiceCount)throw new Error('奖惩骰超过数量限制')
    for (let i = 0; i < extra; i += 1) tensList.push(this.rollInt(10) - 1)
    const pickedTens = modifier > 0 ? Math.min(...tensList) : modifier < 0 ? Math.max(...tensList) : tensBase
    const value = pickedTens === 0 && ones === 0 ? 100 : pickedTens * 10 + ones
    const sign = modifier > 0 ? "奖励骰" : modifier < 0 ? "惩罚骰" : "1D100"
    const diceText = modifier === 0
      ? "1D100"
      : `${sign}[十位:${tensList.map(n => n * 10).join("/")},个位:${ones}]`
    return { value, diceText }
  }

extractDifficultyPrefix(text = "") {
    const prefixes = NeutralBuiltin.DIFFICULTY_PREFIXES
    for (const prefix of ["大成功", "极难", "極難", "困难", "困難", "常规", "常規"]) {
      if (text.startsWith(prefix)) {
        return { difficulty: prefixes[prefix]!, rest: text.slice(prefix.length) }
      }
    }
    return { difficulty: 0, rest: text }
  }

computeCocRank(d100:number, value:number, normalizedRule = "0", difficultyRequired = 0) {
    let criticalSuccessValue = 1
    let fumbleValue = 100
    let checkVal = value
    if (difficultyRequired === 2) checkVal = Math.floor(value / 2)
    else if (difficultyRequired === 3) checkVal = Math.floor(value / 5)
    else if (difficultyRequired === 4) checkVal = criticalSuccessValue

    let successRank = d100 <= checkVal ? 1 : -1

    switch (normalizedRule) {
      case "0":
        // 规则书：不满50出96-100大失败，满50出100大失败（以折算后判定值为准）
        if (checkVal < 50) fumbleValue = 96
        break
      case "1":
        if (value >= 50) criticalSuccessValue = 5
        if (value < 50) fumbleValue = 96
        break
      case "2":
        criticalSuccessValue = 5
        if (value < criticalSuccessValue) criticalSuccessValue = value
        fumbleValue = 96
        if (value >= fumbleValue) fumbleValue = Math.min(100, value + 1)
        break
      case "3":
        criticalSuccessValue = 5
        fumbleValue = 96
        break
      case "4":
        criticalSuccessValue = Math.min(5, Math.floor(value / 10))
        fumbleValue = Math.min(100, 96 + Math.floor(value / 10))
        break
      case "5":
        criticalSuccessValue = Math.min(2, Math.floor(value / 5))
        fumbleValue = value < 50 ? 96 : 99
        break
      default:
        break
    }

    if (successRank === 1 || d100 <= criticalSuccessValue) {
      if (d100 <= Math.floor(value / 2)) successRank = 2
      if (d100 <= Math.floor(value / 5)) successRank = 3
      if (d100 <= criticalSuccessValue) successRank = 4
    } else if (d100 >= fumbleValue) {
      successRank = -2
    }

    if (normalizedRule === "0" || normalizedRule === "1" || normalizedRule === "2") {
      // 为1必是大成功，即使判定线是0（40周年版 407页）
      if (d100 === 1) successRank = 4
    }
    if (d100 === 100 && normalizedRule === "0") successRank = -2
    if (normalizedRule === "3") {
      // 强行大成功或大失败
      if (d100 <= criticalSuccessValue) successRank = 4
      if (d100 >= fumbleValue) successRank = -2
    }
    return { rank: successRank, criticalSuccessValue }
  }

judgeCoc(roll:number, target:number, rule = "coc7", difficultyRequired = 0) {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 1) throw new Error("检定值必须是正数")
    const normalizedRule = this.normalizeCocRule(rule)
    const d100 = Number(roll)
    const noFumble = normalizedRule === "nofumble"
    const effectiveRule = noFumble ? "0" : normalizedRule
    const { rank } = this.computeCocRank(d100, value, effectiveRule, difficultyRequired)
    return this.levelTextFromRank((noFumble && rank === -2) ? -1 : rank)
  }

judgeCocDetails(roll:number, target:number, rule = "coc7", difficultyRequired = 0) {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 1) throw new Error("检定值必须是正数")
    const normalizedRule = this.normalizeCocRule(rule)
    const d100 = Number(roll)
    const noFumble = normalizedRule === "nofumble"
    const effectiveRule = noFumble ? "0" : normalizedRule
    const { rank } = this.computeCocRank(d100, value, effectiveRule, difficultyRequired)
    const displayRank = (noFumble && rank === -2) ? -1 : rank
    return { rank, displayRank, level: this.levelTextFromRank(displayRank) }
  }

levelTextFromRank(rank:number) {
    const levels = this.getConfig().checkLevels || DEFAULT_CHECK_LEVELS
    if (rank === 4) return levels.critical || "大成功"
    if (rank === 3) return levels.extreme || "极难成功"
    if (rank === 2) return levels.hard || "困难成功"
    if (rank === 1) return levels.success || "成功"
    if (rank === -2) return levels.fumble || "大失败"
    return levels.fail || "失败"
  }

handleRoll(subject:Subject, raw = "") {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const { rounds, expr } = this.splitRounds(stripCqMentions(raw || "1d100"))
    if (rounds > config.maxRounds) return `最多一次掷 ${config.maxRounds} 轮。`
    const rollSubject = this.resolveDelegate(subject).subject
    const name = this.getUserName(rollSubject)
    const results = []
    for (let i = 0; i < rounds; i += 1) {
      const result = this.rollExpression(expr || "1d100", config)
      results.push(renderTemplate(config.templates.roll, { name, ...result }))
    }
    return results.join("\n")
  }

handleBonusPenaltyRoll(subject:Subject, raw = "", modifier = 1) {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const { rounds } = this.splitRounds(raw || "1d100")
    if (rounds > config.maxRounds) return `最多一次掷 ${config.maxRounds} 轮。`
    const name = this.getUserName(subject)
    const results = []
    for (let i = 0; i < rounds; i += 1) {
      const roll = this.rollD100(modifier)
      results.push(renderTemplate(config.templates.bonus, {
        name,
        kind: modifier > 0 ? "奖励骰" : "惩罚骰",
        diceText: roll.diceText,
        value: roll.value
      }))
    }
    return results.join("\n")
  }

parseCheckArgs(raw = "") {
    let text = String(raw || "").trim()
    let difficulty = 0
    // sealdice 表达式形式：(N)M = N 轮对 M 检定（.ra(1)50 / .rab3(1)50）
    const paren = text.match(/^\((\d+)\)\s*(\d+)$/)
    if (paren) return { skill: "检定", target: Number(paren[2]!), modifier: 0, difficulty: 0, rounds: Number(paren[1]!) }
    // 难度前缀：可能独立成词（.ra 困难 侦查 60）或紧贴技能（.ra 困难侦查60）
    const spaceSplit = text.split(/\s+/)
    const first = this.extractDifficultyPrefix(spaceSplit[0] || "")
    if (first.difficulty) {
      difficulty = first.difficulty
      if (first.rest) spaceSplit[0] = first.rest
      else spaceSplit.shift()
      text = spaceSplit.join(" ")
    } else {
      const compact = this.extractDifficultyPrefix(text)
      if (compact.difficulty && compact.rest && /[\u4e00-\u9fa5A-Za-z]/.test(compact.rest[0]!)) {
        difficulty = compact.difficulty
        text = compact.rest
      }
    }
    const parts = text.split(/\s+/).filter(Boolean)
    // sealdice 多轮前缀：3#技能 / 3# 技能 / #3 技能（.rab#3 的轮数由命令头解析，
    // 这里兜参数区写法，防止 N#/#N 混进技能名）
    let rounds = 0
    if (/^\d+#$/.test(parts[0] || "")) {
      rounds = Number(parts[0]!.slice(0, -1))
      parts.shift()
    } else if (/^#\d+$/.test(parts[0] || "")) {
      rounds = Number(parts[0]!.slice(1))
      parts.shift()
    } else if (parts[0]) {
      const lead = parts[0].match(/^(\d+)#(?=\S)/)
      if (lead) {
        rounds = Number(lead[1]!)
        parts[0] = parts[0]!.slice(lead[0].length)
      }
    }
    let modifier = 0
    let bonusLead = /^(b|奖励|奖励骰)(\d+)?$/i.exec(parts[0] || "")
    if (bonusLead) { modifier = Number(bonusLead[2] || 1); parts.shift() }
    else {
      const penaltyLead = /^(p|惩罚|惩罚骰)(\d+)?$/i.exec(parts[0] || "")
      if (penaltyLead) { modifier = -Number(penaltyLead[2] || 1); parts.shift() }
    }
    // sealdice 技能修正后缀：侦查+10 / 斗殴-5（作用于卡值/默认值/显式值）
    let offset = 0
    const offsetToken = parts.length ? parts[parts.length - 1]!.match(/^([.+\-])(\d+)$/) : null
    if (offsetToken && parts.length >= 2) {
      offset = Number(offsetToken[1]! + offsetToken[2]!)
      parts.pop()
    }
    const splitSkillOffset = (name:string) => {
      const m = String(name || "").match(/^(.+?)([+\-]\d+)$/)
      return m ? { skill: m[1]!, offset: Number(m[2]!) } : { skill: name, offset: 0 }
    }
    // 目标值取最后一个数字/表达式 token（sealdice 值在末尾且支持表达式，如 50+10）
    let valueIndex = -1
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (/^[\d.+\-*/%()dDkhl]+$/.test(parts[i]!) && /\d/.test(parts[i]!)) { valueIndex = i; break }
    }
    if (valueIndex < 0) {
      const compact = parts.join(" ")
      // 紧贴修正优先：侦查+10（避免被末尾数字截断成「侦查+ 对10检定」）
      const compactOffset = compact.match(/^(.+?)([+\-]\d+)$/)
      if (compactOffset && compactOffset[1]!.trim() && !/^[+\-]/.test(compactOffset[1]!.trim())) {
        const base = normalizeSkillName(compactOffset[1]!)
        return { skill: base || "检定", target: NaN, modifier, difficulty, rounds, offset: offset + Number(compactOffset[2]!) }
      }
      const compactMatch = compact.match(/^(.+?)[\s:=：]*(-?\d+)$/)
      if (compactMatch) {
        const split = splitSkillOffset(normalizeSkillName(compactMatch[1]!))
        return { skill: split.skill, target: Number(compactMatch[2]!), modifier, difficulty, rounds, offset: offset + split.offset }
      }
      const split = splitSkillOffset(compact || "检定")
      return { skill: split.skill || "检定", target: NaN, modifier, difficulty, rounds, offset: offset + split.offset }
    }
    let target = Number(parts[valueIndex])
    if (!/^\d+$/.test(parts[valueIndex]!)) {
      try { target = numericDiceTotal(this.rollExpression(parts[valueIndex], this.getConfig()).total) } catch { target = NaN }
    }
    const skillRaw = parts.slice(0, valueIndex).join(" ") || "检定"
    const split = splitSkillOffset(skillRaw)
    return { skill: split.skill || "检定", target, modifier, difficulty, rounds, offset: offset + split.offset }
  }

handleCheck(subject:Subject, raw = "", options:DiceCheckOptions = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const targetUserId = options.targetUserId || this.getMentionedUserIds(subject)[0]
    const cleanRaw = targetUserId ? stripCqMentions(raw) : raw
    const targetSubject = targetUserId ? this.withSubject(subject, targetUserId) : subject
    const parsed = this.parseCheckArgs(cleanRaw)
    // sealdice 语义：.ra 侦查+10 = 基础值（卡/默认/显式）+ 修正
    const target = Number.isFinite(Number(parsed.target))
      ? Number(parsed.target) + (parsed.offset || 0)
      : (Number.isFinite(this.getTargetValue(parsed.skill, NaN, targetSubject)) ? this.getTargetValue(parsed.skill, NaN, targetSubject) + (parsed.offset || 0) : NaN)
    const modifier = options.modifier ?? parsed.modifier
    if (!Number.isFinite(target)) {
      // 未录卡值：照样掷骰（不过判定线），并提示怎么录入——群里发 .ra格斗 应该有骰可看
      const bare = !String(cleanRaw || "").trim()
      const roll = this.rollD100(modifier)
      const label = bare ? "" : ` ${parsed.skill}`
      return `${this.getUserName(targetSubject)} 进行${label} 检定：${roll.diceText}=${roll.value}（未录卡值，不判档位；录入：.st${label} 60，或带值检定 .ra${label} 60）`
    }
    const difficulty = Number(options.difficulty ?? parsed.difficulty) || 0
    const maxRounds = safeNumber(config.maxRounds, 20, 1, 1000)
    const rounds = Math.max(1, Math.min(maxRounds, Number(options.rounds ?? parsed.rounds) || 1))
    const rule = this.getGroupRule(subject, config)
    const skill = difficulty > 1 ? `${this.difficultyLabel(difficulty)}${resolveSealSkillName(parsed.skill)}` : resolveSealSkillName(parsed.skill)
    const renderOnce = () => {
      const roll = this.rollD100(modifier)
      const level = this.renderCheckLevel(roll.value, target, rule, difficulty)
      // 多轮时用基础单行模板，避免逐轮吐槽文案刷屏
      const template = rounds > 1
        ? (config.templates.check || DEFAULT_TEMPLATES.check)
        : pickCheckTemplate(config.templates, level, config.checkLevels)
      return renderTemplate(template, {
        name: this.getUserName(targetSubject),
        skill,
        target,
        roll: roll.value,
        diceText: roll.diceText,
        level,
        rule
      })
    }
    if (rounds > 1) return Array.from({ length: rounds }, renderOnce).join("\n")
    return renderOnce()
  }

difficultyLabel(difficulty = 0) {
    return { 2: "困难", 3: "极难", 4: "大成功" }[difficulty] || ""
  }

renderCheckLevel(rollValue:number, target:number, rule:string, difficulty = 0) {
    if (difficulty > 1) {
      const normalizedRule = this.normalizeCocRule(rule)
      const { rank } = this.computeCocRank(rollValue, target, normalizedRule, difficulty)
      const pass = rank >= difficulty
      const extra = rank === 4 && rank > difficulty ? "（大成功）" : (!pass && rank === -2) ? "（大失败）" : ""
      return `${this.difficultyLabel(difficulty)}检定${pass ? "成功" : "失败"}${extra}`
    }
    return this.judgeCoc(rollValue, target, rule)
  }

checkLevelRank(level = "") {
    const levels = this.getConfig().checkLevels || DEFAULT_CHECK_LEVELS
    if (level === (levels.critical || "大成功")) return 5
    if (level === (levels.extreme || "极难成功")) return 4
    if (level === (levels.hard || "困难成功")) return 3
    if (level === (levels.success || "成功")) return 2
    if (level === (levels.fail || "失败")) return 1
    if (level === (levels.fumble || "大失败")) return 0
    return -1
  }

rollCheckObject(subject:Subject, raw = "", options:DiceCheckOptions = {}) {
    const config = this.getConfig()
    const parsed = this.parseCheckArgs(raw)
    const target = this.getTargetValue(parsed.skill, parsed.target, subject)
    if (!Number.isFinite(target)) throw new Error(`找不到「${parsed.skill}」的技能值`)
    const modifier = options.modifier ?? parsed.modifier
    const roll = this.rollD100(modifier)
    const rule = this.getGroupRule(subject, config)
    const details = this.judgeCocDetails(roll.value, target, rule)
    return {
      name: this.getUserName(subject),
      skill: parsed.skill,
      target,
      roll: roll.value,
      diceText: roll.diceText,
      level: details.level,
      rank: cocRankToCompareRank(details.displayRank)
    }
  }

handleWho(subject:Subject, raw = "") {
    const items = String(raw || "").split(/[\s,，、]+/).filter(Boolean)
    if (items.length < 2) return "格式：.who 选项1 选项2 选项3 …（随机打乱顺序，常用作身份/顺序分配）"
    const pool = [...items]
    const shuffled:(string|undefined)[] = []
    while (pool.length) shuffled.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0])
    return `随机分配结果：\n${items.map((item, i) => `${item} → ${shuffled[i]}`).join("\n")}`
  }

getTeamMap(subject:Subject, state:DiceState|null = null, config:DiceConfig|null = null) {
    config = config || this.getConfig()
    const groupId = "scene"
    const full = state || this.readState(config)
    full.groups[groupId] ||= {}
    full.groups[groupId].teams ||= {}
    return { teams: full.groups[groupId].teams, groupId, state: full, config }
  }

async handleTeam(subject:Subject, raw = "") {
    const config = this.getConfig()
    const text = String(raw || "").trim()
    const { teams, state } = this.getTeamMap(subject, null, config)
    if (!text || /^(list|列表|帮助|help)$/i.test(text)) {
      const names = Object.keys(teams)
      if (!names.length) return "当前群还没有团队。用法：.team 队名 add @成员 ｜ .team 队名 ra 技能 ｜ .team 队名 draw 2"
      return names.map(name => `【${name}】${teams[name]!.length} 人：${teams[name]!.map(id => this.getUserName(this.withSubject(subject,id))).join("、")}`).join("\n")
    }
    const match = text.match(/^(\S+)\s+([\s\S]+)$/)
    if (!match) return "用法：.team 队名 add @成员 ｜ del @成员 ｜ clear ｜ call ｜ draw [N] ｜ st ｜ ra/rc 技能"
    const teamName = match[1]!.slice(0, 30)
    const action = match[2]!.trim()
    const members = () => teams[teamName] || []
    const ensureTeam = () => { teams[teamName] ||= []; return teams[teamName] }

    if (/^add/i.test(action)) {
      const ids = this.getMentionedUserIds(subject)
      const botId = String(this.context.botUserId || "")
      const valid = ids.filter(id => id !== botId)
      if (!valid.length) return "必须 @ 至少一名成员（不能是骰子自己或@全体）。"
      const team = ensureTeam()
      for (const id of valid) if (!team.includes(id)) team.push(id)
      return `已添加 ${valid.length} 名玩家至团队 ${teamName}（现 ${team.length} 人）。`
    }
    if (/^(del|rm|delete|remove)/i.test(action)) {
      if (!teams[teamName]) return `没有叫 ${teamName} 的团队，或它已被清除。`
      const ids = this.getMentionedUserIds(subject)
      const before = teams[teamName]!.length
      teams[teamName] = teams[teamName].filter(id => !ids.includes(id))
      return `已从团队 ${teamName} 删除 ${before - teams[teamName]!.length} 名玩家（现 ${teams[teamName]!.length} 人）。`
    }
    if (/^clear/i.test(action)) {
      if (!teams[teamName]) return `没有叫 ${teamName} 的团队，或它已被清除。`
      delete teams[teamName]
      return `清空了团队 ${teamName}。`
    }
    if (/^call/i.test(action)) {
      const team = members()
      if (!team.length) return `团队 ${teamName} 没有成员。`
      return `呼叫 ${teamName}：` + team.map(id => this.memberLabel(id)).join(" ")
    }
    if (/^draw/i.test(action)) {
      const team = members()
      if (!team.length) return `团队 ${teamName} 没有成员。`
      const count = Math.min(team.length, Math.max(1, Number(action.match(/\d+/)?.[0]) || 1))
      const pool = [...team]
      const picked:string[] = []
      while (picked.length < count) picked.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]!)
      return (count === 1
        ? `从团队 ${teamName} 中随机抽取到：` + picked.map(id => this.memberLabel(id)).join(" ")
        : `从团队 ${teamName} 中随机抽取 ${count} 名成员：` + picked.map(id => this.memberLabel(id)).join(" "))
    }
    if (/^(st|show|查看)$/i.test(action)) {
      const team = members()
      if (!team.length) return `团队 ${teamName} 没有成员。`
      return `队伍 ${teamName} 的属性：\n` + team.map(id => {
        const userSubject = this.withSubject(subject, id)
        return `${this.getUserName(userSubject)}：${this.renderCard(userSubject, this.getActiveCard(userSubject, state), config).split("\n").slice(2).join("；")}`
      }).join("\n")
    }
    if (/^(ra|rc|检定)\b/i.test(action) || /^ra/i.test(action) || /^rc/i.test(action)) {
      const team = members()
      if (!team.length) return `团队 ${teamName} 没有成员。`
      const expr = action.replace(/^(ra|rc|检定)\s*/i, "")
      const lines = []
      for (const id of team) {
        const userSubject = this.withSubject(subject, id)
        try {
          lines.push(this.rollCheckObject(userSubject, expr || "斗殴"))
        } catch { }
      }
      if (!lines.length) return "团队检定没有产生任何结果，请检查技能名。"
      return `团队 ${teamName} 检定 ${expr}：\n` + lines.map(l => `${l.name}：${l.diceText}=${l.roll}/${l.target} ${l.level}`).join("\n")
    }
    // 无动作：视为创建/查看
    ensureTeam()
    return `团队 ${teamName} 已就绪（现 ${teams[teamName]!.length} 人）。add @成员 添加；ra 技能 全队检定。`
  }

handleOpposed(subject:Subject, raw = "") {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const text = String(raw || "").trim()
    const parts = text.split(/\s+(?:vs|VS|对抗)\s+/)
    let leftRaw = ""
    let rightRaw = ""
    let rightSubject = subject
    const mentioned = this.getMentionedUserIds(subject)
    let leftSubject = subject
    if (parts.length >= 2) {
      leftRaw = parts[0]!
      rightRaw = parts.slice(1).join(" vs ")
      // .rav 技能1 技能2 @A @B：两人各用各的技能对抗（sealdice）
      if (mentioned.length >= 2) {
        const tokens = stripCqMentions(parts[0]!).split(/[\s,，]+/).filter(Boolean)
        if (tokens.length >= 2) {
          leftRaw = tokens[0]!
          rightRaw = tokens[1]!
          leftSubject = this.withSubject(subject, mentioned[0]!)
          rightSubject = this.withSubject(subject, mentioned[1]!)
        }
      }
    } else if (mentioned.length >= 2) {
      const tokens = stripCqMentions(text).split(/[\s,，]+/).filter(Boolean)
      if (tokens.length >= 2) {
        leftRaw = tokens[0]!
        rightRaw = tokens[1]!
        leftSubject = this.withSubject(subject, mentioned[0]!)
        rightSubject = this.withSubject(subject, mentioned[1]!)
      } else {
        leftRaw = stripCqMentions(text)
        rightRaw = leftRaw
        leftSubject = this.withSubject(subject, mentioned[0]!)
        rightSubject = this.withSubject(subject, mentioned[1]!)
      }
    } else if (mentioned.length) {
      leftRaw = stripCqMentions(text)
      rightRaw = leftRaw
      rightSubject = this.withSubject(subject, mentioned[0]!)
    } else {
      return "格式：.rav 斗殴 60 vs 斗殴 50 ｜ .rav 斗殴 @对方 ｜ .rav 侦查 斗殴 @A @B（两人各用各的卡）"
    }
    try {
      const left = this.rollCheckObject(leftSubject, leftRaw)
      const right = this.rollCheckObject(rightSubject, rightRaw)
      // sealdice 语义：双方成功等级相同视为平局（其属性比较分支已被官方注释停用）
      let winner = "平手"
      if (left.rank !== right.rank) winner = left.rank > right.rank ? `${left.name} 胜出` : `${right.name} 胜出`
      const leftText = `${left.name}：${left.diceText}=${left.roll}/${left.target} ${left.level}`
      const rightText = `${right.name}：${right.diceText}=${right.roll}/${right.target} ${right.level}`
      return renderTemplate(config.templates.opposed, { left: leftText, right: rightText, winner })
    } catch (error) {
      return `对抗检定失败：${diceError(error)}`
    }
  }

async handleSan(subject:Subject, raw = "") {
    const config = this.getConfig()
    let text = String(raw || "").trim()
    // sealdice 关键字参数：--half 扣除减半；--cap=N 扣除上限
    let halfLoss = false
    let lossCap = 0
    text = text.replace(/--half\b\s*/gi, () => { halfLoss = true; return "" })
    text = text.replace(/--cap\s*=\s*(\d+)\s*/gi, (_, n) => { lossCap = Number(n); return "" })
    text = text.trim()
    // sealdice：.sc [b|p] 前缀 = SAN 检定带奖惩骰
    let bpModifier = 0
    text = text.replace(/^([bp])(\d*)\s+/i, (_, kind, n) => {
      bpModifier = (kind.toLowerCase() === "b" ? 1 : -1) * (Number(n) || 1)
      return ""
    }).trim()
    // sealdice：.sc <失败时掉san> 单参简易写法 = 成功扣 0（仅接受表达式形态）
    const single = /^[\d.+\-*/%()dDkhl]+$/.test(text) && /\d/.test(text) && !text.includes("/") ? [text, text] : null
    const m = text.match(/^(\S+)\s*\/\s*(\S+)(?:\s+(\d+))?/)
    if (!m && !single) return "格式：.sc 成功损失/失败损失 [当前SAN]，例如 .sc 1/1d6 60、.sc 1d6（简易）、.sc b 1/1d6（奖惩骰）"
    // sealdice 代骰：.sc 1/1d6 @某人 → 用对方的卡扣 SAN
    const scDelegate = this.resolveDelegate(subject)
    const scSubject = scDelegate.subject
    const successExpr = m ? m[1]! : "0"
    const failExpr = m ? m[2]! : single![1]!
    const sanHint = m ? m[3]! : undefined
    const target = this.getTargetValue("SAN", sanHint, scSubject)
    if (!Number.isFinite(target)) return "找不到当前 SAN。请写成：.sc 1/1d6 60，或先用 .st SAN=60"
    if (!sanHint) {
      const currentState = this.readState(config)
      const currentCard = this.getActiveCard(scSubject, currentState)
      if (this.isCardLocked(currentCard)) return this.lockedCardReply(currentCard)
    }
    const roll = this.rollD100(bpModifier)
    const rule = this.getGroupRule(subject, config)
    const details = this.judgeCocDetails(roll.value, target, rule)
    const level = details.level
    const lossExpr = details.displayRank > 0 ? successExpr : failExpr
    // sealdice：大失败时损失骰取最大值（BigFailDiceOn）
    const isBigFail = details.displayRank === -2
    const lossRandom = isBigFail ? () => 0.999999 : undefined
    let loss = numericDiceTotal(this.rollExpression(lossExpr, config, lossRandom).total)
    if (halfLoss) loss = Math.floor(loss / 2)
    if (lossCap > 0 && loss > lossCap) loss = lossCap
    let sanAfter = Math.max(0, target - loss)
    let insanity = loss >= 5 ? `；单次损失 >=5，建议进行 INT 检定判定临时疯狂` : ""
    if (!sanHint) {
      const state = this.readState(config)
      const card = this.getActiveCard(scSubject, state)
      if (Number.isFinite(Number(card.attrs?.SAN))) {
        card.attrs.SAN = sanAfter
        card.sanLossLog ||= {}
        const day = this.getTodayKey(new Date(this.context.source.at), config)
        const previous = card.sanLossLog[day]
        const previousLoss = Number(typeof previous === "object" ? previous.loss : previous) || 0
        const baseline = Number(typeof previous === "object" ? previous.baseline : NaN)
        const dayBaseline = Number.isFinite(baseline) ? baseline : target + previousLoss
        const dayLoss = previousLoss + loss
        card.sanLossLog[day] = { loss: dayLoss, baseline: dayBaseline }
        const indefiniteThreshold = Math.max(1, Math.floor(dayBaseline / 5))
        if (dayLoss >= indefiniteThreshold) {
          insanity += `；今日累计损失 ${dayLoss}，达到当日初始 SAN 的五分之一，建议进入不定疯狂判定`
        }
      }
    }
    if (sanAfter <= 0) insanity += "；SAN 归零"
    return renderTemplate(config.templates.san, {
      name: this.getUserName(scSubject),
      target,
      roll: roll.value,
      diceText: roll.diceText,
      level,
      loss,
      sanAfter,
      insanity
    })
  }

async handleEn(subject:Subject, raw = "") {
    const config = this.getConfig()
    const text = String(raw || "").trim()
    // 批量成长：.en 技能1 技能2 …（全部按人物卡数值结算，sealdice 语义）
    const tokens = text.split(/[\s,，]+/).filter(Boolean)
    // sealdice：.en 技能[值] +成功成长值 / +失败成长值/成功成长值
    const gainToken = text.match(/\+([^\s+/]+)(?:\/([^\s+/]+))?\s*$/)
    const tokensBase = gainToken ? text.slice(0, text.lastIndexOf(gainToken[0])).split(/[\s,，]+/).filter(Boolean) : tokens
    const skillTokens = tokensBase.filter(token => !/^\d+$/.test(token) && !/^\+/.test(token))
    const numberTokens = tokensBase.filter(token => /^\d+$/.test(token))
    if (gainToken && skillTokens.length >= 2) {
      return "带自定义成长值（+N）的批量成长暂不支持，请逐个 .en，或用 .en 技能1 技能2 走默认 +1d10。"
    }
    if (skillTokens.length >= 2) {
      if (numberTokens.length) return "批量成长按人物卡数值结算，不带数值；请写 .en 技能1 技能2，或逐个 .en 技能 数值。"
      const state = this.readState(config)
      const card = this.getActiveCard(this.resolveDelegate(subject).subject, state)
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const lines = []
      let changed = false
      for (const token of skillTokens.slice(0, 20)) {
        const rawKey = normalizeSkillName(token)
        const attr = ATTR_ALIASES[token] || ATTR_ALIASES[rawKey]
        const storedValue = attr ? card.attrs?.[attr] : sealSkillLookupKeys(rawKey).reduce<number|undefined>((found, k) => found ?? card.skills?.[k], undefined)
        const target = Number(storedValue)
        if (!Number.isFinite(target)) {
          lines.push(`${token}：找不到技能值，请先 .st ${token} 60`)
          continue
        }
        const roll = this.rollD100(0).value
        const success = roll > target
        const gain = success ? numericDiceTotal(this.rollExpression("1d10", config).total) : 0
        let result = "成长失败"
        if (success) {
          const after = target + gain
          if (attr) card.attrs[attr] = after
          else card.skills[rawKey] = after
          changed = true
          result = `成长成功，增加 ${gain}（${target}→${after}，已写入人物卡）`
        }
        lines.push(renderTemplate(config.templates.en, {
          name: this.getUserName(subject),
          skill: token,
          target,
          roll,
          result
        }))
      }
      return lines.join("\n")
    }
    // 有自定义成长值(+N/+F/S)时先剥离，避免 +1/2 被当数值 token 解析
    const parsed = this.parseCheckArgs(gainToken ? tokensBase.join(" ") : raw)
    // sealdice 代骰：.en 技能 @某人 → 成长对方的卡（读写都用对方事件）
    const enDelegate = this.resolveDelegate(subject)
    const enSubject = enDelegate.subject
    const state = this.readState(config)
    const card = this.getActiveCard(enSubject, state)
    const rawKey = normalizeSkillName(parsed.skill)
    const attr = ATTR_ALIASES[parsed.skill] || ATTR_ALIASES[rawKey]
    // sealdice 语义：成长按"当前值"=卡值优先，未录但有官方默认(如 神秘学=5)时按默认值
    const storedValue = attr
      ? card.attrs?.[attr]
      : sealSkillLookupKeys(rawKey).reduce<number|undefined>((found, k) => found ?? card.skills?.[k], undefined) ?? this.getTargetValue(parsed.skill, NaN, enSubject)
    const key = rawKey
    const usesCardValue = !Number.isFinite(Number(parsed.target))
    const target = usesCardValue ? Number(storedValue) : Number(parsed.target)
    if (!Number.isFinite(target)) return `找不到「${parsed.skill}」的技能值。请写成：.en ${parsed.skill} 60`
    if (usesCardValue && this.isCardLocked(card)) return this.lockedCardReply(card)
    const roll = this.rollD100(0).value
    const success = roll > target
    // sealdice 语义：成功加 <成功成长值>（默认 1d10），失败加 <失败成长值>（默认 0）
    const successGain = gainToken ? numericDiceTotal(this.rollExpression(gainToken[1], config).total) : numericDiceTotal(this.rollExpression("1d10", config).total)
    const failGain = gainToken && gainToken[2] ? numericDiceTotal(this.rollExpression(gainToken[2], config).total) : 0
    const gain = success ? successGain : failGain
    let result = gain > 0 ? `成长失败，但按设定增加 ${gain}` : "成长失败"
    if (success && usesCardValue) {
      const after = Number(storedValue) + gain
      if (attr) card.attrs[attr] = after
      else card.skills[key] = after
      result = `成长成功，增加 ${gain}（${target}→${after}，已写入人物卡）`
    } else if (success) {
      result = `成长成功，增加 ${gain}（使用临时技能值，未修改人物卡）`
    } else if (!success && failGain > 0 && usesCardValue) {
      const after = Number(storedValue) + failGain
      if (attr) card.attrs[attr] = after
      else card.skills[key] = after
      result = `成长失败，按 +失败/成功 设定增加 ${failGain}（${target}→${after}，已写入人物卡）`
    }
    return renderTemplate(config.templates.en, {
      name: this.getUserName(enSubject),
      skill: parsed.skill,
      target,
      roll,
      result
    })
  }

generateCoc() {
    const times5 = (expr:string) => numericDiceTotal(this.rollExpression(expr, this.getConfig()).total) * 5
    const attrs:Record<string,number> = {
      STR: times5("3d6"),
      CON: times5("3d6"),
      SIZ: times5("2d6+6"),
      DEX: times5("3d6"),
      APP: times5("3d6"),
      INT: times5("2d6+6"),
      POW: times5("3d6"),
      EDU: times5("2d6+6"),
      LUCK: times5("3d6")
    }
    attrs.SAN = attrs.POW!
    attrs.HP = Math.floor((attrs.CON! + attrs.SIZ!) / 10)
    attrs.MP = Math.floor(attrs.POW! / 5)
    return attrs
  }

formatCocRow(attrs:Record<string,number> = {}, index = 0, options:{noLuck?:boolean} = {}) {
    const primaryTotal = COC_PRIMARY_ATTRS.reduce((sum, key) => sum + (Number(attrs[key]) || 0), 0)
    const luck = Number(attrs.LUCK) || 0
    const totalText = options.noLuck ? String(primaryTotal) : `${primaryTotal}/${primaryTotal + luck}`
    const entries = COC_DISPLAY_ATTRS
      .filter(key => !options.noLuck || key !== "LUCK")
      .map(key => `${COC_ATTR_LABELS[key] || key} ${attrs[key]}`)
      .join(" / ")
    return `${index > 0 ? `${index}. ` : ""}${entries} ｜ ${totalText}`
  }

parseCocArgs(raw = "") {
    const text = normalizeDiceExpression(raw).replace(/#/g, "")
    const count = Math.min(this.getConfig().maxRounds, Math.max(1, Number(text.match(/\d+/)?.[0]) || 1))
    const noLuck = /不含运|不含幸运|无运|noluck|no_luck/.test(String(raw || "").toLowerCase())
    return { count, noLuck }
  }

handleCoc(subject:Subject, raw = "") {
    const config = this.getConfig()
    const { count, noLuck } = this.parseCocArgs(raw)
    const rows = []
    for (let i = 0; i < count; i += 1) {
      const attrs = this.generateCoc()
      rows.push(this.formatCocRow(attrs, count > 1 ? i + 1 : 0, { noLuck }))
    }
    const attributes = rows.join("\n")
    return renderTemplate(config.templates.coc, { name: this.getUserName(subject), attributes })
  }

handleJrrp(subject:Subject) {
    const config = this.getConfig()
    const userId = String(subject.subjectId || "")
    let hash = 2166136261
    for (const char of `${this.getTodayKey(new Date(this.context.source.at), config)}:${userId}`) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    const value = (hash >>> 0) % 100 + 1
    return renderTemplate(config.templates.jrrp, {
      name: this.getUserName(subject),
      value,
      comment: pickJrrpComment(value, config.jrrpComments)
    })
  }

handleDb(subject:Subject, raw = "") {
    const config = this.getConfig()
    const text = String(raw || "").trim()
    const parts = text.match(/\d+/g)?.map(Number) || []
    let sum = 0
    if (parts.length >= 2) {
      sum = parts[0]! + parts[1]!
    } else {
      const state = this.readState(config)
      const card = this.getActiveCard(subject, state)
      sum = (Number(card.attrs?.STR) || 0) + (Number(card.attrs?.SIZ) || 0)
    }
    if (!sum) return "格式：.db STR SIZ，或先用 .st STR=50 SIZ=60"
    let db = "-2", build = -2
    if (sum >= 65 && sum <= 84) { db = "-1"; build = -1 }
    else if (sum >= 85 && sum <= 124) { db = "0"; build = 0 }
    else if (sum >= 125 && sum <= 164) { db = "+1D4"; build = 1 }
    else if (sum >= 165 && sum <= 204) { db = "+1D6"; build = 2 }
    else if (sum >= 205) {
      const extra = Math.floor((sum - 205) / 80)
      db = `+${2 + extra}D6`
      build = 3 + extra
    }
    return renderTemplate(config.templates.db, { name: this.getUserName(subject), sum, db, build })
  }

async handleSt(subject:Subject, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    // sealdice 代骰：.st 侦查 60 @某人 → 录到对方的卡（KP 录 NPC/玩家）
    const stSubject = this.resolveDelegate(subject).subject
    const user = this.ensureUser(state, stSubject)
    const card = user.cards[user.activeCard]!
    const text = String(raw || "").trim()
    const groupId = "scene"
    const group = (state.groups[groupId] ||= {})
    if (!text) return this.renderCard(stSubject, card, config, { groupFmt: group.stFmt })
    if (/^(show|查看|查询)$/i.test(text)) return this.renderCard(stSubject, card, config, { groupFmt: group.stFmt })
    const fmtMatch = text.match(/^fmt\s*([\s\S]*)$/i)
    if (fmtMatch) {
      const arg = fmtMatch[1]!.trim()
      if (!arg) return `当前群人物卡模板：${group.stFmt || "（未设置）"}\n设置：.st fmt HP:{hp}/{hpmax} SAN:{san}\n模板里 {属性名} 会替换为对应数值；.st fmt clr 恢复默认（群管理可改）。`
      if (/^(clr|clear|清除|重置)$/i.test(arg)) {
        if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以修改本群人物卡模板。"
        delete group.stFmt
        return "人物卡模板已恢复默认展示。"
      }
      if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以修改本群人物卡模板。"
      if (arg.length > 300) return "模板太长（上限 300 字符）。"
      group.stFmt = arg
      return `人物卡模板已保存：${arg}\n.st show 将按此格式展示。`
    }
    if (this.isCardLocked(card)) return this.lockedCardReply(card)
    const clearMatch = text.match(/^(clr|clear|清空)(?:\s+(.+))?$/i)
    if (clearMatch) {
      const target = String(clearMatch[2] || "").trim()
      if (!target || /^(all|全部)$/i.test(target)) {
        card.attrs = {}
        card.skills = {}
        return "当前人物卡已清空。"
      }
      const key = ATTR_ALIASES[target] || normalizeSkillName(target)
      delete card.attrs?.[key]
      delete card.skills?.[key]
      return `已清空：${key}`
    }
    if (/^(showall|显示全部)$/i.test(text)) return this.renderCard(stSubject, card, config, { showAll: true })
    const hideMatch = text.match(/^(hide|隐藏)\s+(.+)$/i)
    if (hideMatch) {
      const key = normalizeSkillName(hideMatch[2])
      const attrKey = ATTR_ALIASES[key] || key
      card.hiddenAttrs ||= []
      if (!card.hiddenAttrs.includes(attrKey)) card.hiddenAttrs.push(attrKey)
      return `已隐藏 ${key}，用 .st showall 可查看全部`
    }
    if (/^(unhide|取消隐藏)\s+/i.test(text)) {
      const key = normalizeSkillName(text.replace(/^(unhide|取消隐藏)\s+/i, ""))
      const attrKey = ATTR_ALIASES[key] || key
      card.hiddenAttrs = (card.hiddenAttrs || []).filter(k => k !== attrKey)
      return `已取消隐藏 ${key}`
    }
    const showMatch = text.match(/^(show|查看|查询)\s+(.+)$/i)
    if (showMatch) {
      const keyRaw = showMatch[2]!.trim()
      const key = normalizeSkillName(keyRaw)
      const attr = ATTR_ALIASES[keyRaw] || ATTR_ALIASES[key]
      const value = attr ? card.attrs?.[attr] : card.skills?.[key]
      return value === undefined ? `没有找到：${keyRaw}` : `${attr || key}=${value}`
    }
    const delMatch = text.match(/^(del|删除)\s+(.+)$/i)
    if (delMatch) {
      const keys = delMatch[2]!.split(/[,\s，]+/).filter(Boolean)
      const removed = []
      for (const keyRaw of keys) {
        const attr = ATTR_ALIASES[keyRaw]
        const key = attr || normalizeSkillName(keyRaw)
        if (attr && Object.prototype.hasOwnProperty.call(card.attrs || {}, attr)) {
          delete card.attrs[attr]
          removed.push(attr)
        } else if (Object.prototype.hasOwnProperty.call(card.skills || {}, key)) {
          delete card.skills[key]
          removed.push(key)
        }
      }
      if (!removed.length) return "没有找到要删除的字段。"
      return `已删除：${removed.join("，")}`
    }
    const updates:[string,number][] = []
    const compactExpressionTokens = text.split(/[,\s，]+/).filter(Boolean)
    for (const token of compactExpressionTokens) {
      const m = token.match(/^(.+?)([:=：])(.+)$/) || token.match(/^(.+?)([+\-])(.+)$/)
      if (!m || !/[dD+\-*/%()]/.test(m[3]!)) continue
      const keyRaw = m[1]!.trim()
      const operator = m[2]!
      const expr = m[3]!.trim()
      const attr = ATTR_ALIASES[keyRaw]
      const normalizedKey = attr || normalizeSkillName(keyRaw)
      const current = attr ? Number(card.attrs?.[attr]) || 0 : Number(card.skills?.[normalizedKey]) || 0
      let delta
      try {
        delta = numericDiceTotal(this.rollExpression(expr, config).total)
      } catch {
        continue
      }
      const value = operator === "+" ? current + delta : operator === "-" ? current - delta : delta
      if (attr) card.attrs[attr] = value
      else card.skills[normalizedKey] = value
      updates.push([normalizedKey, value])
    }
    if (updates.length) {
      return renderTemplate(config.templates.cardSaved, { name: this.getUserName(stSubject), updates: formatUpdates(updates) })
    }
    const pairs = text.match(/[^,\s，]+(?:\s*[:=：]\s*|\s+)[+\-]?\d+|[^,\s，]+[+\-]\d+/g) || []
    const compactPairs = []
    // 紧凑中文格式「.st 敏捷0力量-1本能0生命6」(无分隔符):逐段"名+带符号数值"。
    // 必须先于 pairs 判定——贪婪的 [+-]\d+ 配对会把整串误切成"敏捷0力量=-1"这种垃圾键
    const isCompactCjkStats = !/[\s,，]/.test(text) && /[\u4e00-\u9fa5][+\-]?\d/.test(text) && !/[:=：]/.test(text)
    if (isCompactCjkStats) {
      const compactRe = /([A-Za-z\u4e00-\u9fa5_·•]+?)([+\-]?\d+)/g
      let match
      while ((match = compactRe.exec(text))) compactPairs.push(`${match[1]!}=${match[2]!}`)
    } else if (!pairs.length) {
      const compactRe = /([^\d\s,，:=：]+)(\d+)/g
      let match
      while ((match = compactRe.exec(text))) compactPairs.push(`${match[1]!}=${match[2]!}`)
    }
    for (const pair of (compactPairs.length ? compactPairs : pairs)) {
      const m = pair.match(/^(.+?)(?:\s*[:=：]\s*|\s+)([+\-]?\d+)$/) || pair.match(/^(.+?)([+\-]\d+)$/)
      if (!m) continue
      const keyRaw = m[1]!.trim()
      const rawValue = String(m[2]!)
      const attr = ATTR_ALIASES[keyRaw]
      const normalizedKey = attr || normalizeSkillName(keyRaw)
      const current = attr ? Number(card.attrs?.[attr]) || 0 : Number(card.skills?.[normalizedKey]) || 0
      const value = /^[+\-]/.test(rawValue) && !/[=:：]/.test(pair)
        ? current + Number(rawValue)
        : Number(rawValue)
      if (!Number.isFinite(value)) continue
      if (attr) card.attrs[attr] = value
      else card.skills[normalizedKey] = value
      updates.push([normalizedKey, value])
    }
    if (!updates.length) return "没有识别到属性或技能。格式：.st STR=50 侦查=60 或 .st 侦查 60"
    return renderTemplate(config.templates.cardSaved, { name: this.getUserName(stSubject), updates: formatUpdates(updates) })
  }

renderCard(subject:Subject, card:DiceCard, config = this.getConfig(), options:{groupFmt?:string|undefined;showAll?:boolean} = {}) {
    // 群级 .st fmt 模板：{属性名} 替换为对应数值（属性/技能均可引用）
    if (options.groupFmt && !options.showAll) {
      const lookup:Record<string,number> = {}
      for (const [key, value] of Object.entries({ ...(card.attrs || {}), ...(card.skills || {}) })) {
        lookup[String(key).toLowerCase()] = value
      }
      const expanded = String(options.groupFmt).replace(/\{([^{}\s]{1,40})\}/g, (_, key) => {
        const value = lookup[String(key).toLowerCase()]
        return value === undefined ? "-" : String(value)
      })
      return renderTemplate(config.templates.card, { name: this.getUserName(subject), card: expanded })
    }
    const hidden = new Set(options.showAll ? [] : (card.hiddenAttrs || []))
    const attrs = Object.entries(card.attrs || {})
      .filter(([k]) => options.showAll || !hidden.has(k))
      .map(([k, v]) => `${k}:${v}`).join(" ")
    const skills = Object.entries(card.skills || {})
      .filter(([k]) => options.showAll || !hidden.has(k))
      .map(([k, v]) => `${k}:${v}`).join(" ")
    const cardText = [
      `角色：${card.name || this.getUserName(subject)}`,
      `状态：${this.isCardLocked(card) ? "已锁定" : "可编辑"}`,
      attrs ? `属性：${attrs}` : "属性：暂无",
      skills ? `技能：${skills}` : "技能：暂无"
    ].join("\n")
    return renderTemplate(config.templates.card, { name: this.getUserName(subject), card: cardText })
  }

async handlePc(subject:Subject, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const user = this.ensureUser(state, subject)
    const text = String(raw || "").trim()
    const [cmd, ...rest] = text.split(/\s+/)
    const name = rest.join(" ").trim()
    if (!cmd || /^(list|列表)$/i.test(cmd)) {
      const cards = Object.entries(user.cards).map(([cardName, card]) => `${cardName}${this.isCardLocked(card) ? "🔒" : ""}`)
      return `人物卡：${cards.join("，")}\n当前：${user.activeCard}`
    }
    if (/^(rename|改名)$/i.test(cmd)) {
      const renameArgs = name.split(/\s+/).filter(Boolean)
      if (!renameArgs.length) return "格式：.pc rename 新名字 ｜ .pc rename 旧名字 新名字"
      let targetName = null
      let newName = renameArgs[renameArgs.length - 1]!
      if (renameArgs.length >= 2) targetName = renameArgs[0]!
      const current = targetName || user.activeCard
      if (!user.cards[current]) return `没有找到人物卡：${current}`
      if (user.cards[current].locked) return `人物卡「${current}」已锁定；请先用 .pc unlock 解锁。`
      if (user.cards[newName]) return `已存在同名人物卡：${newName}`
      user.cards[newName] = { ...user.cards[current], name: newName }
      delete user.cards[current]
      if (user.activeCard === current) user.activeCard = newName
      return `人物卡已改名：${current} → ${newName}`
    }
    if (/^(new|新增|创建|save|保存)$/i.test(cmd)) {
      if (!name) return "格式：.pc new 角色名"
      user.cards[name] = user.cards[name] || { name, attrs: {}, skills: {} }
      user.activeCard = name
      return `已保存并切换人物卡：${name}${await this.syncAutoGroupCard(subject, user.cards[name].name || name, state, config)}`
    }
    if (/^(use|切换|使用|load|载入)$/i.test(cmd)) {
      if (!user.cards[name]) return `没有找到人物卡：${name}`
      user.activeCard = name
      return `已切换人物卡：${name}${await this.syncAutoGroupCard(subject, user.cards[name].name || name, state, config)}`
    }
    if (/^(del|删除)$/i.test(cmd)) {
      if (!user.cards[name]) return `没有找到人物卡：${name}`
      if (this.isCardLocked(user.cards[name])) return this.lockedCardReply(user.cards[name])
      delete user.cards[name]
      user.activeCard = Object.keys(user.cards)[0] || "默认"
      if (!user.cards[user.activeCard]!) user.cards[user.activeCard] = { name: user.nickname || "调查员", attrs: {}, skills: {} }
      return `已删除人物卡：${name}`
    }
    if (/^(tag|标签)$/i.test(cmd)) {
      const card = user.cards[user.activeCard]!
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      card.tags = name ? name.split(/[,\s，]+/).filter(Boolean) : []
      return `当前人物卡标签：${card.tags.join("，") || "无"}`
    }
    if (/^(lock|锁定)$/i.test(cmd)) {
      user.cards[user.activeCard]!.locked = true
      return "当前人物卡已锁定。"
    }
    if (/^(unlock|解锁)$/i.test(cmd)) {
      user.cards[user.activeCard]!.locked = false
      return "当前人物卡已解锁。"
    }
    return "人物卡命令：.pc list / .pc new|save 名字 / .pc use|load 名字 / .pc del 名字 / .pc tag 标签 / .pc lock"
  }

async handleNn(subject:Subject, raw = "") {
    const config = this.getConfig()
    const name = String(raw || "").trim()
    // sealdice：.nn 无参=查看当前角色名；.nn clr=重置回群名片
    if (!name) {
      const user = this.readState(config).users?.[String(subject.subjectId || "")]
      const current = user?.nickname || this.subjectName(subject) || "(未设置)"
      return `当前骰娘昵称：${current}\n.nn <名字> 修改；.nn clr 重置回群名片`
    }
    if (/^(clr|清除|重置)$/i.test(name)) {
      const state = this.readState(config)
      const user = this.ensureUser(state, subject)
      const restore = this.subjectName(subject) || user.nickname || ""
      delete user.nickname
      let suffix = ""
      try {
        if (restore) {
          await this.setGroupCardName(subject, restore)
          suffix = `，群名片已恢复为：${restore}`
        }
      } catch { }
      return `骰娘昵称已清除${suffix}`
    }
    const state = this.readState(config)
    const user = this.ensureUser(state, subject)
    user.nickname = name.slice(0, 30)
    return `骰娘昵称已设置为：${user.nickname}${await this.syncAutoGroupCard(subject, user.nickname, state, config)}`
  }

async handleSetCoc(subject:Subject, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = "scene"
    state.groups[groupId] ||= {}
    const text = String(raw || "").trim()
    if (!text) {
      return [
        `当前群规则：${state.groups[groupId].rule || config.defaultRule}（实际按 ${this.normalizeCocRule(state.groups[groupId].rule || config.defaultRule)} 生效）`,
        "支持 setcoc 0-5：",
        "0: 1大成功；技能<50 时 96-100 大失败，否则 100 大失败",
        "1: 技能>=50 时 1-5 大成功；大失败同 0",
        "2: 1-5 且不超过技能大成功；96-100 且超过技能大失败",
        "3: 1-5 大成功；96-100 大失败",
        "4: 1-5 且不超过技能大成功；100 大失败",
        "5: 1 大成功；100 大失败"
      ].join("\n")
    }
    if (!this.canManageGroupDice(subject)) return "只有经授权的群管理可以修改当前群 COC 房规。"
    if (!this.isValidCocRule(text)) {
      return "规则不认识。请使用：.setcoc 0 / 1 / 2 / 3 / 4 / 5 / 无大失败"
    }
    state.groups[groupId].rule = this.normalizeCocRule(text)
    return `已设置当前群 COC 规则：${state.groups[groupId].rule}`
  }

handleInsanity(type = "ti") {
    const config = this.getConfig()
    const list = type === "li"
      ? (config.insanityTables?.indefinite || DEFAULT_INDEFINITE_INSANITY)
      : (config.insanityTables?.temp || DEFAULT_TEMP_INSANITY)
    if (!list.length) return "疯狂表是空的。"
    const idx = this.rollInt(list.length) - 1
    return renderTemplate(config.templates.insanity, {
      kind: type === "li" ? "总结疯狂" : "临时疯狂",
      index: idx + 1,
      text: list[idx]
    })
  }
}

const migrated=new Set(['drawCard','roll','initiativeRoll','initiative','observer','randomName','rsr','ww','dx','ek','ekgen','bonusRoll','penaltyRoll','team','who','ping','opposed','seaCocCheck','check','numberedCheck','bonusCheck','penaltyCheck','hiddenCheck','sanCheck','enCheck','coc','dnd','nameDnd','dndUtility','st','pc','nn','sn','setCoc','setDiceOption','jrrp','db','ti','li'])
const rules=[...DICE_COMMAND_RULES.filter(rule=>migrated.has(rule.fnc)),{fnc:'team',reg:'^[.。]\\s*team(?![A-Za-z])[\\s\\S]*$'}].map(rule=>({...rule,pattern:new RegExp(rule.reg,'iu')}))
const commandMatch=(command:string)=>rules.find(rule=>rule.pattern.test(command.trim()))
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 const object=value as Record<string,unknown>
 return '{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+canonical(object[key])).join(',')+'}'
}
function freeze<T>(value:T):T {
 if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value)}return value
}
function resolveConfig(input:AgentDiceBuiltinConfig):DiceConfig {
 const supplied=cleanJson(input)
 const allowed=['enabled','maxDiceCount','maxDiceSides','maxRounds','defaultRule','allowHiddenRoll','timeZone','templates','checkLevels','insanityTables','jrrpComments','decks']
 if(Object.keys(supplied).some(key=>!allowed.includes(key)))throw new Error('骰子内核配置无效')
 const decks=supplied.decks??{}
 if(!decks||typeof decks!=='object'||Array.isArray(decks)||Object.keys(decks).length>80||
   Object.entries(decks).some(([name,items])=>!name.trim()||name!==name.trim()||name.length>48||/[\u0000-\u001f\u007f]/u.test(name)||
     !Array.isArray(items)||items.length<1||items.length>200||items.some(item=>typeof item!=='string'||!item.trim()||item.length>800||
       Number(/^::(\d+)::/u.exec(item)?.[1]??1)>100)))throw new Error('牌堆配置无效')
 const config={...defaults,...supplied,...mergeDiceReplyConfig(supplied),decks}
 for(const [key,min,max]of [['maxDiceCount',1,10000],['maxDiceSides',2,100000000],['maxRounds',1,1000]] as const){if(!Number.isSafeInteger(config[key])||config[key]<min||config[key]>max)throw new Error('骰子内核配置无效')}
 if(typeof config.enabled!=='boolean'||typeof config.allowHiddenRoll!=='boolean'||typeof config.defaultRule!=='string'||typeof config.timeZone!=='string')throw new Error('骰子内核配置无效')
 if(Object.values(config.templates).some(value=>typeof value!=='string'||value.length>8000)||Object.values(config.checkLevels).some(value=>typeof value!=='string'||value.length>256)||
   Object.values(config.insanityTables).some(value=>!Array.isArray(value)||value.length>1000||value.some(row=>typeof row!=='string'||row.length>4000)))throw new Error('骰子内核文案无效')
 new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone})
 if(!/^(?:[0-5]|coc7|默认|标准|nofumble|不大失败|无大失败|crit1|大成功1|房规1)$/iu.test(config.defaultRule))throw new Error('骰子房规无效')
 return freeze(config)
}
function validateContext(context:AgentDiceBuiltinContext){
 if(!context||!isPlatformIdentifier(context.source?.messageId)||context.source.messageId==='0'||!isPlatformIdentifier(context.source.authorId)||context.source.authorId!==context.actor?.id||
  !Number.isSafeInteger(context.source.at)||context.source.at<=0||!Number.isFinite(new Date(context.source.at).getTime())||!storageIdentifier(context.actor.id)||typeof context.actor.name!=='string'||!context.actor.name.trim()||context.actor.name.length>256||
  !isPlatformIdentifier(context.groupId)||!Array.isArray(context.members)||context.members.length>4096||new Set(context.members.map(member=>member.id)).size!==context.members.length||
  context.members.some(member=>!storageIdentifier(member.id)||typeof member.name!=='string'||!member.name.trim()||member.name.length>256)||!Array.isArray(context.mentions)||context.mentions.length>128||context.mentions.some(id=>!isPlatformIdentifier(id))||typeof context.allows!=='function')throw new Error('骰子来源或成员快照无效')
 if(!context.allows('player',context.actor.id))throw new Error('骰子命令未获得当前玩家授权')
}

/** A pure, owner-local transition. Source claiming, durable random freezing and delivery belong to the engine. */
export function createAgentDiceBuiltin(input:AgentDiceBuiltinConfig={}) {
 const config=resolveConfig(input)
 const {decks,...previous}=config
 const deck=normalizeDiceDeck(decks,'Core')
 const visibleDecks=Object.keys(decks).filter(name=>!name.startsWith('_'))
 const definitionId='dice:builtin:v1:'+createHash('sha256').update(canonical(Object.keys(decks).length?config:previous)).digest('hex')
 return Object.freeze({
  definitionId,
  isCandidate:(command:string)=>config.enabled&&typeof command==='string'&&!!commandMatch(command),
  async evaluate(request:{readonly state:AgentDiceBuiltinState|null;readonly command:string;readonly context:AgentDiceBuiltinContext;readonly random:()=>number}):Promise<{readonly matched:boolean;readonly state:AgentDiceBuiltinState;readonly effects:readonly AgentDiceBuiltinEffect[];readonly events:readonly AgentDiceBuiltinEvent[];readonly subjectIds?:readonly string[]}>{
   const {command,context}=request,match=commandMatch(command)
   if(!config.enabled||!match)return {matched:false,state:request.state?cleanJson(request.state):{version:1,users:{},scene:{}},effects:[],events:[]}
   validateContext(context)
   if(command.length>16384||/(?:^|[^A-Za-z0-9_])(?:__proto__|prototype|constructor)(?=$|[^A-Za-z0-9_])/u.test(command))throw new Error('骰子命令字段无效')
   let draws=0
   const random=()=>{if(++draws>Math.max(10000,config.maxDiceCount*config.maxRounds*5))throw new Error('单条来源骰数超过限制');const value=request.random();if(!Number.isFinite(value)||value<0||value>=1)throw new Error('骰点随机源无效');return value}
   const runtime=new NeutralBuiltin(config,context,random,request.state)
   const initial=canonical({version:1,users:runtime.state.users,scene:runtime.state.groups.scene||{}})
   const actor=runtime.withSubject({subjectId:context.actor.id},context.actor.id)
   if(runtime.state.groups.scene?.observers?.includes(context.actor.id)&&match.fnc!=='observer')return freeze({matched:true,state:{version:1 as const,users:runtime.state.users,scene:runtime.state.groups.scene||{}},effects:[],events:[]})
   const text=normalizeDiceCommandText(command.trim()),strip=(head:string)=>stripDiceCommand(text,head)
   let output='',hidden=false
   switch(match.fnc){
    case 'drawCard': {
     const name=strip('(draw|抽牌)').trim()
     if (deck && visibleDecks.includes(name)) {
      try {
       output=name+' · '+executeDiceDeck(deck,name,true,{playerName:context.actor.name,
        maxDepth:8,maxDraws:32,maxTextLength:1800},0,runtime.rollInt.bind(runtime))
      } catch { output='此牌堆的抽取规则暂时无法完成。' }
     } else output=name?'牌堆未找到。用 .draw 查看可用牌堆。':
      visibleDecks.length?'可用牌堆：'+visibleDecks.join('、'):'本实例尚未配置牌堆。'
     break
    }
    case 'roll': output=runtime.handleRoll(actor,strip('(r(?![A-Za-z])|roll)'));break
    case 'initiativeRoll':output=await runtime.handleInitiativeRoll(actor,strip('ri'));break
    case 'initiative':output=await runtime.handleInitiative(actor,strip('(init|先攻)'));break
    case 'observer': {const head=/^\.(obon|oboff|ob)\s*([\s\S]*)$/iu.exec(text)!;output=await runtime.handleObserve(actor,head[1]?.toLowerCase()==='obon'?'on':head[1]?.toLowerCase()==='oboff'?'off':head[2]||'');break}
    case 'randomName':output=runtime.handleName(actor,strip('name'));break
    case 'nameDnd':output=runtime.handleNameDnd(actor,strip('namednd'));break
    case 'rsr':output=runtime.handleRsr(actor,strip('rsr'));break
    case 'ww':output=runtime.handleWw(actor,strip('ww'));break
    case 'dx':output=runtime.handleDx(actor,strip('dx'));break
    case 'ek':output=runtime.handleEk(actor,strip('ek'));break
    case 'ekgen':output=runtime.handleEkgen(actor,strip('ekgen'));break
    case 'bonusRoll':case 'penaltyRoll':{const parsed=/^\.(bp|pp)(\d+)?\s*([\s\S]*)$/iu.exec(text)!;output=runtime.handleBonusPenaltyRoll(actor,parsed[3]||'',(Number(parsed[2])||1)*(match.fnc==='bonusRoll'?1:-1));break}
    case 'team':{const raw=strip('(组队|team)'),action=/^\S+\s+([\s\S]+)$/u.exec(raw)?.[1];if(action&&!/^(?:st|show|查看|ra|rc|检定|call|draw)(?:\b|[^A-Za-z])/iu.test(action)&&!context.allows('admin'))throw new Error('团队变更未授权');output=await runtime.handleTeam(actor,raw);break}
    case 'who':output=runtime.handleWho(actor,strip('who'));break
    case 'ping':output='pong！骰子内核在线。';break
    case 'opposed':output=runtime.handleOpposed(actor,strip('rav'));break
    case 'seaCocCheck':{const parsed=/^\.(rab|rap|rahb|rahp|rah|ra)(\d+)?(#)?(\d+)?(b|p)?\s*([\s\S]*)$/iu.exec(text)!;
     const head=(parsed[1]||'ra').toLowerCase(),num=Number(parsed[2])||0,after=Number(parsed[4])||0,suffix=(parsed[5]||'').toLowerCase()
     const modifier=parsed[3]?(head.includes('b')||suffix==='b'?1:head.includes('p')||suffix==='p'?-1:0):head.includes('b')?(num||1):head.includes('p')?-(num||1):undefined
     const rounds=parsed[3]?(after||num||1):(after||(!head.includes('b')&&!head.includes('p')?num:0)||undefined)
     const options={...(modifier===undefined?{}:{modifier}),...(rounds===undefined?{}:{rounds})};hidden=head.includes('h')
     output=hidden?await runtime.handleHiddenCheck(actor,parsed[6]||'',options):runtime.handleCheck(actor,parsed[6]||'',options);break}
    case 'numberedCheck':{const parsed=/^\.(?:ra|rc)([+\-]?\d+)\s*([\s\S]*)$/iu.exec(text)!;output=runtime.handleCheck(actor,parsed[2]||'',{modifier:Number(parsed[1])||0});break}
    case 'check':{const raw=strip('(ra|rc)');output=/^\.rc/iu.test(text)&&runtime.shouldUseDndCheck(actor,raw)?runtime.handleDndCheck(actor,raw):runtime.handleCheck(actor,raw);break}
    case 'bonusCheck':case 'penaltyCheck':{const parsed=/^\.(rb|rp)(\d+)?\s*([\s\S]*)$/iu.exec(text)!;output=runtime.handleCheck(actor,parsed[3]||'',{modifier:(Number(parsed[2])||1)*(match.fnc==='bonusCheck'?1:-1)});break}
    case 'hiddenCheck':hidden=true;output=await runtime.handleHiddenCheck(actor,strip('(rh|rah)'));break
    case 'sanCheck':output=await runtime.handleSan(actor,strip('sc'));break
    case 'enCheck':output=await runtime.handleEn(actor,strip('en'));break
    case 'coc':output=runtime.handleCoc(actor,strip('(coc7?|天命)'));break
    case 'jrrp':output=runtime.handleJrrp(actor);break
    case 'db':output=runtime.handleDb(actor,strip('(db|伤害加值)'));break
    case 'dnd':output=runtime.handleDnd(actor,strip('(dnd5e?|dnd)'));break
    case 'dndUtility':{const parsed=/^\.(buff|ss|cast|longrest|ds)\s*([\s\S]*)$/iu.exec(text)!;output=await runtime.handleDndUtility(actor,parsed[1]||'',parsed[2]||'');break}
    case 'st':output=await runtime.handleSt(actor,strip('st'));break
    case 'pc':output=await runtime.handlePc(actor,strip('pc'));break
    case 'nn':output=await runtime.handleNn(actor,strip('nn'));break
    case 'sn':{const raw=strip('sn'),template=await runtime.applyBuiltinCardTemplate(actor,raw);output=template?`群名片模板已排队：${template}`:await runtime.handleSn(actor,raw);break}
    case 'setCoc':output=await runtime.handleSetCoc(actor,strip('setcoc'));break
    case 'setDiceOption':output=await runtime.handleSetOption(actor,strip('set'));break
    case 'ti':case 'li':output=runtime.handleInsanity(match.fnc);break
   }
   if(output.length>32000||runtime.effects.length>127)throw new Error('骰子结果超过限制')
   const state:AgentDiceBuiltinState={version:1,users:runtime.state.users,scene:runtime.state.groups.scene||{}}
   const events:AgentDiceBuiltinEvent[]=[]
   const source=cleanJson(context.source),subjectIds=[...runtime.subjects]
   if(canonical(state)!==initial||runtime.effects.some(effect=>effect.kind==='card'))events.push({kind:'card_change',source,actorId:context.actor.id,subjectIds,visibility:hidden?'private':'public',command:hidden?'hidden':match.fnc})
   // Hidden result bodies are kept only in the private delivery effect and never enter archiveable events.
   if(output&&!hidden){events.push({kind:'dice_result',source,actorId:context.actor.id,subjectIds,visibility:'public',command:match.fnc,text:output});runtime.effects.push({kind:'public',text:output,eventIndex:events.length-1})}
   else if(output)runtime.effects.push({kind:'public',text:output})
   return freeze(cleanJson({matched:true,state,effects:runtime.effects,events,subjectIds}))
  },
 })
}
