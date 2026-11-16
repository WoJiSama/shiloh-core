import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {SemanticMemoryStore} from '../dist/backend/modules/memory/infrastructure/SemanticMemoryStore.js'
import {SemanticMemoryIndexer} from '../dist/backend/modules/memory/infrastructure/SemanticMemoryIndexer.js'
import {EmbeddingGateway} from '../dist/backend/modules/memory/infrastructure/EmbeddingGateway.js'
import {RerankGateway} from '../dist/backend/modules/memory/infrastructure/RerankGateway.js'
import {SemanticMemoryRetriever} from '../dist/backend/modules/memory/infrastructure/SemanticMemoryRetriever.js'
import * as correction from '../dist/backend/modules/memory/infrastructure/memorySelfCorrection.js'
import {createDelegateMemoryRuntime} from '../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'
import {createDelegatedMemoryStore} from '../dist/backend/modules/memory/infrastructure/delegatedMemoryStore.js'
import {installSemanticMemoryRuntime,__resetSemanticMemoryRuntimeForTest} from '../dist/backend/modules/memory/infrastructure/semanticRuntime.js'
import {createReplyRendering} from '../dist/backend/modules/conversation/application/replyRendering.js'
import {createConversationEntryPolicy} from '../dist/backend/modules/conversation/infrastructure/conversationEntryPolicy.js'
const logger={info(){},warn(){},error(){},mark(){}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const records=n=>Array.from({length:n},(_,i)=>({group_id:'20',message_id:String(i+1),timestamp:Date.now(),user_id:100,raw_message:`record ${i+1}`}))
function archive(rows){return {formatRecord:r=>r.raw_message,readAllGroupMessages:async()=>rows,readRecentGroupMessages:async(_g,n)=>rows.slice(-n),listArchiveGroupIds:async()=>['20']}}
function gateway(){return {model:'fixture',embedBatch:async texts=>texts.map(()=>new Float32Array([1,0]))}}
async function indexed(t,rows){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-reliability-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new SemanticMemoryStore({baseDir:dir,dimension:2});const indexer=new SemanticMemoryIndexer({store,gateway:gateway(),archiveManager:archive(rows)});t.after(()=>{if(indexer.dispose)indexer.dispose();else if(indexer.flushTimer)clearTimeout(indexer.flushTimer)});return {dir,store,indexer}}
const covered=store=>new Set([...store.loadGroup('20').chunks.values()].flatMap(c=>c.message_ids||[]))

test('incremental indexing covers the whole burst and resumes equal-time records after restart',async t=>{
 const rows=records(36);for(const r of rows)r.timestamp=rows[0].timestamp
 const {dir,store,indexer}=await indexed(t,rows)
 indexer.onArchivedRecord(rows.at(-1));await indexer.flushDirtyGroups()
 assert.equal(covered(store).size,36,'all 36 records, not only the latest 20, must be indexed')
 indexer.dispose()
 rows.push({...rows[0],message_id:'37',raw_message:'late message with the same timestamp'})
 const restartedStore=new SemanticMemoryStore({baseDir:dir,dimension:2})
 const restarted=new SemanticMemoryIndexer({store:restartedStore,gateway:gateway(),archiveManager:archive(rows)})
 t.after(()=>restarted.dispose())
 await restarted.start();await restarted.flushDirtyGroups()
 assert.ok(covered(restartedStore).has('37'),'a timestamp tie must not be discarded')
 const checkpoint=JSON.parse(await fs.readFile(path.join(dir,'index-progress','20.json'),'utf8'))
 assert.equal(checkpoint.processed.length,37)
})

test('a failed embedding keeps unconsumed work and a later retry recovers without a new message',async t=>{
 const rows=records(30),{store,indexer}=await indexed(t,rows)
 let failing=true
 indexer.gateway.embedBatch=async texts=>texts.map(()=>failing?null:new Float32Array([1,0]))
 indexer.onArchivedRecord(rows.at(-1));await indexer.flushDirtyGroups()
 assert.equal(covered(store).size,0)
 assert.ok(indexer.dirtyGroups.has('20'),'failed work must remain pending')
 failing=false;await indexer.flushDirtyGroups()
 assert.equal(covered(store).size,30)
})

test('startup recovery honors retained dates and group filters, and checkpoints bounded batches',async t=>{
 const rows=records(90),{dir,store,indexer}=await indexed(t,rows)
 rows.unshift({...rows[0],message_id:'expired',raw_message:'expired private archive',timestamp:Date.now()-8*24*3600*1000})
 indexer.config={includeGroups:['20','21'],excludeGroups:['21']}
 indexer.archiveManager.listArchiveGroupIds=async()=>['20','21','22']
 indexer.gateway.batchSize=3
 let fail=true,calls=0;const inputs=[]
 indexer.gateway.embedBatch=async texts=>{inputs.push(texts);calls++;return texts.map(()=>fail&&calls===2?null:new Float32Array([1,0]))}
 await indexer.start();assert.deepEqual([...indexer.dirtyGroups],['20']);await indexer.flushDirtyGroups()
 const partial=JSON.parse(await fs.readFile(path.join(dir,'index-progress','20.json'),'utf8')).processed
 assert.ok(partial.length>0&&partial.length<90,'only completed batches advance the checkpoint')
 fail=false;await indexer.flushDirtyGroups()
 assert.equal(covered(store).size,90);assert.equal(covered(store).has('expired'),false)
 assert.ok(inputs.every(batch=>batch.length<=3))
 assert.ok(inputs.flat().every(text=>!text.includes('expired private archive')))
})

test('short tails are indexed and unusable records remain eligible when later completed',async t=>{
 const rows=records(2);rows[1].raw_message=''
 const {dir,store,indexer}=await indexed(t,rows)
 indexer.onArchivedRecord(rows[1]);await indexer.flushDirtyGroups()
 assert.deepEqual([...covered(store)],['1'])
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'index-progress','20.json'),'utf8')).processed,['1'])
 rows[1].raw_message='completed short tail';indexer.onArchivedRecord(rows[1]);await indexer.flushDirtyGroups()
 assert.deepEqual([...covered(store)].sort(),['1','2'])
})

