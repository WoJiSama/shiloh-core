import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {createAgentRedisFixture,redisAvailable} from './helpers/agentRedis.js'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentRuntime}=await load('core/agentRuntime.js')
const {createAgentBindingDirectory,conversationAddressKey,platformAccountKey}=await load('modules/runtime/domain/agentBindings.js')
const {createAgentDiceState}=await load('modules/dice/infrastructure/agentDiceState.js')
const {createAgentGroupLogStore}=await load('modules/dice/infrastructure/agentGroupLogStore.js')
const {compileAgentDiceRulePackage}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const {personMemoryCommandText:privacy}=await load('modules/memory/domain/personMemoryCommands.js')

const options={skip:!redisAvailable,timeout:25_000}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceKey=(target,id)=>JSON.stringify([conversationAddressKey(target),id])
const textOf=action=>action.parts.filter(part=>part.kind==='text').map(part=>part.text).join('')
const deferred=()=>Promise.withResolvers()
let fixtureSequence=0

async function waitFor(probe,label,details=()=> ''){
 const deadline=performance.now()+8_000
 while(performance.now()<deadline){if(await probe())return;await delay(10)}
 assert.fail(`${label}: ${details()}`)
}

async function fixture(t,settings={}){
 let host,f
 t.after(async()=>{settings.release?.();await host?.stop()})
 const redis=await createAgentRedisFixture(t,'dice-group-log-core')
 const namespace='dice-group-log-core-'+ ++fixtureSequence
 const accounts=['robot-one','robot-two'].map(id=>({platform:'fixture',namespace,id}))
 const user=(id='alice',account=accounts[0])=>({platform:account.platform,namespace:account.namespace,id})
 const group={account:accounts[0],kind:'group',id:'room'},otherGroup={...group,id:'other-room'},otherAccountGroup={...group,account:accounts[1]}
 const targets=[group,otherGroup,otherAccountGroup]
 const config={version:1,agents:[{id:'daily',personaId:'default'},{id:'other',personaId:'default'}],
  connections:accounts.map((account,index)=>({id:'connection-'+index,platform:account.platform,namespace:account.namespace,accountId:account.id})),
  bindings:targets.map(target=>({connectionId:'connection-'+accounts.indexOf(target.account),kind:target.kind,conversationId:target.id,agentId:'daily'}))}
 let directory=createAgentBindingDirectory(config,'engine-core-initial'),serial=0,receipt=0,current=true,clock=Date.now()
 const now=()=>clock=Math.max(clock,Date.now())
 const receives=new Map(),ready=new Map(),sources=new Map(),reads=[],memberReads=[],grantReads=[],attempts=[],sends=[],privateAttempts=[],privateSends=[],interactions=[],requests=[],logs=[],deliveries=[]
 const state=createAgentDiceState(redis.storage),groupLogs=createAgentGroupLogStore(redis.storage)
 const engineConfig={enabled:true,builtin:{allowHiddenRoll:true},...settings.engine}
 const permissions=['player','delegate','hidden','card','gm','admin']
 const queueKeys=accounts.flatMap(account=>['group-log','group-text','simulation','private','privacy'].map(kind=>redis.prefix+`agent:inbox:${kind}:${platformAccountKey(account)}`))
 function makeHost(){
  const adapters=accounts.map((account,index)=>({id:'connection-'+index,account,botUserId:account.id,botName:'Dice Core fixture',
   isReady:()=>ready.get(platformAccountKey(account))===true,
   async start(consume){receives.set(platformAccountKey(account),consume);ready.set(platformAccountKey(account),true)},
   stop(){ready.set(platformAccountKey(account),false)},
   async readMessage(target,id,guard){
    reads.push({target:structuredClone(target),id});await settings.beforeRead?.(f,target,id,guard)
    if(guard?.isCurrent?.()===false)return undefined
    const value=sources.get(sourceKey(target,id)),copy=value?structuredClone(value):undefined
    return settings.readMessage?settings.readMessage(copy,target,id,f):copy
   },
   async readConversationMember(target,subject,guard){
    if(guard?.isCurrent?.()===false)return undefined
    return {target:structuredClone(target),observedAt:now(),member:{user:structuredClone(subject),displayName:'Current admin',role:'admin'}}
   },
   async listConversationMembers(target,guard){
    memberReads.push(structuredClone(target));await settings.beforeMembers?.(f,target,guard)
    if(guard?.isCurrent?.()===false)return undefined
    const value={target:structuredClone(target),observedAt:now(),complete:true,members:f.members.map(member=>({...structuredClone(member),user:{...member.user,platform:account.platform,namespace:account.namespace}}))}
    return settings.members?settings.members(value,f):value
   },
   actions:{
    async send(action,guard){
     attempts.push(structuredClone(action));await settings.beforeSend?.(f,action,guard)
     try{await guard?.ensureCurrent?.()}catch{return {state:'failed',code:'stale'}}
     if(!guard?.isCurrent?.())return {state:'failed',code:'stale'}
     sends.push(structuredClone(action))
     const result=settings.receipt?await settings.receipt(f,action,guard):{state:'sent',messageId:'native-public-'+ ++receipt}
     deliveries.push({action:structuredClone(action),receipt:structuredClone(result)});return result
    },
    async sendDicePrivate(request,guard){
     privateAttempts.push(structuredClone(request));await settings.beforePrivate?.(f,request,guard)
     try{await guard.ensureCurrent()}catch{return {state:'failed',code:'stale'}}
     if(!guard.isCurrent())return {state:'failed',code:'stale'}
     privateSends.push(structuredClone(request))
     return settings.privateReceipt?settings.privateReceipt(f,request,guard):{state:'sent',messageId:'native-private-'+ ++receipt}
    },
    async interact(action,guard){
     await guard?.ensureCurrent?.();if(guard?.isCurrent?.()===false)return {state:'failed'}
     interactions.push(structuredClone(action));return {state:'confirmed'}
    },
   },
  }))
  return createAgentRuntime({storage:redis.storage,adapters,isExecutionCurrent:redis.isCurrent,now,diceEngine:engineConfig,isDiceCurrent:()=>current,
   ...(settings.omitGrant?{}:{async readDiceGrant(request,guard){
    grantReads.push({binding:structuredClone(request.binding),messageId:request.source.messageId});await settings.beforeGrant?.(f,request,guard)
    const value={binding:structuredClone(request.binding),revision:f.grantRevision,actorId:request.source.sender.id,permissions:[...f.permissions],
     subjects:f.members.filter(member=>member.user.id!==request.source.sender.id&&member.user.id!==accountId(request.binding)).map(member=>({id:member.user.id,permissions:[...f.subjectPermissions]}))}
    return settings.grant?settings.grant(value,request,f):value
   }}),
   groupLog:{enabled:true},privateChatEnabled:true,useTextGroup:target=>target.kind==='group',textGroupRevision:'dice-engine-core-test',
   resolvePersona(target){const binding=directory.resolve(target);return binding&&{binding,persona:{name:'Dice test'},systemContent:'Isolated deterministic dice integration'}},
   getSection:()=>({enabled:true,allGroups:true,reflection:{enabled:false},consistency:{enabled:false},wakeGate:{enabled:false},rhythm:{enabled:false},mood:{enabled:false},personProfile:{enabled:false},meme:{enabled:false},userStyle:{enabled:false},lifeThreads:{enabled:false},
    wake:{probability:0,proactiveProbability:0,batchWindowMs:1000,maxWakePerMinute:100,maxWakePerHour:100},turn:{minSendGapMs:0,maxTurnsPerDay:1000,maxToolRounds:2,maxSendsPerTurn:1},toolPolicy:{mode:'open'}}),
   getExecutionConfig:()=>({}),logger:{info:line=>logs.push(line),warn:line=>logs.push(line),error:line=>logs.push(line)},
   async YTapi(request){requests.push(structuredClone(request));return {choices:[{message:{content:'ordinary chat reply'}}]}},
  })
 }
 const accountId=binding=>binding.target.account.id
 f={...redis,accounts,user,group,otherGroup,otherAccountGroup,state,groupLogs,engineConfig,sources,reads,memberReads,grantReads,attempts,sends,privateAttempts,privateSends,interactions,requests,logs,deliveries,
  permissions:[...permissions],subjectPermissions:[...permissions],grantRevision:'explicit-grant-one',
  members:[{user:user(),displayName:'Fresh Alice',role:'member'},{user:user('bob'),displayName:'Fresh Bob',role:'member'},{user:user('carol'),displayName:'Fresh Carol',role:'owner'}],
  get host(){return host},get now(){return now()},binding:(target=group)=>directory.resolve(target),
  owner:(target=group)=>({target,agentId:directory.resolve(target).agentId}),
  disable(){current=false},enable(){current=true},
  rebind(target=group){directory=createAgentBindingDirectory({...config,bindings:config.bindings.map(binding=>binding.conversationId===target.id&&binding.connectionId==='connection-'+accounts.indexOf(target.account)?{...binding,agentId:'other'}:binding)},'engine-core-rebound')},
  message(text='.r 1d6',extra={}){const target=extra.conversation??group;return {version:1,conversation:target,sender:user('alice',target.account),senderName:'Stale incoming name',messageId:'engine-source-'+ ++serial,occurredAt:clock=Math.max(clock+1,Date.now()),text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false,...extra}},
  async emit(message){sources.set(sourceKey(message.conversation,message.messageId),structuredClone(message));await receives.get(platformAccountKey(message.conversation.account))({kind:'message',message:structuredClone(message)})},
  async recall(message){sources.delete(sourceKey(message.conversation,message.messageId));await receives.get(platformAccountKey(message.conversation.account))({kind:'recall',target:message.conversation,messageId:message.messageId})},
  async drained(){await waitFor(async()=>Number(await redis.reader.eval("local total=0; for _, key in ipairs(KEYS) do total=total+redis.call('LLEN',key) end; return total",{keys:queueKeys,arguments:[]}))===0,'Core dice inbox did not drain',()=>logs.slice(-5).join('\n'));await host.runtime.drain()},
  async send(text,extra){const message=f.message(text,extra);await f.emit(message);await f.drained();return message},
  async restart(){await host.stop();host=makeHost();await host.start()},
  async rows(target=group){const owner=f.owner(target),value=await groupLogs.read(owner);return (await Promise.all(value.logs.map(log=>groupLogs.snapshot(owner,log.id)))).flatMap(snapshot=>snapshot.sourceRows)},
  async snapshot(target=group){return state.read(f.binding(target))},
  async operation(message){const value=await redis.reader.get(redis.prefix+'agent:dice:engine:v1:operation:'+hash([conversationAddressKey(message.conversation),message.messageId]));return value?JSON.parse(value):null},
  sendsFor:message=>sends.filter(action=>action.replyTo===message.messageId&&conversationAddressKey(action.target)===conversationAddressKey(message.conversation)),
 }
 host=makeHost();await host.start();return f
}

