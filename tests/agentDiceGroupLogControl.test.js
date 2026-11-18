import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {createAgentRedisFixture,redisAvailable} from './helpers/agentRedis.js'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentGroupLogStore}=await load('modules/dice/infrastructure/agentGroupLogStore.js')
const options={skip:!redisAvailable,timeout:15_000}
const digest=value=>createHash('sha256').update(value).digest('hex')
const account={platform:'fixture',namespace:'dice-log-control',id:'bot'}
const owner={target:{account,kind:'group',id:'room'},agentId:'daily'}
const now=Date.now()
const deferred=()=>Promise.withResolvers()
const request=(id='one',changes={})=>({sourceMessageId:'native-source-'+id,subjectId:'alice',operationId:digest('operation-'+id),index:0,operation:'start',ownershipId:digest('ownership-'+id),title:'Automatic '+id,...changes})
const control=async(store,value,selected=owner,at=now)=>store.controlDiceLog(selected,value,at,await store.capture(selected,value.subjectId))
const manual=async(store,id,operation,selected=owner)=>store.command(selected,id,{kind:operation,...(operation==='start'?{title:id}:{})},now)

test('invalid automatic log provenance is rejected before touching Redis',async()=>{
 let calls=0
 const store=createAgentGroupLogStore({async eval(){calls++;throw Error('unexpected mutation')}}),epochs={globalEpoch:'0',sceneEpoch:'0'}
 for(const changes of [{sourceMessageId:''},{subjectId:''},{operationId:'native-source'},{ownershipId:'manual-log-id'},{index:-1},{index:4096},{operation:'end'},{title:' padded '}]){
  await assert.rejects(store.controlDiceLog(owner,request('invalid',changes),now,epochs),/归属无效/u)
 }
 assert.equal(calls,0)
})

test('concurrent duplicate automatic controls create and stop one exact log with stable durable receipts',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-duplicates'),store=createAgentGroupLogStore(storage),start=request()
 const receipts=await Promise.all(Array.from({length:12},()=>control(store,start)))
 for(const receipt of receipts)assert.deepEqual(receipt,receipts[0])
 assert.equal(receipts[0].state,'confirmed');assert.ok(receipts[0].logId)
 let state=await store.read(owner);assert.equal(state.logs.length,1);assert.equal(state.currentId,receipts[0].logId)
 const stop=request('stop',{operation:'stop',ownershipId:start.ownershipId}),ended=await Promise.all(Array.from({length:12},()=>control(store,stop)))
 for(const receipt of ended)assert.deepEqual(receipt,{state:'confirmed',logId:receipts[0].logId})
 state=await store.read(owner);assert.equal(state.active,false);assert.equal(state.logs.length,1)
 const endedAt=state.log.endedAt,reopened=createAgentGroupLogStore(storage)
 assert.deepEqual(await control(reopened,start,owner,now+50_000),receipts[0])
 assert.deepEqual(await control(reopened,stop,owner,now+50_000),ended[0]);assert.equal((await reopened.read(owner)).log.endedAt,endedAt)
})

test('competing automatic sessions choose one owner and permanently freeze the losing failed receipt',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-compete'),store=createAgentGroupLogStore(storage),starts=[request('one'),request('two')]
 const results=await Promise.all(starts.map(value=>control(store,value)))
 assert.equal(results.filter(value=>value.state==='confirmed').length,1);assert.equal(results.filter(value=>value.state==='failed').length,1)
 const loser=results.findIndex(value=>value.state==='failed'),winner=1-loser
 await manual(store,'manual-stop','stop')
 assert.deepEqual(await control(createAgentGroupLogStore(storage),starts[loser]),{state:'failed'})
 assert.deepEqual(await control(store,request('winner-stop',{operation:'stop',ownershipId:starts[winner].ownershipId})),{state:'failed'})
 assert.equal((await store.read(owner)).active,false);assert.equal((await store.read(owner)).logs.length,1)
})

test('automatic stop cannot stop a manually reopened log and its failure remains stable across another reopen',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-manual'),store=createAgentGroupLogStore(storage),start=request()
 const automatic=await control(store,start)
 await manual(store,'manual-off-one','stop');await manual(store,'manual-on-one','start')
 const current=(await store.read(owner)).currentId,stop=request('stop',{operation:'stop',ownershipId:start.ownershipId})
 assert.notEqual(current,automatic.logId);assert.deepEqual(await control(store,stop),{state:'failed'})
 assert.equal((await store.read(owner)).active,true);assert.equal((await store.read(owner)).currentId,current)
 await manual(store,'manual-off-two','stop');await manual(store,'manual-on-two','start')
 const next=(await store.read(owner)).currentId
 assert.deepEqual(await control(createAgentGroupLogStore(storage),stop),{state:'failed'})
 assert.equal((await store.read(owner)).active,true);assert.equal((await store.read(owner)).currentId,next)
 assert.deepEqual(await control(store,request('same-owner-again',{ownershipId:start.ownershipId})),{state:'failed'})
})

