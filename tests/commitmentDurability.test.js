import test from 'node:test'
import assert from 'node:assert/strict'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'
const {createCommitmentRuntime}=await load('modules/commitments/infrastructure/commitmentTool.js')
const {createCommitmentStore, COMMITMENT_LEASE_MS}=await load('modules/commitments/infrastructure/commitmentStore.js')
import {commitmentRedis} from './helpers/commitmentRedis.js'
const {createAgentBindingDirectory}=await load('modules/runtime/domain/agentBindings.js')
const prefix='bl-chat:commitment:'
const at=Date.parse('2026-11-11T12:00:00+08:00')
const event={group_id:'20',user_id:'10',self_id:'200',sender:{nickname:'tester'}}
function setup(options={}){
 const data=options.data||new Map(),clock={value:at},redis=options.redis||commitmentRedis(data,()=>clock.value),calls=[]
 const bot={uin:'200',sendApi:async(...args)=>{calls.push(args);return {retcode:0,data:{message_id:'m1'}}}}
 const ports={redis,logger:{info(){},warn(){},error(){}},getBot:id=>!id||id==='200'?bot:null,isSimulationGroup:()=>true,
 wakeSim:async(_gid,_card,opts)=>{assert.equal(await opts.beforeExecution(),true);return {status:'succeeded',sent:1}},loadConfig:()=>({}),now:()=>clock.value}
 const runtime=createCommitmentRuntime(ports)
 return {data,clock,redis,calls,bot,ports,...runtime,tool:new runtime.CommitmentTool()}
}
async function create(r,extra={}){
 assert.match(await r.tool.execute({action:'create',intent:'提醒喝水',schedule_kind:'once',schedule_time:'2026-11-11T12:10:00+08:00',deliver:'static',static_message:'喝水',...extra},event),/已记下/)
 const list=await r.store.listActiveCommitments();return list.at(-1)
}
test('known rejected receipt retries; missing receipt and transport uncertainty never replay',async()=>{
 for(const [send,status,retries] of [[async()=>({retcode:100,status:'failed'}),'active',1],[async()=>undefined,'unknown',0],[async()=>{throw Error('accepted but response lost')},'unknown',0]]){
  const r=setup();let sends=0;r.bot.sendApi=async()=>{sends++;return send()}
  const c=await create(r);r.clock.value+=11*60_000;await r.commitmentTick()
  const saved=await r.store.getCommitment(c.id);assert.equal(saved.status,status);assert.equal(saved.retry_count,retries)
  if(status==='unknown'){r.clock.value+=200_000;await r.commitmentTick();assert.equal(sends,1);assert.equal((await r.store.readFailLog()).length,1)}
 }
})
test('claim before execution stays recoverable across restart; executing claim becomes unknown',async()=>{
 for(const started of [false,true]){
  const r=setup(),c=await create(r);r.clock.value+=11*60_000
  const [claim]=await r.store.takeDueCommitments(r.clock.value)
  assert.equal((await r.store.listActiveCommitments()).length,1)
  if(started)assert.equal(await r.store.refreshClaim(claim,r.clock.value,true),true)
  r.clock.value+=COMMITMENT_LEASE_MS+1
  const replacement=createCommitmentRuntime(r.ports);await replacement.commitmentTick()
  assert.equal((await r.store.getCommitment(c.id)).status,started?'unknown':'completed')
  assert.equal(r.calls.length,started?0:1)
 }
})
test('cancel during in-flight daily delivery cannot be resurrected by its completion',async()=>{
 const r=setup(),c=await create(r,{schedule_kind:'daily',schedule_time:'12:10'});let release,entered
 const started=new Promise(resolve=>entered=resolve)
 r.bot.sendApi=async()=>{entered();return new Promise(resolve=>release=()=>resolve({retcode:0,data:{message_id:'m1'}}))}
 r.clock.value+=11*60_000;const tick=r.commitmentTick();await started
 assert.equal(await r.store.cancelCommitment(c.id),true);release();await tick
 assert.equal((await r.store.getCommitment(c.id)).status,'cancelled');assert.deepEqual(await r.store.listActiveCommitments(),[])
})
test('stale run owner cannot complete a task after a fresh claim acquired its expired lease',async()=>{
 const r=setup();await create(r);r.clock.value+=11*60_000
 const [old]=await r.store.takeDueCommitments(r.clock.value);r.clock.value+=COMMITMENT_LEASE_MS+1
 const [fresh]=await r.store.takeDueCommitments(r.clock.value)
 assert.notEqual(old.run_id,fresh.run_id)
 assert.equal(await r.store.commitRunOutcome({...old,status:'completed'}),false)
 assert.equal((await r.store.getCommitment(old.id)).run_id,fresh.run_id)
})
test('agent dispatch does not complete until an actual execution outcome returns',async()=>{
 const r=setup();let finish,entered
 const started=new Promise(resolve=>entered=resolve)
 r.ports.wakeSim=async(_g,_c,opts)=>{assert.equal(await opts.beforeExecution(),true);entered();return new Promise(resolve=>finish=resolve)}
 const c=await create(r,{deliver:'agent'});r.clock.value+=11*60_000
 const pending=r.commitmentTick();await started
 assert.equal((await r.store.getCommitment(c.id)).status,'active')
 finish({status:'succeeded',sent:1});await pending
 assert.equal((await r.store.getCommitment(c.id)).status,'completed')
})
test('a temporarily unavailable simulation releases an unstarted agent task for restart without spending a retry',async()=>{
 const r=setup(),c=await createBound(r,binding(),'agent')
 r.clock.value+=11*60_000
 let attempt=0
 const ports={...r.ports,resolveBinding:()=>binding(),waitForSimulation:true,
  isSimulationGroup:()=>attempt!==0,
  wakeSim:async(_group,_card,opts)=>{
   if(attempt===1)return {status:'deferred',sent:0}
   assert.equal(await opts.beforeExecution(),true)
   return {status:'succeeded',sent:1}
  },
 }
 for(attempt=0;attempt<2;attempt++){
  await createCommitmentRuntime(ports).commitmentTick()
  const pending=await r.store.getCommitment(c.id)
  assert.equal(pending.status,'active')
  assert.equal(pending.next_run_at,c.next_run_at)
  assert.equal(pending.run_id,undefined)
  assert.equal(pending.retry_count,0)
 }
 await createCommitmentRuntime(ports).commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'completed')
})
test('an executing task cannot use a deferred outcome to replay',async()=>{
 const r=setup(),c=await createBound(r,binding(),'agent')
 r.clock.value+=11*60_000
 const worker=createCommitmentRuntime({...r.ports,resolveBinding:()=>binding(),
  wakeSim:async(_group,_card,opts)=>{
   assert.equal(await opts.beforeExecution(),true)
   return {status:'deferred',sent:0}
  },
 })
 await worker.commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'unknown')
 assert.equal((await r.store.readFailLog()).length,1)
})
test('task list exposes unique full IDs for same-millisecond tasks and cancel remains usable',async()=>{
 const r=setup();await create(r);await create(r,{intent:'第二件事'})
 const active=await r.store.listActiveCommitments(),list=await r.tool.execute({action:'list'},event)
 assert.equal(active.length,2);for(const c of active)assert.ok(list.includes(c.id))
 assert.match(await r.tool.execute({action:'cancel',commitment_id:active[0].id},event),/已取消/)
 assert.equal((await r.store.listActiveCommitments()).length,1)
})
test('event bot is retained and missing original account never falls back to default',async()=>{
 const r=setup();assert.match(await r.tool.execute({action:'create',intent:'x',schedule_kind:'once',schedule_time:'2026-11-11T12:10:00+08:00',deliver:'static',static_message:'x'},{...event,self_id:'missing'}),/已记下/)
 r.clock.value+=11*60_000;await r.commitmentTick();assert.equal(r.calls.length,0)
 assert.equal((await r.store.listActiveCommitments())[0].retry_count,1)
})
test('legacy orphan task is exposed as unknown instead of silently lost or blindly replayed',async()=>{
 const r=setup(),c=await create(r);r.data.set(prefix+'pending:list','[]');r.clock.value+=11*60_000
 await createCommitmentRuntime(r.ports).commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'unknown');assert.equal(r.calls.length,0)
 assert.equal((await r.store.readFailLog()).length,1)
})
test('atomic index/detail commit failure cannot falsely complete a confirmed send',async()=>{
 const r=setup(),c=await create(r);const eval_=r.redis.eval.bind(r.redis);let rejected=false
 r.redis.eval=async(script,args)=>{
  if(script.includes('commitment-state-v2')&&JSON.parse(args.arguments[1]).status==='completed'&&!rejected){rejected=true;throw Error('persist failed')}
  return eval_(script,args)
 }
 r.clock.value+=11*60_000;await r.commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'unknown');r.clock.value+=200_000;await r.commitmentTick();assert.equal(r.calls.length,1)
})

