import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {createClient} from '@redis/client'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const [{convertLegacyDeferredReminder,stageLegacyDeferredReminders,applyLegacyDeferredReminderTransfer},
  {freezeDeferredAction,deferredActionHash},{encodeCommitment,decodeCommitment},
  {createAgentBindingDirectory,agentBindingIdentity,agentConversationKey}]=await Promise.all([
  load('modules/runtime/infrastructure/agentDeferredActionMigration.js'),
  load('modules/commitments/infrastructure/agentDeferredActionData.js'),
  load('modules/commitments/infrastructure/commitmentStore.js'),
  load('modules/runtime/domain/agentBindings.js'),
])
const at=Date.parse('2026-11-17T12:00:00+08:00')
const account={platform:'qq',namespace:'global',id:'200'}
const directory=createAgentBindingDirectory({version:1,agents:[{id:'daily',personaId:'default'}],
  connections:[{id:'qq-main',platform:'qq',namespace:'global',accountId:'200'}],
  bindings:[{connectionId:'qq-main',kind:'group',conversationId:'20',agentId:'daily'},
    {connectionId:'qq-main',kind:'private',conversationId:'10',agentId:'daily'}]},'source-version')
const group=directory.resolve({account,kind:'group',id:'20'})
const privateBinding=directory.resolve({account,kind:'private',id:'10'})
const hash=raw=>createHash('sha256').update(raw).digest('hex')
const sourceDetailKey=id=>`legacy:reminder:detail:${id}`
const destinationDetailKey=id=>`new:commitment:detail:${id}`
const sourceIndexKey='legacy:reminder:pending'
const destinationIndexKey='new:commitment:pending'
const idleKeys=['legacy:reminder:lock','new:commitment:lock','new:host-lease']
const mapping={from:'pokeTool',to:'simSendPoke',definitionId:'poke-v1',executor:'builtin'}

function setup(overrides={},options={}) {
  const binding=options.binding??group
  const old={id:'rem_1',bot_id:'200',bindingIdentity:agentBindingIdentity(binding),group_id:binding.target.kind==='group'?'20':null,
    user_id:'10',message_id:'source-message',content:'提醒喝水',reminder_message:'喝水啦',trigger_time:at+10_000,
    created_at:at-60_000,status:'pending',extra_action:{tool:'pokeTool',params:{}},retry_count:0,...overrides}
  const raw=JSON.stringify(old),selectedMapping=options.mapping??mapping
  const params={...old.extra_action.params}
  if(old.extra_action.tool==='pokeTool'&&!params.target)params.target=[old.user_id]
  const action=freezeDeferredAction({tool:selectedMapping.to,executor:selectedMapping.executor,definitionId:selectedMapping.definitionId,params})
  const grant={version:1,id:`grant:${old.id}`,ruleId:'migration-rule',ruleRevision:'rule-v2',bindingIdentity:agentBindingIdentity(binding),scopeKey:agentConversationKey(binding),
    creator:{platform:'qq',namespace:'global',id:old.user_id},actionHash:deferredActionHash(action),dueAt:old.trigger_time,
    source:{kind:'migration',id:old.id,sourceHash:hash(raw),authorizedBy:'offline-operator',at},issuedAt:at,expiresAt:at+86_400_000}
  return {old,raw,action,grant,options:{raw,detailKey:sourceDetailKey(old.id),pending:{id:old.id,trigger_time:old.trigger_time},
    sourceBinding:binding,binding:{...binding,revision:'target-version'},destinationMode:'simulation',mapping:selectedMapping,grant,now:at,...options}}
}

