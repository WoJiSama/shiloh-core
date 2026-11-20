import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {createClient} from '@redis/client'
import {commitmentRedis} from './helpers/commitmentRedis.js'

const root=fileURLToPath(new URL('../',import.meta.url)),source=process.env.BL_CHAT_AGENT_SOURCE_TEST==='1'
if(source){
  const ts=(await import('typescript')).default,sourceRoot=pathToFileURL(path.join(root,'src')+path.sep).href
  registerHooks({
    resolve(specifier,context,next){
      if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot)&&specifier.endsWith('.js'))return next(new URL(specifier.replace(/\.js$/u,'.ts'),context.parentURL).href,context)
      return next(specifier,context)
    },
    load(url,context,next){
      if(url.startsWith(sourceRoot)&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText}
      return next(url,context)
    },
  })
}
const host=relative=>import(pathToFileURL(path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR||root,source?'src':'dist/backend',relative.replace(/\.js$/u,source?'.ts':'.js'))).href)
const {createAgentDeferredActionRuntime,createAgentDeferredReminderSender}=await host('modules/runtime/infrastructure/agentDeferredActionRuntime.js')
const {createAgentDeferredActionExecutor,createAgentDeferredToolDefinition,createAgentDeferredMcpDefinition}=await host('modules/tools/infrastructure/agentDeferredActionExecutor.js')
const {createAgentDeferredActionPolicy}=await host('modules/tools/infrastructure/agentDeferredActionPolicy.js')
const {createAgentDeferredActionTool}=await host('modules/tools/infrastructure/agentDeferredActionTool.js')
const {createAgentDeferredPokeDefinition}=await host('modules/tools/infrastructure/agentDeferredActionPoke.js')
const {createAgentInteractionWorkflow}=await host('modules/tools/infrastructure/agentInteractions.js')
const {createCommitmentRuntime}=await host('modules/commitments/infrastructure/commitmentTool.js')
const {COMMITMENT_LEASE_MS,commitmentDetailKey,decodeCommitment,encodeCommitment}=await host('modules/commitments/infrastructure/commitmentStore.js')
const {freezeDeferredAction}=await host('modules/commitments/infrastructure/agentDeferredActionData.js')
const {agentBindingIdentity,agentConversationKey}=await host('modules/runtime/domain/agentBindings.js')

const at=Date.parse('2026-11-17T12:00:00+08:00'),logger={info(){},warn(){},error(){}}
const account={platform:'qq',namespace:'global',id:'900001'},creator={...account,id:'900002'}
const target={account,kind:'group',id:'900003'}
const binding={source:'configured',id:'test-binding',revision:'v1',agentId:'daily',personaId:'default',connectionId:'qq-main',target}
const deferred=()=>Promise.withResolvers()

function fixture(redis){
  const clock={at},data=new Map(),calls={extra:[],messages:[],checks:[]},controls={enabled:true,mode:'simulation',ready:true,authority:'allowed',binding}
  redis??=commitmentRedis(data,()=>clock.at)
  const definitions=[{name:'testTool',executor:'custom',definitionId:'test:v1',isCurrent:()=>true,validate:params=>params.value==='fixed',
    execute:async(params,context)=>{calls.extra.push({params,context});return {status:'succeeded',content:'do not persist result'}}}]
  const executor=createAgentDeferredActionExecutor({getDefinitions:()=>definitions})
  const config={enabled:true,rules:[{id:'test-rule',revision:'r1',bindingIdentity:agentBindingIdentity(binding),scopeKey:agentConversationKey(binding),creatorIds:[creator.id],tool:'testTool',executor:'custom',definitionId:'test:v1',maxDelayMs:86_400_000}]}
  const authorization=createAgentDeferredActionPolicy({getConfig:()=>({...config,enabled:controls.enabled}),resolveDefinition:executor.resolve,
    mode:()=>controls.mode,isToolAllowed:()=>true,verifyAuthority:async input=>{calls.checks.push(input.phase);return controls.authority},now:()=>clock.at})
  const options={redis,logger,executor,authorization,resolveBinding:()=>controls.binding,mode:()=>controls.mode,ready:()=>controls.ready,now:()=>clock.at,
    sendReminder:createAgentDeferredReminderSender({send:async(action,guard)=>{
      await guard.ensureCurrent();if(!guard.isCurrent())return {state:'failed',code:'revoked'}
      calls.messages.push(action);return {state:'sent',messageId:`m-${calls.messages.length}`}
    }})}
  let runtime=createAgentDeferredActionRuntime(options)
  const input=(overrides={})=>({binding,creator,creatorName:'tester',source:{kind:'message',messageId:'source-1',at},requestText:'一分钟后提醒我并运行指定动作',dueAt:at+60_000,
    content:'喝水',message:'去喝水',tool:'testTool',params:{value:'fixed'},signal:new AbortController().signal,isCurrent:()=>true,...overrides})
  async function create(overrides){const result=await runtime.create(input(overrides));assert.equal(result.status,'succeeded',JSON.stringify(result));return runtime.store.getCommitment(result.id)}
  return {data,redis,clock,calls,controls,definitions,config,executor,authorization,options,input,create,get runtime(){return runtime},restart(){runtime=createAgentDeferredActionRuntime(options);return runtime}}
}