test('renewal committed after claiming prevents expiry based on the stale task snapshot',async()=>{
 const r=setup(),c=await create(r)
 r.data.set(prefix+'detail:'+c.id,JSON.stringify({...c,expiry_at:at+10*60_000}))
 const refresh=r.store.refreshClaim;let renewed=false
 r.store.refreshClaim=async(...args)=>{
  const current=await refresh(...args)
  if(current&&!renewed)renewed=await r.store.updateActive(c.id,value=>({...value,expiry_at:at+86400_000}))
  return current
 }
 r.clock.value+=11*60_000;await r.commitmentTick()
 const final=await r.store.getCommitment(c.id)
 assert.equal(renewed,true);assert.equal(final.status,'completed');assert.equal(r.calls.length,1)
 assert.equal(final.expiry_at,at+86400_000)
})

test('two runtime renewal scans atomically claim one notice',async()=>{
 const r=setup(),c=await create(r)
 r.data.set(prefix+'detail:'+c.id,JSON.stringify({...c,expiry_at:at+2*86400_000,next_run_at:at+86400_000}))
 r.data.set(prefix+'pending:list',JSON.stringify([{id:c.id,next_run_at:at+86400_000}]))
 const other=createCommitmentRuntime(r.ports)
 await Promise.all([r.commitmentTick(),other.commitmentTick()])
 assert.equal(r.calls.length,1)
 assert.equal((await r.store.getCommitment(c.id)).renewal_asked_at,at)
})

