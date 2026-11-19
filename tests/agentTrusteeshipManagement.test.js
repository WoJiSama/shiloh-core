import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'
import {createQzoneRedis,qzoneRedisAvailable} from './helpers/agentQzoneRedis.mjs'

const {createAgentTrusteeshipManagement}=await load('modules/commitments/infrastructure/agentTrusteeshipManagement.js')
const {createCommitmentStore,commitmentDetailKey,encodeCommitment,COMMITMENT_LOCK_KEY,COMMITMENT_LEASE_MS}=await load('modules/commitments/infrastructure/commitmentStore.js')
const {createDelegatedMemoryStore,delegatedMemoryStorageKey}=await load('modules/memory/infrastructure/delegatedMemoryStore.js')
const {agentBindingIdentity,agentConversationKey,conversationAddressKey}=await load('modules/runtime/domain/agentBindings.js')
const {freezeDeferredAction}=await load('modules/commitments/infrastructure/agentDeferredActionData.js')
const {createAgentDeferredActionPolicy}=await load('modules/tools/infrastructure/agentDeferredActionPolicy.js')
const {createAgentManagementBindings}=await load('modules/runtime/infrastructure/agentManagementBindings.js')

const at=Date.parse('2026-11-18T12:00:00Z'),FAILLOG='bl-chat:commitment:faillog'
const logger={info(){},warn(){},error(){}}
const options={skip:!qzoneRedisAvailable,timeout:20_000}
function binding(agentId='agent-a',accountId='900001',kind='group',id='300001'){
  return {source:'configured',id:`binding-${agentId}-${accountId}-${kind}`,revision:'v1',agentId,personaId:'default',
    connectionId:`qq-${accountId}`,target:{account:{platform:'qq',namespace:'global',id:accountId},kind,id}}
}
function task(owner,id='task-a',extra={}){
  return {id,group_id:owner.target.kind==='group'?owner.target.id:'',creator_id:owner.target.kind==='private'?owner.target.id:'200001',
    creator_name:'Creator',intent:`intent ${id}`,schedule:{kind:'once',time:at+60_000},deliver:'static',static_message:'fixed reminder',
    expiry_at:at+86400_000,next_run_at:at+60_000,last_run_at:0,retry_count:0,created_at:at,status:'active',last_result:'',
    bot_id:owner.target.account.id,scope:owner,bindingIdentity:agentBindingIdentity(owner),...extra}
}
const entry=(id='memory-a',extra={})=>({id,owner:'200001',ownerName:'Creator',content:`remember ${id}`,dueAt:0,status:'active',createdAt:at,updatedAt:at,...extra})
const hasCode=code=>error=>error?.name==='AgentManagementError'&&error.code===code

async function fixture(t,owners=[binding()]){
  const {storage:raw}=await createQzoneRedis(t),state={owners,live:true,rights:new Map(),checks:[],hooks:{}}
  const invoke=async(name,...args)=>{
    const hook=state.hooks[name]
    if(hook){delete state.hooks[name];await hook(...args)}
  }
  const redis={
    get:async key=>{await invoke('beforeGet',key);const value=await raw.get(key);await invoke('afterGet',key,value);return value},
    set:async(key,value,opts)=>{await invoke('beforeSet',key,value,opts);const result=await raw.set(key,value,opts);await invoke('afterSet',key,result);return result},
    del:key=>raw.del(key),
    eval:async(script,args)=>{await invoke('beforeEval',script,args);const result=await raw.eval(script,args);await invoke('afterEval',script,args,result);return result},
    async *scanIterator(input){for await(const batch of raw.scanIterator(input)){await invoke('scan',batch);yield batch}},
  }
  const store=createCommitmentStore({redis,logger}),memories=createDelegatedMemoryStore({redis,logger,loadConfig:()=>({}),now:()=>at})
  const bindings={list:()=>state.owners,resolve:target=>state.resolve?state.resolve(target):state.owners.find(owner=>conversationAddressKey(owner.target)===conversationAddressKey(target))}
  const management=createAgentTrusteeshipManagement({store,redis,bindings,now:()=>at})
  function context(selected){
    const controller=new AbortController()
    const ctx={signal:controller.signal,isCurrent:()=>state.live,
      ensureCurrent(){if(!state.live)throw Error('revoked')},
      async authorize(operation,owner,guard){
        guard.ensureCurrent();state.checks.push({operation,scopeKey:agentConversationKey(owner)})
        await invoke('authorize',operation,owner,guard)
        return state.rights.get(`${operation}:${agentConversationKey(owner)}`)??'allowed'
      },...(selected?{binding:selected}:{})}
    return {ctx,controller}
  }
  const deny=(operation,owner)=>state.rights.set(`${operation}:${agentConversationKey(owner)}`,'denied')
  const append=async saved=>store.appendFailLog({id:saved.id,intent:saved.intent,group_id:saved.group_id,reason:'delivery unknown',at})
  return {raw,redis,state,store,memories,management,context,deny,append}
}