test('frozen extra action executes once, then one fixed reminder; source retry is idempotent',async()=>{
  const f=fixture(),params={value:'fixed'},task=await f.create({params});params.value='mutated'
  assert.equal((await f.runtime.create(f.input())).id,task.id)
  f.clock.at+=60_001;await Promise.all([f.runtime.tick(account),f.runtime.tick(account)])
  const saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'completed');assert.equal(saved.deferredAction.state,'succeeded');assert.equal(saved.last_result,'sent')
  assert.equal(f.calls.extra.length,1);assert.deepEqual(f.calls.extra[0].params,{value:'fixed'})
  assert.equal(f.calls.extra[0].context.kind,'deferred');assert.equal(f.calls.extra[0].context.actor,undefined)
  assert.equal(f.calls.messages.length,1);assert.deepEqual(f.calls.messages[0].parts,[{kind:'mention',user:creator},{kind:'text',text:' 去喝水'}])
  assert.equal(encodeCommitment(saved).includes('do not persist result'),false)
  f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account);assert.equal(f.calls.extra.length,1)
  assert.equal((await f.runtime.create(f.input())).code,'existing_completed')
})

for(const result of [{status:'unknown',content:'maybe happened'},undefined,new Error('transport lost')]){
  test(`unknown/invalid/thrown extra freezes all later text (${result instanceof Error?'thrown':result?.status||'missing'})`,async()=>{
    const f=fixture(),task=await f.create();let attempts=0
    f.definitions[0].execute=async()=>{attempts++;if(result instanceof Error)throw result;return result}
    f.clock.at+=60_001;await f.runtime.tick(account)
    const saved=await f.runtime.store.getCommitment(task.id)
    assert.equal(saved.status,'unknown');assert.equal(saved.deferredAction.state,'unknown');assert.equal(f.calls.messages.length,0)
    f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account);assert.equal(attempts,1)
    assert.equal((await f.runtime.list(binding,creator))[0].status,'unknown')
    assert.equal(await f.runtime.cancel(task.id,binding,creator),true)
    assert.equal((await f.runtime.store.getCommitment(task.id)).status,'cancelled')
  })
}

test('explicitly failed extra still sends fixed text, and only text retries after explicit delivery rejection',async()=>{
  const f=fixture(),task=await f.create();let extra=0,sends=0
  f.definitions[0].execute=async()=>{extra++;return {status:'failed',content:'known rejection'}}
  f.options.sendReminder=async(_task,context)=>{await context.ensureCurrent();sends++;return sends===1?{state:'failed',code:'known_no_send'}:{state:'sent',messageId:'confirmed'}}
  f.restart();f.clock.at+=60_001;await f.runtime.tick(account)
  let saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'active');assert.equal(saved.deferredAction.state,'failed');assert.equal(saved.retry_count,1)
  f.restart();f.clock.at+=10_001;await f.runtime.tick(account);saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'completed');assert.equal(saved.last_result,'sent_extra_failed');assert.equal(extra,1);assert.equal(sends,2)
})

test('cancel while extra is executing never sends or resurrects detail after late completion',async()=>{
  const f=fixture(),task=await f.create(),entered=deferred(),late=deferred();let attempts=0
  f.definitions[0].execute=async()=>{attempts++;entered.resolve();return late.promise}
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise
  assert.equal(await f.runtime.cancel(task.id,binding,creator),true)
  await tick;late.resolve({status:'succeeded',content:'late'});await delay(10)
  const saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'cancelled');assert.equal(f.calls.messages.length,0);assert.equal(saved.deferredAction.state,'executing')
  f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account);assert.equal(attempts,1)
  const repeated=await f.runtime.create(f.input());assert.equal(repeated.status,'failed');assert.equal(repeated.code,'existing_cancelled')
})

