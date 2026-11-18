import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const [{createAgentDeferredPokeDefinition},{freezeDeferredAction,deferredActionHash},
  {createAgentBindingDirectory,agentBindingIdentity,agentConversationKey}]=await Promise.all([
  load('modules/tools/infrastructure/agentDeferredActionPoke.js'),
  load('modules/commitments/infrastructure/agentDeferredActionData.js'),
  load('modules/runtime/domain/agentBindings.js'),
])
const definitionId='builtin-poke-deferred-v1'
const account={platform:'qq',namespace:'global',id:'200'}
const directory=createAgentBindingDirectory({version:1,agents:[{id:'daily',personaId:'default'}],
  connections:[{id:'qq-main',platform:'qq',namespace:'global',accountId:'200'}],
  bindings:[{connectionId:'qq-main',kind:'group',conversationId:'20',agentId:'daily'}]},'revision-1')
const binding=directory.resolve({account,kind:'group',id:'20'})
const creator={platform:'qq',namespace:'global',id:'creator:fixed'}

function setup(params={target:['opaque:first','opaque:second'],times:2}) {
  const clock=Date.now(),controller=new AbortController(),reads=[],plans=[],contexts=[]
  const state={current:true,definitionCurrent:true,ensures:0}
  const action=freezeDeferredAction({tool:'pokeTool',executor:'builtin',definitionId,params})
  const delegation={version:1,id:'delegation-1',ruleId:'poke-self',ruleRevision:'policy-2',bindingIdentity:agentBindingIdentity(binding),
    scopeKey:agentConversationKey(binding),creator,actionHash:deferredActionHash(action),dueAt:clock-100,
    source:{kind:'message',messageId:'creation-message',at:clock-10_000},issuedAt:clock-10_000,expiresAt:clock+60_000}
  const context={kind:'deferred',taskId:'reminder:1',binding,creator,delegation,signal:controller.signal,
    isCurrent:()=>state.current,async ensureCurrent(){state.ensures++;if(!state.current)throw new Error('revoked')}}
  const member=id=>({target:binding.target,observedAt:Date.now(),member:{user:{platform:'qq',namespace:'global',id},displayName:'临时成员名',role:'member'}})
  const ports={definitionId,isCurrent:()=>state.definitionCurrent,
    async readMember(id,receivedContext){reads.push(id);contexts.push(receivedContext);return member(id)},
    async perform(plan,receivedContext){plans.push(plan);contexts.push(receivedContext);return {state:'confirmed',completed:plan.operations.length,requested:plan.operations.length}},
  }
  return {params,action,delegation,context,ports,state,controller,reads,plans,contexts,member,
    definition:()=>createAgentDeferredPokeDefinition(ports)}
}

test('deferred poke produces one exact neutral plan from current IDs without a human actor or original request',async()=>{
  const fixture=setup(),contextKeys=Object.keys(fixture.context)
  const definition=fixture.definition()
  assert.equal(definition.name,'pokeTool');assert.equal(definition.executor,'builtin');assert.equal(definition.definitionId,definitionId)
  assert.equal(definition.validate(fixture.params),true)
  const result=await definition.execute(fixture.params,fixture.context)
  assert.equal(result.status,'succeeded')
  assert.deepEqual(fixture.reads,[creator.id,'opaque:first','opaque:second'])
  assert.deepEqual(fixture.plans,[{version:1,kind:'poke',operations:[
    {kind:'poke',user:{platform:'qq',namespace:'global',id:'opaque:first'}},
    {kind:'poke',user:{platform:'qq',namespace:'global',id:'opaque:first'}},
    {kind:'poke',user:{platform:'qq',namespace:'global',id:'opaque:second'}},
    {kind:'poke',user:{platform:'qq',namespace:'global',id:'opaque:second'}},
  ]}])
  assert.deepEqual(JSON.parse(result.content),{action:'poke',state:'confirmed',requested:4,completed:4,code:'deferred_poke_confirmed'})
  assert.ok(fixture.contexts.every(received=>received===fixture.context))
  assert.deepEqual(Object.keys(fixture.context),contextKeys)
  assert.equal('actor'in fixture.context,false);assert.equal('request'in fixture.context,false)
  assert.equal('messageId'in JSON.parse(result.content),false)
  assert.ok(fixture.state.ensures>=8)
})