test('automatic ownership is isolated by account, namespace, group and Agent',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-scope'),store=createAgentGroupLogStore(storage)
 const owners=[owner,{...owner,agentId:'another'},{...owner,target:{...owner.target,id:'another-room'}},
  {...owner,target:{...owner.target,account:{...account,id:'another-bot'}}},{...owner,target:{...owner.target,account:{...account,namespace:'another-namespace'}}}]
 const starts=[]
 for(const selected of owners)starts.push(await control(store,request(),selected))
 assert.equal(new Set(starts.map(value=>value.logId)).size,owners.length)
 await control(store,request('stop',{operation:'stop',ownershipId:request().ownershipId}),owner)
 for(const selected of owners.slice(1))assert.equal((await store.read(selected)).active,true)
})

test('recalling a real source fences new controls and old successful receipts after store restart',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-recall'),store=createAgentGroupLogStore(storage),start=request()
 const before=await store.capture(owner,'alice')
 await store.revokeSource(owner.target,start.sourceMessageId)
 await assert.rejects(store.controlDiceLog(owner,start,now,before),/source revoked/u)
 assert.equal((await store.read(owner)).active,false)
 const allowed=request('allowed');assert.equal((await control(store,allowed)).state,'confirmed')
 await store.revokeSource(owner.target,allowed.sourceMessageId)
 await assert.rejects(control(createAgentGroupLogStore(storage),allowed),/source revoked/u)
 const stop=request('recalled-stop',{operation:'stop',ownershipId:allowed.ownershipId})
 await store.revokeSource(owner.target,stop.sourceMessageId)
 await assert.rejects(control(store,stop),/source revoked/u);assert.equal((await store.read(owner)).active,true)
})

for(const scope of ['local','global'])test(`${scope} privacy epochs reject stale automatic starts and stops while new sources continue`,options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-privacy-'+scope),store=createAgentGroupLogStore(storage),stale=await store.capture(owner,'alice')
 const purge={account,agentId:owner.agentId,subjectId:'alice',...(scope==='local'?{groupId:owner.target.id}:{})}
 await store.purgeSubject(purge)
 await assert.rejects(store.controlDiceLog(owner,request('stale'),now,stale),/privacy epoch changed/u)
 assert.equal((await store.read(owner)).active,false)
 const start=request('fresh');assert.equal((await control(store,start)).state,'confirmed')
 const stop=request('stop',{operation:'stop',ownershipId:start.ownershipId}),before=await store.capture(owner,'alice')
 await store.purgeSubject(purge)
 await assert.rejects(store.controlDiceLog(owner,stop,now,before),/privacy epoch changed/u)
 assert.equal((await store.read(owner)).active,true)
 assert.equal((await control(store,request('fresh-stop',{operation:'stop',ownershipId:start.ownershipId}))).state,'confirmed')
})

for(const action of ['recall','forget'])test(`a ${action} interleaved before the automatic control Lua cannot mutate the log`,options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-interleaved-'+action),reached=deferred(),release=deferred()
 t.after(()=>release.resolve())
 let held=true
 const store=createAgentGroupLogStore({...storage,async eval(script,args){if(held&&script.includes("base .. ':diceControls'")){held=false;reached.resolve();await release.promise}return storage.eval(script,args)}})
 const value=request('interleaved'),epochs=await store.capture(owner,'alice'),pending=store.controlDiceLog(owner,value,now,epochs)
 const rejection=assert.rejects(pending,action==='recall'?/source revoked/u:/privacy epoch changed/u)
 await reached.promise
 if(action==='recall')await store.revokeSource(owner.target,value.sourceMessageId)
 else await store.purgeSubject({account,agentId:owner.agentId,subjectId:'alice',groupId:owner.target.id})
 release.resolve();await rejection
 assert.equal((await store.read(owner)).active,false);assert.deepEqual((await store.read(owner)).logs,[])
})

test('one operation and effect index cannot be rebound to a different source or ownership',options,async t=>{
 const {storage}=await createAgentRedisFixture(t,'dice-log-control-provenance'),store=createAgentGroupLogStore(storage),value=request()
 const receipt=await control(store,value)
 for(const changed of [{sourceMessageId:'forged-source'},{ownershipId:digest('forged-owner')},{subjectId:'bob'},{title:'changed title'}]){
  await assert.rejects(control(store,{...value,...changed}),/invalid dice group log control receipt/u)
 }
 assert.equal((await store.read(owner)).currentId,receipt.logId);assert.equal((await store.read(owner)).logs.length,1)
})