test('a complete binding reader validates all trusteeship owners once per guard and observes the next revision after an await',options,async t=>{
  const owners=[binding(),binding('agent-a','900002'),binding('agent-c','900003')],f=await fixture(t,owners)
  for(const [index,owner] of owners.entries())await f.store.createCommitment(task(owner,'observed-'+index))
  let reads=0,held,checked=0
  const bindings=createAgentManagementBindings(()=>{reads++;return f.state.owners})
  const management=createAgentTrusteeshipManagement({store:f.store,redis:f.redis,bindings,now:()=>at})
  f.state.hooks.authorize=(_operation,_owner,guard)=>{
    held=guard;reads=0;guard.ensureCurrent();assert.equal(reads,1);checked++
  }
  const view=await management.overview(f.context().ctx)
  assert.deepEqual(view.commitments.map(row=>row.id).sort(),['observed-0','observed-1','observed-2'])
  assert.equal(checked,1)
  await Promise.resolve()
  f.state.owners=f.state.owners.map(owner=>({...owner,revision:'v2'}))
  assert.equal(held.isCurrent(),false)
  assert.throws(held.ensureCurrent,hasCode('conflict'))
})

test('complete binding observations retain live selected-context checks after authorization awaits',options,async t=>{
  for(const change of ['add','remove','replace'])await t.test(change,async t=>{
    const a=binding(),b=binding('agent-b','900002'),f=await fixture(t,[a,b])
    const management=createAgentTrusteeshipManagement({store:f.store,redis:f.redis,
      bindings:createAgentManagementBindings(()=>f.state.owners),now:()=>at})
    const request=f.context(change==='add'?undefined:a).ctx
    f.state.hooks.authorize=async()=>{
      await Promise.resolve()
      if(change==='remove')delete request.binding
      else request.binding=b
    }
    await assert.rejects(management.overview(request),hasCode('conflict'))
  })
})

test('complete binding requests reject a replaced bindings holder after authorization awaits',options,async t=>{
  for(const operation of ['overview','cancel'])for(const change of ['factory','foreign','accessor'])await t.test(`${operation}: ${change}`,async t=>{
    const owner=binding(),f=await fixture(t,[owner])
    await f.store.createCommitment(task(owner,'holder-task'))
    let originalReads=0,readsAtReplacement,getters=0,replacementReads=0
    const initial=createAgentManagementBindings(()=>{originalReads++;return f.state.owners})
    const ports={store:f.store,redis:f.redis,bindings:initial,now:()=>at}
    const management=createAgentTrusteeshipManagement(ports)
    f.state.hooks.authorize=async()=>{
      await Promise.resolve()
      readsAtReplacement=originalReads
      if(change==='factory')ports.bindings=createAgentManagementBindings(()=>{replacementReads++;return f.state.owners})
      else if(change==='foreign')ports.bindings={list:()=>{replacementReads++;return f.state.owners},resolve:()=>({...owner,revision:'revoked'})}
      else Object.defineProperty(ports,'bindings',{get(){getters++;return initial}})
    }
    const request=f.context(owner).ctx
    await assert.rejects(operation==='overview'?management.overview(request):
      management.cancelCommitment(agentConversationKey(owner),'holder-task',request),hasCode('conflict'))
    assert.equal(typeof readsAtReplacement,'number')
    assert.equal(originalReads,readsAtReplacement,'a withdrawn factory is not read again')
    assert.equal(replacementReads,0,'a request does not transfer its captured authority to another port')
    assert.equal(getters,0,'replacement accessors are not evaluated by an owned check')
    assert.equal((await f.store.getCommitment('holder-task')).status,'active')
    assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
  })
})