test('concurrent source registrations cannot report a different reminder as registered',async()=>{
  const f=fixture(),entered=deferred(),release=deferred(),issue=f.authorization.issue
  let checks=0
  f.authorization.issue=async request=>{checks++;if(checks===2)entered.resolve();await release.promise;return issue(request)}
  const first=f.runtime.create(f.input()),second=f.runtime.create(f.input({dueAt:at+120_000,message:'different message'}))
  await entered.promise;release.resolve();const results=await Promise.all([first,second])
  assert.equal(results.filter(result=>result.status==='succeeded').length,1)
  assert.equal(results.filter(result=>result.code==='source_already_used').length,1)
})

test('cancel during fixed-message queue is rechecked at native dispatch',async()=>{
  const f=fixture(),task=await f.create(),queued=deferred(),release=deferred();let native=0
  f.options.sendReminder=createAgentDeferredReminderSender({send:async(_action,guard)=>{
    queued.resolve();await release.promise;await guard.ensureCurrent();if(guard.isCurrent())native++;return {state:'sent',messageId:'native'}
  }})
  f.restart();f.clock.at+=60_001;const tick=f.runtime.tick(account);await queued.promise
  await f.runtime.cancel(task.id,binding,creator);release.resolve();await tick;await delay(10)
  assert.equal(native,0);assert.equal((await f.runtime.store.getCommitment(task.id)).status,'cancelled')
})

for(const revoke of ['configuration','identity','privacy','binding','mode','definition']){
  test(`${revoke} revocation during an action stops every subsequent call`,async()=>{
    const f=fixture(),task=await f.create(),entered=deferred(),release=deferred();let followup=0
    f.definitions[0].execute=async(_params,context)=>{entered.resolve();await release.promise;await context.ensureCurrent();followup++;return {status:'succeeded',content:'late'}}
    f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise
    if(revoke==='configuration')f.controls.enabled=false
    if(revoke==='identity'||revoke==='privacy')f.controls.authority='denied'
    if(revoke==='binding')f.controls.binding={...binding,revision:'v2'}
    if(revoke==='mode')f.controls.mode='text'
    if(revoke==='definition')f.definitions[0]={...f.definitions[0],definitionId:'test:v2'}
    release.resolve();await tick
    assert.equal(followup,0);assert.equal(f.calls.messages.length,0)
    assert.equal((await f.runtime.store.getCommitment(task.id)).status,'unknown')
  })
}

test('unstarted claim restarts; marked executing claim becomes unknown without extra or text',async()=>{
  for(const started of [false,true]){
    const f=fixture(),task=await f.create();f.clock.at+=60_001
    const [claim]=await f.runtime.store.takeDueCommitments(f.clock.at)
    if(started){const d=claim.deferredAction;assert.equal(await f.runtime.store.updateDeferredActionClaim(claim,'pending',{...d,state:'executing',attemptedAt:f.clock.at,resultCode:'attempted'},f.clock.at),true)}
    f.clock.at+=COMMITMENT_LEASE_MS+1;f.restart();await f.runtime.tick(account)
    assert.equal((await f.runtime.store.getCommitment(task.id)).status,started?'unknown':'completed')
    assert.equal(f.calls.extra.length,started?0:1);assert.equal(f.calls.messages.length,started?0:1)
  }
})

test('offline and temporary authorization unavailability leave unstarted work pending without retries',async()=>{
  const f=fixture(),task=await f.create();f.clock.at+=60_001
  f.controls.ready=false;await f.runtime.tick(account);assert.equal((await f.runtime.store.getCommitment(task.id)).run_id,undefined)
  f.controls.ready=true;f.controls.authority='unavailable';await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(task.id)).run_id,undefined);assert.equal(f.calls.extra.length,0)
  f.controls.authority='allowed';f.restart();await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(task.id)).status,'completed')
})

