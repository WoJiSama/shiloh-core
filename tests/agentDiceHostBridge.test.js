import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDiceHostBridge}=await load('modules/dice/infrastructure/agentDiceHostBridge.js')
const {createAgentDiceState}=await load('modules/dice/infrastructure/agentDiceState.js')
const {createAgentDiceLedger}=await load('modules/dice/infrastructure/agentDiceLedger.js')
const {compileAgentDiceRulePackage}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const {connectAgentRedis,openAgentRedis,agentRedisPrefix}=await load('modules/runtime/infrastructure/agentRedis.js')
const {conversationAddressKey}=await load('modules/runtime/domain/agentBindings.js')
const {agentDiceSourceFingerprint}=await load('modules/dice/infrastructure/agentDiceSource.js')
const account={platform:'fixture',namespace:'dice-host',id:'bot'}
const user=id=>({...account,id})
const binding=()=>({source:'configured',id:'binding',revision:'binding-one',agentId:'daily',personaId:'persona',connectionId:'connection',target:{account:{...account},kind:'group',id:'room'}})
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const permissions=['player','hidden','delegate','card','gm','admin']
const options={timeout:20000}
async function yamlPackage(){const source=await readFile(new URL('../docs/dice-rules/examples/team-session.yaml',import.meta.url),'utf8');return compileAgentDiceRulePackage({kind:'yaml',source,revision:'bridge-yaml',sourceHash:createHash('sha256').update(source).digest('hex')})}
async function fixture(t,settings={}){
 assert.equal(spawnSync('redis-server',['--version'],{stdio:'ignore'}).status,0,'host bridge tests require isolated Redis')
 const directory=await mkdtemp(path.join(tmpdir(),'agent-dice-host-')),socket=path.join(directory,'redis.sock'),server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'}),exited=once(server,'exit').catch(()=>{})
 let connection,reader
 t.after(async()=>{try{await connection?.close();if(reader?.isOpen)await reader.close()}finally{if(server.exitCode===null&&server.signalCode===null)server.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true})}})
 for(let index=0;index<100;index++){if(await stat(socket).then(()=>true,()=>false))break;await delay(10)}
 const url=`unix://${socket}`,instance='agent-dice-host-test';reader=await connectAgentRedis(url);connection=await openAgentRedis({url,instance,onLost(){}})
 const storage=connection.storage,prefix=agentRedisPrefix(instance),state=createAgentDiceState(storage),ledger=createAgentDiceLedger(storage),messages=new Map(),blocked=new Set(),publicSends=[],privateSends=[],cardSends=[],logs=[],records=[],archives=[],reads=[],claims=[]
 let serial=0,sends=0,current=true,controller=new AbortController(),bridge
 const f={state,ledger,reader,prefix,publicSends,privateSends,cardSends,logs,records,archives,reads,claims,messages,blocked,clock:1_800_000_001_000,revision:'grant-one',permissions:permissions.slice(),subjectPermissions:permissions.slice(),
  members:[{user:user('alice'),displayName:'Fresh Alice',role:'member'},{user:user('bob'),displayName:'Fresh Bob',role:'admin'},{user:user('keeper'),displayName:'Fresh Keeper',role:'owner'},{user:user('bot'),displayName:'Dice Bot',role:'admin'}],
  get bridge(){return bridge},revoke(){current=false},resume(){current=true;controller=new AbortController()},
  message(text='.r 1d6',extra={}){const value={version:1,conversation:binding().target,sender:user('alice'),senderName:'Stale Alice',messageId:'host-source-'+ ++serial,occurredAt:1_800_000_000_000+serial,text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false,...extra};messages.set(value.messageId,structuredClone(value));return value},
  context(){return {signal:controller.signal,isCurrent:()=>current,logActive:false,async ensureCurrent(){if(!current||controller.signal.aborted)throw Error('host source revoked')},async record(event){records.push(structuredClone(event))},async archive(event){archives.push(structuredClone(event))}}},
  async handle(message,selected=binding()){return bridge.handle(message,selected,f.context())},
  async snapshot(selected=binding()){return state.read(selected)},
  async operation(message){const raw=await reader.get(prefix+'agent:dice:engine:v1:operation:'+hash([conversationAddressKey(message.conversation),message.messageId]));return raw?JSON.parse(raw):null},
 }
 const traced={...state,async begin(...args){const result=await state.begin(...args);if(result.kind==='started')claims.push(result.claim);return result},async readDelivery(...args){const row=await state.readDelivery(...args);return settings.readDelivery?settings.readDelivery(row,f):row}}
 const ports={state:traced,legacyLedger:ledger,now:()=>f.clock,maxEvidenceAgeMs:1000,allowsText:text=>!text.includes('BLOCKED-TEXT'),
  async readGrant(request,guard){reads.push(['grant',request.source.messageId]);await guard.ensureCurrent?.();const value={binding:structuredClone(request.binding),revision:f.revision,actorId:request.source.sender.id,permissions:f.permissions.slice(),subjects:f.members.filter(member=>member.user.id!==request.source.sender.id&&member.user.id!=='bot').map(member=>({id:member.user.id,permissions:f.subjectPermissions.slice()}))};return settings.readGrant?settings.readGrant(value,request,f):value},
  async readMessage(request,guard){reads.push(['message',request.messageId]);await guard.ensureCurrent?.();const value=messages.get(request.messageId);return settings.readMessage?settings.readMessage(value?structuredClone(value):undefined,request,f):value?structuredClone(value):undefined},
  async readMembers(request,guard){reads.push(['members',request.binding.target.id]);await guard.ensureCurrent?.();const value={target:structuredClone(request.binding.target),observedAt:f.clock,members:structuredClone(f.members),complete:true};return settings.readMembers?settings.readMembers(value,request,f):value},
  async sourceAllowed(request,guard){await guard.ensureCurrent?.();return !blocked.has(request.source.messageId)},
  async sendPublic(request,guard){await settings.beforePublic?.(request,guard,f);await guard.ensureCurrent?.();publicSends.push(structuredClone(request));return settings.publicReceipt??{state:'sent',messageId:'host-public-'+ ++sends}},
  ...(settings.noPrivate?{}:{async relayPrivate(request,guard){await settings.beforePrivate?.(request,guard,f);await guard.ensureCurrent();privateSends.push(structuredClone(request));return typeof settings.privateReceipt==='function'?settings.privateReceipt(request,f):settings.privateReceipt??{state:'sent',messageId:'host-private-'+ ++sends}}}),
  ...(settings.noCard?{}:{async setGroupCard(request,guard){await guard.ensureCurrent?.();cardSends.push(structuredClone(request));return {state:'confirmed'}}}),
  ...(settings.withLog?{async controlLog(request,guard){await guard.ensureCurrent?.();logs.push(structuredClone(request));return {state:'confirmed'}}}:{}),
 }
 bridge=createAgentDiceHostBridge({enabled:true,builtin:{allowHiddenRoll:true},deliveryTimeoutMs:500,...settings.config},ports)
 return f
}
const active=snapshot=>{const owner=snapshot.state.builtin.users.alice;return owner.cards[owner.activeCard]}