test('legacy frozen action keeps the original record and explicit mapping without rebuilding a current human event',()=>{
  const fixture=setup({retry_count:2,updated_at:at-30_000})
  const result=convertLegacyDeferredReminder(fixture.options)
  assert.equal(result.kind,'moved');assert.equal(result.pending,true)
  const task=result.task
  assert.deepEqual({id:task.id,creator:task.creator_id,created:task.created_at,due:task.next_run_at,retries:task.retry_count,
    status:task.status,text:task.static_message,intent:task.intent},
  {id:'rem_1',creator:'10',created:at-60_000,due:at+10_000,retries:2,status:'active',text:'喝水啦',intent:'提醒喝水'})
  assert.deepEqual(task.deferredAction.action,{tool:'simSendPoke',executor:'builtin',definitionId:'poke-v1',params:{target:['10']}})
  assert.equal(task.deferredAction.grant.source.sourceHash,hash(fixture.raw))
  assert.deepEqual(task.deferredAction.legacy,{kind:'legacy-qq-reminder',detailKey:sourceDetailKey('rem_1'),rawSha256:hash(fixture.raw),
    originalStatus:'pending',originalCreatedAt:at-60_000,originalUpdatedAt:at-30_000,originalTriggerTime:at+10_000,
    originalMessageId:'source-message',originalExtraAttempted:false,explicitToolMapping:mapping})
  assert.equal(task.deferredAction.state,'pending');assert.equal(task.deferredAction.attemptedAt,0)
  assert.equal(task.deferredAction.settledAt,0)
  assert.deepEqual(decodeCommitment(encodeCommitment(task)).deferredAction,task.deferredAction)
  assert.ok(!JSON.stringify(task).includes('isMaster'))
  assert.ok(!JSON.stringify(task).includes('actor'))
})

test('an explicit original poke target and exact custom/MCP mapping survive conversion',()=>{
  for(const executor of ['custom','mcp']) {
    const fixture=setup({extra_action:{tool:'notes_lookup',params:{query:'固定查询',nested:{b:2,a:1}}}},
      {mapping:{from:'notes_lookup',to:'mcp_notes_lookup',definitionId:'notes-generation-2',executor}})
    const result=convertLegacyDeferredReminder(fixture.options)
    assert.equal(result.kind,'moved')
    assert.deepEqual(result.task.deferredAction.action.params,{nested:{a:1,b:2},query:'固定查询'})
    assert.equal(result.task.deferredAction.action.executor,executor)
  }
  const result=convertLegacyDeferredReminder(setup({extra_action:{tool:'pokeTool',params:{target:['99']}}}).options)
  assert.deepEqual(result.task.deferredAction.action.params.target,['99'])
})

test('missing account, binding, mapping or explicit grant leaves the record at source',()=>{
  for(const [overrides,optionOverrides,reason] of [
    [{bot_id:''},{},'unscoped'],[{bindingIdentity:undefined},{},'unscoped'],
    [{},{sourceBinding:{...group,agentId:'other'}},'binding'],
    [{},{binding:{...group,personaId:'other'}},'binding'],
    [{},{mapping:undefined},'unsupported'],[{},{grant:undefined},'authorization'],
  ]) {
    const fixture=setup(overrides)
    assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,...optionOverrides}),{kind:'retained',reason})
  }
})

test('migration grant pins source bytes, creator, tool parameters, definition, binding and due time',()=>{
  const fixture=setup()
  for(const change of [
    {source:{...fixture.grant.source,sourceHash:'0'.repeat(64)}},
    {source:{kind:'message',messageId:'old-message',at}},
    {source:{...fixture.grant.source,id:'another-record'}},
    {creator:{...fixture.grant.creator,id:'99'}},
    {actionHash:'0'.repeat(64)},{bindingIdentity:'another-binding'},{scopeKey:agentConversationKey(privateBinding)},
    {dueAt:at+9999},{expiresAt:at+1},{issuedAt:at+1},
  ]) assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,grant:{...fixture.grant,...change}}),{kind:'retained',reason:'authorization'})
  assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,mapping:{...mapping,definitionId:'changed-definition'}}),{kind:'retained',reason:'authorization'})
  assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,raw:fixture.raw+' '}),{kind:'retained',reason:'authorization'})
})

