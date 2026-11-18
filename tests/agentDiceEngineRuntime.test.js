import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {createAgentRedisFixture,redisAvailable} from './helpers/agentRedis.js'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentRuntime}=await load('core/agentRuntime.js')
const {createAgentBindingDirectory,conversationAddressKey,platformAccountKey}=await load('modules/runtime/domain/agentBindings.js')
const {createAgentDiceState}=await load('modules/dice/infrastructure/agentDiceState.js')
const {createAgentDiceLedger}=await load('modules/dice/infrastructure/agentDiceLedger.js')
const {createAgentGroupLogStore}=await load('modules/dice/infrastructure/agentGroupLogStore.js')
const {compileAgentDiceRulePackage}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const {agentDiceSourceFingerprint}=await load('modules/dice/infrastructure/agentDiceSource.js')
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
 const redis=await createAgentRedisFixture(t,'dice-engine-core')
 const namespace='dice-engine-core-'+ ++fixtureSequence
 const accounts=['robot-one','robot-two'].map(id=>({platform:'fixture',namespace,id}))
 const user=(id='alice',account=accounts[0])=>({platform:account.platform,namespace:account.namespace,id})
 const group={account:accounts[0],kind:'group',id:'room'},otherGroup={...group,id:'other-room'},otherAccountGroup={...group,account:accounts[1]}
 const targets=[group,otherGroup,otherAccountGroup]
 const config={version:1,agents:[{id:'daily',personaId:'default'},{id:'other',personaId:'default'}],
  connections:accounts.map((account,index)=>({id:'connection-'+index,platform:account.platform,namespace:account.namespace,accountId:account.id})),
  bindings:targets.map(target=>({connectionId:'connection-'+accounts.indexOf(target.account),kind:target.kind,conversationId:target.id,agentId:'daily'}))}
 let directory=createAgentBindingDirectory(config,'engine-core-initial'),serial=0,receipt=0,current=true,clock=Date.now()
 const now=()=>clock=Math.max(clock,Date.now())
 const receives=new Map(),ready=new Map(),sources=new Map(),reads=[],memberReads=[],grantReads=[],attempts=[],sends=[],privateAttempts=[],privateSends=[],interactions=[],requests=[],logs=[]
 const state=createAgentDiceState(redis.storage),ledger=createAgentDiceLedger(redis.storage),groupLogs=createAgentGroupLogStore(redis.storage)
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
     return settings.receipt?settings.receipt(f,action,guard):{state:'sent',messageId:'native-public-'+ ++receipt}
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
   groupLog:{enabled:false},privateChatEnabled:true,useTextGroup:target=>target.kind==='group',textGroupRevision:'dice-engine-core-test',
   resolvePersona(target){const binding=directory.resolve(target);return binding&&{binding,persona:{name:'Dice test'},systemContent:'Isolated deterministic dice integration'}},
   getSection:()=>({enabled:true,allGroups:true,reflection:{enabled:false},consistency:{enabled:false},wakeGate:{enabled:false},rhythm:{enabled:false},mood:{enabled:false},personProfile:{enabled:false},meme:{enabled:false},userStyle:{enabled:false},lifeThreads:{enabled:false},
    wake:{probability:0,proactiveProbability:0,batchWindowMs:1000,maxWakePerMinute:100,maxWakePerHour:100},turn:{minSendGapMs:0,maxTurnsPerDay:1000,maxToolRounds:2,maxSendsPerTurn:1},toolPolicy:{mode:'open'}}),
   getExecutionConfig:()=>({}),logger:{info:line=>logs.push(line),warn:line=>logs.push(line),error:line=>logs.push(line)},
   async YTapi(request){requests.push(structuredClone(request));return {choices:[{message:{content:'ordinary chat reply'}}]}},
  })
 }
 const accountId=binding=>binding.target.account.id
 f={...redis,accounts,user,group,otherGroup,otherAccountGroup,state,ledger,groupLogs,engineConfig,sources,reads,memberReads,grantReads,attempts,sends,privateAttempts,privateSends,interactions,requests,logs,
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
  async snapshot(target=group){return state.read(f.binding(target))},
  async operation(message){const value=await redis.reader.get(redis.prefix+'agent:dice:engine:v1:operation:'+hash([conversationAddressKey(message.conversation),message.messageId]));return value?JSON.parse(value):null},
  async oldFence(message,status){
   const binding=f.binding(message.conversation),source={target:message.conversation,agentId:binding.agentId,authorId:message.sender.id,messageId:message.messageId},epochs=await ledger.capture(source)
   const prepared=await ledger.prepare(source,binding,hash(['old-source']),[{eventId:hash(['old-result']),text:'old frozen result',result:true}],epochs)
   assert.ok(prepared)
   if(status==='ready')return
   const {items,...terminal}=prepared.record
   assert.ok(await ledger.change(source,prepared,status==='pending'?{...prepared.record,state:status}:{...terminal,state:status},epochs))
  },
  sendsFor:message=>sends.filter(action=>action.replyTo===message.messageId&&conversationAddressKey(action.target)===conversationAddressKey(message.conversation)),
 }
 host=makeHost();await host.start();return f
}