test('a copied complete port with a stronger foreign resolver keeps its original resolve checks',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),complete=createAgentManagementBindings(()=>f.state.owners)
  const management=createAgentTrusteeshipManagement({store:f.store,redis:f.redis,
    bindings:{...complete,resolve:()=>({...owner,revision:'withdrawn'})},now:()=>at})
  await assert.rejects(management.overview(f.context().ctx),hasCode('conflict'))
  assert.deepEqual(f.state.checks,[])
})

test('complete binding observations preserve cancellation through the running store and other-account isolation',options,async t=>{
  const a=binding(),b=binding('agent-a','900002'),f=await fixture(t,[a,b])
  await f.store.createCommitment(task(a,'cancel-observed'))
  await f.store.createCommitment(task(b,'retain-observed'))
  await f.store.takeDueCommitments(at+60_000)
  const controller=new AbortController()
  f.store.onInvalidated('cancel-observed',()=>controller.abort())
  const management=createAgentTrusteeshipManagement({store:f.store,redis:f.redis,
    bindings:createAgentManagementBindings(()=>f.state.owners),now:()=>at})
  assert.equal(await management.cancelCommitment(agentConversationKey(a),'cancel-observed',f.context(a).ctx),true)
  assert.equal(controller.signal.aborted,true)
  assert.equal((await f.store.getCommitment('cancel-observed')).status,'cancelled')
  assert.equal((await f.store.getCommitment('retain-observed')).status,'active')
})

test('a binding directory may synchronously audit a trusteeship guard with a paired parent',options,async t=>{
  const {createSynchronousGuard}=await load('modules/runtime/domain/synchronousGuard.js')
  const owner=binding(),f=await fixture(t,[owner])
  await f.store.createCommitment(task(owner))
  let observer,busy=false
  const observed=[],bindings={list(){
    if(observer&&!busy){busy=true;try{observed.push(observer())}finally{busy=false}}
    return f.state.owners
  },resolve:()=>owner}
  const management=createAgentTrusteeshipManagement({store:f.store,redis:f.redis,bindings,now:()=>at})
  f.state.hooks.authorize=(_operation,_binding,guard)=>{
    observer=()=>guard.isCurrent()
    try{guard.ensureCurrent()}finally{observer=undefined}
  }
  const request=f.context().ctx,parent={...request,...createSynchronousGuard(request.signal,request.ensureCurrent,()=>{throw Error('revoked')})}
  const view=await management.overview(parent)
  assert.deepEqual(view.commitments.map(row=>row.id),['task-a'])
  assert.ok(observed.length>0)
  assert.ok(observed.every(value=>value===true))
})

