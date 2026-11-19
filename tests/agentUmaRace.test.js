import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentUmaRaceHandler:create,agentUmaRaceDataDir:directory}=await load('modules/games/infrastructure/agentUmaRace.js')
const {normalizeUmaRaceConfig,createUmaRaceManager}=await load('modules/games/infrastructure/uma/UmaRaceManager.js')
const config=normalizeUmaRaceConfig({enabled:true,lobbySeconds:10,raceStageSeconds:10,cooldownSeconds:0,winPoints:5,secondPoints:3,thirdPoints:2,participationPoints:1,baseDir:'/must-never-be-read-or-written'})
const clone=value=>structuredClone(value)
const binding={source:'configured',id:'game-binding',revision:'one',agentId:'game-agent',personaId:'game-persona',connectionId:'game-connection',target:{account:{platform:'fixture',namespace:'one',id:'bot-one'},kind:'group',id:'group-one'}}
const sevenPlayers=()=>({players:Object.fromEntries(Array.from({length:7},(_,index)=>{
  const id=String(10001+index)
  return[id,{userId:id,nickname:'玩家'+id,points:200,wins:index,races:index===6?83:60,podiums:index,trainingPity:{basic:{speed:2}},uma:{name:'小马'+id,personality:'稳重',attributes:{speed:8,stamina:8,power:7,focus:7,wisdom:5,luck:5},total:40,proficiency:{steady:20},trait:{key:'steady',label:'稳健',description:'fixture',fit:{steady:5},tagFit:{},riskAdjust:0,luckBonus:0}}}]
}))})
const totals=data=>Object.values(data.players).reduce((sum,player)=>sum+player.races,0)
async function settle(){for(let i=0;i<20;i++)await immediate()}
function fixture(t,changes={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-uma-')),sent=[],states=new Map(),background=[]
  let sequence=0
  const make=(text,{userId='10001',role='member',scope=binding,...extra}={})=>{
    const controller=new AbortController(),state={current:true,controller},source={version:1,conversation:clone(scope.target),sender:{...scope.target.account,id:userId},senderName:'不可信主人',messageId:'uma-'+(++sequence),occurredAt:1800000000000+sequence,text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false,binding:clone(scope)}
    const context={source,binding:clone(scope),member:{id:userId,name:'玩家'+userId,role},signal:controller.signal,isCurrent:()=>state.current,
      ensureCurrent:async()=>{if(!state.current||controller.signal.aborted)throw Error('core stale');if(extra.ensure)await extra.ensure();if(!state.current||controller.signal.aborted)throw Error('core stale')},
      sendText:async(text,guard)=>{if(extra.queueText)await extra.queueText(text);await guard?.ensureCurrent();await context.ensureCurrent();sent.push({kind:'text',text,userId,source:source.messageId})},
      sendImage:async(image,guard)=>{if(extra.queueImage)await extra.queueImage();await guard?.ensureCurrent();await context.ensureCurrent();sent.push({kind:'image',image,userId,source:source.messageId})},
      sendPrivate:async()=>{throw Error('Uma never needs a private relay')},}
    states.set(source.messageId,{state,context});return context
  }
  const handler=create({dataDir,config,authorizeBackground:async input=>{background.push(input.source.messageId);const value=states.get(input.source.messageId);return value?.state.current&&!value.state.controller.signal.aborted?value.context:undefined},...changes})
  t.after(()=>{handler.stop();fs.rmSync(dataDir,{recursive:true,force:true})})
  const file=(scope=binding)=>path.join(directory(dataDir,scope),'points.json')
  const seed=(scope=binding,data=sevenPlayers())=>{fs.mkdirSync(path.dirname(file(scope)),{recursive:true});fs.writeFileSync(file(scope),JSON.stringify(data))}
  const read=(scope=binding)=>JSON.parse(fs.readFileSync(file(scope),'utf8'))
  const run=async(text,options)=>{const value=make(text,options);assert.equal(await handler.handle(value),true);return value}
  return{dataDir,handler,sent,make,run,file,seed,read,states,background}
}

test('Uma retains every explicit legacy command form and rejects natural speech and foreign source scopes',async t=>{
  const f=fixture(t)
  for(const text of ['.赛马娘','.赛马娘 帮助','.赛马娘 领养 名字 温柔','.赛马娘 重新领养 新名 勇敢','.赛马娘 弃养 确认','.赛马娘 六维','.赛马娘 小马词条','.赛马娘 洗词条','.赛马娘 词条池','.赛马娘 训练状态','.赛马娘 训练 基础 速度','.赛马娘 开始','.赛马娘 加入 稳住','.赛马娘 决策 稳住','.赛马娘 开赛','.赛马娘 结束','.赛马娘 改积分 10001 2','.赛马娘 我的积分','.赛马娘 排行榜 5']){
    const current=f.make(text);assert.equal(f.handler.isCandidate(current.source,current.binding),true,text)
  }
  for(const text of ['帮我赛马','开始赛马娘吧','.赛马娘 未知命令','普通聊天']){const current=f.make(text);assert.equal(f.handler.isCandidate(current.source,current.binding),false)}
  const current=f.make('.赛马娘 开始'),foreign=clone(current.source);foreign.conversation.account.namespace='another'
  assert.equal(f.handler.isCandidate(foreign,current.binding),false)
  assert.equal(await f.handler.handle({...current,member:{...current.member,id:'not-source-sender'}}).catch(()=>false),false)
})

test('seven migrated players, pets and 443 races remain readable across groups and isolated by complete account and Agent',async t=>{
  const f=fixture(t);f.seed();const before=fs.readFileSync(f.file(),'utf8')
  for(const text of ['.赛马娘 积分','.赛马娘 属性','.赛马娘 词条','.赛马娘 训练状态','.赛马娘 排行'])await f.run(text)
  assert.equal(fs.readFileSync(f.file(),'utf8'),before);assert.equal(Object.keys(f.read().players).length,7);assert.equal(totals(f.read()),443)
  const secondGroup=clone(binding);secondGroup.target.id='group-two'
  assert.equal(f.file(secondGroup),f.file());await f.run('.赛马娘 积分',{scope:secondGroup});assert.match(f.sent.at(-1).text,/200/)
  for(const alter of [scope=>scope.agentId='other-agent',scope=>scope.target.account.id='bot-two',scope=>scope.target.account.namespace='two',scope=>scope.target.account.platform='another']){
    const scope=clone(binding);alter(scope);assert.notEqual(f.file(scope),f.file());await f.run('.赛马娘 领养 新马 勇敢',{scope});assert.equal(Object.keys(f.read(scope).players).length,1)
  }
  assert.equal(fs.readFileSync(f.file(),'utf8'),before)
})

test('group administrators cannot adjust cross-group points and cancellation uses explicit starter or fresh group role',async t=>{
  const f=fixture(t);f.seed();const before=fs.readFileSync(f.file(),'utf8')
  for(const role of ['member','admin','owner'])await f.run('.赛马娘 加积分 10001 900',{role})
  assert.equal(fs.readFileSync(f.file(),'utf8'),before);assert.ok(f.sent.every(item=>/获授权的主人/u.test(item.text)))
  await f.run('.赛马娘 开始');assert.equal(f.handler.isActive(binding),true)
  await f.run('.赛马娘 取消',{userId:'10002'});assert.equal(f.handler.isActive(binding),true)
  await f.run('.赛马娘 取消',{userId:'10002',role:'admin'});assert.equal(f.handler.isActive(binding),false)
  const permitted=fixture(t,{canAdjustPoints:context=>context.member.id==='10001'});permitted.seed()
  await permitted.run('.赛马娘 加积分 10001 9');assert.equal(permitted.read().players['10001'].points,209)
})

test('complete staged race preserves seven pets and awards one transaction without replay on concurrent final decisions',async t=>{
  const f=fixture(t);f.seed()
  await f.run('.赛马娘 开始');await f.run('.赛马娘 开跑')
  await f.run('.赛马娘 决策 稳住');await f.run('.赛马娘 决策 稳住')
  await Promise.all([f.run('.赛马娘 决策 稳住'),f.run('.赛马娘 决策 稳住')])
  assert.equal(totals(f.read()),444);assert.equal(Object.keys(f.read().players).length,7);assert.ok(Object.values(f.read().players).every(player=>player.uma?.name))
  assert.equal(f.handler.isActive(binding),false)
  const snapshot=fs.readFileSync(f.file(),'utf8');await f.run('.赛马娘 决策 稳住');assert.equal(fs.readFileSync(f.file(),'utf8'),snapshot)
  assert.ok(f.sent.some(item=>item.kind==='text'&&item.text.includes('赛马结果出炉')))
})

test('lobby and stage timers reauthorize the original opener after another player joins',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t);f.seed();const origin=await f.run('.赛马娘 开始');await f.run('.赛马娘 加入 稳住',{userId:'10002'})
  t.mock.timers.tick(10_000);await settle()
  for(let stage=0;stage<3;stage++){t.mock.timers.tick(10_000);await settle()}
  assert.equal(totals(f.read()),445);assert.equal(f.handler.isActive(binding),false)
  assert.ok(f.background.length>=4);assert.ok(f.background.every(id=>id===origin.source.messageId))
})

