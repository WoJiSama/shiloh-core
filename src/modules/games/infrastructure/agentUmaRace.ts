import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import path from 'node:path'
import type {AgentBindingSnapshot} from '../../../contracts/agentBinding.js'
import type {AgentGroupGameContext,AgentGroupGameHandler,AgentGroupGameSendGuard} from '../../../contracts/agentGames.js'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'
import type {MessageImage} from '../../../contracts/platformConnection.js'
import type {UmaConfig,UmaEvent,UmaLogger,UmaReport} from '../../../contracts/uma.js'
import {agentBindingToken,conversationAddressKey,samePlatformNamespace} from '../../runtime/domain/agentBindings.js'
import {createUmaRaceManager,normalizeUmaRaceConfig} from './uma/UmaRaceManager.js'

export interface AgentUmaRaceOptions {
  readonly config:Readonly<UmaConfig>
  /** Host-owned absolute games root. Package/config baseDir never selects storage. */
  readonly dataDir:string
  readonly logger?:UmaLogger
  readonly renderReport?:(report:UmaReport,context:AgentGroupGameContext)=>Promise<MessageImage|null>
  readonly canAdjustPoints?:(context:AgentGroupGameContext)=>boolean
  readonly authorizeBackground?:(input:{source:IncomingMessage;binding:AgentBindingSnapshot})=>Promise<AgentGroupGameContext|undefined>
}

/** Players retain cross-group scores within one account and Agent. */
export function agentUmaRaceDataDir(dataDir:string,binding:AgentBindingSnapshot):string {
  if(!path.isAbsolute(dataDir))throw new Error('赛马娘数据根目录必须为绝对路径')
  const {account}=binding.target
  const scope=createHash('sha256').update(JSON.stringify([account.platform,account.namespace,account.id,binding.agentId])).digest('hex')
  return path.join(dataDir,scope,'uma-race')
}

// These are the legacy app's explicit command forms, in its original order.
const commands=[
  [/^[.。]赛马娘\s*$/u,'help'],[/^[.。]赛马娘\s*(帮助|help)\s*$/u,'help'],
  [/^[.。]赛马娘\s*(领养|创建|注册)\s+[\s\S]+$/u,'adopt'],[/^[.。]赛马娘\s*重新领养\s+[\s\S]+$/u,'readopt'],
  [/^[.。]赛马娘\s*(弃养|放生)(\s*确认)?\s*$/u,'abandon'],[/^[.。]赛马娘\s*(我的赛马娘|赛马娘信息|属性|六维)\s*$/u,'uma'],
  [/^[.。]赛马娘\s*(词条|小马词条)\s*$/u,'affix'],[/^[.。]赛马娘\s*(重铸|洗练|洗词条)\s*$/u,'reroll'],
  [/^[.。]赛马娘\s*(词条池|词条列表)\s*$/u,'pool'],[/^[.。]赛马娘\s*(训练|训练状态|训练进度)\s*$/u,'training'],
  [/^[.。]赛马娘\s*训练\s+[\s\S]+$/u,'train'],[/^[.。]赛马娘\s*(开始|开局|创建)\s*$/u,'start'],
  [/^[.。]赛马娘\s*(加入|参加|上马|报名)([\s\S]*)$/u,'join'],[/^[.。]赛马娘\s*(决策|选择|行动|策略)\s+[\s\S]+$/u,'decision'],
  [/^[.。]赛马娘\s*(开跑|开赛|比赛|冲|跑)\s*$/u,'run'],[/^[.。]赛马娘\s*(取消|关闭|结束)\s*$/u,'cancel'],
  [/^[.。]赛马娘\s*(加积分|改积分|调整积分)\s+[\s\S]+$/u,'adjust'],[/^[.。]赛马娘\s*(积分|分数|我的积分)\s*$/u,'score'],
  [/^[.。]赛马娘\s*(排行|排行榜|排名)(\s+\d+)?\s*$/u,'rank'],
] as const
const commandFor=(text:string)=>commands.find(([pattern])=>pattern.test(text))?.[1]
const sameBinding=(left:AgentBindingSnapshot,right:AgentBindingSnapshot)=>agentBindingToken(left)===agentBindingToken(right)&&conversationAddressKey(left.target)===conversationAddressKey(right.target)
function validSource(source:IncomingMessage,binding:AgentBindingSnapshot):boolean {
  return binding.target.kind==='group'&&source.conversation.kind==='group'&&conversationAddressKey(source.conversation)===conversationAddressKey(binding.target)&&
    samePlatformNamespace(source.sender,binding.target.account)&&(!source.binding||sameBinding(source.binding,binding))
}
const isImage=(value:unknown):value is MessageImage=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  typeof (value as MessageImage).mime==='string'&&typeof (value as MessageImage).base64==='string'