test('attempted, sending, unknown, orphan and ambiguous delivery records require an explicit frozen transfer',()=>{
  for(const [old,extra] of [
    [{extra_attempted:true},{}],[{status:'sending'},{}],[{status:'unknown'},{}],
    [{},{pending:undefined}],[{delivery:{state:'unknown'}},{}],[{delivery:{state:'sent',messageId:'native-sent'}},{}],
  ]) {
    const fixture=setup(old)
    const options={...fixture.options,...extra}
    assert.deepEqual(convertLegacyDeferredReminder(options),{kind:'retained',reason:'in-flight'})
    const frozen=convertLegacyDeferredReminder({...options,freezeUncertain:true})
    assert.equal(frozen.kind,'moved');assert.equal(frozen.pending,false);assert.equal(frozen.task.status,'unknown')
    assert.equal(frozen.task.next_run_at,0);assert.equal(frozen.task.deferredAction.state,'unknown')
    assert.equal(frozen.task.deferredAction.attemptedAt,0)
    assert.equal(frozen.task.deferredAction.settledAt,at)
    assert.equal(frozen.task.deferredAction.legacy.originalStatus,fixture.old.status)
    assert.equal(frozen.task.deferredAction.legacy.originalExtraAttempted,!!fixture.old.extra_attempted)
    assert.equal(decodeCommitment(encodeCommitment(frozen.task)).status,'unknown')
  }
  assert.equal(convertLegacyDeferredReminder(setup({delivery:{state:'failed',code:'explicit_rejection'}}).options).task.status,'active')
})

test('terminal record status and source timestamps survive without manufacturing extra-action success',()=>{
  for(const status of ['completed','failed','cancelled']) {
    const fixture=setup({status,extra_attempted:true,updated_at:at-15_000})
    const result=convertLegacyDeferredReminder({...fixture.options,pending:undefined})
    assert.equal(result.kind,'moved');assert.equal(result.pending,false);assert.equal(result.task.status,status)
    assert.equal(result.task.next_run_at,0);assert.equal(result.task.deferredAction.state,'unknown')
    assert.equal(result.task.deferredAction.legacy.originalUpdatedAt,at-15_000)
    assert.equal(result.task.last_run_at,0)
  }
})

test('text groups and private conversations cannot acquire active frozen tool execution',()=>{
  const groupFixture=setup(),friendFixture=setup({}, {binding:privateBinding})
  assert.deepEqual(convertLegacyDeferredReminder({...groupFixture.options,destinationMode:'text'}),{kind:'retained',reason:'unsupported'})
  assert.deepEqual(convertLegacyDeferredReminder({...friendFixture.options,destinationMode:'private'}),{kind:'retained',reason:'unsupported'})
  const unknown=setup({status:'unknown'}, {binding:privateBinding})
  const frozen=convertLegacyDeferredReminder({...unknown.options,destinationMode:'private',freezeUncertain:true})
  assert.equal(frozen.task.status,'unknown');assert.equal(frozen.pending,false)
})

test('malformed old parameters and lossy-normalization cases are retained',()=>{
  const fixture=setup()
  for(const change of [
    {extra_action:{tool:'pokeTool',params:[]}}, {extra_action:{tool:'pokeTool',params:null}},
    {extra_action:{tool:'pokeTool',params:{constructor:'unsafe'}}},
    {retry_count:'1'},{trigger_time:'1234'},{created_at:0},{extra_attempted:'true'},
    {delivery:{state:'not-a-receipt'}},{updated_at:at+1},{message_id:{}},
  ]) {
    const raw=JSON.stringify({...fixture.old,...change})
    assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,raw,
      grant:{...fixture.grant,source:{...fixture.grant.source,sourceHash:hash(raw)}}}),{kind:'retained',reason:'invalid'})
  }
  assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,raw:'[]'}),{kind:'retained',reason:'invalid'})
  assert.deepEqual(convertLegacyDeferredReminder({...fixture.options,pending:{id:'other',trigger_time:fixture.old.trigger_time}}),{kind:'retained',reason:'invalid'})
})

