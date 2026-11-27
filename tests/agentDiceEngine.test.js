import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDiceEngine}=await load('modules/dice/infrastructure/agentDiceEngine.js')
const {createAgentDiceState}=await load('modules/dice/infrastructure/agentDiceState.js')
const {createAgentDiceLedger}=await load('modules/dice/infrastructure/agentDiceLedger.js')
const {createAgentDiceBuiltin}=await load('modules/dice/infrastructure/agentDiceBuiltin.js')
const {connectAgentRedis,openAgentRedis,agentRedisPrefix}=await load('modules/runtime/infrastructure/agentRedis.js')
const {agentBindingIdentity,agentConversationKey,conversationAddressKey}=await load('modules/runtime/domain/agentBindings.js')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account={platform:'fixture',namespace:'dice-engine',id:'bot'}
const binding=(changes={})=>({source:'configured',id:'binding',revision:'one',agentId:'daily',personaId:'persona',connectionId:'connection',target:{account,kind:'group',id:'room'},...changes})
const options={timeout:20000}
const textOf=effects=>effects.filter(effect=>effect.kind==='public').map(effect=>effect.text).join('\n')
const permissionList=['player','admin','delegate','hidden','card']
const randomFromSeed=seed=>{let index=0;return()=>createHash('sha256').update(`${seed}:${index++}`).digest().readUInt32BE(0)/0x1_0000_0000}

async function waitFor(probe,label){for(let attempt=0;attempt<300;attempt++){if(await probe())return;await delay(10)}assert.fail(`Timed out waiting for ${label}`)}
async function fixture(t,settings={}){
 assert.equal(spawnSync('redis-server',['--version'],{stdio:'ignore'}).status,0,'engine tests require actual isolated Redis')
 const directory=await mkdtemp(path.join(tmpdir(),'agent-dice-engine-')),socket=path.join(directory,'redis.sock')
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'}),exited=once(server,'exit').catch(()=>{})
 let reader,connection
 t.after(async()=>{try{await connection?.close();if(reader?.isOpen)await reader.close()}finally{if(server.exitCode===null&&server.signalCode===null)server.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true})}})
 for(let attempt=0;attempt<100;attempt++){if(await stat(socket).then(()=>true,()=>false))break;if(server.exitCode!==null)assert.fail('Redis exited before readiness');await delay(10)}
 const instance='agent-dice-engine-test',url=`unix://${socket}`
 reader=await connectAgentRedis(url);connection=await openAgentRedis({url,instance,onLost(){}})
 const storage=connection.storage,prefix=agentRedisPrefix(instance),state=createAgentDiceState(storage),ledger=createAgentDiceLedger(storage)
 const auth={revision:'authority-1',actor:{id:'alice',name:'Alice'},permissions:permissionList.slice(),members:[{id:'alice',name:'Alice',permissions:permissionList.slice()},{id:'bob',name:'Bob',permissions:permissionList.slice()}],botUserId:'bot'}
 const seeds=[],commits=[],attempts=[],delivered=[],records=[],archives=[],diagnostics=[],sequence=[]
 let serial=0,receipt=0,current=true,controller=new AbortController(),engine,loseCommit=false
 const traced={...state,
  async begin(...args){const result=await state.begin(...args);if(result.kind==='started')seeds.push(result.claim);await settings.afterBegin?.(result,f);return result},
  async commit(...args){const result=await state.commit(...args);if(result)commits.push({operation:result,payload:structuredClone(args[2])});await settings.afterCommit?.(result,f);if(loseCommit){loseCommit=false;return undefined}return result},
  async claimEffect(...args){const result=await state.claimEffect(...args);await settings.afterClaim?.(result,f);return result},
 }
 const config={enabled:true,builtin:{allowHiddenRoll:true},deliveryTimeoutMs:200,...settings.config}
 const ports={state:traced,legacyLedger:ledger,allowsText:text=>!text.includes('BLOCKED-TEXT'),diagnostics:{emit:event=>diagnostics.push(event)},
  async authorize(request,guard){await settings.authorize?.(request,guard,f);return settings.noAuthorization?undefined:structuredClone(auth)},
  async deliver(request,guard){attempts.push(structuredClone(request));await settings.beforeDeliver?.(request,guard,f);if(settings.ignoreGuard!==true)await guard.ensureCurrent?.();const result=settings.receipt?await settings.receipt(request,guard,f):{state:'sent',messageId:'native-delivery-'+ ++receipt};delivered.push(structuredClone(request));sequence.push(request.effect.kind);return result},
 }
 const context=()=>({signal:controller.signal,isCurrent:()=>current,async ensureCurrent(){await settings.ensureCurrent?.(f);if(!current||controller.signal.aborted)throw Error('current source revoked')},
  async record(event){sequence.push('event');records.push(structuredClone(event));await settings.record?.(event,f)},
  async archive(event){sequence.push('archive');archives.push(structuredClone(event));await settings.archive?.(event,f)},
 })
 function make(){return createAgentDiceEngine(config,ports)}
 const f={reader,storage,prefix,state,ledger,auth,seeds,commits,attempts,delivered,records,archives,diagnostics,sequence,config,
  get engine(){return engine},rebuild(){engine=make();return engine},loseCommit(){loseCommit=true},abort(){controller.abort()},revoke(){current=false},resume(){current=true;controller=new AbortController()},
  message(text='.r 1d100',changes={}){const target=changes.conversation??binding().target;return {version:1,conversation:target,sender:{platform:target.account.platform,namespace:target.account.namespace,id:'alice'},senderName:'Alice',messageId:'native-source-'+ ++serial,occurredAt:1_800_000_000_000+serial,text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false,...changes}},
  async handle(message,selected=binding(),selectedEngine=engine){return selectedEngine.handle(message,selected,context())},
  async operation(message,selected=binding()){const raw=await reader.get(prefix+'agent:dice:engine:v1:operation:'+hash([conversationAddressKey(selected.target),message.messageId]));return raw?JSON.parse(raw):null},
  async snapshot(selected=binding()){return state.read(selected)},
  async oldFence(message,status){const source={target:message.conversation,agentId:binding().agentId,authorId:message.sender.id,messageId:message.messageId},epochs=await ledger.capture(source),prepared=await ledger.prepare(source,binding(),hash(['old-source']),[{eventId:hash(['old-result']),text:'old frozen result',result:true}],epochs);assert.ok(prepared);if(status==='ready')return;const{items,...terminal}=prepared.record;const next=status==='pending'?{...prepared.record,state:status}:{...terminal,state:status};await ledger.change(source,prepared,next,epochs)},
 }
 engine=make();return f
}