test('cancellation interrupts a suspended fresh authorization check without dispatching later',async()=>{
  const f=fixture(),task=await f.create(),entered=deferred(),late=deferred()
  f.authorization.check=async()=>{entered.resolve();return late.promise}
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise
  assert.equal(await f.runtime.cancel(task.id,binding,creator),true)
  await tick;late.resolve('allowed');await delay(5)
  assert.equal(f.calls.extra.length,0);assert.equal(f.calls.messages.length,0)
  assert.equal((await f.runtime.store.getCommitment(task.id)).status,'cancelled')
})

test('shutdown interrupts an executing action and leaves a durable unknown fence',async()=>{
  const f=fixture(),task=await f.create(),entered=deferred(),late=deferred()
  f.definitions[0].execute=async()=>{entered.resolve();return late.promise}
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise;await f.runtime.drain();await tick
  late.resolve({status:'succeeded',content:'late'});await delay(5)
  assert.equal((await f.runtime.store.getCommitment(task.id)).status,'unknown');assert.equal(f.calls.messages.length,0)
})

test('shutdown during unstarted authorization preserves pending work for restart',async()=>{
  const f=fixture(),task=await f.create(),entered=deferred(),late=deferred(),check=f.authorization.check
  f.authorization.check=async()=>{entered.resolve();return late.promise}
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise;await f.runtime.drain();await tick
  let saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'active');assert.equal(saved.run_id,undefined);assert.equal(saved.deferredAction.state,'pending')
  late.resolve('allowed');f.authorization.check=check;f.restart();await f.runtime.tick(account)
  saved=await f.runtime.store.getCommitment(task.id);assert.equal(saved.status,'completed')
  assert.equal(f.calls.extra.length,1);assert.equal(f.calls.messages.length,1)
})

test('shutdown after extra settlement preserves only the unsent reminder for restart',async()=>{
  const f=fixture(),task=await f.create(),entered=deferred(),late=deferred(),check=f.authorization.check
  f.authorization.check=async(grant,request)=>{
    if((await f.runtime.store.getCommitment(task.id)).deferredAction.state==='succeeded'){entered.resolve();return late.promise}
    return check(grant,request)
  }
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise;await f.runtime.drain();await tick
  let saved=await f.runtime.store.getCommitment(task.id)
  assert.equal(saved.status,'active');assert.equal(saved.run_id,undefined);assert.equal(saved.deferredAction.state,'succeeded')
  late.resolve('allowed');f.authorization.check=check;f.restart();await f.runtime.tick(account)
  saved=await f.runtime.store.getCommitment(task.id);assert.equal(saved.status,'completed')
  assert.equal(f.calls.extra.length,1);assert.equal(f.calls.messages.length,1)
})

test('temporary binding read errors preserve unstarted claims and do not spend retries',async()=>{
  const f=fixture(),task=await f.create(),resolve=f.options.resolveBinding
  f.options.resolveBinding=()=>{throw Error('configuration temporarily unreadable')};f.restart();f.clock.at+=60_001;await f.runtime.tick(account)
  const pending=await f.runtime.store.getCommitment(task.id);assert.equal(pending.status,'active');assert.equal(pending.run_id,undefined);assert.equal(pending.retry_count,0)
  f.options.resolveBinding=resolve;f.restart();await f.runtime.tick(account);assert.equal((await f.runtime.store.getCommitment(task.id)).status,'completed')
})

test('a pending account does not block another account using the same Agent and ledger',async()=>{
  const f=fixture(),otherAccount={...account,id:'900004'},otherBinding={...binding,target:{...target,account:otherAccount},connectionId:'qq-second',id:'binding-second'}
  f.options.resolveBinding=target=>target.account.id===account.id?binding:otherBinding
  f.config.rules.push({...f.config.rules[0],id:'second-rule',bindingIdentity:agentBindingIdentity(otherBinding),scopeKey:agentConversationKey(otherBinding)})
  f.restart();const first=await f.create(),second=await f.create({binding:otherBinding,source:{kind:'message',messageId:'source-second',at}})
  const entered=deferred(),late=deferred()
  f.definitions[0].execute=async(_params,context)=>{
    if(context.binding.target.account.id===account.id){entered.resolve();return late.promise}
    return {status:'succeeded',content:'other completed'}
  }
  f.clock.at+=60_001;const slow=f.runtime.tick(account);await entered.promise
  await f.runtime.tick(otherAccount)
  assert.equal((await f.runtime.store.getCommitment(second.id)).status,'completed')
  assert.equal((await f.runtime.store.getCommitment(first.id)).status,'active')
  late.resolve({status:'succeeded',content:'first completed'});await slow
  assert.equal((await f.runtime.store.getCommitment(first.id)).status,'completed')
  assert.equal(f.calls.messages.length,2)
})