async function yamlPackage(){
 const source=JSON.stringify({version:1,id:'session-rules',name:'Session YAML',aliases:['sessionrules'],
  character:{fields:{hp:{type:'integer',default:12,min:0,max:12}}},
  group:{fields:{threat:{type:'integer',default:0,min:0,max:20}}},
  events:{session_start:[{op:'set',scope:'group',field:'threat',value:1}],session_end:[{op:'set',scope:'group',field:'threat',value:0}]},
  commands:[{id:'hello',aliases:['hello'],output:'Public YAML fact.'},{id:'secret',aliases:['secret'],visibility:'gm',rolls:{secret:'1d100'},output:'SECRET-NATIVE-RESULT {roll.secret.detail}',public_output:'Secret result delivered privately.'}],
 })
 return compileAgentDiceRulePackage({kind:'yaml',source,revision:'session-yaml-one',sourceHash:createHash('sha256').update(source).digest('hex')})
}

test('real Core YAML session owns an automatic log, survives restart and stops its exact log',options,async t=>{
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]}})
 assert.equal((await f.groupLogs.read(f.owner())).active,false)
 const started=await f.send('.sessionrules 团务 开始 自动团录')
 const log=await f.groupLogs.read(f.owner()),rules=(await f.snapshot()).state.rules.packs['session-rules']
 assert.equal(log.active,true,JSON.stringify(f.logs));assert.equal(log.log.title,'自动团录')
 assert.equal(rules.group.session.active,true);assert.equal(rules.group.group.values.threat,1)
 assert.match(rules.group.session.logOwnershipId,/^[a-f0-9]{64}$/u);assert.equal((await f.operation(started)).state,'confirmed')
 const roll=await f.send('.r 1d6');assert.equal((await f.rows()).filter(row=>row.messageId===roll.messageId&&row.type==='dice_result').length,1)
 await f.restart();await f.emit(started);await f.drained()
 assert.equal((await f.groupLogs.read(f.owner())).currentId,log.currentId)
 const ended=await f.send('.sessionrules 团务 结束'),after=await f.groupLogs.read(f.owner())
 assert.equal(after.active,false);assert.equal(after.currentId,log.currentId);assert.equal(after.logs.length,1)
 assert.ok(after.log.endedAt);assert.equal((await f.snapshot()).state.rules.packs['session-rules'].group.session.active,false)
 assert.equal((await f.operation(ended)).state,'confirmed');assert.equal(f.requests.length,0)
})

