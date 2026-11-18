import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import fs from 'node:fs'
import {mkdtemp,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import YAML from 'yaml'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDiceEngine}=await load('modules/dice/infrastructure/agentDiceEngine.js')
const {createAgentDiceState}=await load('modules/dice/infrastructure/agentDiceState.js')
const {createAgentDiceLedger}=await load('modules/dice/infrastructure/agentDiceLedger.js')
const {compileAgentDiceRulePackage}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const {connectAgentRedis,openAgentRedis,agentRedisPrefix}=await load('modules/runtime/infrastructure/agentRedis.js')
const {conversationAddressKey,agentBindingToken}=await load('modules/runtime/domain/agentBindings.js')
const {agentDiceSourceFingerprint}=await load('modules/dice/infrastructure/agentDiceSource.js')
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')
const account={platform:'fixture',namespace:'dice-private-engine',id:'bot'}
const owner=(changes={})=>({source:'configured',id:'binding',revision:'binding-one',agentId:'daily',personaId:'persona',connectionId:'connection',target:{account,kind:'group',id:'room'},...changes})
const options={skip:spawnSync('redis-server',['--version'],{stdio:'ignore'}).status!==0,timeout:20000}
const permissions=['player','gm','admin','delegate','hidden','card']
const packId='ember-team'
const slots=(snapshot,id='alice')=>snapshot.state.rules.packs[packId].players[JSON.stringify([id,'默认'])]
const queueOf=snapshot=>snapshot.state.rules.packs[packId].group.privateDeliveries
const privateAttempts=f=>f.attempts.filter(attempt=>attempt.effect.kind==='private')
const bindingIdentity=value=>JSON.stringify([agentBindingToken(value),conversationAddressKey(value.target)])

async function redisFixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'agent-dice-private-')),socket=path.join(directory,'redis.sock')
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'}),exited=once(server,'exit').catch(()=>{})
  let reader,connection
  t.after(async()=>{try{await connection?.close();if(reader?.isOpen)await reader.close()}finally{if(server.exitCode===null&&server.signalCode===null)server.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true})}})
  for(let attempt=0;attempt<100;attempt++){if(await stat(socket).then(()=>true,()=>false))break;if(server.exitCode!==null)assert.fail('Redis exited before readiness');await delay(10)}
  const instance='agent-dice-private-test',url=`unix://${socket}`
  reader=await connectAgentRedis(url);connection=await openAgentRedis({url,instance,onLost(){}})
  return {reader,storage:connection.storage,prefix:agentRedisPrefix(instance),url}
}

