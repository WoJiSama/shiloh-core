import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDicePrivateOrigin:createOrigin,readAgentDicePrivateOrigin:readOrigin,prepareAgentDicePrivateDeliveries:prepare,
  settleAgentDicePrivateDelivery:settle,scrubAgentDicePrivateSource:scrub,scrubAgentDicePrivateSubject:scrubSubject}=await load('modules/dice/infrastructure/agentDicePrivateDelivery.js')
const {agentDiceSourceFingerprint:fingerprint}=await load('modules/dice/infrastructure/agentDiceSource.js')
const {conversationAddressKey}=await load('modules/runtime/domain/agentBindings.js')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account={platform:'fixture',namespace:'dice-private',id:'bot'}
const binding={source:'configured',id:'binding',revision:'one',agentId:'daily',personaId:'persona',connectionId:'connection',target:{account,kind:'group',id:'room'}}
const source=(id='real-origin')=>({version:1,conversation:structuredClone(binding.target),sender:{...account,id:'alice'},messageId:id,occurredAt:1_800_000_000_000,
  text:'.ember secret',parts:[{kind:'text',text:'.ember secret'}],mentions:[],directedToAccount:false})
const operation=id=>hash([conversationAddressKey(binding.target),id])
const origin=(id='real-origin')=>createOrigin(binding,source(id),operation(id),'authority-one')
const effects=()=>[{kind:'event',event:{kind:'card_change'}},{kind:'private',packId:'ember',deliveryId:'audit-one:alice',recipientId:'alice',text:'SECRET-ALICE'},
  {kind:'private',packId:'ember',deliveryId:'audit-one:bob',recipientId:'bob',text:'SECRET-BOB'},{kind:'public',text:'公开通知'}]
const state=()=>({version:1,builtin:{version:1,users:{alice:{activeCard:'card',cards:{card:{name:'Alice',attrs:{SAN:70},skills:{侦查:55}}}}}},rules:{version:1,packs:{
  ember:{players:{alice:{values:{hp:9}}},group:{group:{values:{threat:3}},audit:[{id:'audit-one',source:{messageId:'real-origin'},output:'SECRET-AUDIT',result:'SECRET-RESULT',rolls:{secret:13},args:{secret:42},actions:[{secret:true}],tags:['secret']}],privateDeliveries:[
    {deliveryId:'audit-one:alice',userId:'alice',text:'SECRET-ALICE',state:'unknown',attempts:0,requiredPermission:'gm'},
    {deliveryId:'audit-one:bob',userId:'bob',text:'SECRET-BOB',state:'unknown',attempts:0,requiredPermission:'gm'},
  ]}},
  other:{players:{bob:{values:{hp:5}}},group:{audit:[{id:'unrelated',source:{messageId:'other-source'},output:'KEEP-AUDIT'}],privateDeliveries:[{deliveryId:'unrelated:charlie',userId:'charlie',text:'KEEP-CHARLIE',state:'failed'}]}},
}}})
const queue=(value,pack='ember')=>value.rules.packs[pack].group.privateDeliveries
const prepared=()=>prepare(state(),effects(),origin(),operation('real-origin'))
const attempt=(index=1,id='real-origin')=>({operationId:operation(id),index})

test('private origin captures a genuine source fingerprint, complete binding, operation and independent grant revision',()=>{
  const message=source(),result=createOrigin(binding,message,operation(message.messageId),'authority-two')
  assert.equal(result.operationId,operation('real-origin'))
  assert.equal(result.authorityRevision,'authority-two')
  assert.deepEqual(result.binding,binding)
  assert.deepEqual(result.source,{messageId:'real-origin',author:{...account,id:'alice'},occurredAt:message.occurredAt,fingerprint:fingerprint(message)})
  assert.notEqual(result.binding,binding)
  message.text='changed';message.parts[0].text='changed'
  assert.notEqual(result.source.fingerprint,fingerprint(message))
  assert.deepEqual(readOrigin(result),result)
})

test('origin decoding rejects forged operation IDs, missing provenance and mismatched source namespaces',()=>{
  for(const change of [value=>{value.operationId='a'.repeat(64)},value=>{value.source.messageId='another-source'},value=>{value.source.messageId='0'},
    value=>{delete value.source.fingerprint},value=>{value.source.fingerprint='invalid'},value=>{value.source.author.namespace='other'},
    value=>{value.source.author.platform='other'},value=>{value.source.occurredAt=0},value=>{value.binding.target.kind='private'},value=>{value.binding.source='legacy'},
    value=>{value.unknown='authority'},value=>{value.source.extra=true}]){
    const value=origin();change(value);assert.throws(()=>readOrigin(value),/私密投递/u)
  }
})