const active=(snapshot,id='alice')=>{const user=snapshot.state.builtin.users[id];return user.cards[user.activeCard]}

test('actual Core inbox runs public dice and builtin card/check state with fresh members and explicit authority',options,async t=>{
 const f=await fixture(t),rolled=await f.send('.r 1d6')
 assert.equal(f.sendsFor(rolled).length,1,JSON.stringify(f.logs));assert.equal(f.requests.length,0)
 const action=f.sendsFor(rolled)[0]
 assert.deepEqual(action.binding,f.binding());assert.deepEqual(action.target,f.group);assert.equal(action.replyTo,rolled.messageId)
 assert.match(textOf(action),/Fresh Alice.*1D6/iu);assert.ok(!textOf(action).includes(rolled.senderName))
 assert.equal((await f.operation(rolled)).state,'confirmed')
 await f.send('.pcnew hero');await f.send('.st SAN=60 侦查=60')
 const checked=await f.send('.ra 侦查'),snapshot=await f.snapshot()
 assert.equal(snapshot.state.builtin.users.alice.activeCard,'hero');assert.equal(active(snapshot).attrs.SAN,60);assert.equal(active(snapshot).skills.侦查,60)
 assert.match(textOf(f.sendsFor(checked)[0]),/\/60/u)
 assert.ok(f.memberReads.length>=4);assert.ok(f.grantReads.every(read=>read.binding.target.kind==='group'))
 assert.equal(snapshot.revision,4);assert.equal(f.requests.length,0)
})

async function yamlPackage(){
 const source=JSON.stringify({version:1,id:'runtime-rules',name:'Runtime YAML',aliases:['runtime'],
  character:{fields:{hp:{type:'integer',default:12,min:0,max:12}}},commands:[
   {id:'hello',aliases:['hello'],output:'YAML reached Core.'},
   {id:'hit',aliases:['hit'],arguments:[{id:'victim',type:'actor',required:true,allowed:['member']},{id:'damage',type:'integer',required:true,min:0,max:12}],
    actions:[{op:'subtract',scope:'target',target:'victim',field:'hp',value:'arg.damage'}],output:'{target.name} HP={target.attr.hp}.'},
  ]})
 return compileAgentDiceRulePackage({kind:'yaml',source,revision:'runtime-yaml-one',sourceHash:createHash('sha256').update(source).digest('hex')})
}