const activeCard=snapshot=>{const state=snapshot.state.builtin,user=state.users.alice;return user.cards[user.activeCard]}

test('a real source atomically freezes one seed, commits before delivery and archives only the confirmed native message ID',options,async t=>{
 const f=await fixture(t),message=f.message('.r 2d6')
 assert.equal(f.engine.isCandidate(message),true);assert.equal(await f.handle(message),true)
 assert.equal(f.seeds.length,1);assert.equal(f.commits.length,1);assert.equal(f.delivered.length,1)
 const claim=f.seeds[0],expected=await createAgentDiceBuiltin(f.config.builtin).evaluate({state:null,command:message.text,context:{source:{messageId:message.messageId,authorId:'alice',at:message.occurredAt},actor:f.auth.actor,members:f.auth.members,mentions:[],groupId:'room',botUserId:'bot',allows:permission=>f.auth.permissions.includes(permission)},random:randomFromSeed(claim.seed)})
 assert.equal(f.delivered[0].effect.text,textOf(expected.effects))
 assert.equal(f.archives.length,1);assert.equal(f.archives[0].deliveryMessageId,'native-delivery-1');assert.equal(f.archives[0].source.messageId,message.messageId);assert.equal(f.archives[0].producer,'agent-dice-engine')
 assert.match(f.archives[0].eventId,/^[a-f0-9]{64}$/u);assert.equal((await f.operation(message)).state,'confirmed')
 assert.equal('seed'in await f.operation(message),false)
 await f.handle(message);await f.handle(message, binding(),f.rebuild())
 assert.equal(f.seeds.length,1);assert.equal(f.delivered.length,1);assert.equal(f.archives.length,1)
})

