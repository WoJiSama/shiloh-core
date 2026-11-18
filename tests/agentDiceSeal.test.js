import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {inspectAgentDiceSeal,runAgentDiceSeal}=await load('modules/dice/infrastructure/agentDiceSeal.js')
// These compatibility assertions require an actual host-verified OS memory quota.
// A Darwin diagnostic or a fake callback cannot satisfy the production contract.
const scriptRunner=undefined
const options={skip:'pending: no host-verified runner with an OS hard total-process memory quota',timeout:15000}
const at=1_800_000_000_000
const text=result=>result.effects.filter(effect=>effect.kind==='public').map(effect=>effect.text).join('\n')
const source=(body,{allowDelegate=false,prefix='',async=false}={})=>`${prefix}\nconst input='package-local-input',storage='package-local-storage';
const ext=seal.ext.new('compat','tests','1');seal.ext.register(ext);
const command=seal.ext.newCmdItemInfo();command.allowDelegate=${allowDelegate};command.help='兼容帮助：probe [参数]';
command.solve=${async?'async ':''}(ctx,msg,args)=>{${body}};
ext.cmdMap.probe=command;ext.cmdMap['测试']=command;`
function fixture(changes={}){
 const cards={alice:{key:'active-one',name:'Alice Card',attrs:{力量:60},skills:{侦查:50}},bob:{key:'active-bob',name:'Bob Card',attrs:{力量:40},skills:{护甲:2}}}
 const players={legacy:{values:{力量:999}}},state={version:1,storage:{kept:'unchanged'}}
 const context={source:{messageId:'native-source',authorId:'alice',at},actor:{id:'alice',name:'Alice'},members:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'bot',name:'Dice Bot'}],groupId:'scene',botUserId:'bot',mentions:[],logActive:false,
  allows:(permission,id='alice')=>permission==='player'||id==='alice'&&['delegate','card'].includes(permission)}
 const f={cards,players,state,context,...changes}
 f.run=(code,extra={})=>runAgentDiceSeal({source:code,packId:'seal-fixture',command:'probe',args:'',state:f.state,players:f.players,cards:f.cards,context:f.context,random:()=>0.5,...(scriptRunner?{scriptRunner}:{}),...extra})
 return f
}

test('Seal inspect and help support top-level command, input and storage constants without entering solve',options,async()=>{
 const code=source("throw Error('help must not enter solve')"),commands=await inspectAgentDiceSeal(code,'seal-fixture',scriptRunner)
 assert.deepEqual(commands,['probe','测试']);assert.equal(Object.isFrozen(commands),true)
 const f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state})
 for(const args of ['help','帮助','-h'])assert.equal(text(await f.run(code,{args})),'兼容帮助：probe [参数]')
 assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
 const missing=await f.run(code,{command:'missing'});assert.equal(missing.matched,false);assert.deepEqual(missing.effects,[])
})

test('Seal numeric vars write only the supplied active card while member/group storage persists and temp vars reset',options,async()=>{
 const f=fixture(),code=source(`if(args.getArgN(1)==='read'){seal.replyToSender(ctx,msg,JSON.stringify({temp:seal.vars.intGet(ctx,'$ttemp'),charges:seal.vars.intGet(ctx,'$mcharges'),note:seal.vars.strGet(ctx,'$mnote'),round:seal.vars.intGet(ctx,'$ground'),saved:ext.storageGet('saved')}));return seal.ext.newCmdExecuteResult(true)}
const old=seal.vars.intGet(ctx,'力量');seal.vars.intSet(ctx,'力量',old[0]+2);seal.vars.intSet(ctx,'护甲',3);
seal.vars.intSet(ctx,'$mcharges',seal.vars.intGet(ctx,'$mcharges')[0]+1);seal.vars.strSet(ctx,'$mnote','memo');seal.vars.intSet(ctx,'$ground',5);seal.vars.intSet(ctx,'$ttemp',9);ext.storageSet('saved','one');
seal.applyPlayerGroupCardByTemplate(ctx,'{$t玩家_RAW} 力量{力量}');seal.replyToSender(ctx,msg,seal.format(ctx,'{力量}/{侦查}'));return seal.ext.newCmdExecuteResult(true)`)
 const stateBefore=structuredClone(f.state),playersBefore=structuredClone(f.players),bobBefore=structuredClone(f.cards.bob),result=await f.run(code)
 assert.equal(result.matched,true);assert.equal(f.cards.alice.key,'active-one');assert.equal(f.cards.alice.attrs.力量,62);assert.equal(f.cards.alice.skills.护甲,3);assert.equal(f.cards.alice.skills.侦查,50)
 assert.deepEqual(f.cards.bob,bobBefore);assert.deepEqual(f.state,stateBefore);assert.deepEqual(f.players,playersBefore)
 assert.equal(text(result),'62/50');assert.deepEqual(result.effects.find(effect=>effect.kind==='card'),{kind:'card',subjectId:'alice',name:'Alice 力量62'})
 assert.equal(result.state.storage.__scoped['__m:alice:charges'],1);assert.equal(result.state.storage.__scoped['__m:alice:note'],'memo');assert.equal(result.state.storage.__scoped['__g:round'],5);assert.equal(result.state.storage['compat:saved'],'one')
 const read=await f.run(code,{args:'read',state:result.state})
 assert.deepEqual(JSON.parse(text(read)),{temp:[0,false],charges:[1,true],note:['memo',true],round:[5,true],saved:'one'})
})