test('overview isolates identical group IDs by account and Agent, projects console fields, and hides legacy ownership',options,async t=>{
  const a=binding(),b=binding('agent-a','900002'),c=binding('agent-c','900003'),f=await fixture(t,[a,b,c])
  for(const [owner,id] of [[a,'a'],[b,'b'],[c,'c']]){
    const saved=task(owner,id);await f.store.createCommitment(saved);await f.append(saved)
    await f.memories.update(owner,()=>({entries:[entry(id,{actor:{secret:'internal-memory-authority'}})],result:true}))
  }
  const legacy=task(a,'legacy');delete legacy.scope;delete legacy.bindingIdentity
  await f.store.createCommitment(legacy);await f.append(legacy)
  await f.raw.set(delegatedMemoryStorageKey(a.target.id),JSON.stringify([entry('legacy-memory')]))
  f.deny('trusteeship.read',b)
  const view=await f.management.overview(f.context().ctx)
  assert.deepEqual(view.commitments.map(row=>row.id),['a','c'])
  assert.deepEqual(view.delegated.map(row=>row.entries[0].id),['a','c'])
  assert.deepEqual(view.failures.map(row=>row.id).sort(),['a','c'])
  for(const row of [...view.commitments,...view.delegated,...view.failures]){
    assert.equal(row.scopeKey,agentConversationKey(row.binding));assert.equal(row.groupId,'300001')
    assert.equal(row.account.id,row.binding.target.account.id);assert.deepEqual(row.conversation,row.binding.target)
  }
  assert.equal(view.commitments[0].creatorId,'200001');assert.equal(typeof view.commitments[0].schedule,'string')
  assert.deepEqual(view.config,{maxActivePerGroup:10,maxPerCreator:5,defaultExpiryDays:30,maxPerGroupDelegated:50,maxPerOwnerDelegated:20})
  assert.equal(JSON.stringify(view).includes('internal-memory-authority'),false)
  assert.equal(JSON.stringify(view).includes('bindingIdentity'),false)
  assert.equal(JSON.stringify(view).includes('failureId'),false)
  const selected=await f.management.overview(f.context(c).ctx)
  assert.deepEqual(selected.commitments.map(row=>row.id),['c'])
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(a),'legacy',f.context().ctx),hasCode('forbidden'))
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(a),'b',f.context().ctx),hasCode('forbidden'))
  assert.equal((await f.store.getCommitment('b')).status,'active')
  assert.equal(await f.management.deleteDelegated(agentConversationKey(a),'a',f.context().ctx),true)
  assert.equal((await f.memories.load(b))[0].id,'b')
  assert.equal((await f.memories.load(a.target.id))[0].id,'legacy-memory')
})

test('cancel uses the supplied store and invalidates its running claim; late completion cannot resurrect it',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),saved=task(owner)
  await f.store.createCommitment(saved)
  const [claim]=await f.store.takeDueCommitments(at+60_000)
  assert.equal(await f.store.refreshClaim(claim,at+60_000,true),true)
  const controller=new AbortController();f.store.onInvalidated(saved.id,()=>controller.abort())
  let uses=0;const original=f.store.cancelCommitment
  f.store.cancelCommitment=(...args)=>{uses++;return original(...args)}
  assert.equal(await f.management.cancelCommitment(agentConversationKey(owner),saved.id,f.context().ctx),true)
  assert.equal(uses,1);assert.equal(controller.signal.aborted,true)
  assert.equal(await f.store.commitRunOutcome({...claim,status:'completed',last_result:'late success'}),false)
  const cancelled=await f.store.getCommitment(saved.id)
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.run_id,undefined)
  assert.match(cancelled.last_result,/在途动作不能撤回/)
  assert.deepEqual(await f.store.takeDueCommitments(at+COMMITMENT_LEASE_MS*2),[])
})

test('imported private reminders retain their complete original scope and can be cancelled',options,async t=>{
  const owner=binding('agent-private','900001','private','200002'),f=await fixture(t,[owner])
  await f.store.createCommitment(task(owner,'private',{importedReminder:true}))
  const view=await f.management.overview(f.context().ctx)
  assert.equal(view.commitments[0].conversation.kind,'private');assert.equal(view.commitments[0].groupId,'')
  assert.equal(view.commitments[0].scopeKey,agentConversationKey(owner))
  assert.equal(await f.management.cancelCommitment(agentConversationKey(owner),'private',f.context().ctx),true)
  await assert.rejects(f.management.deleteDelegated(agentConversationKey(owner),'x',f.context().ctx),hasCode('invalid_request'))
})