test('card transitions commit owner state and truthful producer facts before their public confirmation',options,async t=>{
 const f=await fixture(t),saved=f.message('.st STR=50 SAN=60 侦查=60')
 await f.handle(saved);let snapshot=await f.snapshot();assert.equal(activeCard(snapshot).attrs.SAN,60);assert.equal(activeCard(snapshot).skills.侦查,60)
 assert.equal(f.sequence[0],'event');assert.equal(f.records[0].kind,'card_change');assert.equal(f.records[0].source.messageId,saved.messageId);assert.equal(f.records[0].source.authorId,'alice');assert.equal('deliveryMessageId'in f.records[0],false)
 assert.ok(!JSON.stringify(f.records[0].facts).includes('60'))
 await f.handle(f.message('.pc new second'));snapshot=await f.snapshot();assert.equal(snapshot.state.builtin.users.alice.activeCard,'second')
 await f.handle(f.message('.pc use 默认'));await f.handle(f.message('.sc 1/1'));snapshot=await f.snapshot();assert.equal(activeCard(snapshot).attrs.SAN,59)
 const ra=f.message('.ra 侦查');await f.handle(ra);assert.ok(f.archives.some(event=>event.source.messageId===ra.messageId&&event.text.includes('/60')))
 assert.equal(snapshot.revision,4)
})

test('fresh delegation changes the subject card while audit ownership remains the real message author',options,async t=>{
 const f=await fixture(t),message=f.message('.st SAN=70',{mentions:[{platform:account.platform,namespace:account.namespace,id:'bob'}]})
 await f.handle(message)
 const snapshot=await f.snapshot(),user=snapshot.state.builtin.users.bob
 assert.equal(user.cards[user.activeCard].attrs.SAN,70);assert.equal(f.records[0].source.authorId,'alice');assert.equal(f.records[0].facts.actorId,'alice');assert.ok(f.records[0].facts.subjectIds.includes('bob'))
 f.auth.members.find(member=>member.id==='bob').permissions=[]
 const denied=f.message('.st SAN=1',{mentions:message.mentions});await f.handle(denied)
 const still=await f.snapshot();assert.equal(still.state.builtin.users.bob.cards[user.activeCard].attrs.SAN,70)
 assert.match(f.delivered.at(-1).effect.text,/未修改人物卡/u)
})

test('hidden private delivery is one-shot; an unknown receipt freezes the public notice and all archiveable output',options,async t=>{
 const f=await fixture(t,{receipt:request=>request.effect.kind==='private'?{state:'unknown'}:{state:'sent',messageId:'public'}}),message=f.message('.rh 1d100')
 await f.handle(message)
 assert.deepEqual(f.delivered.map(request=>request.effect.kind),['private']);assert.equal(f.archives.length,0)
 assert.equal((await f.operation(message)).state,'unknown');assert.equal('effects'in await f.operation(message),false)
 await f.handle(message,binding(),f.rebuild());assert.equal(f.delivered.length,1);assert.equal(f.seeds.length,1)
 assert.ok(!f.records.some(event=>JSON.stringify(event).includes('暗骰结果')))
})

test('confirmed hidden results send private first and a fixed public notice with no hidden-result archive',options,async t=>{
 const f=await fixture(t),message=f.message('.rah 侦查 60')
 await f.handle(message)
 assert.deepEqual(f.delivered.map(request=>request.effect.kind),['private','public']);assert.match(f.delivered[0].effect.text,/\/60/u)
 assert.match(f.delivered[1].effect.text,/结果仅私聊发送/u);assert.ok(!f.delivered[1].effect.text.includes('/60'));assert.equal(f.archives.length,0)
 assert.equal((await f.operation(message)).state,'confirmed')
})

test('a delegated hidden roll indexes its subject even without a card-change event, so subject purge clears its ready body',options,async t=>{
 const f=await fixture(t),bob={platform:account.platform,namespace:account.namespace,id:'bob'}
 await f.handle(f.message('.st SAN=60',{mentions:[bob]}))
 const before=await f.snapshot(),message=f.message('.rh 1d6',{mentions:[bob]}),deliveries=f.delivered.length
 f.loseCommit();await f.handle(message)
 const ready=await f.operation(message)
 assert.equal(ready.state,'ready');assert.ok(ready.effects.some(effect=>effect.kind==='private'))
 assert.deepEqual(f.commits.at(-1).payload.subjectIds,['alice','bob'])
 await f.state.purgeSubject({account,agentId:'daily',subjectId:'bob',target:binding().target})
 const purged=await f.operation(message)
 assert.equal(purged.state,'unknown');assert.equal('effects'in purged,false);assert.equal('event'in purged,false)
 assert.deepEqual((await f.snapshot()).state.builtin,before.state.builtin)
 await f.handle(message,binding(),f.rebuild())
 assert.equal(f.delivered.length,deliveries)
})