test('cancelling during report rendering prevents late images and keeps existing score data',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
  const f=fixture(t,{renderReport:async()=>{entered();await gate;return {mime:'image/png',base64:'aGVsbG8='}}});f.seed();await f.run('.赛马娘 开始')
  const pending=f.run('.赛马娘 开跑');await started;await f.run('.赛马娘 取消');release()
  await assert.rejects(pending,/取消|改变/u);assert.equal(f.sent.filter(item=>item.kind==='image').length,0);assert.equal(totals(f.read()),443)
})

test('cancelling a settlement queued on the points lock cannot commit awards or proficiency',async t=>{
  const f=fixture(t);f.seed();await f.run('.赛马娘 开始');await f.run('.赛马娘 开跑');await f.run('.赛马娘 决策 稳住');await f.run('.赛马娘 决策 稳住')
  const before=fs.readFileSync(f.file(),'utf8'),lock=f.file()+'.lock';fs.writeFileSync(lock,'fixture-held')
  const pending=f.run('.赛马娘 决策 稳住');await delay(30);await f.run('.赛马娘 取消');fs.unlinkSync(lock)
  await assert.rejects(pending,/取消|改变/u);assert.equal(fs.readFileSync(f.file(),'utf8'),before);assert.equal(f.handler.isActive(binding),false)
})