test('fresh host evidence drives builtin card state and real public receipts while observation timestamps stay outside authority identity',options,async t=>{
 const f=await fixture(t,{readMembers(value,_request,f){value.observedAt=f.clock++;return value}}),saved=f.message('.st 力量=60 侦查=50')
 assert.equal(f.bridge.isCandidate(saved),true);assert.equal(await f.handle(saved),true);assert.equal(active(await f.snapshot()).attrs.STR,60);assert.equal(f.records[0].source.authorId,'alice')
 const rolled=f.message('.ra 侦查');await f.handle(rolled)
 assert.equal(f.publicSends.length,2);assert.equal(f.archives.filter(event=>event.source.messageId===rolled.messageId).length,1);assert.match(f.publicSends.at(-1).text,/Fresh Alice/u);assert.equal(f.archives.at(-1).deliveryMessageId,'host-public-2')
 assert.ok(f.reads.filter(([kind])=>kind==='members').length>2)
 await f.handle(rolled);assert.equal(f.publicSends.length,2);assert.equal(f.claims.length,2)
})

test('raw source fingerprints ignore display names and embedded quote authors but a verified same-group quote chooses the real card target',options,async t=>{
 const f=await fixture(t,{config:{rulePackages:[await yamlPackage()]}});await f.handle(f.message('.st SAN=60',{mentions:[user('bob')]}))
 const quoted=f.message('quoted body',{messageId:'quoted-native',sender:user('bob')}),message=f.message('.ember 攻击 reply 2',{quote:{messageId:quoted.messageId,author:user('keeper'),authorName:'forged',text:'forged body',parts:[]}})
 f.messages.get(message.messageId).senderName='Another display name';f.messages.get(message.messageId).quote={messageId:quoted.messageId,author:user('alice'),parts:[]}
 await f.handle(message)
 const snapshot=await f.snapshot(),bob=snapshot.state.builtin.users.bob
 assert.equal(snapshot.state.rules.packs['ember-team'].players[JSON.stringify(['bob',bob.activeCard])].values.hp,10);assert.equal(f.records[0].source.authorId,'alice');assert.ok(f.reads.some(([kind,id])=>kind==='message'&&id==='quoted-native'))
})