test('a known sent private receipt settles before a later authority failure seals all remaining effects',options,async t=>{
 const f=await fixture(t,{receipt(_request,_guard,f){f.revoke();return {state:'sent',messageId:'confirmed-before-revoke'}}}),message=f.message('.rh 1d6')
 await f.handle(message)
 assert.deepEqual(f.delivered.map(request=>request.effect.kind),['private'])
 assert.equal((await f.operation(message)).state,'unknown')
 assert.equal((await f.snapshot()).revision,2,'the known sent receipt and business projection settle before the continuation fence')
 f.resume();await f.handle(message,binding(),f.rebuild())
 assert.equal(f.delivered.length,1)
 assert.equal(f.archives.length,0)
})

for(const raw of [{state:'sent'},{state:'sent',messageId:'0'},{state:'confirmed'},null]){
 test(`a message receipt without a genuine delivery ID stays unknown (${JSON.stringify(raw)})`,options,async t=>{
  const f=await fixture(t,{receipt:()=>raw}),message=f.message('.r 1d6 .r 1d6')
  await f.handle(message);assert.equal(f.delivered.length,1);assert.equal(f.archives.length,0);assert.equal((await f.operation(message)).state,'unknown')
  await f.handle(message);assert.equal(f.delivered.length,1);assert.equal(f.seeds.length,1)
 })
}

test('a durable ready result resumes delivery after lost commit acknowledgement without another computation',options,async t=>{
 const f=await fixture(t),message=f.message('.r 1d6');f.loseCommit();await f.handle(message)
 assert.equal(f.delivered.length,0);const ready=await f.operation(message);assert.equal(ready.state,'ready');const frozen=ready.effects.find(effect=>effect.kind==='public').text
 await f.handle(message,binding(),f.rebuild());assert.equal(f.seeds.length,1);assert.equal(f.commits.length,1);assert.equal(f.delivered[0].effect.text,frozen);assert.equal((await f.operation(message)).state,'confirmed')
})

test('restart recovery turns an interrupted pending delivery into unknown and never retries its frozen text',options,async t=>{
 const f=await fixture(t),message=f.message('.r 1d6');f.loseCommit();await f.handle(message)
 const ready=await f.operation(message),claimed=await f.state.claimEffect(binding(),ready.source,0);assert.ok(claimed);assert.equal((await f.operation(message)).state,'pending')
 await f.handle(message,binding(),f.rebuild());assert.equal(f.delivered.length,0);assert.equal(f.seeds.length,1);assert.equal((await f.operation(message)).state,'unknown')
})

test('concurrent duplicate messages across engine instances claim a source at most once and never consume a second seed',options,async t=>{
 const f=await fixture(t),message=f.message('.r 1d100'),other=f.rebuild()
 await Promise.all(Array.from({length:12},(_,index)=>f.handle(message,binding(),index%2?f.engine:other)))
 assert.equal(f.seeds.length,1);assert.ok(f.delivered.length<=1);assert.ok(f.archives.length<=1)
 const operation=await f.operation(message);assert.ok(['confirmed','unknown'].includes(operation.state));await f.handle(message);assert.equal(f.seeds.length,1)
})

test('business state partitions by complete account, Agent and scene while a real source cannot move owners',options,async t=>{
 const f=await fixture(t),selected=binding(),message=f.message('.st SAN=60');await f.handle(message,selected)
 const accountTwo={...account,id:'bot-two'},otherAccount=binding({target:{account:accountTwo,kind:'group',id:'room'}}),otherScene=binding({target:{account,kind:'group',id:'elsewhere'}}),otherAgent=binding({agentId:'other'})
 for(const [owner,value]of [[otherAccount,10],[otherScene,20],[otherAgent,30]]){
  assert.equal(await f.snapshot(owner),null)
  const next=f.message(`.st SAN=${value}`,{conversation:owner.target});await f.handle(next,owner);assert.equal(activeCard(await f.snapshot(owner)).attrs.SAN,value)
 }
 assert.equal(activeCard(await f.snapshot(selected)).attrs.SAN,60)
 const count=f.delivered.length;await f.handle(message,otherAgent);await f.handle(message,{...selected,revision:'rebound'});assert.equal(f.delivered.length,count);assert.equal(f.seeds.filter(claim=>claim.source.messageId===message.messageId).length,1)
 const reused=f.message('.st SAN=11',{messageId:message.messageId,conversation:otherAccount.target});await f.handle(reused,otherAccount)
 assert.equal(activeCard(await f.snapshot(otherAccount)).attrs.SAN,11)
})