test('captured Date.now, new Date and random tape reproduce the same Seal output in independent real children',options,async()=>{
 const code=source(`seal.replyToSender(ctx,msg,JSON.stringify({capturedNow,capturedDate,capturedRandom,now:Date.now(),date:+new Date(),random:Math.random(),roll:seal.format(ctx,'{1d6}')}));return seal.ext.newCmdExecuteResult(true)`,
  {prefix:'const capturedNow=Date.now(),capturedDate=+new Date(),capturedRandom=Math.random();'})
 const makeRandom=()=>{let index=0;return()=>[0.1,0.8,0.7][index++]??0.5}
 const first=await fixture().run(code,{random:makeRandom()}),second=await fixture().run(code,{random:makeRandom()})
 assert.deepEqual(first,second);assert.deepEqual(JSON.parse(text(first)),{capturedNow:at,capturedDate:at,capturedRandom:0.1,now:at,date:at,random:0.8,roll:'5'})
})

test('Seal receives privilegeLevel zero, an empty message and no native event or host callbacks even under a broad host ceiling',options,async()=>{
 let calls=0
 const f=fixture();f.context.allows=()=>true;f.context.hostCallback=()=>{calls++;return 'host'};f.context.__event={secret:'native-must-stay-host-side'}
 const code=source(`seal.replyToSender(ctx,msg,JSON.stringify({privilege:ctx.privilegeLevel,messageKeys:Object.keys(msg),event:typeof msg.__event,ctxEvent:typeof ctx.__event,host:typeof ctx.hostCallback,require:typeof require,process:typeof process,fetch:typeof fetch,notice:ctx.notice('noop'),actor:ctx.player.userId,group:ctx.group.groupId}));return seal.ext.newCmdExecuteResult(true)`)
 const result=await f.run(code)
 assert.deepEqual(JSON.parse(text(result)),{privilege:0,messageKeys:[],event:'undefined',ctxEvent:'undefined',host:'undefined',require:'undefined',process:'undefined',fetch:'undefined',notice:true,actor:'alice',group:'scene'})
 assert.equal(calls,0);assert.ok(!JSON.stringify(result).includes('native-must-stay-host-side'))
})

test('fresh exact delegate and card capabilities are both required, and rejection preserves all supplied inputs',options,async()=>{
 const code=source(`seal.vars.intSet(ctx,'力量',1);ext.storageSet('draft','must roll back');const target=seal.getCtxProxyFirst(ctx,args);seal.vars.intSet(target,'力量',2);seal.applyPlayerGroupCardByTemplate(target,'{$t玩家_RAW} {力量}');seal.replyToSender(ctx,msg,'must not escape');return seal.ext.newCmdExecuteResult(true)`,{allowDelegate:true})
 for(const allowed of [[],['delegate']]){
  const f=fixture();f.context.mentions=[{id:'bob'}];f.context.allows=(permission,id='alice')=>permission==='player'||id==='bob'&&allowed.includes(permission)
  const before=structuredClone({cards:f.cards,players:f.players,state:f.state})
  await assert.rejects(f.run(code));assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
 }
 const f=fixture();f.context.mentions=[{id:'bob'}];f.context.allows=(permission,id='alice')=>permission==='player'||id==='bob'&&['delegate','card'].includes(permission)
 const result=await f.run(code);assert.equal(f.cards.alice.attrs.力量,1);assert.equal(f.cards.bob.attrs.力量,2)
 assert.equal(result.effects.find(effect=>effect.kind==='card').subjectId,'bob');assert.match(text(result),/^由Alice代骰：\n/u)
})

test('allowDelegate rejects another member when disabled but an authorized bot mention always stays on the invoker',options,async()=>{
 const body=`const target=seal.getCtxProxyFirst(ctx,args);seal.vars.intSet(target,'力量',seal.vars.intGet(target,'力量')[0]+1);seal.replyToSender(ctx,msg,target.player.userId);return seal.ext.newCmdExecuteResult(true)`
 const denied=fixture();denied.context.mentions=[{id:'bob'}];denied.context.allows=()=>true;const before=structuredClone(denied.cards)
 await assert.rejects(denied.run(source(body)));assert.deepEqual(denied.cards,before)
 for(const allowDelegate of [false,true]){
  const f=fixture();f.context.mentions=[{id:'bot'}];f.context.allows=permission=>permission==='player'
  const result=await f.run(source(body,{allowDelegate}));assert.equal(text(result),'alice');assert.equal(f.cards.alice.attrs.力量,61);assert.equal(f.cards.bob.attrs.力量,40)
 }
})