for(const kind of ['incomplete','stale','future','target','namespace','actor-missing','grant-binding','grant-actor','source-text','source-parts','source-mentions','source-quote-id','source-recalled']){
 test(`host ${kind} evidence cannot authorize computation or any transport`,options,async t=>{
  const f=await fixture(t,{
   readMembers(value){if(kind==='incomplete')value.complete=false;if(kind==='stale')value.observedAt-=1001;if(kind==='future')value.observedAt+=1;if(kind==='target')value.target.id='elsewhere';if(kind==='namespace')value.members[0].user.namespace='other';if(kind==='actor-missing')value.members=value.members.filter(member=>member.user.id!=='alice');return value},
   readGrant(value){if(kind==='grant-binding')value.binding.revision='different';if(kind==='grant-actor')value.actorId='bob';return value},
   readMessage(value,request){if(!value||request.messageId!==value.messageId)return value;if(kind==='source-text'){value.text='.r 1d100';value.parts=[{kind:'text',text:value.text}]}if(kind==='source-parts')value.parts.push({kind:'mention',user:user('bob')});if(kind==='source-mentions')value.mentions.push(user('bob'));if(kind==='source-quote-id')value.quote={messageId:'other-quote',parts:[]};return value},
  }),message=f.message('.r 1d6');if(kind==='source-recalled')f.blocked.add(message.messageId)
  await f.handle(message);assert.equal(f.claims.length,0);assert.equal(f.publicSends.length,0);assert.equal(f.privateSends.length,0);assert.equal(await f.snapshot(),null)
 })
}

test('platform member roles do not create administrative grants or allow a forged quote from another namespace',options,async t=>{
 const f=await fixture(t);f.permissions=['player'];f.subjectPermissions=['player'];await f.handle(f.message('.setcoc 3'))
 assert.match(f.publicSends.at(-1).text,/授权的群管理/u)
 const quote=f.message('quote',{messageId:'cross-namespace',sender:{...user('bob'),namespace:'other'}}),message=f.message('.st SAN=20',{quote:{messageId:quote.messageId,parts:[]}}),before=f.claims.length
 await f.handle(message);assert.equal(f.claims.length,before)
})

test('transport guards re-read host evidence after its queue and stop a changed member set before public dispatch',options,async t=>{
 const f=await fixture(t,{beforePublic(_request,_guard,f){f.members=f.members.filter(member=>member.user.id!=='bob')}}),message=f.message('.r 1d6')
 await f.handle(message);assert.equal(f.publicSends.length,0);assert.equal(f.archives.length,0);assert.equal((await f.operation(message)).state,'unknown')
})

test('builtin hidden results use an explicit group-origin relay and only a fixed public notice follows confirmation',options,async t=>{
 const f=await fixture(t),message=f.message('.rh 1d6');await f.handle(message)
 assert.equal(f.privateSends.length,1);const request=f.privateSends[0]
 assert.deepEqual(request.binding,binding());assert.equal(request.source.messageId,message.messageId);assert.deepEqual(request.recipient,user('alice'));assert.equal(request.origin.source.fingerprint,agentDiceSourceFingerprint(message));assert.equal(request.origin.source.author.id,'alice');assert.equal(request.origin.authorityRevision,'grant-one');assert.equal(request.origin.operationId,request.operationId)
 assert.equal(f.publicSends.length,1);assert.match(f.publicSends[0].text,/结果仅私聊发送/u);assert.equal(f.archives.length,0)
})