for(const kind of ['recall','global-purge','scene-purge','authority-change','source-revoked']){
 test(`${kind} at the dispatch boundary stops the first external effect and fences replay`,options,async t=>{
  let fired=false
  const f=await fixture(t,{async beforeDeliver(request,guard,f){if(fired)return;fired=true
   if(kind==='recall')await f.ledger.revokeSource(request.binding.target,request.source.messageId)
   if(kind==='global-purge')await f.ledger.purgeSubject({account:request.binding.target.account,agentId:request.binding.agentId,subjectId:request.source.sender.id})
   if(kind==='scene-purge')await f.ledger.purgeSubject({account:request.binding.target.account,agentId:request.binding.agentId,subjectId:request.source.sender.id,target:request.binding.target})
   if(kind==='authority-change')f.auth.revision='authority-2'
   if(kind==='source-revoked')f.revoke()
  }}),message=f.message('.r 1d6 .r 1d6')
  await f.handle(message);assert.equal(f.attempts.length,1);assert.equal(f.delivered.length,0);assert.equal(f.archives.length,0);assert.equal((await f.operation(message)).state,'unknown')
  f.resume();await f.handle(message,binding(),f.rebuild());assert.equal(f.delivered.length,0);assert.equal(f.seeds.length,1)
 })
}

test('a timed-out remote wait stays unknown, ignores the late result and does not continue or retry',options,async t=>{
 let release, deliverySignal
 const f=await fixture(t,{config:{deliveryTimeoutMs:100},ignoreGuard:true,receipt:(_request,guard)=>new Promise(resolve=>{release=resolve;deliverySignal=guard.signal})}),message=f.message('.r 1d6 .r 1d6')
 await f.handle(message);assert.equal(f.attempts.length,1);assert.equal(f.archives.length,0);assert.equal((await f.operation(message)).state,'unknown')
 assert.equal(deliverySignal.reason.name,'TimeoutError')
 const failure=f.diagnostics.find(event=>event.code==='effect_continuation_unconfirmed')
 assert.equal(failure.details.step,'dice_effect_delivery');assert.equal(failure.details.field,'public');assert.equal(failure.delivery.state,'unknown')
 release({state:'sent',messageId:'late-native-result'});await delay(10);await f.handle(message,binding(),f.rebuild());assert.equal(f.attempts.length,1);assert.equal(f.seeds.length,1);assert.equal(f.archives.length,0)
})

for(const state of ['ready','pending','unknown','confirmed']){
 test(`the old public-dice ${state} ledger fence prevents a replacement roll`,options,async t=>{
  const f=await fixture(t),message=f.message('.r 1d100');await f.oldFence(message,state)
  await f.handle(message);assert.equal(f.seeds.length,0);assert.equal(f.delivered.length,0);assert.equal(await f.snapshot(),null)
 })
}

test('unowned old roots and malformed message authority never become neutral card state',options,async t=>{
 const f=await fixture(t)
 await f.reader.set(f.prefix+'dice:state',JSON.stringify({users:{alice:{activeCard:'legacy',cards:{legacy:{name:'legacy',attrs:{SAN:99},skills:{}}}}},groups:{room:{rule:'3'}}}))
 const message=f.message('.st show');await f.handle(message);assert.ok(!textOf(f.delivered.map(row=>row.effect)).includes('99'));assert.notEqual((await f.snapshot()).state.builtin.users.alice.activeCard,'legacy')
 const before=f.seeds.length
 for(const extra of [{messageId:undefined},{messageId:'0'},{sender:{platform:'other',namespace:account.namespace,id:'alice'}},{parts:[{kind:'image',url:'private'}]},{quote:{messageId:'quoted'},mentions:[]}]){
  const invalid=f.message('.ra 侦查',extra);if(extra.quote){f.auth.actor.id='bob'}await f.handle(invalid);f.auth.actor.id='alice'
 }
 assert.equal(f.seeds.length,before)
})