test('parameters allow only fixed IDs with a bounded integer count and reject random/name expansion',()=>{
  const definition=setup().definition()
  for(const params of [{target:'opaque:id'},{target:'opaque:id',random:false},{target:['opaque:id'],times:10},
    {target:Array.from({length:20},(_,index)=>`id:${index}`),times:5}])assert.equal(definition.validate(params),true)
  for(const params of [{},{target:[]},{target:12},{target:['one','one']},{target:[' valid-id']},
    {target:['id\n']},{target:['id'],times:'2'},{target:['id'],times:0},{target:['id'],times:11},{target:['id'],times:1.5},
    {target:Array.from({length:21},(_,index)=>`id:${index}`)},
    {target:Array.from({length:20},(_,index)=>`id:${index}`),times:6},
    {target:'id',random:true},{target:'id',random:'false'},{target:'id',name:'成员名'}])assert.equal(definition.validate(params),false,JSON.stringify(params))
  let getters=0
  assert.equal(definition.validate({get target(){getters++;return 'id'}}),false)
  assert.equal(definition.validate(new Proxy({target:'id'},{})),false)
  assert.equal(getters,0)
})

test('the default count is one and opaque IDs are verified as exact identities rather than names',async()=>{
  const fixture=setup({target:'成员名'}),lookups=[]
  fixture.ports.readMember=async id=>{
    lookups.push(id)
    // A name lookup that resolves to another ID is not proof of the frozen ID.
    return fixture.member(id===creator.id?id:'actual-native-id')
  }
  const result=await fixture.definition().execute(fixture.params,fixture.context)
  assert.equal(result.status,'failed');assert.equal(fixture.plans.length,0)
  assert.deepEqual(lookups,[creator.id,'成员名'])
  const exact=setup({target:'opaque:exact'})
  assert.equal((await exact.definition().execute(exact.params,exact.context)).status,'succeeded')
  assert.equal(exact.plans[0].operations.length,1)
})

test('missing, stale or mismatched fresh creator/target evidence makes no perform call',async()=>{
  for(const mutate of [
    (_fixture,_id)=>undefined,
    (fixture,id)=>id===creator.id?fixture.member(id):undefined,
    (fixture,id)=>({...fixture.member(id),observedAt:Date.now()-60_000}),
    (fixture,id)=>({...fixture.member(id),observedAt:Date.now()+60_000}),
    (fixture,id)=>({...fixture.member(id),target:{...binding.target,account:{...account,id:'different-account'}}}),
    (fixture,id)=>({...fixture.member(id),target:{...binding.target,id:'another-conversation'}}),
    (fixture,id)=>({...fixture.member(id),member:{...fixture.member(id).member,user:{platform:'qq',namespace:'another-namespace',id}}}),
    (fixture,id)=>({...fixture.member(id),member:{...fixture.member(id).member,user:{platform:'qq',namespace:'global',id:'different-member'}}}),
  ]) {
    const fixture=setup()
    fixture.ports.readMember=async id=>mutate(fixture,id)
    const result=await fixture.definition().execute(fixture.params,fixture.context)
    assert.equal(result.status,'failed');assert.equal(fixture.plans.length,0)
  }
})