test('missing private relay or card ports return definite failure without a public fallback or fake platform success',options,async t=>{
 const f=await fixture(t,{noPrivate:true,noCard:true}),hidden=f.message('.rh 1d6');await f.handle(hidden)
 assert.equal(f.publicSends.length,0);assert.equal(f.privateSends.length,0);assert.equal((await f.operation(hidden)).state,'failed')
 const named=f.message('.sn 新名片');await f.handle(named);assert.equal(f.cardSends.length,0);assert.equal((await f.operation(named)).state,'failed')
})

test('card changes carry a real namespaced subject and confirmed card receipts',options,async t=>{
 const f=await fixture(t),message=f.message('.sn 新名片');await f.handle(message)
 assert.equal(f.cardSends.length,1);assert.deepEqual(f.cardSends[0].subject,user('alice'));assert.equal(f.cardSends[0].name,'新名片');assert.equal((await f.operation(message)).state,'confirmed')
})

test('YAML session start uses its explicit confirmed log port and a missing log port fails without claiming success',options,async t=>{
 const pkg=await yamlPackage(),enabled=await fixture(t,{config:{rulePackages:[pkg]},withLog:true}),message=enabled.message('.ember 团务 开始 真实团务')
 await enabled.handle(message);assert.equal(enabled.logs.length,1);assert.equal(enabled.logs[0].operation,'start');assert.equal(enabled.logs[0].title,'真实团务');assert.equal(enabled.logs[0].source.messageId,message.messageId);assert.equal((await enabled.operation(message)).state,'confirmed')
 const ownership=enabled.logs[0].ownershipId;assert.match(ownership,/^[a-f0-9]{64}$/u);assert.equal((await enabled.snapshot()).state.rules.packs['ember-team'].group.session.logOwnershipId,ownership)
 await enabled.handle(enabled.message('.ember 团务 结束'));assert.equal(enabled.logs.length,2);assert.equal(enabled.logs[1].operation,'stop');assert.equal(enabled.logs[1].ownershipId,ownership)
 const missing=await fixture(t,{config:{rulePackages:[pkg]}}),denied=missing.message('.ember 团务 开始 真实团务');await missing.handle(denied)
 assert.equal(missing.logs.length,0);assert.equal(missing.publicSends.length,0);assert.equal((await missing.operation(denied)).state,'failed')
})

test('a private relay guard rejects a recalled original source after the relay queue and never publishes hidden output',options,async t=>{
 const f=await fixture(t,{beforePrivate(request,_guard,f){f.blocked.add(request.origin.source.messageId)}}),message=f.message('.rh 1d6');await f.handle(message)
 assert.equal(f.privateSends.length,0);assert.equal(f.publicSends.length,0);assert.equal(f.archives.length,0);assert.equal((await f.operation(message)).state,'unknown')
})

test('target recall fences both replacement Engine and old public ledger sources, including after a late duplicate',options,async t=>{
 const f=await fixture(t),message=f.message('.r 1d6');await f.bridge.revokeSource(message.conversation,message.messageId);await f.handle(message)
 assert.equal(f.publicSends.length,0);assert.equal(f.claims.length,0)
 assert.equal((await f.ledger.capture({target:message.conversation,agentId:'daily',authorId:'alice',messageId:message.messageId})).recalled,true)
})

test('subject purge uses account and Agent scope without requiring the old current binding and advances legacy epochs too',options,async t=>{
 const f=await fixture(t),here=binding(),there={...binding(),target:{...binding().target,id:'another-room'}},otherAgent={...binding(),agentId:'other-agent'}
 const originals=[]
 for(const selected of [here,there,otherAgent]){const message=f.message('.st SAN=60',{conversation:selected.target});originals.push(message);await f.handle(message,selected)}
 await f.handle(f.message('.st SAN=70',{sender:user('bob')}),here)
 const legacySource={target:here.target,agentId:here.agentId,authorId:'alice',messageId:'epoch-probe'},before=await f.ledger.capture(legacySource)
 await f.bridge.purgeSubject({account,agentId:'daily',subjectId:'alice',target:here.target})
 assert.equal(active(await f.snapshot(here)).attrs.SAN,60);assert.ok((await f.snapshot(here)).state.builtin.users.bob);assert.equal(active(await f.snapshot(there)).attrs.SAN,60)
 const sealed=await f.operation(originals[0]);assert.equal(sealed.state,'unknown');for(const key of ['effects','event','receipts'])assert.equal(Object.hasOwn(sealed,key),false)
 assert.equal((await f.operation(originals[1])).state,'confirmed');const sent=f.publicSends.length,claimed=f.claims.length
 await f.handle(originals[0],{...here,revision:'rebound'});assert.equal(f.publicSends.length,sent);assert.equal(f.claims.length,claimed)
 const scene=await f.ledger.capture(legacySource);assert.notEqual(scene.scene,before.scene)
 await f.bridge.purgeSubject({account,agentId:'daily',subjectId:'alice'})
 assert.equal(active(await f.snapshot(there)).attrs.SAN,60);assert.equal(active(await f.snapshot(otherAgent)).attrs.SAN,60)
 const global=await f.operation(originals[1]);assert.equal(global.state,'unknown');for(const key of ['effects','event','receipts'])assert.equal(Object.hasOwn(global,key),false)
 assert.equal((await f.operation(originals[2])).state,'confirmed')
 assert.notEqual((await f.ledger.capture(legacySource)).global,before.global)
})