test('default disabled, foreign creator/account and non-simulation creation are refused',async()=>{
  const f=fixture();f.controls.enabled=false
  assert.equal((await f.runtime.create(f.input())).status,'failed');f.controls.enabled=true
  for(const mode of ['text','private',undefined]){f.controls.mode=mode;assert.equal((await f.runtime.create(f.input())).status,'failed')}
  f.controls.mode='simulation';const task=await f.create()
  assert.equal(await f.runtime.cancel(task.id,binding,{...creator,id:'other'}),false)
  assert.deepEqual(await f.runtime.list({...binding,target:{...target,account:{...account,id:'other'}}},creator),[])
})

test('ordinary commitment scheduler skips frozen extra reminders and cannot renew them',async()=>{
  const f=fixture(),task=await f.create();f.clock.at+=60_001
  const old=createCommitmentRuntime({redis:f.redis,logger,getBot:()=>null,resolveBinding:()=>binding,isSimulationGroup:()=>true,
    wakeSim:async()=>assert.fail('deferred action entered natural-language planning'),loadConfig:()=>({}),now:()=>f.clock.at})
  await old.commitmentTick(account)
  assert.equal((await old.store.getCommitment(task.id)).run_id,undefined)
  assert.equal(f.calls.extra.length,0);assert.equal(f.calls.messages.length,0)
  const tool=new old.CommitmentTool()
  assert.match(await tool.func({action:'renew',commitment_id:task.id},{user_id:creator.id,group_id:target.id,_agentBinding:binding}),/一次性提醒/)
})

test('existing commitment management can inspect and cancel unresolved migrated private reminders only',async()=>{
  const f=fixture(),task=await f.create(),privateBinding={...binding,id:'private-bind',target:{account,kind:'private',id:creator.id}}
  const privateTask={...task,id:'legacy-private-id',group_id:'',importedReminder:true,scope:privateBinding,bindingIdentity:agentBindingIdentity(privateBinding),status:'unknown',next_run_at:0,
    deferredAction:{...task.deferredAction,state:'unknown',attemptedAt:at,settledAt:at+1,resultCode:'legacy_result_unknown',grant:{...task.deferredAction.grant,bindingIdentity:agentBindingIdentity(privateBinding),scopeKey:agentConversationKey(privateBinding)}}}
  await f.runtime.store.createCommitment(privateTask)
  const old=createCommitmentRuntime({redis:f.redis,logger,getBot:()=>null,resolveBinding:()=>privateBinding,resolvePrivatePeer:()=>creator.id,isSimulationGroup:()=>false,wakeSim:async()=>assert.fail('private migrated reminder must not plan'),loadConfig:()=>({}),now:()=>f.clock.at})
  const tool=new old.CommitmentTool(),ev={user_id:creator.id,self_id:account.id,isMaster:true,_agentBinding:privateBinding}
  const listed=await tool.managePrivateReminder({action:'list'},ev);assert.match(listed,/legacy-private-id/);assert.match(listed,/unknown/)
  assert.match(await tool.managePrivateReminder({action:'create'},ev),/查看和取消/)
  assert.match(await tool.managePrivateReminder({action:'cancel',commitment_id:'legacy-private-id'},ev),/已取消/)
  assert.equal((await old.store.getCommitment('legacy-private-id')).status,'cancelled')
  assert.doesNotMatch(await tool.managePrivateReminder({action:'list'},{...ev,user_id:'other'}),/legacy-private-id/)
})