test('unknown actions are only inspected or cancelled, never reconstructed; grant and tool params stay private',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),action=freezeDeferredAction({tool:'testTool',executor:'custom',definitionId:'test:v1',params:{secret:'private-action-params'}})
  const policy=createAgentDeferredActionPolicy({now:()=>at,mode:()=> 'simulation',isToolAllowed:()=>true,verifyAuthority:async()=> 'allowed',
    resolveDefinition:()=>({name:'testTool',executor:'custom',definitionId:'test:v1',isCurrent:()=>true,validate:()=>true}),
    getConfig:()=>({enabled:true,rules:[{id:'test-rule',revision:'r1',bindingIdentity:agentBindingIdentity(owner),scopeKey:agentConversationKey(owner),creatorIds:['200001'],tool:'testTool',executor:'custom',definitionId:'test:v1',maxDelayMs:86400_000}]})})
  const grant=await policy.issue({binding:owner,creator:{...owner.target.account,id:'200001'},source:{kind:'message',messageId:'original-message',at},
    requestText:'explicit request',dueAt:at+60_000,action})
  assert.ok(grant)
  const deferredAction={version:1,action,grant,state:'unknown',attemptedAt:at+60_000,settledAt:at+60_001,resultCode:'transport_lost'}
  await f.store.createCommitment(task(owner,'unknown-extra',{status:'unknown',next_run_at:0,deferredAction}))
  await f.store.createCommitment(task(owner,'unknown-normal',{status:'unknown',next_run_at:0}))
  const before=await f.raw.get(commitmentDetailKey('unknown-extra')),view=await f.management.overview(f.context().ctx)
  assert.equal(view.commitments.length,2);assert.equal(await f.raw.get(commitmentDetailKey('unknown-extra')),before)
  for(const secret of ['private-action-params','original-message','actionHash','grant','actor','authority'])assert.equal(JSON.stringify(view).includes(secret),false,secret)
  assert.equal(await f.management.cancelCommitment(agentConversationKey(owner),'unknown-extra',f.context().ctx),true)
  assert.equal(await f.management.cancelCommitment(agentConversationKey(owner),'unknown-normal',f.context().ctx),false)
  assert.equal((await f.store.getCommitment('unknown-extra')).deferredAction.state,'unknown')
  assert.deepEqual(await f.store.takeDueCommitments(at+86400_000),[])
})

for(const change of ['revision','rebind','removed','directory-added','resolve-missing'])test(`cancel rejects ${change} changes across storage await`,options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  const original=await f.raw.get(commitmentDetailKey('task-a'))
  f.state.hooks.afterEval=async script=>{
    assert.match(script,/commitment-cleanup-read-v1/)
    if(change==='removed')f.state.owners=[]
    else if(change==='directory-added')f.state.owners=[owner,binding('agent-b','900002')]
    else if(change==='resolve-missing')f.state.resolve=()=>undefined
    else f.state.owners=[{...owner,...(change==='revision'?{revision:'v2'}:{agentId:'replacement'})}]
  }
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('conflict'))
  assert.equal(await f.raw.get(commitmentDetailKey('task-a')),original);assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
})

test('a replacement Agent cannot list or manage the previous Agent\'s scoped task or memory',options,async t=>{
  const old=binding(),f=await fixture(t,[old]),replacement={...old,id:'replacement-binding',agentId:'agent-new',revision:'v2'}
  await f.store.createCommitment(task(old));await f.memories.update(old,()=>({entries:[entry('old-memory')],result:true}))
  f.state.owners=[replacement]
  const view=await f.management.overview(f.context().ctx)
  assert.deepEqual(view.commitments,[]);assert.deepEqual(view.delegated,[])
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(old),'task-a',f.context().ctx),hasCode('not_found'))
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(replacement),'task-a',f.context().ctx),hasCode('forbidden'))
  assert.equal(await f.management.deleteDelegated(agentConversationKey(replacement),'old-memory',f.context().ctx),false)
  assert.equal((await f.memories.load(old))[0].id,'old-memory')
})