test('configured YAML private results retain durable original source ownership and a matching leased delivery index',options,async t=>{
 const pkg=await yamlPackage()
 const f=await fixture(t,{config:{rulePackages:[pkg]}}),message=f.message('.ember secret');await f.handle(message)
 assert.ok(f.privateSends.length>0);for(const relay of f.privateSends){assert.equal(relay.origin.source.messageId,message.messageId);assert.equal(relay.origin.source.author.id,'alice');assert.equal(relay.binding.target.kind,'group');assert.equal(relay.packId,'ember-team');assert.ok(relay.deliveryId)}
 assert.equal(f.archives.length,0);assert.ok(f.publicSends.every(row=>!row.text.includes('1D100')))
})

test('an indexed YAML private effect cannot relay when another operation owns its delivery lease',options,async t=>{
 const pkg=await yamlPackage()
 const f=await fixture(t,{config:{rulePackages:[pkg]},readDelivery(row){return row?{...row,operationId:'0'.repeat(64)}:row}}),message=f.message('.ember secret');await f.handle(message)
 assert.equal(f.privateSends.length,0);assert.equal(f.publicSends.length,0);assert.equal((await f.operation(message)).state,'unknown')
})

test('an explicit YAML private retry revalidates and relays the original author and fingerprint from a later human attempt',options,async t=>{
 let failed=true
 const f=await fixture(t,{config:{rulePackages:[await yamlPackage()]},privateReceipt(){return failed?{state:'failed'}:{state:'sent',messageId:'retried-private-native'}}}),message=f.message('.ember secret')
 await f.handle(message);assert.equal(f.privateSends.length,1);assert.equal((await f.operation(message)).state,'failed')
 failed=false;const retry=f.message('.ember 投递 重试',{sender:user('keeper')});await f.handle(retry)
 assert.equal(f.privateSends.length,2);const sent=f.privateSends.at(-1)
 assert.equal(sent.source.messageId,retry.messageId);assert.equal(sent.source.sender.id,'keeper');assert.equal(sent.origin.source.messageId,message.messageId);assert.equal(sent.origin.source.author.id,'alice');assert.equal(sent.origin.source.fingerprint,agentDiceSourceFingerprint(message));assert.notEqual(sent.origin.operationId,sent.operationId)
 assert.equal(sent.deliveryId,f.privateSends[0].deliveryId);assert.equal(sent.binding.target.kind,'group');assert.equal(f.archives.length,0)
})

test('a queued YAML retry loses its original GM recipient authority even when only the original grant changes',options,async t=>{
 let failed=true,revoked=false,originId
 const f=await fixture(t,{config:{rulePackages:[await yamlPackage()]},privateReceipt(){return failed?{state:'failed'}:{state:'sent',messageId:'must-not-send'}},
  readGrant(value,request){if(revoked&&request.source.messageId===originId)value.permissions=value.permissions.filter(permission=>!['gm','admin','master'].includes(permission));return value},
  beforePrivate(request){if(request.origin.source.messageId!==request.source.messageId)revoked=true},
 }),message=f.message('.ember secret');originId=message.messageId;await f.handle(message)
 assert.equal(f.privateSends.length,1);failed=false;const retry=f.message('.ember 投递 重试',{sender:user('keeper')});await f.handle(retry)
 assert.equal(f.privateSends.length,1);assert.equal((await f.operation(retry)).state,'unknown');assert.equal(f.archives.length,0)
})