test('compiled pure YAML executes through the actual Core and quote targets come only from readMessage',options,async t=>{
 const pkg=await yamlPackage(),f=await fixture(t,{engine:{rulePackages:[pkg]}})
 const hello=await f.send('.runtime hello');assert.equal(textOf(f.sendsFor(hello)[0]),'YAML reached Core.')
 const quoted=await f.send('.pcnew bob-card',{messageId:'real-quote',sender:f.user('bob')})
 const hit=await f.send('.runtime hit reply 2',{quote:{messageId:quoted.messageId,author:f.user('carol'),authorName:'Forged Carol',text:'fake quote',parts:[{kind:'text',text:'fake quote'}]}})
 const snapshot=await f.snapshot(),bob=snapshot.state.builtin.users.bob
 assert.equal(snapshot.state.rules.packs['runtime-rules'].players[JSON.stringify(['bob',bob.activeCard])]?.values?.hp,10,JSON.stringify({state:snapshot.state.rules,sends:f.sendsFor(hit),readIds:[...new Set(f.reads.map(read=>read.id))],logs:f.logs}))
 assert.ok(f.reads.some(read=>read.id===quoted.messageId&&conversationAddressKey(read.target)===conversationAddressKey(f.group)))
 assert.match(textOf(f.sendsFor(hit)[0]),/bob-card HP=10/u)
 assert.equal(snapshot.state.rules.packs['runtime-rules'].players[JSON.stringify(['carol','default'])],undefined)
 assert.equal(f.requests.length,0)
})

test('same Core source rolls and changes cards only once across duplicates and restart',options,async t=>{
 const f=await fixture(t),saved=await f.send('.st SAN=60'),changed=await f.send('.st SAN+1'),rolled=await f.send('.r 1d100')
 const before=await f.snapshot(),originalText=textOf(f.sendsFor(rolled)[0])
 for(const source of [saved,changed,rolled])await f.emit(source)
 await f.drained();await f.restart()
 for(const source of [changed,rolled])await f.emit(source)
 await f.drained()
 assert.equal((await f.snapshot()).revision,before.revision);assert.equal(active(await f.snapshot()).attrs.SAN,61)
 assert.equal(f.sendsFor(changed).length,1);assert.equal(f.sendsFor(rolled).length,1);assert.equal(textOf(f.sendsFor(rolled)[0]),originalText)
 assert.equal(f.requests.length,0)
})

test('an unknown native receipt remains frozen through Core restart without later output or a new roll',options,async t=>{
 const f=await fixture(t,{receipt:()=>({state:'unknown'})}),message=await f.send('.r 1d6 .r 1d8')
 const operation=await f.operation(message),before=await f.snapshot()
 assert.equal(f.sendsFor(message).length,1);assert.equal(operation.state,'unknown');assert.equal(Object.hasOwn(operation,'effects'),false)
 await f.restart();await f.emit(message);await f.drained()
 assert.equal(f.sendsFor(message).length,1);assert.equal((await f.snapshot()).revision,before.revision);assert.equal(f.requests.length,0)
})

for(const status of ['ready','pending','unknown','confirmed'])test(`the old public ledger ${status} fence blocks replacement Core execution`,options,async t=>{
 const f=await fixture(t),message=f.message('.r 1d100');await f.oldFence(message,status)
 await f.emit(message);await f.drained();await f.restart();await f.emit(message);await f.drained()
 assert.equal(f.sendsFor(message).length,0);assert.equal(await f.operation(message),null);assert.equal(await f.snapshot(),null);assert.equal(f.requests.length,0)
})

test('real native mentions require intersecting actor and subject delegation permissions',options,async t=>{
 const f=await fixture(t),bob=f.user('bob'),mention={mentions:[bob],parts:[{kind:'text',text:'.st SAN=70'},{kind:'mention',user:bob}]}
 const changed=await f.send('.st SAN=70',mention)
 assert.equal(active(await f.snapshot(),'bob').attrs.SAN,70)
 assert.equal(f.sendsFor(changed).length,1);assert.deepEqual(f.sendsFor(changed)[0].binding,f.binding())
 f.permissions=['player'];f.subjectPermissions=['player','delegate']
 const actorDenied=await f.send('.st SAN=1',{mentions:[bob],parts:[{kind:'text',text:'.st SAN=1'},{kind:'mention',user:bob}]})
 assert.equal(active(await f.snapshot(),'bob').attrs.SAN,70);assert.match(textOf(f.sendsFor(actorDenied)[0]),/未修改人物卡/u)
 f.permissions=['player','delegate'];f.subjectPermissions=['player']
 await f.send('.st SAN=2',{mentions:[bob],parts:[{kind:'text',text:'.st SAN=2'},{kind:'mention',user:bob}]})
 assert.equal(active(await f.snapshot(),'bob').attrs.SAN,70);assert.equal(f.requests.length,0)
})