test('builtin adapter never manufactures a human, and tool exposes only creator-owned management',async()=>{
  const f=fixture(),tool=createAgentDeferredActionTool({runtime:f.runtime,sourceAt:()=>at}),context={binding,actor:{kind:'user',user:creator},request:{messageId:'source-1',text:'创建提醒',mentions:[]},signal:new AbortController().signal,isCurrent:()=>true}
  assert.deepEqual(tool.effect,{actor:'user',metadata:['request']})
  assert.equal((await tool.execute({action:'create',reminder_time:new Date(at+60_000).toISOString(),content:'喝水',extra_action:{tool:'testTool',params:{value:'fixed'},unexpected:true}},context)).status,'failed')
  assert.equal((await tool.execute({action:'list'},{...context,request:undefined})).status,'failed')
  assert.deepEqual(await f.runtime.store.listDeferredActions(),[])
  assert.equal((await tool.execute({action:'create',reminder_time:new Date(at+60_000).toISOString(),content:'喝水',extra_action:{tool:'testTool',params:{value:'fixed'}}},context)).status,'succeeded')
  const [task]=await f.runtime.list(binding,creator)
  assert.match((await tool.execute({action:'list'},context)).content,new RegExp(task.id))
  assert.equal((await tool.execute({action:'cancel',reminder_id:task.id},{...context,actor:{kind:'commitment'}})).status,'failed')
  assert.equal((await tool.execute({action:'cancel',reminder_id:task.id},context)).status,'succeeded')
  let actor,request
  const definition=createAgentDeferredToolDefinition({tool:{name:'neutral',description:'',parameters:{type:'object',properties:{},required:[]},execute:async(_params,context)=>{actor=context.actor;request=context.request;return {status:'succeeded',content:''}}},executor:'builtin',definitionId:'v1',isCurrent:()=>true,validate:()=>true})
  await definition.execute({}, {kind:'deferred',binding,creator,delegation:{},signal:new AbortController().signal,isCurrent:()=>true,ensureCurrent:async()=>{}})
  assert.deepEqual(actor,{kind:'commitment'});assert.equal(request,undefined)
})

test('malformed JSON parameters and tampered persistent delegation are rejected before execution',async()=>{
  for(const params of [{value:NaN},{value:undefined},{get value(){throw Error('getter must not run')}},new Proxy({},{getPrototypeOf(){throw Error('proxy')}})]){
    assert.throws(()=>freezeDeferredAction({tool:'test',executor:'custom',definitionId:'v1',params}))
  }
  const f=fixture(),task=await f.create(),raw=JSON.parse(encodeCommitment(task))
  raw.deferredAction.grant.dueAt++
  assert.throws(()=>decodeCommitment(JSON.stringify(raw)),/排期/)
  raw.deferredAction.grant.dueAt--;raw.deferredAction.grant.scopeKey='foreign-scope'
  assert.throws(()=>decodeCommitment(JSON.stringify(raw)),/归属/)
})

const redisAvailable=spawnSync('redis-server',['--version'],{stdio:'ignore'}).status===0
async function isolatedRedis(t){
  const directory=await mkdtemp(path.join(tmpdir(),'deferred-runtime-')),socket=path.join(directory,'redis.sock')
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'}),exited=once(server,'exit')
  const client=createClient({socket:{path:socket}});client.on('error',()=>{})
  t.after(async()=>{if(client.isOpen)await client.close();if(server.exitCode===null)server.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true})})
  for(let i=0;i<100;i++){if(await stat(socket).then(()=>true,()=>false))break;await delay(10)}
  await client.connect();return client
}
test('isolated Redis persists cancellation during extra and restart unknown without external services',{skip:!redisAvailable,timeout:10_000},async t=>{
  const redis=await isolatedRedis(t),f=fixture(redis),task=await f.create(),entered=deferred(),late=deferred();let attempts=0
  f.definitions[0].execute=async()=>{attempts++;entered.resolve();return late.promise}
  f.clock.at+=60_001;const tick=f.runtime.tick(account);await entered.promise
  assert.equal(await f.runtime.store.cancelCommitment(task.id),true);await tick;late.resolve({status:'succeeded',content:'late'})
  f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(task.id)).status,'cancelled');assert.equal(f.calls.messages.length,0);assert.equal(attempts,1)
  await redis.del(commitmentDetailKey(task.id))
  const second=await f.create({source:{kind:'message',messageId:'source-2',at},dueAt:f.clock.at+60_000})
  f.definitions[0].execute=async()=>{attempts++;return {status:'unknown',content:'not known'}}
  f.clock.at+=60_001;await f.runtime.tick(account);f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(second.id)).status,'unknown');assert.equal(attempts,2);assert.equal(f.calls.messages.length,0)
})