test('YAML sessions observe an existing manual log and never take ownership or stop it',options,async t=>{
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]}})
 await f.send('.log on 手动团录')
 const manual=await f.groupLogs.read(f.owner());assert.equal(manual.active,true)
 const started=await f.send('.sessionrules 团务 开始 已有手动团录')
 let session=(await f.snapshot()).state.rules.packs['session-rules'].group.session
 assert.equal(session.logOwned,false);assert.equal(Object.hasOwn(session,'logOwnershipId'),false)
 assert.equal((await f.operation(started)).state,'confirmed');await f.restart()
 await f.send('.sessionrules 团务 结束')
 const after=await f.groupLogs.read(f.owner())
 assert.equal(after.active,true);assert.equal(after.currentId,manual.currentId);assert.equal(after.logs.length,1)
 session=(await f.snapshot()).state.rules.packs['session-rules'].group.session
 assert.equal(session.active,false);assert.equal(f.requests.length,0)
})

test('manually closing and reopening an automatic log prevents its old session from stopping the new log after restart',options,async t=>{
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]}})
 await f.send('.sessionrules 团务 开始 自动一号')
 const automatic=await f.groupLogs.read(f.owner())
 await f.send('.log off');await f.send('.log on 手动接管')
 const manual=await f.groupLogs.read(f.owner());assert.equal(manual.active,true);assert.notEqual(manual.currentId,automatic.currentId)
 await f.restart()
 const ended=await f.send('.sessionrules 团务 结束'),after=await f.groupLogs.read(f.owner())
 assert.equal(after.active,true);assert.equal(after.currentId,manual.currentId);assert.equal(after.logs.length,2)
 assert.equal((await f.operation(ended)).state,'failed','the old owner cannot claim a successful stop of a different active log')
 await f.restart();await f.emit(ended);await f.drained()
 assert.equal((await f.groupLogs.read(f.owner())).currentId,manual.currentId);assert.equal((await f.groupLogs.read(f.owner())).active,true)
 assert.equal(f.requests.length,0)
})