for(const mismatch of ['scope','id'])test(`cancel validates stored ${mismatch} inside its lock against a concurrently replaced detail`,options,async t=>{
  const owner=binding(),other=binding('agent-b','900002'),f=await fixture(t,[owner,other]);await f.store.createCommitment(task(owner))
  const replaced=encodeCommitment(mismatch==='scope'?task(other):task(owner,'wrong-id'))
  f.state.hooks.afterSet=async key=>{assert.equal(key,COMMITMENT_LOCK_KEY);await f.raw.set(commitmentDetailKey('task-a'),replaced)}
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode(mismatch==='scope'?'forbidden':'unavailable'))
  assert.equal(await f.raw.get(commitmentDetailKey('task-a')),replaced)
})

test('cancellation still invalidates workers if request authority changes after the atomic write',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  let invalidated=false;f.store.onInvalidated('task-a',()=>{invalidated=true})
  const afterWrite=async script=>{
    if(!script.includes('commitment-state-v2')){f.state.hooks.afterEval=afterWrite;return}
    f.state.live=false
  }
  f.state.hooks.afterEval=afterWrite
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('conflict'))
  assert.equal(invalidated,true);assert.equal((await f.store.getCommitment('task-a')).status,'cancelled')
  assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
})

test('cancel checks operation permission after reads and while contending for the lock',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  const original=await f.raw.get(commitmentDetailKey('task-a'))
  f.state.hooks.afterGet=async()=>{f.deny('commitments.cancel',owner)}
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('forbidden'))
  f.state.rights.clear();await f.raw.set(COMMITMENT_LOCK_KEY,'other',{PX:500})
  f.state.hooks.afterSet=async(key,result)=>{assert.equal(key,COMMITMENT_LOCK_KEY);assert.equal(result,null);f.deny('commitments.cancel',owner)}
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('forbidden'))
  assert.equal(await f.raw.get(commitmentDetailKey('task-a')),original);assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),'other')
})

test('source cancellation after lock acquisition releases its lock and makes no task mutation',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  const {ctx,controller}=f.context(),original=await f.raw.get(commitmentDetailKey('task-a'))
  f.state.hooks.afterSet=async()=>controller.abort()
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',ctx),hasCode('conflict'))
  assert.equal(await f.raw.get(commitmentDetailKey('task-a')),original);assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
})

test('stored identity never follows a new persona or connection with the same Agent and conversation',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  f.state.owners=[{...owner,personaId:'different-persona',connectionId:'different-connection',revision:'v2'}]
  assert.deepEqual((await f.management.overview(f.context().ctx)).commitments,[])
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('forbidden'))
  assert.equal((await f.store.getCommitment('task-a')).status,'active')
})

test('overview reauthorizes after storage and observes directory changes during scanning',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  f.state.hooks.afterGet=async()=>{f.deny('trusteeship.read',owner)}
  await assert.rejects(f.management.overview(f.context().ctx),hasCode('forbidden'))
  f.state.rights.clear();f.state.hooks.scan=async()=>{f.state.owners=[]}
  await assert.rejects(f.management.overview(f.context().ctx),hasCode('conflict'))
})

test('overview rejects permission revoked after reading its final failure document',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner));await f.append(task(owner))
  const original=f.redis.get
  f.redis.get=async key=>{
    const result=await original(key)
    if(key===FAILLOG)f.deny('trusteeship.read',owner)
    return result
  }
  await assert.rejects(f.management.overview(f.context().ctx),hasCode('forbidden'))
  await assert.rejects(f.management.overview(f.context(owner).ctx),hasCode('forbidden'))
})