async function fixture(t,settings={}) {
  const redis=await redisFixture(t),state=createAgentDiceState(redis.storage),ledger=createAgentDiceLedger(redis.storage)
  const raw=YAML.parse(fs.readFileSync(new URL('../docs/dice-rules/examples/team-session.yaml',import.meta.url),'utf8'))
  raw.commands.find(command=>command.id==='secret_search').actions=[{op:'subtract',field:'hp',value:1}]
  const source=YAML.stringify(raw),compiled=await compileAgentDiceRulePackage({kind:'yaml',source,revision:'private-one',sourceHash:digest(source)})
  const auth={revision:'authority-one',actor:{id:'alice',name:'Alice'},permissions:[...permissions],members:[
    {id:'alice',name:'Alice',permissions:[...permissions]},{id:'bob',name:'Bob',permissions:['player','gm','hidden']},
    {id:'charlie',name:'Charlie',permissions:['player']}],botUserId:'bot'}
  const attempts=[],deliveries=[],settlements=[],commits=[],events=[],diagnostics=[],originChecks=[],sources=new Map(),recalled=new Set()
  let selected=owner(),sequence=0,receipt=0,current=true,controller=new AbortController(),engine,lostSettlement=false
  const traced={...state,
    async commit(...args){const result=await state.commit(...args);if(result)commits.push({payload:structuredClone(args[2]),operation:result});return result},
    async settleEffect(...args){
      await settings.beforeSettle?.(args,f)
      const before=await state.read(args[0]),result=await state.settleEffect(...args),after=await state.read(args[0])
      settlements.push({args:structuredClone(args.slice(0,4)),before,after,result})
      await settings.afterSettle?.({args,before,after,result},f)
      return result
    },
    async settleEffectAndState(...args){
      await settings.beforeSettle?.(args,f)
      const before=await state.read(args[0]),result=await state.settleEffectAndState(...args),after=await state.read(args[0])
      settlements.push({args:structuredClone(args.slice(0,4)),before,after,result})
      await settings.afterSettle?.({args,before,after,result},f)
      if(settings.loseSettlementAcknowledgement&&!lostSettlement&&args[3]?.state==='sent'&&result){lostSettlement=true;return undefined}
      return result
    },
  }
  const ports={state:traced,legacyLedger:ledger,allowsText:()=>true,diagnostics:{emit:value=>diagnostics.push(value)},
    async authorize(request,guard){await settings.authorize?.(request,guard,f);return structuredClone(auth)},
    async authorizePrivateOrigin(request,guard){
      originChecks.push(structuredClone(request))
      if(settings.authorizePrivateOrigin)return await settings.authorizePrivateOrigin(request,guard,f)
      const {origin,recipientId,requiredPermission}=request,original=sources.get(origin.source.messageId)
      const recipient=auth.members.find(member=>member.id===recipientId),levels=recipient?.permissions??[]
      return !!original&&!recalled.has(origin.source.messageId)&&bindingIdentity(origin.binding)===bindingIdentity(request.binding)&&
        origin.source.fingerprint===agentDiceSourceFingerprint(original)&&origin.source.author.id===original.sender.id&&
        auth.permissions.includes('player')&&auth.permissions.includes('hidden')&&levels.includes('player')&&levels.includes('hidden')&&
        (requiredPermission!=='gm'||levels.some(level=>['gm','admin','master'].includes(level)))
    },
    async deliver(request,guard){attempts.push(structuredClone(request));await settings.beforeDeliver?.(request,guard,f)
      if(!settings.ignoreGuard)await guard.ensureCurrent?.()
      const result=settings.receipt?await settings.receipt(request,guard,f):{state:'sent',messageId:'private-native-'+ ++receipt}
      deliveries.push({request:structuredClone(request),receipt:structuredClone(result)})
      return result
    },
  }
  if(settings.omitPrivateOriginAuthority)delete ports.authorizePrivateOrigin
  const make=()=>createAgentDiceEngine({enabled:true,builtin:{allowHiddenRoll:true},rulePackages:[compiled],deliveryTimeoutMs:settings.deliveryTimeoutMs??200},ports)
  const context=()=>({signal:controller.signal,isCurrent:()=>current,async ensureCurrent(){if(!current||controller.signal.aborted)throw Error('source revoked')},
    async record(value){events.push(structuredClone(value))},async archive(){assert.fail('a hidden rule result cannot be publicly archived')}})
  const f={...redis,state,ledger,auth,attempts,deliveries,settlements,commits,events,diagnostics,originChecks,sources,
    get binding(){return selected},get engine(){return engine},rebuild(){engine=make();return engine},
    rebind(changes={revision:'binding-two'}){selected=owner(changes);return selected},
    message(text='.ember secret',changes={}){const message={version:1,conversation:selected.target,sender:{platform:account.platform,namespace:account.namespace,id:'alice'},senderName:'Alice',messageId:'real-private-source-'+ ++sequence,
      occurredAt:1_800_000_000_000+sequence,text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false,...changes};sources.set(message.messageId,structuredClone(message));return message},
    async handle(message,chosen=selected,chosenEngine=engine){return chosenEngine.handle(message,chosen,context())},
    snapshot(chosen=selected){return state.read(chosen)},
    async operation(message,chosen=selected){const raw=await redis.reader.get(redis.prefix+'agent:dice:engine:v1:operation:'+digest([conversationAddressKey(chosen.target),message.messageId]));return raw?JSON.parse(raw):null},
    async recall(message,chosen=selected){recalled.add(message.messageId);await ledger.revokeSource(chosen.target,message.messageId);await state.revokeSource(chosen,message.messageId)},
    revoke(){current=false;controller.abort()},resume(){current=true;controller=new AbortController()},
  }
  engine=make()
  return f
}

test('confirmed YAML private receipts remove only their exact durable queue entries in the operation settlement CAS',options,async t=>{
  const f=await fixture(t),message=f.message()
  await f.handle(message)
  assert.deepEqual(privateAttempts(f).map(attempt=>attempt.effect.recipientId),['alice','bob'])
  assert.equal(f.deliveries.at(-1).request.effect.kind,'public')
  assert.equal(slots(await f.snapshot()).values.hp,11)
  assert.deepEqual(queueOf(await f.snapshot()),[])
  assert.equal((await f.operation(message)).state,'confirmed')
  const privateSteps=f.settlements.filter(step=>step.before&&queueOf(step.before).length!==queueOf(step.after).length)
  assert.equal(privateSteps.length,2)
  for(const step of privateSteps){
    assert.equal(queueOf(step.before).length-queueOf(step.after).length,1)
    assert.equal(step.result.completed,step.args[2]+1)
    assert.equal(slots(step.after).values.hp,11)
  }
  const count=privateAttempts(f).length
  await f.handle(message,f.binding,f.rebuild())
  assert.equal(privateAttempts(f).length,count)
})