test('Core archives committed card and rule facts plus only confirmed public dice receipt IDs, without hidden bodies',options,async t=>{
 let inspected=false
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]},async beforeSend(run,action){
  if(action.replyTo!=='committed-card-source')return
  const snapshot=await run.snapshot(),card=snapshot.state.builtin.users.alice
  assert.equal(card.cards[card.activeCard].attrs.SAN,60)
  assert.ok((await run.rows()).some(row=>row.messageId===action.replyTo&&row.type==='dice_rule'))
  inspected=true
 }})
 await f.send('.log on 事件审计')
 const card=await f.send('.st SAN=60',{messageId:'committed-card-source'}),rule=await f.send('.sessionrules hello'),roll=await f.send('.r 1d6')
 const hidden=await f.send('.rh 1d100'),yamlHidden=await f.send('.sessionrules secret'),rows=await f.rows()
 assert.equal(inspected,true);assert.ok(f.privateSends.some(request=>request.source.messageId===hidden.messageId))
 assert.ok(f.privateSends.some(request=>request.source.messageId===yamlHidden.messageId))
 const result=rows.filter(row=>row.messageId===roll.messageId&&row.type==='dice_result')
 assert.equal(result.length,1);assert.equal(result[0].authorId,roll.sender.id);assert.equal(result[0].occurredAt,roll.occurredAt)
 assert.match(result[0].eventId,/^[a-f0-9]{64}$/u)
 const delivery=f.deliveries.find(value=>value.action.replyTo===roll.messageId)
 assert.equal(delivery.receipt.state,'sent');assert.equal(result[0].deliveryMessageId,delivery.receipt.messageId)
 assert.equal(result[0].content,textOf(delivery.action));assert.notEqual(result[0].deliveryMessageId,result[0].messageId)
 for(const [source,kind] of [[card,'card_change'],[rule,'rule_event']]){
  const facts=rows.filter(row=>row.messageId===source.messageId&&row.type==='dice_rule')
  assert.ok(facts.length>0)
  assert.ok(facts.some(row=>JSON.parse(row.content).kind===kind))
  for(const row of facts){
   assert.equal(row.authorId,source.sender.id);assert.match(row.eventId,/^[a-f0-9]{64}$/u);assert.equal(Object.hasOwn(row,'deliveryMessageId'),false)
   const fact=JSON.parse(row.content);assert.ok(['card_change','rule_event'].includes(fact.kind))
   assert.equal(Object.hasOwn(fact,'messageId'),false);assert.equal(Object.hasOwn(fact,'deliveryMessageId'),false)
  }
 }
 for(const request of f.privateSends)assert.ok(rows.every(row=>!row.content.includes(request.text)))
 assert.ok(rows.every(row=>!row.content.includes('SECRET-NATIVE-RESULT')))
 assert.equal(rows.filter(row=>[hidden.messageId,yamlHidden.messageId].includes(row.messageId)&&row.type==='dice_result').length,0)
 assert.equal(rows.filter(row=>row.messageId===yamlHidden.messageId&&row.type==='dice_rule').length,0)
 const before=structuredClone(rows)
 await f.restart();for(const source of [card,rule,roll,hidden,yamlHidden])await f.emit(source);await f.drained()
 assert.deepEqual(await f.rows(),before);assert.equal(f.requests.length,0)
})