test('preparation binds each exact queued recipient to the durable stored-effect index without mutating inputs',()=>{
  const input=state(),outbound=effects(),before=structuredClone(input),priorEffects=structuredClone(outbound),result=prepare(input,outbound,origin(),operation('real-origin'))
  assert.deepEqual(input,before);assert.deepEqual(outbound,priorEffects)
  assert.deepEqual(result.privateDeliveries,[{packId:'ember',deliveryId:'audit-one:alice',originMessageId:'real-origin',index:1},
    {packId:'ember',deliveryId:'audit-one:bob',originMessageId:'real-origin',index:2}])
  for(const [index,item]of queue(result.state).entries()){
    assert.deepEqual(item.origin,origin())
    assert.deepEqual(item.attempt,attempt(index+1))
    assert.deepEqual(result.effects[index+1].origin,item.origin)
    assert.equal(result.effects[index+1].requiredPermission,'gm')
  }
  assert.deepEqual(result.state.builtin,input.builtin)
  assert.deepEqual(result.state.rules.packs.other,input.rules.packs.other)
})

test('preparation refuses ambiguous, mismatched and duplicated queue intents',()=>{
  const cases={recipient:out=>{out[1].recipientId='bob'},body:out=>{out[1].text='different'},missing:out=>{out[1].deliveryId='missing'},
    pack:out=>{out[1].packId='other'},duplicate:out=>{out.push(structuredClone(out[1]))},halfReference:out=>{delete out[1].packId}}
  for(const [label,change]of Object.entries(cases)){const input=state(),out=effects();change(out);assert.throws(()=>prepare(input,out,origin(),operation('real-origin')),/私密投递/u,label)}
  const duplicate=state();queue(duplicate).push(structuredClone(queue(duplicate)[0]))
  assert.throws(()=>prepare(duplicate,effects(),origin(),operation('real-origin')),/私密投递/u)
  const notFenced=state();queue(notFenced)[0].state='failed'
  assert.throws(()=>prepare(notFenced,effects(),origin(),operation('real-origin')),/私密投递/u)
})

test('an explicit retry preserves the original source and authority while binding a new durable attempt',()=>{
  const initial=prepared(),failed=settle(initial.state,initial.effects[1],{state:'failed'},attempt())
  queue(failed)[0].state='unknown'
  const retryOrigin=origin('explicit-retry'),retryEffect={...initial.effects[1]},retry=prepare(failed,[retryEffect],retryOrigin,operation('explicit-retry'))
  assert.deepEqual(queue(retry.state)[0].origin,origin())
  assert.deepEqual(queue(retry.state)[0].attempt,attempt(0,'explicit-retry'))
  assert.equal(retry.privateDeliveries[0].originMessageId,'real-origin')
  assert.equal(retry.effects[0].origin.source.messageId,'real-origin')
  const rebound=origin('explicit-retry');rebound.binding.revision='rebound'
  assert.throws(()=>prepare(failed,[retryEffect],rebound,operation('explicit-retry')),/私密投递/u)
})

test('sent settlement removes one exact delivery and preserves other recipients, package state and new cards',()=>{
  const initial=prepared(),before=structuredClone(initial.state)
  initial.state.builtin.users.alice.cards.card.attrs.SAN=42
  const result=settle(initial.state,initial.effects[1],{state:'sent',messageId:'real-private-receipt'},attempt())
  assert.equal(queue(result).length,1)
  assert.equal(queue(result)[0].deliveryId,'audit-one:bob')
  assert.equal(result.builtin.users.alice.cards.card.attrs.SAN,42)
  assert.deepEqual(result.rules.packs.other,before.rules.packs.other)
  assert.equal(queue(initial.state).length,2,'settlement is a pure state projection')
  assert.throws(()=>settle(initial.state,initial.effects[1],{state:'sent',messageId:'0'},attempt()),/私密投递/u)
})

test('failed settlement retains only explicit retry text while unknown and malformed confirmations scrub it',()=>{
  const initial=prepared(),failed=settle(initial.state,initial.effects[1],{state:'failed'},attempt())
  assert.equal(queue(failed)[0].state,'failed')
  assert.equal(queue(failed)[0].text,'SECRET-ALICE')
  assert.equal(queue(failed)[0].attempts,1)
  for(const receipt of [{state:'unknown'},{state:'confirmed'}]){
    const result=settle(initial.state,initial.effects[1],receipt,attempt())
    assert.equal(queue(result)[0].state,'unknown')
    assert.equal(queue(result)[0].text,'')
    assert.equal(queue(result)[1].text,'SECRET-BOB')
    assert.deepEqual(result.builtin,initial.state.builtin)
  }
})

test('settlement rejects stale attempts, wrong recipients and origins instead of deleting a similar delivery',()=>{
  const initial=prepared()
  for(const [effect,owner]of [[initial.effects[1],attempt(2)],[initial.effects[1],attempt(1,'other-attempt')],
    [{...initial.effects[1],recipientId:'bob'},attempt()],[{...initial.effects[1],origin:origin('other-source')},attempt()],
    [{...initial.effects[1],deliveryId:'missing'},attempt()]]){
    assert.throws(()=>settle(initial.state,effect,{state:'sent',messageId:'confirmed'},owner),/私密投递/u)
  }
  assert.equal(queue(initial.state).length,2)
})