test('isolated Redis due tick runs real builtin/MCP bridges with local providers and freezes MCP unknown',{skip:!redisAvailable,timeout:10_000},async t=>{
  const redis=await isolatedRedis(t),f=fixture(redis),provider=[]
  f.config.rules[0].executor='builtin'
  f.definitions[0]=createAgentDeferredToolDefinition({tool:{name:'testTool',description:'local stand-in',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']},
    async execute(params,context){provider.push({params,actor:context.actor,request:context.request});const receipt=await context.sendMessage({text:'本地工具发送'});return {status:receipt.state==='sent'?'succeeded':'unknown',content:'not retained'}}},
    executor:'builtin',definitionId:'test:v1',isCurrent:()=>true,validate:params=>params.value==='fixed',capabilities:context=>({sendMessage:async message=>{
      await context.ensureCurrent();provider.push({message});return {state:'sent',messageId:'builtin-send'}
    }})})
  const builtin=await f.create();f.clock.at+=60_001;await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(builtin.id)).status,'completed');assert.deepEqual(provider[0].actor,{kind:'commitment'});assert.equal(provider[0].request,undefined)
  f.config.rules[0].executor='mcp'
  let result={content:[{type:'text',text:'raw MCP payload must not persist'}]},attempts=0
  f.definitions[0]=createAgentDeferredMcpDefinition({name:'testTool',remoteName:'remote.tool',definitionId:'test:v1',isCurrent:()=>true,validate:params=>params.value==='fixed',
    async callTool(request,options){attempts++;assert.deepEqual(request,{name:'remote.tool',arguments:{value:'fixed'}});assert.equal(options.signal.aborted,false);return result}})
  const mcp=await f.create({source:{kind:'message',messageId:'mcp-source',at},dueAt:f.clock.at+60_000})
  f.clock.at+=60_001;await f.runtime.tick(account)
  const saved=await f.runtime.store.getCommitment(mcp.id);assert.equal(saved.status,'completed');assert.equal(encodeCommitment(saved).includes('raw MCP payload'),false)
  result=undefined
  const uncertain=await f.create({source:{kind:'message',messageId:'mcp-unknown-source',at},dueAt:f.clock.at+60_000})
  f.clock.at+=60_001;await f.runtime.tick(account);f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(uncertain.id)).status,'unknown');assert.equal(attempts,2);assert.equal(f.calls.messages.length,2)
})

test('isolated Redis deferred poke uses the existing durable interaction workflow and never borrows a human',{skip:!redisAvailable,timeout:10_000},async t=>{
  const redis=await isolatedRedis(t),f=fixture(redis),native=[],workflow=createAgentInteractionWorkflow(redis)
  let receipt={state:'confirmed'}
  f.config.rules[0].tool='pokeTool';f.config.rules[0].executor='builtin'
  f.definitions[0]=createAgentDeferredPokeDefinition({definitionId:'test:v1',isCurrent:()=>true,
    async readMember(id,context){await context.ensureCurrent();assert.equal(context.actor,undefined);assert.equal(context.request,undefined)
      return {target,observedAt:Date.now(),member:{user:{...creator,id},displayName:'local member',role:'member'}}},
    perform(plan,context){return workflow.execute({binding:context.binding,identity:`deferred:${context.taskId}:${context.delegation.id}`,plan,signal:context.signal,
      isCurrent:context.isCurrent,ensureCurrent:context.ensureCurrent,validateOperation:async operation=>operation.kind==='poke'&&operation.user.id===creator.id,
      async dispatch(action,guard){await guard.ensureCurrent();assert.equal(guard.isCurrent(),true);native.push(action);return receipt}})},
  })
  const task=await f.create({tool:'pokeTool',params:{}});assert.deepEqual(task.deferredAction.action.params,{target:[creator.id]})
  f.clock.at+=60_001;await f.runtime.tick(account);assert.equal((await f.runtime.store.getCommitment(task.id)).status,'completed')
  assert.equal(native.length,1);assert.deepEqual(native[0].interaction,{kind:'poke',user:creator});assert.equal(f.calls.messages.length,1)
  receipt={state:'unknown'}
  const uncertain=await f.create({tool:'pokeTool',params:{},source:{kind:'message',messageId:'deferred-poke-unknown',at},dueAt:f.clock.at+60_000})
  f.clock.at+=60_001;await f.runtime.tick(account);f.restart();f.clock.at+=COMMITMENT_LEASE_MS+1;await f.runtime.tick(account)
  assert.equal((await f.runtime.store.getCommitment(uncertain.id)).status,'unknown');assert.equal(native.length,2);assert.equal(f.calls.messages.length,1)
})