test('Core outbound queues retain a captured room guard when a room is cancelled before image dispatch',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),queued=new Promise(resolve=>entered=resolve)
  const f=fixture(t,{renderReport:async()=>({mime:'image/png',base64:'aGVsbG8='})});f.seed();await f.run('.赛马娘 开始')
  const pending=f.run('.赛马娘 开跑',{queueImage:async()=>{entered();await gate}});await queued
  await f.run('.赛马娘 取消');release();await assert.rejects(pending,/取消|改变/u)
  assert.equal(f.sent.filter(item=>item.kind==='image').length,0)
})

test('revoked opener and stopped runtime cannot advance timers or write into the next binding',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t);f.seed();const origin=await f.run('.赛马娘 开始'),snapshot=fs.readFileSync(f.file(),'utf8')
  f.states.get(origin.source.messageId).state.current=false
  const before=f.sent.length;t.mock.timers.tick(10_000);await settle();assert.equal(f.sent.length,before);assert.equal(fs.readFileSync(f.file(),'utf8'),snapshot)
  const revised=clone(binding);revised.revision='two';await f.run('.赛马娘 开始',{scope:revised});f.handler.stop()
  t.mock.timers.tick(60_000);await settle();assert.equal(fs.readFileSync(f.file(),'utf8'),snapshot)
  assert.equal(f.handler.isActive(revised),false)
})

test('legacy manager still reads its existing cwd defaults and injected manager never needs those files',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uma-injection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}}),legacy=new UmaRaceManager({cwd:root})
  assert.equal(legacy.getDataDir(),path.join(root,'plugins/shiloh-plugin/data/uma_race'))
  const own=new UmaRaceManager({cwd:path.join(root,'no-legacy-root'),config,getDataDir:()=>path.join(root,'injected')})
  assert.equal(own.getConfig().winPoints,5);assert.equal(own.getConfig().maxPlayers,8)
  await own.adoptUma({user_id:'10001',msg:'.赛马娘 领养 injected calm'});assert.ok(fs.existsSync(path.join(root,'injected/points.json')))
})