test('an explicit failed private receipt can retry once from durable origin evidence and keeps unresolved recipients fenced',options,async t=>{
  let fail=true
  const f=await fixture(t,{receipt:request=>request.effect.kind==='private'&&fail?{state:'failed'}:{state:'sent',messageId:'confirmed-retry'}}),message=f.message()
  await f.handle(message)
  const initial=await f.snapshot(),pending=queueOf(initial),failed=pending.find(item=>item.userId==='alice')
  assert.equal(failed.state,'failed')
  assert.equal(pending.find(item=>item.userId==='bob').state,'unknown')
  assert.equal(slots(initial).values.hp,11)
  fail=false
  const retry=f.message('.ember 投递 重试');await f.handle(retry,f.binding,f.rebuild())
  assert.deepEqual(privateAttempts(f).map(attempt=>attempt.effect.recipientId),['alice','alice'])
  assert.equal(privateAttempts(f).at(-1).effect.deliveryId,failed.deliveryId)
  assert.ok(f.originChecks.some(check=>check.origin.source.messageId===message.messageId&&check.source.messageId===retry.messageId))
  assert.equal(queueOf(await f.snapshot()).some(item=>item.deliveryId===failed.deliveryId),false)
  assert.equal(queueOf(await f.snapshot()).find(item=>item.userId==='bob').state,'unknown')
  assert.equal(slots(await f.snapshot()).values.hp,11)
})

test('unknown private receipts never replay from a new retry source or after engine restart',options,async t=>{
  const f=await fixture(t,{receipt:()=>({state:'unknown'})}),message=f.message()
  await f.handle(message)
  assert.equal(privateAttempts(f).length,1)
  assert.ok(queueOf(await f.snapshot()).every(item=>item.state==='unknown'))
  await f.handle(f.message('.ember 投递 重试'),f.binding,f.rebuild())
  await f.handle(message)
  assert.equal(privateAttempts(f).length,1)
  assert.equal(slots(await f.snapshot()).values.hp,11)
})

test('a failed result cannot retry without the mandatory original-source authority port',options,async t=>{
  const f=await fixture(t,{omitPrivateOriginAuthority:true,receipt:()=>({state:'failed'})}),message=f.message()
  await f.handle(message)
  assert.equal(queueOf(await f.snapshot()).find(item=>item.userId==='alice').state,'failed')
  const count=privateAttempts(f).length
  await f.handle(f.message('.ember 投递 重试'),f.binding,f.rebuild())
  assert.equal(privateAttempts(f).length,count)
  assert.equal(slots(await f.snapshot()).values.hp,11)
})

test('failed private results cannot retry after their original source is recalled or binding revision changes, while cards survive',options,async t=>{
  for(const kind of ['recall','rebind']){
    const f=await fixture(t,{receipt:()=>({state:'failed'})}),message=f.message()
    await f.handle(message)
    const original=f.binding
    if(kind==='recall')await f.recall(message)
    else f.rebind()
    const attempts=privateAttempts(f).length
    await f.handle(f.message('.ember 投递 重试'),f.binding,f.rebuild())
    assert.equal(privateAttempts(f).length,attempts,kind)
    assert.equal(slots(await f.snapshot(original)).values.hp,11,kind)
    await f.handle(message,original)
    assert.equal(privateAttempts(f).length,attempts,`old source ${kind}`)
  }
})

test('retry authorization checks the original recipient current GM status and hidden capability',options,async t=>{
  const f=await fixture(t,{receipt:request=>request.effect.kind==='private'&&request.effect.recipientId==='bob'?{state:'failed'}:{state:'sent',messageId:'confirmed-first'}}),message=f.message()
  await f.handle(message)
  assert.equal(queueOf(await f.snapshot()).find(item=>item.userId==='bob').state,'failed')
  f.auth.revision='authority-two';f.auth.members.find(member=>member.id==='bob').permissions=['player']
  const count=privateAttempts(f).length
  await f.handle(f.message('.ember 投递 重试'))
  assert.equal(privateAttempts(f).length,count)
  assert.equal(queueOf(await f.snapshot()).find(item=>item.userId==='bob').state,'failed')
})