export function createAgentUmaRaceHandler(options:AgentUmaRaceOptions):AgentGroupGameHandler {
  if(!path.isAbsolute(options.dataDir))throw new Error('赛马娘数据根目录必须为绝对路径')
  const config=Object.freeze(normalizeUmaRaceConfig({...options.config}))
  const active=new AsyncLocalStorage<AgentGroupGameContext>(),events=new WeakMap<UmaEvent,AgentGroupGameContext>()
  type Manager=InstanceType<ReturnType<typeof createUmaRaceManager>['UmaRaceManager']>
  const managers=new Map<string,Manager>(),sends=new WeakMap<Manager,(message:unknown,lifetime?:(()=>boolean))=>Promise<void>>()
  let stopped=false
  const assertContext=(context:AgentGroupGameContext)=>{
    if(stopped||context.signal.aborted||!context.isCurrent()||!validSource(context.source,context.binding)||context.member.id!==context.source.sender.id)throw new Error('赛马娘来源或角色绑定已改变')
  }
  const context=()=>{const value=active.getStore();if(!value)throw new Error('赛马娘缺少Core授权');assertContext(value);return value}
  const ensure=async(value:AgentGroupGameContext)=>{assertContext(value);await value.ensureCurrent();assertContext(value)}

  const managerFor=(binding:AgentBindingSnapshot):Manager=>{
    const directory=agentUmaRaceDataDir(options.dataDir,binding)
    const existing=managers.get(directory)
    if(existing)return existing
    let manager:Manager
    const send=async(message:unknown,lifetime?:()=>boolean):Promise<void>=>{
      const source=context(),roomCurrent=manager.captureIsCurrent()
      const assert=()=>{assertContext(source);if(!roomCurrent()||lifetime&&!lifetime())throw new Error('原赛马局已结束或取消')}
      const guard:AgentGroupGameSendGuard={signal:source.signal,isCurrent:()=>{try{assert();return true}catch{return false}},ensureCurrent:async()=>{assert();await source.ensureCurrent();assert()}}
      const parts=Array.isArray(message)?message:[message]
      for(const part of parts){
        assert();await guard.ensureCurrent();assert()
        if(typeof part==='string'){
          for(let start=0;start<part.length;start+=3800){await source.sendText(part.slice(start,start+3800),guard);assert()}
        }else if(isImage(part)){await source.sendImage(part,guard);assert()}
        else if(part!==undefined&&part!==null)throw new Error('赛马报表输出格式无效')
      }
    }
    const {UmaRaceManager}=createUmaRaceManager({
      sendSmartReply:async(_event,message)=>{await send(message)},
      guard:{assertCurrent:()=>{context()},ensureCurrent:async()=>{await ensure(context())}},
      withEvent:async(event,work)=>{
        const origin=events.get(event)
        if(!origin)throw new Error('赛马娘缺少开局来源')
        const current=options.authorizeBackground?await options.authorizeBackground({source:origin.source,binding:origin.binding}):origin
        if(!current||!sameBinding(current.binding,origin.binding)||current.source.messageId!==origin.source.messageId||current.source.sender.id!==origin.source.sender.id||current.source.occurredAt!==origin.source.occurredAt||current.source.text!==origin.source.text)throw new Error('赛马娘原开局授权已失效')
        assertContext(current);await ensure(current);assertContext(current)
        return await active.run(current,work)
      },
      canCancel:()=>['admin','owner'].includes(context().member.role),
      canAdjustPoints:()=>options.canAdjustPoints?.(context())===true,
      ...(options.renderReport?{renderReport:async(_event:UmaEvent,report:UmaReport)=>{
        const current=context();await ensure(current)
        const image=await options.renderReport!(report,current)
        assertContext(current);return image
      }}:{}),
    })
    manager=new UmaRaceManager({cwd:path.dirname(directory),config,getDataDir:()=>directory,...(options.logger?{logger:options.logger}:{})})
    managers.set(directory,manager);sends.set(manager,send)
    return manager
  }

  return {
    id:'uma-race',
    isCandidate:(source,binding)=>!stopped&&config.enabled&&validSource(source,binding)&&!!commandFor(source.text),
    isActive:binding=>{
      const manager=managers.get(agentUmaRaceDataDir(options.dataDir,binding)),room=manager?.getRoom(conversationAddressKey(binding.target))
      const origin=room?events.get(room.event):undefined
      return !stopped&&!!origin&&sameBinding(origin.binding,binding)&&!origin.signal.aborted&&origin.isCurrent()
    },
    handle:async(current)=>{
      const command=commandFor(current.source.text)
      if(stopped||!config.enabled||!command||!validSource(current.source,current.binding))return false
      await ensure(current)
      return await active.run(current,async()=>{
        const manager=managerFor(current.binding),source=current.source
        for(const room of manager.rooms.values()){
          const origin=events.get(room.event)
          if(!origin||origin.signal.aborted||!origin.isCurrent())manager.discardRoom(room.groupId)
        }
        const sendForEvent=sends.get(manager)!
        const event:UmaEvent={group_id:conversationAddressKey(source.conversation),user_id:source.sender.id,msg:source.text,nickname:current.member.name,
          sender:{user_id:source.sender.id,nickname:current.member.name},reply:async(message)=>{await sendForEvent(message)}}
        events.set(event,current)
        let output:unknown
        switch(command){
          case 'help':output=manager.showHelp();break
          case 'adopt':output=await manager.adoptUma(event);break
          case 'readopt':output=await manager.adoptUma(event,{overwrite:true});break
          case 'abandon':output=await manager.abandonUma(event,{confirm:/确认/u.test(source.text)});break
          case 'uma':output=manager.showUma(event);break
          case 'affix':output=manager.showAffix(event);break
          case 'reroll':output=await manager.rerollAffix(event);break
          case 'pool':output=manager.showAffixPool();break
          case 'training':output=manager.showTrainingStatus(event);break
          case 'train':output=await manager.trainUma(event);break
          case 'start':output=await manager.startRace(event);break
          case 'join':output=await manager.joinRace(event,source.text);break
          case 'decision':output=await manager.raceDecision(event);break
          case 'run':output=await manager.runRace(event);break
          case 'cancel':output=manager.cancelRace(event);break
          case 'adjust':output=await manager.adjustScore(event);break
          case 'score':output=manager.showScore(event);break
          case 'rank':output=manager.showRank(source.text.match(/\s+(\d+)\s*$/u)?.[1]);break
        }
        assertContext(current)
        if(output){
          const room=['start','join','run','decision'].includes(command)?manager.getRoom(String(event.group_id)):undefined
          await sendForEvent(output,room?()=>manager.getRoom(room.groupId)===room:undefined)
        }
        assertContext(current)
        return true
      })
    },
    stop:()=>{stopped=true;for(const manager of managers.values())manager.stop();managers.clear()},
  }
}