test('cancelling after claiming a renewal notice prevents the later static send',async()=>{
 const r=setup(),c=await create(r)
 r.data.set(prefix+'detail:'+c.id,JSON.stringify({...c,expiry_at:at+2*86400_000,next_run_at:at+86400_000}))
 const update=r.store.updateActive
 r.store.updateActive=async(...args)=>{const saved=await update(...args);if(saved)await r.store.cancelCommitment(c.id);return saved}
 await r.commitmentTick()
 assert.equal(r.calls.length,0);assert.equal((await r.store.getCommitment(c.id)).status,'cancelled')
})

const qqTarget={account:{platform:'qq',namespace:'global',id:'200'},kind:'group',id:'20'}
const feishuTarget={account:{platform:'feishu',namespace:'tenant-a',id:'200'},kind:'group',id:'20'}
function binding(target=qqTarget,agentId='daily',revision='first'){
 return createAgentBindingDirectory({
  version:1,agents:[{id:'daily',personaId:'default'},{id:'work',personaId:'default'}],
  connections:[{id:'main',platform:target.account.platform,namespace:target.account.namespace,accountId:target.account.id}],
  bindings:[{connectionId:'main',kind:target.kind,conversationId:target.id,agentId}],
 },revision).resolve(target)
}
async function createBound(r,captured,deliver='static'){
 const before=new Set((await r.store.listActiveCommitments()).map(c=>c.id))
 const result=await r.tool.execute({action:'create',intent:`${captured.target.account.platform}-${captured.agentId}-${captured.revision}`,schedule_kind:'once',
  schedule_time:'2026-11-11T12:10:00+08:00',deliver,static_message:'喝水'}, {...event,_agentBinding:captured})
 assert.match(result,/已记下/)
 const record=(await r.store.listActiveCommitments()).find(c=>!before.has(c.id))
 assert.deepEqual(record.scope,{agentId:captured.agentId,target:captured.target})
 return record
}