test('a late private acknowledgement cannot restore retryability or overwrite a newer card commit',options,async t=>{
  let release
  const f=await fixture(t,{deliveryTimeoutMs:100,ignoreGuard:true,receipt:request=>request.effect.kind==='private'?new Promise(resolve=>{release=resolve}):{state:'sent',messageId:'public-confirmed'}}),message=f.message()
  await f.handle(message)
  await f.handle(f.message('.ember 设 hp=7'))
  release({state:'sent',messageId:'late-private-native'})
  await delay(10)
  assert.equal(slots(await f.snapshot()).values.hp,7)
  assert.ok(queueOf(await f.snapshot()).every(item=>item.state==='unknown'))
  await f.handle(f.message('.ember 投递 重试'),f.binding,f.rebuild())
  assert.equal(privateAttempts(f).length,1)
  assert.equal(slots(await f.snapshot()).values.hp,7)
})

test('a snapshot CAS conflict during private settlement fences the source without overwriting a newer card or resending',options,async t=>{
  let changed=false
  const f=await fixture(t,{async beforeSettle(args,f){
    if(changed||args[3]?.state!=='sent')return
    const snapshot=await f.state.read(args[0])
    if(!queueOf(snapshot).length)return
    changed=true
    const next=structuredClone(snapshot.state)
    next.rules.packs[packId].players[JSON.stringify(['alice','默认'])].values.hp=6
    const source={messageId:'concurrent-card-source',authorId:'alice',occurredAt:1_800_000_001_000,sourceHash:digest('concurrent-card-source')}
    const begun=await f.state.begin(args[0],source)
    assert.equal(begun.kind,'started')
    assert.ok(await f.state.commit(args[0],begun.claim,{state:next,effects:[],event:[]}))
  }}),message=f.message()
  await f.handle(message)
  assert.equal(changed,true)
  assert.equal(slots(await f.snapshot()).values.hp,6)
  assert.equal((await f.operation(message)).state,'unknown')
  const count=privateAttempts(f).length
  await f.handle(message,f.binding,f.rebuild())
  await f.handle(f.message('.ember 投递 重试'))
  assert.equal(privateAttempts(f).length,count)
  assert.equal(slots(await f.snapshot()).values.hp,6)
})

test('a lost acknowledgement after atomic private settlement abandons remaining effects and cannot resend after restart',options,async t=>{
  const f=await fixture(t,{loseSettlementAcknowledgement:true}),message=f.message()
  await f.handle(message)
  assert.equal(privateAttempts(f).length,1)
  assert.equal((await f.operation(message)).state,'unknown')
  assert.equal(queueOf(await f.snapshot()).some(item=>item.userId==='alice'),false)
  assert.equal(queueOf(await f.snapshot()).find(item=>item.userId==='bob').state,'unknown')
  assert.equal(slots(await f.snapshot()).values.hp,11)
  await f.handle(message,f.binding,f.rebuild())
  await f.handle(f.message('.ember 投递 重试'))
  assert.equal(privateAttempts(f).length,1)
})

test('subject privacy cleanup finds old Agent output after rebind and repeated cleanup never touches the new Agent',options,async t=>{
  const f=await fixture(t,{receipt:()=>({state:'failed'})}),original=f.binding,first=f.message()
  await f.handle(first)
  const originalSnapshot=await f.snapshot(original),originalQueue=queueOf(originalSnapshot),originalBodies=[...originalQueue.map(item=>item.text),
    ...originalSnapshot.state.rules.packs[packId].group.audit.map(item=>item.output).filter(Boolean)]
  assert.ok(originalBodies.every(Boolean))
  f.rebind({agentId:'other',personaId:'other-persona',revision:'binding-two'})
  const second=f.message();await f.handle(second)
  const newAgent=await f.snapshot(),before=JSON.stringify(newAgent)
  const scope={account,agentId:original.agentId,subjectId:'bob'}
  await f.state.purgeSubject(scope)
  const scrubbed=await f.snapshot(original),raw=JSON.stringify(scrubbed)
  for(const body of originalBodies)assert.equal(raw.includes(JSON.stringify(body).slice(1,-1)),false)
  assert.equal(slots(scrubbed).values.hp,11,'the other member card is preserved')
  assert.equal(JSON.stringify(await f.snapshot()),before)
  const operation=await f.operation(first,original)
  assert.ok(operation===null||!['ready','pending'].includes(operation.state))
  if(operation)assert.equal('effects'in operation,false)
  await f.state.purgeSubject(scope)
  assert.equal(JSON.stringify(await f.snapshot()),before)
  const count=privateAttempts(f).length
  await f.handle(f.message('.ember 投递 重试'),original,f.rebuild())
  assert.equal(privateAttempts(f).length,count)
})