test('builtin hidden delivery uses actions.sendDicePrivate with original group binding and true invoker',options,async t=>{
 const f=await fixture(t),message=await f.send('.rh 1d100')
 assert.equal(f.privateSends.length,1,JSON.stringify({logs:f.logs,attempts:f.privateAttempts.length,operation:await f.operation(message)}));assert.equal(f.sendsFor(message).length,1)
 const request=f.privateSends[0]
 assert.deepEqual(request.binding,f.binding());assert.deepEqual(request.origin.binding,f.binding());assert.equal(request.binding.target.kind,'group')
 assert.deepEqual(request.recipient,f.user('alice'));assert.deepEqual(request.source.sender,message.sender);assert.equal(request.source.messageId,message.messageId)
 assert.deepEqual(request.origin.source.author,message.sender);assert.equal(request.origin.source.messageId,message.messageId)
 assert.equal(request.origin.source.fingerprint,agentDiceSourceFingerprint(message));assert.equal(request.origin.authorityRevision,f.grantRevision)
 assert.equal(request.operationId,request.origin.operationId);assert.match(request.text,/1D100/iu)
 assert.match(textOf(f.sendsFor(message)[0]),/结果仅私聊发送/u);assert.ok(!textOf(f.sendsFor(message)[0]).includes('1D100'))
 assert.deepEqual(f.sendsFor(message)[0].binding,f.binding());assert.equal((await f.operation(message)).state,'confirmed')
 assert.equal(f.requests.length,0)
})

test('a delegated hidden result names the subject while its private relay still belongs to the real invoker',options,async t=>{
 const f=await fixture(t),bob=f.user('bob'),message=await f.send('.rh 1d6',{mentions:[bob],parts:[{kind:'text',text:'.rh 1d6'},{kind:'mention',user:bob}]})
 assert.equal(f.privateSends.length,1)
 const request=f.privateSends[0]
 assert.deepEqual(request.recipient,f.user('alice'));assert.deepEqual(request.source.sender,f.user('alice'));assert.deepEqual(request.origin.source.author,f.user('alice'))
 assert.deepEqual(request.binding,f.binding());assert.deepEqual(request.origin.binding,f.binding());assert.equal(request.source.messageId,message.messageId)
 assert.match(request.text,/Fresh Bob/u);assert.equal(f.requests.length,0)
})

for(const kind of ['incomplete','stale','future','target','namespace','actor-missing','grant-binding','grant-actor'])test(`Core rejects ${kind} evidence before state or native dispatch`,options,async t=>{
 const f=await fixture(t,{
  members(value){
   if(kind==='incomplete')value.complete=false
   if(kind==='stale')value.observedAt-=31_000
   if(kind==='future')value.observedAt+=60_000
   if(kind==='target')value.target.id='different-room'
   if(kind==='namespace')value.members[0].user.namespace='another-namespace'
   if(kind==='actor-missing')value.members=value.members.filter(member=>member.user.id!=='alice')
   return value
  },
  grant(value){if(kind==='grant-binding')value.binding.revision='another-binding';if(kind==='grant-actor')value.actorId='bob';return value},
 }),message=await f.send('.r 1d6')
 assert.equal(f.sendsFor(message).length,0);assert.equal(f.privateSends.length,0);assert.equal(await f.snapshot(),null);assert.equal(await f.operation(message),null);assert.equal(f.requests.length,0)
})

