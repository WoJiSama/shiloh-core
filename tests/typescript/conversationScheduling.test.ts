import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createConversationScheduling,type SchedulingHost,type ScheduledEvent} from '../../src/modules/conversation/infrastructure/conversationScheduling.js'
import {createMutedGroupPolicy} from '../../src/modules/conversation/infrastructure/mutedGroupPolicy.js'
import {createGroupRuntime} from '../../src/modules/runtime/application/groupRuntime.js'
import {smartConversationKey} from '../../src/modules/conversation/domain/conversationIdentity.js'
import type {ConversationState} from '../../src/modules/conversation/application/smartConversation.js'
const logger={info(_s:string){},warn(_s:string){},error(_s:string,_e?:unknown){}}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
function fixture(){
 const runtime=createConversationScheduling({logger,resolveToolRequestMergeMs:()=>5,shouldBypassMergeForExcel:()=>false,isDrawTaskStatusInquiry:()=>false})
 const states=createGroupRuntime<ReturnType<typeof setTimeout>,null,null>({now:Date.now,cancelTimer:clearTimeout,peekTopic:()=>null,peekSocial:()=>null})
 const stateMap=new Map<string|number,ConversationState>()
 const events:ScheduledEvent[]=[]
 const host:SchedulingHost={config:{enabled:true,chatTriggerMode:'smart'},resolveTalkValue:()=>1,computeAvgReplyLatency:()=>1,checkGroupPermission:()=>true,isUserBlacklisted:()=>false,isMutedInGroup:async()=>false,
 handleRandomReplySmart:async e=>{events.push(e)},handleTool:async e=>{events.push(e)},getSmartState(g,e){const key=smartConversationKey(g,e);let s=stateMap.get(key);if(!s){s={...states.getSmartRuntimeState(key),rerunEvent:null};stateMap.set(key,s)}return s},
 getDirectTriggerMergeMs:()=>5,getDirectTriggerMergeMaxMessages:()=>2,getMergeMsForEvent:()=>5,isMergeableDirectTrigger:()=>true,isMergeableToolRequest:()=>true,isCommand:()=>false,isAutomaticTorrentDownloadEvent:()=>false,isLikelyToolRequestText:()=>true,
 buildMergedDirectTriggerEvent:(e,m)=>runtime.buildMergedDirectTriggerEvent(host,e,m),buildMergedToolRequestEvent:(e,m)=>runtime.buildMergedToolRequestEvent(host,e,m),getSmartLockTimeoutMs:()=>5,releaseSmartInFlight:(s,e,t)=>runtime.releaseSmartInFlight(host,s,e,t)}
 return {runtime,host,events}
}
test('merge timers isolate accounts and retain the newest bounded inputs',async()=>{
 const {runtime,host,events}=fixture();const event={group_id:7,user_id:8,self_id:1,msg:'first'}
 runtime.scheduleMergedDirectTrigger(host,event,async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,msg:'second'},async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,msg:'third'},async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,self_id:2,msg:'other bot'},async e=>{events.push(e)})
 await sleep(30);assert.equal(events.length,2)
 assert.equal(events[0]?._mergedDroppedMessageCount,1);assert.deepEqual(events[0]?._mergedOriginalTexts,['second','third']);assert.equal(events[1]?.msg,'other bot')
})
test('queued direct and tool messages are kept within the binding that received them', async () => {
 const {runtime,host,events} = fixture()
 let revision = 'first'
 const event = (msg:string):ScheduledEvent => {
  const captured = revision
  return {group_id:7,user_id:8,self_id:1,msg,_agentBindingToken:captured,_isAgentBindingCurrent:() => revision === captured}
 }
 const receive = async (event:ScheduledEvent) => { events.push(event) }
 runtime.scheduleMergedDirectTrigger(host, event('旧角色点名'), receive)
 runtime.scheduleMergedToolRequest(host, event('旧角色工具请求'), receive)
 revision = 'next'
 runtime.scheduleMergedDirectTrigger(host, event('新角色点名'), receive)
 runtime.scheduleMergedToolRequest(host, event('新角色工具请求'), receive)
 await sleep(30)
 assert.deepEqual(events.map(item => item.msg), ['新角色点名','新角色工具请求'])
 assert.ok(events.every(item => item._mergedMessageCount === 1))
})
test('stale lock release cannot unlock a newer turn; owner releases and reruns exactly once',()=>{
 const {runtime,host,events}=fixture(),e={group_id:7,self_id:1},s=host.getSmartState(7,e)
 s.inFlight=true;s.inFlightToken=2;s.needsRerun=true;s.rerunEvent=e
 runtime.releaseSmartInFlight(host,s,e,1);assert.equal(s.inFlight,true);assert.equal(events.length,0)
 runtime.releaseSmartInFlight(host,s,e,2);assert.equal(s.inFlight,false);assert.equal(events.length,1)
 runtime.releaseSmartInFlight(host,s,e,2);assert.equal(events.length,1)
})
test('deferred and wait callbacks recheck enabled state and cancellation removes pending timers',async()=>{
 const {runtime,host,events}=fixture(),e={group_id:7,self_id:1},s=host.getSmartState(7,e)
 host.config.smartTrigger={minDeferredMs:5,maxDeferredMs:5};runtime.scheduleDeferredGateCheck(host,e,s)
 host.config.enabled=false;await sleep(20);assert.equal(events.length,0)
 runtime.scheduleWaitReply(host,e,0.01,'test');runtime.cancelPendingConversation(host,7,e)
 await sleep(20);assert.equal(events.length,0);assert.equal(s.waitTimers.size,0)
})
test('expired bindings are dropped before delayed or queued work enters the model path',async()=>{
 const {runtime,host,events}=fixture()
 let live=true
 let muteChecks=0
 host.isMutedInGroup=async()=>{muteChecks++;return false}
 const event:ScheduledEvent={group_id:7,self_id:1,user_id:8,_isAgentBindingCurrent:()=>live}
 const s=host.getSmartState(7,event)
 host.config.smartTrigger={minDeferredMs:5,maxDeferredMs:5}
 runtime.scheduleDeferredGateCheck(host,event,s)
 runtime.scheduleWaitReply(host,event,0.01,'test')
 s.inFlight=true;s.inFlightToken=1;s.needsRerun=true;s.rerunEvent=event
 live=false
 runtime.releaseSmartInFlight(host,s,event,1)
 assert.deepEqual(await runtime.enqueueProactiveTask(host,7,'expired request',{anchorE:event}),{ok:false,error:'binding_changed'})
 await sleep(30)
 assert.equal(s.deferredTimer,null)
 assert.equal(s.waitTimers.size,0)
 assert.equal(s.forceGateCheck,false)
 assert.equal(muteChecks,0)
 assert.deepEqual(events,[])
})
test('mute cache distinguishes bot accounts in the same group',async()=>{
 const runtime=createMutedGroupPolicy(()=>({uin:1}))
 assert.equal(await runtime.isMutedInGroup({group_id:7,self_id:1,group:{mute_left:60}}),true)
 assert.equal(await runtime.isMutedInGroup({group_id:7,self_id:2,group:{}}),false)
})