test('an unknown public receipt never becomes a dice_result row after duplicate events or restart',options,async t=>{
 const f=await fixture(t,{receipt(_run,action){return action.replyTo==='unknown-roll'?{state:'unknown'}:{state:'sent',messageId:'confirmed-'+action.replyTo}}})
 await f.send('.log on 无回执审计')
 const source=await f.send('.r 1d6',{messageId:'unknown-roll'})
 assert.equal((await f.operation(source)).state,'unknown')
 assert.equal((await f.rows()).filter(row=>row.messageId===source.messageId&&row.type==='message').length,1)
 assert.equal((await f.rows()).filter(row=>row.messageId===source.messageId&&row.type==='dice_result').length,0)
 await f.restart();await f.emit(source);await f.drained()
 assert.equal(f.sendsFor(source).length,1);assert.equal((await f.rows()).filter(row=>row.messageId===source.messageId&&row.type==='dice_result').length,0)
 assert.equal(f.requests.length,0)
})

test('source recall removes original and derived Core facts and fences their replay across restart',options,async t=>{
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]}})
 await f.send('.log on 撤回清理')
 const card=await f.send('.st SAN=60'),rule=await f.send('.sessionrules hello'),roll=await f.send('.r 1d6')
 const sources=[card,rule,roll]
 for(const source of sources)assert.ok((await f.rows()).filter(row=>row.messageId===source.messageId).length>=2)
 const preserved=await f.send('.r 1d8',{sender:f.user('bob')})
 for(const source of sources)await f.recall(source)
 await f.drained()
 assert.ok((await f.rows()).every(row=>!sources.some(source=>source.messageId===row.messageId)))
 assert.equal((await f.rows()).filter(row=>row.messageId===preserved.messageId).length,2)
 await f.restart();for(const source of sources)await f.emit(source);await f.drained()
 assert.ok((await f.rows()).every(row=>!sources.some(source=>source.messageId===row.messageId)))
 const fresh=await f.send('.r 1d10');assert.equal(f.sendsFor(fresh).length,1);assert.equal(f.requests.length,0)
})