test('omitted grants never dispatch and native owner or admin roles never create administrative powers',options,async t=>{
 const f=await fixture(t,{omitGrant:true,members(value){value.members.forEach(member=>member.role='owner');return value}}),message=await f.send('.r 1d6')
 assert.equal(f.sendsFor(message).length,0);assert.equal(await f.snapshot(),null);assert.equal(await f.operation(message),null);assert.equal(f.requests.length,0)
 const explicit=await fixture(t,{members(value){value.members.forEach(member=>member.role='admin');return value}})
 explicit.permissions=['player'];explicit.subjectPermissions=['player']
 const denied=await explicit.send('.setcoc 3')
 assert.match(textOf(explicit.sendsFor(denied)[0]),/授权的群管理/u);assert.equal((await explicit.snapshot()).state.builtin.scene.rule,undefined)
 assert.equal(explicit.requests.length,0)
})

for(const channel of ['public','private'])for(const revocation of ['recall','forget','rebind','config'])test(`Core ${revocation} stops in-flight ${channel} effects and a fresh source can continue`,options,async t=>{
 const reached=deferred(),release=deferred(),messageId=`${channel}-${revocation}-source`
 const f=await fixture(t,{
  release:()=>release.resolve(),
  async beforeSend(_f,action){if(channel==='public'&&action.replyTo===messageId){reached.resolve();await release.promise}},
  async beforePrivate(_f,request){if(channel==='private'&&request.source.messageId===messageId){reached.resolve();await release.promise}},
 })
 const original=f.message(channel==='private'?'.rh 1d100':'.r 1d6 .r 1d8',{messageId})
 await f.emit(original)
 await waitFor(()=>f.attempts.some(action=>action.replyTo===messageId)||f.privateAttempts.some(request=>request.source.messageId===messageId),'native effect was not reached',()=>f.logs.slice(-5).join('\n'))
 await reached.promise
 assert.equal((await f.operation(original)).state,'pending')
 if(revocation==='recall')await f.recall(original)
 if(revocation==='forget'){
  const before=await f.groupLogs.capture(f.owner(),original.sender.id)
  await f.emit(f.message(privacy.forget,{messageId:'real-forget-'+channel}))
  await waitFor(async()=> (await f.groupLogs.capture(f.owner(),original.sender.id)).sceneEpoch!==before.sceneEpoch,'privacy epoch did not advance')
 }
 if(revocation==='rebind')f.rebind()
 if(revocation==='config')f.engineConfig.revision='revoked-config'
 release.resolve();await f.drained()
 assert.equal(f.sendsFor(original).length,0);assert.equal(f.privateSends.filter(request=>request.source.messageId===messageId).length,0)
 const sealed=await f.operation(original)
 assert.ok(['confirmed','failed','unknown'].includes(sealed.state));assert.equal(Object.hasOwn(sealed,'effects'),false)
 assert.equal(f.attempts.filter(action=>action.replyTo===messageId).length,channel==='public'?1:0,'a revoked source must not continue to a second native public call')
 assert.equal(f.privateAttempts.filter(request=>request.source.messageId===messageId).length,channel==='private'?1:0)
 await f.restart();await f.emit(original);await f.drained()
 assert.equal(f.sendsFor(original).length,0);assert.equal(f.privateSends.filter(request=>request.source.messageId===messageId).length,0)
 const fresh=await f.send('.r 1d6')
 assert.equal(f.sendsFor(fresh).length,1,JSON.stringify(f.logs.slice(-8)));assert.equal((await f.operation(fresh)).state,'confirmed')
 assert.equal(f.requests.length,0)
})

test('a grant revoked while awaiting native private delivery stops both the result and its public notice',options,async t=>{
 const f=await fixture(t,{async beforePrivate(run){run.permissions=['player'];run.subjectPermissions=['player'];run.grantRevision='revoked-explicit-grant'}}),message=await f.send('.rh 1d100')
 assert.equal(f.privateAttempts.length,1);assert.equal(f.privateSends.length,0);assert.equal(f.sendsFor(message).length,0)
 const fresh=await f.send('.r 1d6');assert.equal(f.sendsFor(fresh).length,1);assert.equal(f.requests.length,0)
})