test('long-message bursts cover actual embedded text before checkpointing each message id',async t=>{
 const rows=records(36)
 for(const row of rows)row.raw_message=`sentinel-${row.message_id}-start ${'长'.repeat(350)} sentinel-${row.message_id}-end`
 const {dir,store,indexer}=await indexed(t,rows),embedded=[]
 indexer.gateway.embedBatch=async texts=>{embedded.push(...texts);return texts.map(()=>new Float32Array([1,0]))}
 indexer.onArchivedRecord(rows.at(-1));await indexer.flushDirtyGroups()
 const chunks=[...store.loadGroup('20').chunks.values()]
 const processed=JSON.parse(await fs.readFile(path.join(dir,'index-progress','20.json'),'utf8')).processed
 assert.equal(processed.length,36)
 for(const row of rows){
  assert.ok(embedded.some(text=>text.includes(row.raw_message)),`actual full normalized line ${row.message_id} must reach embedding`)
 }
 for(const chunk of chunks){
  assert.ok(chunk.text.length<=1600)
  for(const id of chunk.message_ids)assert.ok(chunk.text.includes(rows.find(row=>row.message_id===id).raw_message),`chunk may only claim text it contains: ${id}`)
 }
})

test('partial embedding responses are retried rather than permanently negative-cached',async()=>{
 let calls=0
 const g=new EmbeddingGateway({apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',fetchFn:async()=>({ok:true,json:async()=>({data:++calls===1?[]:[{embedding:[1,0],index:0}]})})})
 assert.deepEqual(await g.embedBatch(['retry me']),[null])
 assert.ok((await g.embedBatch(['retry me']))[0] instanceof Float32Array)
 assert.equal(calls,2)
 g.dispose()
})

test('disposing during embedding prevents a late response from writing chunks or advancing progress',async t=>{
 const rows=records(10),{dir,store,indexer}=await indexed(t,rows),entered=deferred(),finish=deferred()
 indexer.gateway.embedBatch=async texts=>{entered.resolve();await finish.promise;return texts.map(()=>new Float32Array([1,0]))}
 indexer.onArchivedRecord(rows.at(-1));const work=indexer.flushDirtyGroups();await entered.promise
 indexer.dispose();finish.resolve();await work
 assert.equal(store.loadGroup('20').chunks.size,0)
 await assert.rejects(fs.readFile(path.join(dir,'index-progress','20.json')),/ENOENT/)
})

test('config disable cancels queued indexing and aborts embedding before the next batch',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-disable-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));t.after(__resetSemanticMemoryRuntimeForTest)
 const rows=records(1),a={...archive(rows),getBaseDir:()=>path.join(dir,'archive'),recordMessage:async()=>rows[0]}
 const rt=installSemanticMemoryRuntime({pluginSettings:{semanticMemory:{enabled:true},embeddingAiConfig:{embeddingApiUrl:'https://fixture.invalid/embeddings',embeddingApiKey:'fixture-key',embeddingApiModel:'fixture'}},archiveManager:a})
 await a.recordMessage()
 assert.ok(rt.indexer.flushTimer)
 let calls=0;rt.gateway.fetchFn=async()=>{calls++;throw Error('must not start')}
 installSemanticMemoryRuntime({pluginSettings:{semanticMemory:{enabled:false}},archiveManager:a})
 assert.equal(rt.indexer.flushTimer,null)
 await rt.indexer.flushDirtyGroups();assert.equal(calls,0)
 const entered=deferred(),finish=deferred();let signal
 const g=new EmbeddingGateway({apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',batchSize:1,fetchFn:async(_u,opts)=>{calls++;signal=opts.signal;entered.resolve();await finish.promise;return {ok:true,json:async()=>({data:[{embedding:[1,0],index:0}]})}}})
 const result=g.embedBatch(['first','second']);await entered.promise;g.dispose();assert.equal(signal.aborted,true);finish.resolve()
 assert.deepEqual(await result,[null,null]);assert.equal(calls,1,'no second HTTP batch after disposal')
})

test('disposing a reranker and retriever discards late results without memory reinforcement',async()=>{
 const entered=deferred(),finish=deferred();let signal,reinforced=0
 const reranker=new RerankGateway({apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',fetchFn:async(_url,opts)=>{signal=opts.signal;entered.resolve();await finish.promise;return {ok:true,json:async()=>({results:[{index:0,relevance_score:1}]})}}})
 const chunks=[{id:'a',text:'same',end_ts:Date.now(),message_ids:['a']},{id:'b',text:'same',end_ts:Date.now(),message_ids:['b']}]
 const store={searchVector:()=>chunks.map(chunk=>({chunk,score:1})),searchBM25:()=>[],reinforceChunks:()=>{reinforced++}}
 const retriever=new SemanticMemoryRetriever({store,gateway:{embed:async()=>new Float32Array([1,0])},reranker,config:{memoryEvolution:{enabled:true,freezeThreshold:.06}}})
 const result=retriever.search('20','same',{rerank:true});await entered.promise;retriever.dispose();reranker.dispose();assert.equal(signal.aborted,true);finish.resolve()
 assert.deepEqual((await result).items,[]);assert.equal(reinforced,0)
})

function delegated(){const data=new Map();const redis={get:async k=>data.get(k)||null,set:async(k,v)=>{data.set(k,v);return 'OK'},eval:async(_script,{keys,arguments:args})=>{if((data.get(keys[0])||'')!==args[0])return 0;data.set(keys[0],args[1]);return 1}};const ports={redis,logger,loadConfig:()=>({maxPerOwner:2}),now:()=>Date.now()};return {data,ports}}
const ev={group_id:'20',user_id:'100',sender:{nickname:'tester'}}
test('independent bot and console stores serialize remember/remove and preserve the owner cap',async()=>{
 const {ports}=delegated(),a=createDelegateMemoryRuntime(ports),b=createDelegateMemoryRuntime(ports),consoleStore=createDelegatedMemoryStore(ports)
 const ta=new a.DelegateMemoryTool(),tb=new b.DelegateMemoryTool()
 const results=await Promise.all([ta.execute({action:'remember',content:'first'},ev),tb.execute({action:'remember',content:'second'},ev)])
 assert.ok(results.every(x=>x.includes('记下了')));assert.equal((await a.store.load('20')).length,2)
 const [first]=await a.store.load('20')
 await Promise.all([consoleStore.remove('20',first.id),ta.execute({action:'remember',content:'third'},ev)])
 const entries=await a.store.load('20');assert.ok(entries.every(e=>e.id!==first.id));assert.ok(entries.length<=2)
 const listing=await tb.execute({action:'list'},ev);const id=/\[(dlg_[^\]]+)\]/.exec(listing)?.[1]
 assert.ok(id,'the public list must expose an unambiguous id')
 assert.match(await tb.execute({action:'forget',memory_id:id},ev),/已忘掉/)
})

test('delegated mutations fail closed on malformed documents or missing atomic Redis support',async()=>{
 const {ports,data}=delegated(),store=createDelegatedMemoryStore(ports)
 data.set('bl-chat:delegated:20','[{"unexpected":true}]')
 await assert.rejects(store.remove('20','missing'),/数据损坏/)
 assert.equal(data.get('bl-chat:delegated:20'),'[{"unexpected":true}]')
 const noAtomic=createDelegatedMemoryStore({...ports,redis:{get:ports.redis.get,set:ports.redis.set}})
 await assert.rejects(noAtomic.remove('20','missing'),/原子更新/)
 assert.equal('save' in store,false,'do not expose a stale whole-document replacement API')
})

test('correction uses confirmed bot and reply identities, not latest injected memory',async()=>{
 correction.__resetMemorySelfCorrectionForTest()
 const sent=[],runtime={store:{penalizeChunks:(_group,ids)=>{sent.push(ids);return ids.length}}}
 const event=(turn,ids,user='100',bot='99')=>({group_id:'20',self_id:bot,user_id:user,_turnId:turn,_semanticMemoryChunkIds:ids})
 const a=event('A',['memory-A']),b=event('B',['memory-B'])
 const api=createReplyRendering({logger,bot:()=>({uin:'99'}),stats:()=>null,confirmMemoryReply:correction.confirmMemoryReply,guard:{findForbiddenWord:()=>null,chatScopeKey:()=>'',isConversationInterrupted:()=>false,markConversationInterrupted(){},extractReplyText:x=>x}})
 const host={config:{sendPacing:{enabled:false},forbiddenWords:{enabled:false}}}
 await api.sendObservedReply(host,{...a,reply:async()=>({message_id:'reply-A'})},'A',false,'agent_text')
 await api.sendObservedReply(host,{...b,reply:async()=>({message_id:'reply-B'})},'B',false,'agent_final_card')
 const opts={text:'你记错了',groupId:'20',botId:'99',quotesBot:true,quotedReplyMessageId:'reply-A',senderUserId:'100',runtime}
 assert.deepEqual(correction.detectAndPenalize(opts),['memory-A'])
 assert.deepEqual(correction.detectAndPenalize({...opts,botId:'98'}),[])
 const unsent=event('unsent',[]);correction.noteInjectedChunks(unsent,[{chunk:{id:'wrong'}}])
 assert.deepEqual(correction.detectAndPenalize({...opts,quotedReplyMessageId:'reply-B'}),['memory-B'])
 await api.sendObservedReply(host,{...event('C',[]),reply:async()=>({message_id:'reply-C'})},'unrelated',false,'agent_text')
 assert.deepEqual(correction.detectAndPenalize({...opts,quotesBot:false,quotedReplyMessageId:''}),[])
 await api.sendObservedReply(host,{...event('failed',['wrong']),reply:async()=>({status:'failed',retcode:100,data:{message_id:'failed'}})},'failed',false,'agent_text')
 assert.deepEqual(correction.detectAndPenalize({...opts,quotedReplyMessageId:'failed'}),[])
 const policy=createConversationEntryPolicy({logger,getSemanticMemoryRuntime:()=>runtime,bot:()=>({uin:'99'})})
 policy.handleMemorySelfCorrection({getSmartState:()=>({lastBotReplyToUserId:'100'})},{group_id:'20',self_id:'99',user_id:'100',msg:'你记错了',source:{id:'reply-A',user_id:'99'}})
 assert.deepEqual(sent.at(-1),['memory-A'],'entry policy must pass the exact quoted message id')
})
