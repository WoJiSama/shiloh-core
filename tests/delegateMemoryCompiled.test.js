// 委托记忆 compiled 集成测试:原文保真 / 权限 / 召回 / 上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import {createDelegateMemoryRuntime} from '../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'
import {createAgentBindingDirectory} from '../dist/backend/modules/runtime/domain/agentBindings.js'

const key='bl-chat:delegated:20'
function setup(){
  const data=new Map(),logs=[]
  const redis={get:async k=>data.get(k)||null,set:async(k,v)=>{data.set(k,v);return 'OK'},eval:async(_script,{keys,arguments:args})=>{if((data.get(keys[0])||'')!==args[0])return 0;data.set(keys[0],args[1]);return 1}}
  const runtime=createDelegateMemoryRuntime({redis,logger:{info:m=>logs.push(String(m)),warn(){},error(){}},loadConfig:()=>({})})
  return {data,logs,redis,...runtime,tool:new runtime.DelegateMemoryTool()}
}
const ev={group_id:20,user_id:10001,isMaster:false,sender:{nickname:'星野'}}

test('remember 存原文;recall 原样返回;群维度共享',async()=>{
  const r=setup()
  assert.match(await r.tool.execute({action:'remember',content:'周五要交报告',due_time:'2026-11-13T18:00:00+08:00'},ev),/记下了/)
  const entries=JSON.parse(r.data.get(key))
  assert.equal(entries.length,1)
  assert.equal(entries[0].content,'周五要交报告','原文锚定:存的就是原话')
  assert.equal(entries[0].owner,'10001')
  assert.equal(entries[0].dueAt,Date.parse('2026-11-13T18:00:00+08:00'))
  // 另一个人也能 recall 到(群维度),但 list 看不到别人的
  const other={...ev,user_id:20002,sender:{nickname:'坤'}}
  const recall=await r.tool.execute({action:'recall',query:'报告'},other)
  assert.match(recall,/周五要交报告/)
  assert.match(recall,/星野/)
  assert.match(await r.tool.execute({action:'list'},other),/还没托付我记过事/)
  assert.match(await r.tool.execute({action:'list'},ev),/周五要交报告/)
})

test('recall 无命中诚实说没有,不编造',async()=>{
  const r=setup()
  await r.tool.execute({action:'remember',content:'周五要交报告'},ev)
  const miss=await r.tool.execute({action:'recall',query:'完全无关的词'},ev)
  assert.match(miss,/没记住过/)
})

test('forget 权限:本人可删,他人不可,群主可以',async()=>{
  const r=setup()
  await r.tool.execute({action:'remember',content:'我的生日是 3 月 3 日'},ev)
  const entries=JSON.parse(r.data.get(key))
  const shortId=entries[0].id.slice(4,14)
  const other={...ev,user_id:20002}
  assert.match(await r.tool.execute({action:'forget',memory_id:shortId},other),/只能忘掉自己托付的/)
  assert.match(await r.tool.execute({action:'forget',memory_id:shortId},{...ev,isMaster:true}),/已忘掉/)
  assert.equal(JSON.parse(r.data.get(key)).length,0)
})

test('上限:每人 20 条封顶(用注入配置压到 2 验证)',async()=>{
  const data=new Map()
  const redis={get:async k=>data.get(k)||null,set:async(k,v)=>{data.set(k,v);return 'OK'},eval:async(_script,{keys,arguments:args})=>{if((data.get(keys[0])||'')!==args[0])return 0;data.set(keys[0],args[1]);return 1}}
  const runtime=createDelegateMemoryRuntime({redis,logger:{warn(){},error(){},info(){}},loadConfig:()=>({maxPerOwner:2,maxPerGroup:50})})
  const tool=new runtime.DelegateMemoryTool()
  assert.match(await tool.execute({action:'remember',content:'第一条'},ev),/记下了/)
  assert.match(await tool.execute({action:'remember',content:'第二条'},ev),/记下了/)
  assert.match(await tool.execute({action:'remember',content:'第三条'},ev),/每人上限 2/)
})

test('群外(私聊)拒绝',async()=>{
  const r=setup()
  assert.match(await r.tool.execute({action:'remember',content:'x'},{...ev,group_id:undefined}),/群维度/)
})

test('委托记忆按角色和完整会话地址分区，兼容群仍读取原键', async () => {
  const r=setup()
  const agents=[{id:'a',personaId:'shared'},{id:'b',personaId:'shared'}]
  const qq={platform:'qq',namespace:'global',id:'99'}
  const feishu={platform:'feishu',namespace:'tenant-a',id:'99'}
  const targets=[{account:qq,kind:'group',id:'20'},{account:feishu,kind:'group',id:'20'}]
  const binding=(target,agentId,revision)=>createAgentBindingDirectory({
    version:1,agents,
    connections:[{id:'main',platform:target.account.platform,namespace:target.account.namespace,accountId:target.account.id}],
    bindings:[{connectionId:'main',kind:target.kind,conversationId:target.id,agentId}],
  },revision).resolve(target)
  const contexts=[ev,...targets.map(target=>({...ev,_agentBinding:binding(target,'a','first')})),{...ev,_agentBinding:binding(targets[0],'b','first')}]
  const contents=['旧群报告','QQ 角色 A 的报告','飞书角色 A 的报告','QQ 角色 B 的报告']
  for(let i=0;i<contexts.length;i++){
    assert.match(await r.tool.execute({action:'remember',content:contents[i]},contexts[i]),/记下了/)
  }
  for(let i=0;i<contexts.length;i++){
    const listed=await r.tool.execute({action:'list'},contexts[i])
    assert.deepEqual(contents.filter(content=>listed.includes(content)),[contents[i]])
    const recalled=await r.tool.execute({action:'recall',query:'报告'},contexts[i])
    assert.deepEqual(contents.filter(content=>recalled.includes(content)),[contents[i]])
  }
  const revised={...ev,_agentBinding:binding(targets[0],'a','second')}
  assert.match(await r.tool.execute({action:'list'},revised),/QQ 角色 A 的报告/)
  assert.equal((await r.store.load('20')).length,1)
  assert.equal([...r.data.keys()].filter(key=>key.startsWith('bl-chat:delegated:v2:')).length,3)
})

test('绑定在等待 Redis 期间撤销后，委托记忆不读取或提交旧结果', async () => {
  const r=setup()
  let current=true
  const guard={...ev,_isAgentBindingCurrent:()=>current}
  const remember=()=>r.tool.execute({action:'remember',content:'本次暂不保存的报告'},guard)
  const originalGet=r.redis.get
  r.redis.get=async key=>{current=false;return originalGet(key)}
  assert.match(await remember(),/角色绑定已改变/)
  assert.equal(r.data.has(key),false)
  r.redis.get=originalGet
  assert.match(await r.tool.execute({action:'remember',content:'已保存的报告'},ev),/记下了/)
  current=true
  r.redis.get=async key=>{current=false;return originalGet(key)}
  assert.match(await r.tool.execute({action:'list'},guard),/角色绑定已改变/)
})