const redisAvailable=spawnSync('redis-server',['--version'],{stdio:'ignore'}).status===0
async function isolatedRedis(t) {
  const folder=await mkdtemp(join(tmpdir(),'agent-deferred-migration-')),socket=join(folder,'redis.sock')
  const child=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'})
  const exited=once(child,'exit').catch(()=>{})
  let client
  t.after(async()=>{
    try {if(client?.isOpen)await client.close()}
    finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;await rm(folder,{recursive:true,force:true})}
  })
  for(let attempt=0;attempt<100;attempt++){
    if(await stat(socket).then(()=>true,()=>false)){client=createClient({socket:{path:socket}});client.on('error',()=>{});await client.connect();return client}
    if(child.exitCode!==null)break
    await delay(20)
  }
  throw new Error('isolated migration Redis did not start')
}
async function seed(redis,fixtures) {
  const pending=fixtures.filter(fixture=>fixture.old.status==='pending').map(fixture=>({id:fixture.old.id,trigger_time:fixture.old.trigger_time}))
  await redis.set(sourceIndexKey,JSON.stringify(pending))
  for(const fixture of fixtures)await redis.set(sourceDetailKey(fixture.old.id),fixture.raw)
}
function stageOptions(redis,fixtures) {
  return {read:key=>redis.get(key),sourceIndexKey,destinationIndexKey,sourceDetailKey,destinationDetailKey,
    sourceBinding:group,binding:{...group,revision:'target-version'},destinationMode:'simulation',now:at,idleKeys,isCurrent:()=>true,
    selections:fixtures.map(fixture=>({id:fixture.old.id,mapping:fixture.options.mapping,grant:fixture.grant,
      ...(fixture.options.freezeUncertain?{freezeUncertain:true}:{})}))}
}

test('isolated Redis preview and CAS transfer move active, frozen and terminal records with exact index membership',
  {skip:!redisAvailable,timeout:10_000},async t=>{
    const redis=await isolatedRedis(t)
    const active=setup(),unknown=setup({id:'rem_unknown',status:'unknown'},{freezeUncertain:true}),
      terminal=setup({id:'rem_cancelled',status:'cancelled'}),retained=setup({id:'rem_retained',extra_attempted:true})
    const fixtures=[active,unknown,terminal,retained]
    await seed(redis,fixtures)
    const before=await redis.get(sourceIndexKey),staged=await stageLegacyDeferredReminders(stageOptions(redis,fixtures))
    assert.deepEqual(staged.report,{moved:3,active:1,frozen:1,terminal:1,retained:1,reasons:{'in-flight':1}})
    assert.equal(await redis.get(sourceIndexKey),before)
    assert.equal(await redis.get(destinationDetailKey(active.old.id)),null)
    await applyLegacyDeferredReminderTransfer({redis,checks:staged.checks,isCurrent:()=>true})
    assert.deepEqual(JSON.parse(await redis.get(sourceIndexKey)),[{id:retained.old.id,trigger_time:retained.old.trigger_time}])
    assert.deepEqual(JSON.parse(await redis.get(destinationIndexKey)),[{id:active.old.id,next_run_at:active.old.trigger_time}])
    for(const fixture of [active,unknown,terminal]) {
      assert.equal(await redis.get(sourceDetailKey(fixture.old.id)),null)
      const moved=decodeCommitment(await redis.get(destinationDetailKey(fixture.old.id)))
      assert.equal(moved.deferredAction.legacy.rawSha256,hash(fixture.raw))
      assert.equal(moved.deferredAction.grant.source.sourceHash,hash(fixture.raw))
    }
    assert.equal(await redis.get(sourceDetailKey(retained.old.id)),retained.raw)
    assert.equal(decodeCommitment(await redis.get(destinationDetailKey(unknown.old.id))).status,'unknown')
    assert.equal(decodeCommitment(await redis.get(destinationDetailKey(terminal.old.id))).status,'cancelled')
  })