test('real forget clears the author original and derived rows while preserving another author and group',options,async t=>{
 const f=await fixture(t,{engine:{rulePackages:[await yamlPackage()]}})
 await f.send('.log on 本群');await f.send('.log on 另一群',{conversation:f.otherGroup})
 const card=await f.send('.st SAN=60'),rule=await f.send('.sessionrules hello'),roll=await f.send('.r 1d6'),bob=await f.send('.r 1d8',{sender:f.user('bob')})
 const other=await f.send('.r 1d10',{conversation:f.otherGroup}),sources=[card,rule,roll]
 const before=await f.groupLogs.capture(f.owner(),'alice')
 await f.emit(f.message(privacy.forget,{messageId:'real-group-log-forget'}))
 await waitFor(async()=> (await f.groupLogs.capture(f.owner(),'alice')).sceneEpoch!==before.sceneEpoch,'forget epoch did not advance')
 await f.drained()
 assert.ok((await f.rows()).every(row=>row.authorId!=='alice'))
 assert.equal((await f.rows()).filter(row=>row.messageId===bob.messageId).length,2)
 assert.equal((await f.rows(f.otherGroup)).filter(row=>row.messageId===other.messageId).length,2)
 await f.restart();for(const source of sources)await f.emit(source);await f.drained()
 assert.ok((await f.rows()).every(row=>row.authorId!=='alice'))
 const fresh=await f.send('.r 1d12');assert.equal(f.sendsFor(fresh).length,1)
 assert.equal((await f.rows()).filter(row=>row.messageId===fresh.messageId).length,2);assert.equal(f.requests.length,0)
})

for(const revocation of ['recall','forget'])test(`in-flight Core ${revocation} removes already committed facts and blocks late result archival`,options,async t=>{
 const reached=deferred(),release=deferred(),id='inflight-derived-'+revocation
 const f=await fixture(t,{release:()=>release.resolve(),async beforeSend(_run,action){if(action.replyTo===id){reached.resolve();await release.promise}}})
 await f.send('.log on 正在写入')
 const source=f.message('.st SAN=60 .r 1d6',{messageId:id})
 await f.emit(source)
 await waitFor(()=>f.attempts.some(action=>action.replyTo===id),'pending native delivery did not start',()=>f.logs.slice(-5).join('\n'));await reached.promise
 assert.ok((await f.rows()).some(row=>row.messageId===id&&row.type==='dice_rule'))
 if(revocation==='recall')await f.recall(source)
 else{
  const before=await f.groupLogs.capture(f.owner(),'alice');await f.emit(f.message(privacy.forget,{messageId:'inflight-privacy-command'}))
  await waitFor(async()=> (await f.groupLogs.capture(f.owner(),'alice')).sceneEpoch!==before.sceneEpoch,'privacy fence did not advance')
 }
 release.resolve();await f.drained()
 assert.equal(f.sendsFor(source).length,0);assert.equal((await f.rows()).filter(row=>row.messageId===id).length,0)
 await f.restart();await f.emit(source);await f.drained()
 assert.equal((await f.rows()).filter(row=>row.messageId===id).length,0);assert.equal(f.requests.length,0)
})