test('durable commitments isolate the same role and IDs across platforms and route through the correct host after restart',async()=>{
 const r=setup()
 const legacy=await create(r)
 const qq=binding(),feishu=binding(feishuTarget)
 const qqTask=await createBound(r,qq),feishuTask=await createBound(r,feishu)
 const view=await r.tool.execute({action:'list'},{...event,_agentBinding:qq,isMaster:true})
 assert.ok(view.includes(qqTask.id));assert.ok(!view.includes(feishuTask.id));assert.ok(!view.includes(legacy.id))
 assert.match(await r.tool.execute({action:'cancel',commitment_id:feishuTask.id},{...event,_agentBinding:qq,isMaster:true}),/没找到/)
 const deliveries=[]
 const worker=(captured,handlesLegacy)=>createCommitmentRuntime({...r.ports,
  handlesTarget:target=>target?.account.platform===captured.target.account.platform||(!target&&handlesLegacy),
  resolveBinding:()=>captured,
  messageActions:{async send(action,guard){assert.equal(guard.isCurrent(),true);deliveries.push(action);return {state:'sent',messageId:'ok'}}},
 })
 r.clock.value+=11*60_000
 await worker(qq,true).commitmentTick()
 assert.equal((await r.store.getCommitment(qqTask.id)).status,'completed')
 assert.equal((await r.store.getCommitment(feishuTask.id)).status,'active')
 assert.equal((await r.store.getCommitment(legacy.id)).status,'cancelled')
 await worker(feishu,false).commitmentTick()
 assert.equal((await r.store.getCommitment(feishuTask.id)).status,'completed')
 assert.deepEqual(deliveries.map(action=>action.target),[qqTarget,feishuTarget])
 assert.deepEqual(deliveries.map(action=>action.parts[0].user.platform),['qq','feishu'])
 assert.equal(r.calls.length,0,'no legacy send or rebinding notice')
})

test('a different role cannot inherit pending static or agent commitments after restart',async()=>{
 for(const deliver of ['static','agent']){
  const r=setup()
  const c=await createBound(r,binding(),deliver)
  r.clock.value+=11*60_000
  const replacement=createCommitmentRuntime({...r.ports,resolveBinding:()=>binding(qqTarget,'work','second'),
   wakeSim:async()=>assert.fail('stale task cannot wake the new binding'),
   messageActions:{async send(){assert.fail('stale task cannot send')}},
  })
  await replacement.commitmentTick()
  assert.equal((await r.store.getCommitment(c.id)).status,'cancelled')
  assert.equal(r.calls.length,0)
 }
})

test('an unchanged task binding survives a configuration revision across restart',async()=>{
 const r=setup()
 const c=await createBound(r,binding())
 const sent=[]
 const restarted=createCommitmentRuntime({...r.ports,resolveBinding:()=>binding(qqTarget,'daily','saved-another-group'),
  messageActions:{async send(action,options){assert.equal(options.isCurrent(),true);sent.push(action);return {state:'sent',messageId:'ok'}}},
 })
 r.clock.value+=11*60_000
 await restarted.commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'completed')
 assert.deepEqual(sent.map(action=>action.target),[qqTarget])
})

test('an in-flight static commitment loses send authorization after a binding revision',async()=>{
 const r=setup()
 let current=binding()
 const c=await createBound(r,current)
 const runtime=createCommitmentRuntime({...r.ports,resolveBinding:()=>current,messageActions:{
  async send(_action,guard){
   assert.equal(guard.isCurrent(),true)
   current=binding(qqTarget,'daily','changed')
   assert.equal(guard.isCurrent(),false)
   return {state:'failed',code:'binding_changed'}
  },
 }})
 r.clock.value+=11*60_000
 await runtime.commitmentTick()
 assert.equal((await r.store.getCommitment(c.id)).status,'cancelled')
 assert.deepEqual(await r.store.readFailLog(),[])
 assert.equal(r.calls.length,0)
})