test('only complete confirmed results succeed; partial, unknown, thrown or malformed results freeze as unknown',async()=>{
  for(const response of [
    {state:'confirmed',completed:3,requested:4},{state:'confirmed',completed:4,requested:3},
    {state:'failed',completed:1,requested:4},{state:'unknown',completed:0,requested:4},
    {state:'unknown',completed:4,requested:4},undefined,{state:'confirmed',completed:'4',requested:4},
    {state:'confirmed',completed:4,requested:4,messageId:'fake-confirmation'},
    new Error('response lost'),
  ]) {
    const fixture=setup();let calls=0
    fixture.ports.perform=async()=>{calls++;if(response instanceof Error)throw response;return response}
    const result=await fixture.definition().execute(fixture.params,fixture.context)
    assert.equal(result.status,'unknown');assert.equal(calls,1)
    assert.equal(JSON.parse(result.content).code,'deferred_poke_outcome_unknown')
    assert.equal(result.content.includes('response lost'),false)
  }
  const rejected=setup()
  rejected.ports.perform=async()=>({state:'failed',completed:0,requested:4,code:'native-definite-rejection'})
  assert.equal((await rejected.definition().execute(rejected.params,rejected.context)).status,'failed')
})

test('malformed result getters are never evaluated',async()=>{
  const fixture=setup();let getters=0
  fixture.ports.perform=async()=>({get state(){getters++;return 'confirmed'},completed:4,requested:4})
  assert.equal((await fixture.definition().execute(fixture.params,fixture.context)).status,'unknown')
  assert.equal(getters,0)
})

test('revocation during any fresh read prevents perform and later member reads',async()=>{
  for(const blockedId of [creator.id,'opaque:first','opaque:second']) {
    const fixture=setup(),entered=Promise.withResolvers(),release=Promise.withResolvers(),reads=[]
    fixture.ports.readMember=async id=>{reads.push(id);if(id===blockedId){entered.resolve();await release.promise}return fixture.member(id)}
    const running=fixture.definition().execute(fixture.params,fixture.context)
    await entered.promise;fixture.state.current=false;release.resolve()
    assert.equal((await running).status,'failed')
    assert.equal(fixture.plans.length,0);assert.equal(reads.at(-1),blockedId)
  }
})

test('revocation while perform is in flight keeps its result unknown and performs only once',async()=>{
  const fixture=setup(),entered=Promise.withResolvers(),release=Promise.withResolvers();let calls=0
  fixture.ports.perform=async plan=>{calls++;entered.resolve();await release.promise;return {state:'confirmed',completed:plan.operations.length,requested:plan.operations.length}}
  const running=fixture.definition().execute(fixture.params,fixture.context)
  await entered.promise;fixture.controller.abort();release.resolve()
  assert.equal((await running).status,'unknown');assert.equal(calls,1)
})

test('direct execution requires a real deferred grant, configured group and an available definition',async()=>{
  for(const mutate of [
    fixture=>{fixture.context.kind='user'},
    fixture=>{fixture.context.binding={...binding,source:'legacy'}},
    fixture=>{fixture.context.binding={...binding,target:{...binding.target,kind:'private'}}},
    fixture=>{fixture.context.delegation={...fixture.delegation,scopeKey:'another-scope'}},
    fixture=>{fixture.context.delegation={...fixture.delegation,actionHash:'0'.repeat(64)}},
    fixture=>{fixture.context.creator={...creator,id:'another-creator'}},
    fixture=>{fixture.state.definitionCurrent=false},
    fixture=>{fixture.ports.isCurrent=undefined},
  ]) {
    const fixture=setup();mutate(fixture)
    const result=await fixture.definition().execute(fixture.params,fixture.context)
    assert.equal(result.status,'failed');assert.equal(fixture.plans.length,0);assert.equal(fixture.reads.length,0)
  }
})

test('fresh-read exceptions cannot be treated as a definite failed action followed by a reminder',async()=>{
  const fixture=setup()
  fixture.ports.readMember=async()=>{throw new Error('member transport uncertainty')}
  const result=await fixture.definition().execute(fixture.params,fixture.context)
  assert.equal(result.status,'unknown');assert.equal(fixture.plans.length,0)
  assert.equal(result.content.includes('member transport uncertainty'),false)
})