test('delegated management is strict about malformed data and preserves the original bytes',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),key=delegatedMemoryStorageKey(owner)
  for(const bad of ['{broken','{}',JSON.stringify([entry('x',{status:'invalid'})]),JSON.stringify([entry('x',{updatedAt:'0'})]),JSON.stringify([entry('x'),entry('x')])]){
    await f.raw.set(key,bad)
    await assert.rejects(f.management.overview(f.context().ctx),hasCode('unavailable'))
    await assert.rejects(f.management.deleteDelegated(agentConversationKey(owner),'x',f.context().ctx),hasCode('unavailable'))
    assert.equal(await f.raw.get(key),bad)
  }
})

test('delegated deletion retries CAS against current entries and preserves a concurrent addition',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),key=delegatedMemoryStorageKey(owner)
  await f.raw.set(key,JSON.stringify([entry('remove'),entry('keep')]))
  const beforeCas=async script=>{
    if(!script.includes('local current=redis.call')){f.state.hooks.beforeEval=beforeCas;return}
    await f.raw.set(key,JSON.stringify([entry('remove'),entry('keep'),entry('concurrent')]))
  }
  f.state.hooks.beforeEval=beforeCas
  assert.equal(await f.management.deleteDelegated(agentConversationKey(owner),'remove',f.context().ctx),true)
  assert.deepEqual(JSON.parse(await f.raw.get(key)).map(row=>row.id),['keep','concurrent'])
  assert.ok(f.state.checks.filter(row=>row.operation==='delegated.delete').length>6)
})

for(const invalidate of ['permission','binding','source'])test(`delegated CAS retry stops after ${invalidate} invalidation`,options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),key=delegatedMemoryStorageKey(owner),{ctx}=f.context()
  await f.raw.set(key,JSON.stringify([entry('remove')]))
  const latest=JSON.stringify([entry('remove'),entry('concurrent')])
  f.state.hooks.beforeEval=async()=>{
    await f.raw.set(key,latest)
    if(invalidate==='permission')f.deny('delegated.delete',owner)
    else if(invalidate==='binding')f.state.owners=[{...owner,revision:'v2'}]
    else f.state.live=false
  }
  await assert.rejects(f.management.deleteDelegated(agentConversationKey(owner),'remove',ctx),hasCode(invalidate==='permission'?'forbidden':'conflict'))
  assert.equal(await f.raw.get(key),latest)
})

test('failure provenance comes only from a matching original task; legacy or forged rows remain hidden',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),saved=task(owner)
  await f.store.createCommitment(saved);await f.append(saved)
  await f.store.appendFailLog({id:'missing',intent:'invented',group_id:owner.target.id,reason:'old',at,
    scopeKey:agentConversationKey(owner),bindingIdentity:agentBindingIdentity(owner),actor:{token:'secret'}})
  await f.store.appendFailLog({id:saved.id,intent:saved.intent,group_id:'wrong-group',reason:'wrong',at})
  const rows=JSON.parse(await f.raw.get(FAILLOG))
  assert.equal(rows[0].scopeKey,undefined);assert.equal(rows[1].scopeKey,undefined);assert.equal(rows[1].actor,undefined)
  assert.equal(rows[2].scopeKey,agentConversationKey(owner));assert.equal(rows[2].bindingIdentity,agentBindingIdentity(owner))
  assert.equal(typeof rows[2].failureId,'string')
  const view=await f.management.overview(f.context().ctx)
  assert.deepEqual(view.failures.map(row=>row.id),[saved.id])
  assert.equal(await f.management.clearFailLog(f.context().ctx),true)
  assert.deepEqual(JSON.parse(await f.raw.get(FAILLOG)),rows.slice(0,2))
  assert.equal(await f.management.clearFailLog(f.context().ctx),false)
})