test('a literal false solve result rolls back card, scoped storage and draft replies, while solved false remains a matched result',options,async()=>{
 const body=`seal.vars.intSet(ctx,'力量',1);seal.vars.intSet(ctx,'$mcharges',2);ext.storageSet('saved','draft');seal.replyToSender(ctx,msg,'draft');`
 const f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state}),result=await f.run(source(body+'return false'))
 assert.equal(result.matched,false);assert.deepEqual(result.effects,[]);assert.deepEqual(result.state,f.state);assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
 const solved=await f.run(source(body+'return seal.ext.newCmdExecuteResult(false)'))
 assert.equal(solved.matched,true);assert.equal(f.cards.alice.attrs.力量,1);assert.equal(text(solved),'draft')
})

test('async resolved solve drains its microtasks; rejected or unresolved solves discard all draft state',options,async()=>{
 const f=fixture(),code=source(`await Promise.resolve();seal.vars.intSet(ctx,'力量',63);seal.replyToSender(ctx,msg,'async complete');return seal.ext.newCmdExecuteResult(true)`,{async:true})
 const result=await f.run(code);assert.equal(f.cards.alice.attrs.力量,63);assert.equal(text(result),'async complete')
 for(const ending of ["throw Error('private script error')",'return await new Promise(()=>{})']){
  const before=structuredClone({cards:f.cards,players:f.players,state:f.state})
  await assert.rejects(f.run(source("seal.vars.intSet(ctx,'力量',1);ext.storageSet('saved','draft');seal.replyToSender(ctx,msg,'draft');"+ending,{async:true})),error=>/海豹规则执行未确认/u.test(error.message)&&!error.message.includes('private script error'))
  assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
 }
})

test('timers, automatic hooks, require, network and unsupported Seal APIs fail closed with no partial input writes',options,async()=>{
 for(const action of ["setTimeout(()=>{},1)","setInterval(()=>{},1)","require('node:fs')","fetch('http://127.0.0.1:9')",'seal.ext.registerStringInterceptor()',"seal.st.load('x')","seal.deck.draw(ctx,'x')",'seal.cud.run()', 'seal.tsl.run()', 'seal.ban.add()', 'seal.censor.check()']){
  const f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state}),code=source(`seal.vars.intSet(ctx,'力量',1);ext.storageSet('draft','write');seal.replyToSender(ctx,msg,'draft');${action};return seal.ext.newCmdExecuteResult(true)`)
  await assert.rejects(f.run(code));assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
 }
})

test('a nonnumeric active-card write rejects the whole Seal update instead of retaining an earlier numeric write',options,async()=>{
 const f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state})
 const code=source("seal.vars.intSet(ctx,'力量',1);seal.vars.strSet(ctx,'title','not a numeric card field');return seal.ext.newCmdExecuteResult(true)")
 await assert.rejects(f.run(code),/海豹人物卡数值无效/u)
 assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
})

test('Seal inspect and solve are unavailable by default without a host-verified constrained runner and preserve their inputs',async()=>{
 const code=source("seal.vars.intSet(ctx,'力量',1);ext.storageSet('draft','write');seal.replyToSender(ctx,msg,'draft');return seal.ext.newCmdExecuteResult(true)")
 const f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state})
 await assert.rejects(inspectAgentDiceSeal(code,'seal-fixture'),/骰子脚本隔离环境不可用/u)
 await assert.rejects(f.run(code),/骰子脚本隔离环境不可用/u)
 assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
})

test('unsupported automatic hooks are rejected before any constrained runner can be requested',async()=>{
 for(const hook of ['onNotCommandReceived','onMessageReceived','onCommandReceived','onGroupMemberIncrease']){
  const code=source('return true',{prefix:`const extWithHook={${hook}(){}};`})
  await assert.rejects(inspectAgentDiceSeal(code,'seal-fixture'),/不支持海豹异步或自动事件hook/u)
  await assert.rejects(fixture().run(code),/不支持海豹异步或自动事件hook/u)
 }
})

test('structurally invalid Seal runners fail closed without invoking execute callbacks or mutating caller data',async()=>{
 let calls=0
 const never=()=>{calls++;throw Error('a structurally invalid runner must never execute')}
 const code=source('return seal.ext.newCmdExecuteResult(true)'),f=fixture(),before=structuredClone({cards:f.cards,players:f.players,state:f.state})
 for(const runner of [{},{definitionId:'invalid-test-only',limits:{},isolation:{},execute:never,executeSync:never}]){
  await assert.rejects(inspectAgentDiceSeal(code,'seal-fixture',runner),/骰子脚本隔离环境不可用/u)
  await assert.rejects(f.run(code,{scriptRunner:runner}),/骰子脚本隔离环境不可用/u)
 }
 assert.equal(calls,0);assert.deepEqual({cards:f.cards,players:f.players,state:f.state},before)
})