test('recall scrubs the original private queue and audit bodies while preserving committed card and other-source values',()=>{
  const initial=prepared(),before=structuredClone(initial.state),result=scrub(initial.state,{messageId:'real-origin',operationId:operation('real-origin')})
  assert.deepEqual(queue(result),[])
  assert.deepEqual(result.builtin,before.builtin)
  assert.deepEqual(result.rules.packs.ember.players,before.rules.packs.ember.players)
  assert.deepEqual(result.rules.packs.ember.group.group,before.rules.packs.ember.group.group)
  assert.deepEqual(result.rules.packs.other,before.rules.packs.other)
  const audit=result.rules.packs.ember.group.audit[0]
  assert.equal(audit.output,'[revoked]');assert.deepEqual(audit.rolls,{})
  assert.deepEqual(audit.args,{});assert.deepEqual(audit.actions,[]);assert.deepEqual(audit.tags,[])
  assert.equal(JSON.stringify(result).includes('SECRET-'),false)
  assert.equal(queue(initial.state).length,2)
})

test('builtin hidden effects receive original provenance without inventing YAML queues',()=>{
  const input={version:1,builtin:{values:{SAN:60}},rules:null},effect={kind:'private',recipientId:'alice',text:'BUILTIN-SECRET'},prepared=prepare(input,[effect],origin(),operation('real-origin'))
  assert.deepEqual(prepared.privateDeliveries,[])
  assert.deepEqual(prepared.effects[0].origin,origin())
  assert.deepEqual(settle(prepared.state,prepared.effects[0],{state:'sent',messageId:'confirmed'},attempt(0)),input)
  assert.deepEqual(scrub(input,{messageId:'real-origin',operationId:operation('real-origin')}),input)
})

test('subject cleanup scrubs shared-origin bodies for author and recipients while committed game values survive',()=>{
  for(const subjectId of ['alice','bob']){
    const initial=prepared(),before=structuredClone(initial.state),result=scrubSubject(initial.state,{subjectId})
    assert.deepEqual(queue(result),[],subjectId)
    assert.deepEqual(result.builtin,before.builtin,subjectId)
    assert.deepEqual(result.rules.packs.ember.players,before.rules.packs.ember.players,subjectId)
    assert.deepEqual(result.rules.packs.ember.group.group,before.rules.packs.ember.group.group,subjectId)
    assert.deepEqual(result.rules.packs.other,before.rules.packs.other,subjectId)
    assert.equal(JSON.stringify(result).includes('SECRET-'),false,subjectId)
    assert.deepEqual(scrubSubject(result,{subjectId}),result,'subject cleanup is idempotent')
  }
})

test('subject cleanup uses durable origin indexes even after that recipient left the current queue',()=>{
  const initial=prepared(),delivered=settle(initial.state,initial.effects[2],{state:'sent',messageId:'real-bob-private'},attempt(2))
  assert.equal(queue(delivered).length,1)
  const result=scrubSubject(delivered,{subjectId:'bob',originMessageIds:['real-origin'],operationIds:[operation('real-origin')]})
  assert.deepEqual(queue(result),[])
  assert.equal(result.rules.packs.ember.group.audit[0].output,'[revoked]')
  assert.equal(result.rules.packs.ember.players.alice.values.hp,9)
})

test('state, effects, origin, attempt and receipts refuse executable input without running caller code',()=>{
  let calls=0
  const trap=()=>{calls++;throw Error('caller code ran')}
  const hostile=value=>new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap})
  assert.throws(()=>readOrigin(hostile(origin())))
  assert.throws(()=>prepare(hostile(state()),effects(),origin(),operation('real-origin')))
  assert.throws(()=>prepare(state(),hostile(effects()),origin(),operation('real-origin')))
  const initial=prepared()
  assert.throws(()=>settle(initial.state,initial.effects[1],{state:'sent',messageId:'confirmed'},hostile(attempt())))
  const receipt={get state(){trap()}}
  assert.throws(()=>settle(initial.state,initial.effects[1],receipt,attempt()))
  const sourceInput=source()
  Object.defineProperty(sourceInput,'messageId',{enumerable:true,get:trap})
  assert.throws(()=>createOrigin(binding,sourceInput,operation('real-origin'),'authority-one'))
  const recalled={get messageId(){trap()},operationId:operation('real-origin')}
  assert.throws(()=>scrub(initial.state,recalled))
  const subject={get subjectId(){trap()}}
  assert.throws(()=>scrubSubject(initial.state,subject))
  assert.equal(calls,0)
})