test('failure clear preserves unauthorized and bare-group rows plus a new failure appended before its lock',options,async t=>{
  const a=binding(),b=binding('agent-b','900002'),f=await fixture(t,[a,b]),ta=task(a,'a'),tb=task(b,'b')
  await f.store.createCommitment(ta);await f.store.createCommitment(tb);await f.append(ta);await f.append(tb)
  const legacy={id:'old',group_id:a.target.id,reason:'no account proof'}
  await f.raw.set(FAILLOG,JSON.stringify([legacy,...JSON.parse(await f.raw.get(FAILLOG))]))
  f.deny('commitments.clear-failures',b)
  f.state.hooks.beforeSet=async key=>{assert.equal(key,COMMITMENT_LOCK_KEY);await f.append(ta)}
  assert.equal(await f.management.clearFailLog(f.context().ctx),true)
  const retained=JSON.parse(await f.raw.get(FAILLOG))
  assert.equal(retained.length,3);assert.equal(retained[0].id,'a');assert.deepEqual(retained[1],legacy);assert.equal(retained[2].id,'b')
  assert.equal(new Set(retained.filter(row=>row.failureId).map(row=>row.failureId)).size,2)
})

test('failure clear CAS preserves an appended row even if a writer changes the log during its lock',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),saved=task(owner)
  await f.store.createCommitment(saved);await f.append(saved)
  const [old]=JSON.parse(await f.raw.get(FAILLOG)),added={...old,failureId:'concurrent-row',reason:'new failure'}
  f.state.hooks.beforeEval=async script=>{
    assert.match(script,/commitment-failures-cas-v1/)
    await f.raw.set(FAILLOG,JSON.stringify([added,old]))
  }
  assert.equal(await f.management.clearFailLog(f.context().ctx),true)
  assert.deepEqual(JSON.parse(await f.raw.get(FAILLOG)),[added])
})

for(const invalidate of ['permission','directory'])test(`failure clear rejects ${invalidate} changes between snapshot and mutation`,options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),saved=task(owner)
  await f.store.createCommitment(saved);await f.append(saved)
  const original=await f.raw.get(FAILLOG)
  f.state.hooks.afterSet=async()=>{
    if(invalidate==='permission')f.deny('commitments.clear-failures',owner)
    else f.state.owners=[]
  }
  await assert.rejects(f.management.clearFailLog(f.context().ctx),hasCode(invalidate==='permission'?'forbidden':'conflict'))
  assert.equal(await f.raw.get(FAILLOG),original);assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
})

test('failure clear checks permission again after a losing CAS and refuses a late success claim',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner));await f.append(task(owner))
  const rows=JSON.parse(await f.raw.get(FAILLOG)),latest=JSON.stringify([{...rows[0],failureId:'new-row'},...rows])
  f.state.hooks.beforeEval=async()=>{await f.raw.set(FAILLOG,latest);f.deny('commitments.clear-failures',owner)}
  await assert.rejects(f.management.clearFailLog(f.context().ctx),hasCode('forbidden'))
  assert.equal(await f.raw.get(FAILLOG),latest)
})

test('corrupt failure logs are never cleared or overwritten by a new failure',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]),saved=task(owner);await f.store.createCommitment(saved)
  for(const bad of ['{broken','{}']){
    await f.raw.set(FAILLOG,bad)
    await assert.rejects(f.management.clearFailLog(f.context().ctx),hasCode('unavailable'))
    await assert.rejects(f.management.overview(f.context().ctx),hasCode('unavailable'))
    await assert.rejects(f.append(saved))
    assert.equal(await f.raw.get(FAILLOG),bad)
  }
})

test('invalid requests, missing bindings and unavailable authority cannot mutate storage',options,async t=>{
  const owner=binding(),f=await fixture(t,[owner]);await f.store.createCommitment(task(owner))
  await assert.rejects(f.management.cancelCommitment(owner.target.id,'task-a',f.context().ctx),hasCode('invalid_request'))
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(binding('other')),'task-a',f.context().ctx),hasCode('not_found'))
  f.state.rights.set(`commitments.cancel:${agentConversationKey(owner)}`,'unavailable')
  await assert.rejects(f.management.cancelCommitment(agentConversationKey(owner),'task-a',f.context().ctx),hasCode('unavailable'))
  assert.equal((await f.store.getCommitment('task-a')).status,'active');assert.equal(await f.raw.get(COMMITMENT_LOCK_KEY),null)
})