test('isolated Redis rejects changed source, destination and host lease without partial writes',
  {skip:!redisAvailable,timeout:10_000},async t=>{
    const redis=await isolatedRedis(t),fixture=setup()
    await seed(redis,[fixture])
    const options=stageOptions(redis,[fixture])
    for(const key of [sourceDetailKey(fixture.old.id),sourceIndexKey,destinationIndexKey,destinationDetailKey(fixture.old.id),idleKeys[2]]) {
      const before=await redis.get(key),staged=await stageLegacyDeferredReminders(options)
      await redis.set(key,'concurrent-change')
      await assert.rejects(applyLegacyDeferredReminderTransfer({redis,checks:staged.checks,isCurrent:()=>true}),/未写入/u)
      if(key!==destinationDetailKey(fixture.old.id))assert.equal(await redis.get(destinationDetailKey(fixture.old.id)),null)
      if(key!==sourceDetailKey(fixture.old.id))assert.equal(await redis.get(sourceDetailKey(fixture.old.id)),fixture.raw)
      if(before===null)await redis.del(key);else await redis.set(key,before)
    }
    await redis.set(destinationDetailKey(fixture.old.id),'existing-destination')
    await assert.rejects(stageLegacyDeferredReminders(options),/未覆盖/u)
    assert.equal(await redis.get(sourceDetailKey(fixture.old.id)),fixture.raw)
    await redis.del(destinationDetailKey(fixture.old.id))
    await redis.set(idleKeys[0],'source-running')
    await assert.rejects(stageLegacyDeferredReminders(options),/停止宿主/u)
    assert.equal(await redis.get(sourceDetailKey(fixture.old.id)),fixture.raw)
  })

test('staging rejects duplicate/colliding keys and config revocation before writes',async()=>{
  const fixture=setup(),values=new Map([[sourceIndexKey,JSON.stringify([{id:fixture.old.id,trigger_time:fixture.old.trigger_time}])],
    [sourceDetailKey(fixture.old.id),fixture.raw]])
  const fake={get:async key=>values.get(key)??null},options=stageOptions(fake,[fixture])
  await assert.rejects(stageLegacyDeferredReminders({...options,selections:[options.selections[0],options.selections[0]]}),/重复/u)
  await assert.rejects(stageLegacyDeferredReminders({...options,destinationDetailKey:sourceDetailKey}),/重复/u)
  await assert.rejects(stageLegacyDeferredReminders({...options,idleKeys:[]}),/停机/u)
  await assert.rejects(stageLegacyDeferredReminders({...options,isCurrent:()=>false}),/未写入/u)
  const staged=await stageLegacyDeferredReminders(options)
  await assert.rejects(applyLegacyDeferredReminderTransfer({redis:{eval:async()=>assert.fail('revoked plan must not write')},
    checks:staged.checks,isCurrent:()=>false}),/未写入/u)
  assert.equal(values.get(sourceDetailKey(fixture.old.id)),fixture.raw)
})

test('staging preserves unrelated index metadata and refuses coercible destination timestamps',async()=>{
  const fixture=setup(),unrelatedSource={id:'leave-source',trigger_time:at+20_000,sourceTag:'preserve-source'},
    unrelatedDestination={id:'leave-destination',next_run_at:at+30_000,sourceTag:'preserve-destination'}
  const values=new Map([[sourceIndexKey,JSON.stringify([{id:fixture.old.id,trigger_time:fixture.old.trigger_time},unrelatedSource])],
    [destinationIndexKey,JSON.stringify([unrelatedDestination])],[sourceDetailKey(fixture.old.id),fixture.raw]])
  const options=stageOptions({get:async key=>values.get(key)??null},[fixture])
  const staged=await stageLegacyDeferredReminders(options)
  assert.deepEqual(JSON.parse(staged.checks.find(item=>item.key===sourceIndexKey).write),[unrelatedSource])
  assert.deepEqual(JSON.parse(staged.checks.find(item=>item.key===destinationIndexKey).write).at(-1),unrelatedDestination)
  values.set(destinationIndexKey,JSON.stringify([{...unrelatedDestination,next_run_at:String(at+30_000)}]))
  await assert.rejects(stageLegacyDeferredReminders(options),/索引损坏/u)
})
