import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDiceBuiltin}=await load('modules/dice/infrastructure/agentDiceBuiltin.js')
const source={messageId:'native-human-message',authorId:'alice',at:1_800_000_000_000}
const context=(extra={})=>({source,actor:{id:'alice',name:'Alice'},members:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'carol',name:'Carol'}],mentions:[],groupId:'room',botUserId:'bot',allows:permission=>permission==='player',...extra})
const publicText=result=>result.effects.filter(effect=>effect.kind==='public').map(effect=>effect.text).join('\n')
const card=(state,id='alice')=>state.users[id].cards[state.users[id].activeCard]
const randomForD100=value=>{const digits=value===100?[0,0]:[value%10,Math.floor(value/10)];let index=0;return()=>digits[index++%2]/10+0.001}
const inputState=()=>({version:1,users:{alice:{activeCard:'default',cards:{default:{name:'Investigator',attrs:{STR:50,CON:50,SIZ:60,DEX:70,POW:60,EDU:70,SAN:60},skills:{侦查:60,斗殴:50,克苏鲁神话:10}}}},bob:{activeCard:'default',cards:{default:{name:'Other',attrs:{SAN:70,DEX:40},skills:{侦查:80,斗殴:50}}}}},scene:{}})
async function run(command,{state=inputState(),ctx=context(),random=()=>0.501,config={}}={}){return createAgentDiceBuiltin(config).evaluate({state,command,context:ctx,random})}

test('the owner-local transition has a stable effective-config fingerprint and preserves input drafts',async()=>{
 const first=createAgentDiceBuiltin({maxRounds:20,defaultRule:'0'}),second=createAgentDiceBuiltin({defaultRule:'0',maxRounds:20})
 assert.equal(first.definitionId,second.definitionId);assert.notEqual(first.definitionId,createAgentDiceBuiltin({defaultRule:'1'}).definitionId)
 assert.match(first.definitionId,/^dice:builtin:v1:[a-f0-9]{64}$/u)
 assert.equal(first.isCandidate('.st侦查60'),true);assert.equal(first.isCandidate('random chat'),false)
 assert.equal(createAgentDiceBuiltin({maxDiceCount:1}).isCandidate('.r 1d6'),true)
 assert.match(publicText(await run('.ra 侦查',{config:{maxDiceCount:1},random:randomForD100(20)})),/20\/60/u)
 const state=inputState(),before=structuredClone(state),result=await run('.st 侦查 75',{state})
 assert.deepEqual(state,before);assert.equal(card(result.state).skills.侦查,75)
 assert.equal(Object.isFrozen(result.state.users.alice.cards.default.skills),true)
 assert.equal(result.events[0].kind,'card_change');assert.deepEqual(result.events[0].source,source)
 assert.equal(result.events[0].actorId,'alice');assert.deepEqual(result.events[0].subjectIds,['alice'])
 assert.ok(!JSON.stringify(result.events[0]).includes('75'))
 assert.equal((await run('normal chat')).matched,false)
})

test('imported decks resolve nested hidden groups with the current player and bounded weights',async()=>{
 const config={decks:{祝福:['::2::{player}抽到{_符文}'],'_符文':['太阳']}}
 assert.match(publicText(await run('.draw 祝福',{config})),/Alice抽到太阳/u)
 assert.match(publicText(await run('.draw',{config})),/可用牌堆：祝福/u)
 assert.doesNotMatch(publicText(await run('.draw',{config})),/_符文/u)
 assert.match(publicText(await run('.draw _符文',{config})),/牌堆未找到/u)
 assert.throws(()=>createAgentDiceBuiltin({decks:{祝福:['::1000000000::太阳']}}),/牌堆配置无效/u)
})

test('character management preserves aliases, compact fields, delta expressions, hidden fields and per-card lock semantics',async()=>{
 let result=await run('.pcnew hero');assert.equal(result.state.users.alice.activeCard,'hero')
 result=await run('.st 敏捷0力量-1本能0生命6',{state:result.state});assert.equal(card(result.state).attrs.STR,-1);assert.equal(card(result.state).attrs.DEX,0);assert.equal(card(result.state).skills.生命,6)
 result=await run('.st SAN=60 侦查=60',{state:result.state})
 result=await run('.st 侦查+1d6',{state:result.state,random:()=>0});assert.equal(card(result.state).skills.侦查,61)
 result=await run('.st hide 侦查',{state:result.state});assert.ok(!publicText(await run('.st show',{state:result.state})).includes('侦查:61'))
 assert.match(publicText(await run('.st showall',{state:result.state})),/侦查:61/u)
 result=await run('.pc tag brave investigator',{state:result.state});assert.deepEqual(card(result.state).tags,['brave','investigator'])
 result=await run('.pc lock',{state:result.state});assert.equal(card(result.state).locked,true)
 const locked=await run('.st SAN=1',{state:result.state});assert.equal(card(locked.state).attrs.SAN,60);assert.match(publicText(locked),/已锁定/u)
 const growth=await run('.en 侦查',{state:result.state,random:()=>0.99});assert.equal(card(growth.state).skills.侦查,61)
 result=await run('.pc unlock',{state:result.state});result=await run('.pc rename hero renamed',{state:result.state});assert.equal(result.state.users.alice.activeCard,'renamed')
 result=await run('.pc save second',{state:result.state});result=await run('.pc load renamed',{state:result.state});assert.equal(result.state.users.alice.activeCard,'renamed')
 result=await run('.st del 侦查',{state:result.state});assert.equal(card(result.state).skills.侦查,undefined)
 result=await run('.st clear',{state:result.state});assert.deepEqual(card(result.state).attrs,{})
})

test('delegation checks fresh member and separate authority while preserving the true invoker in events',async()=>{
 const state=inputState()
 await assert.rejects(run('.st SAN=55',{state,ctx:context({mentions:['bob']})}),/代骰授权/u)
 await assert.rejects(run('.ra 侦查',{ctx:context({mentions:['departed'],allows:()=>true})}),/代骰授权/u)
 const ctx=context({mentions:['bob'],allows:(permission,id)=>permission==='player'||permission==='delegate'&&id==='bob'})
 const result=await run('.st SAN=55',{state,ctx})
 assert.equal(card(result.state,'bob').attrs.SAN,55);assert.equal(card(result.state).attrs.SAN,60)
 assert.equal(result.events[0].actorId,'alice');assert.deepEqual(result.events[0].subjectIds,['alice','bob'])
 const check=await run('.ra 侦查',{state:result.state,ctx,random:randomForD100(40)})
 assert.match(publicText(check),/Bob.*40\/80/u)
 assert.ok(!JSON.stringify(ctx).includes('isMaster'))
 await assert.rejects(run('.st SAN=55',{ctx:context({mentions:['bob'],isMaster:true})}),/代骰授权/u)
})

test('check aliases, difficulty, offsets, default skills, rounds, bonus and penalty dice retain their meanings',async()=>{
 const noState={version:1,users:{},scene:{}}
 assert.match(publicText(await run('.ra 神秘学',{state:noState,random:randomForD100(5)})),/5\/5/u)
 assert.match(publicText(await run('.ra 偵查+10',{random:randomForD100(50)})),/50\/70/u)
 assert.match(publicText(await run('.ra 闪避',{random:randomForD100(20)})),/20\/35/u)
 assert.match(publicText(await run('.ra 理智上限',{random:randomForD100(50)})),/50\/89/u)
 assert.match(publicText(await run('.ra 不存在技能',{random:randomForD100(50)})),/未录卡值/u)
 assert.equal(publicText(await run('.ra3#侦查',{random:()=>0.5})).split('\n').length,3)
 let index=0;const values=[0.501,0.901,0.101]
 assert.match(publicText(await run('.rab 侦查 60',{random:()=>values[index++%3]})),/奖励骰.*=15\/60/u)
 index=0;assert.match(publicText(await run('.rap 侦查 60',{random:()=>values[index++%3]})),/惩罚骰.*=95\/60/u)
 await assert.rejects(run('.rab99999 侦查 60'),/数量限制/u)
})

test('hidden checks return only a private result plus fixed public placeholder and never archive hidden content',async()=>{
 await assert.rejects(run('.rh 1d100'),/暗骰未获得/u)
 const result=await run('.rah 侦查 60',{random:randomForD100(20),config:{allowHiddenRoll:true,templates:{hiddenPublic:'LEAK {result}'}},ctx:context({allows:permission=>['player','hidden'].includes(permission)})})
 assert.equal(result.effects[0].kind,'private');assert.equal(result.effects[0].recipientId,'alice');assert.match(result.effects[0].text,/20\/60/u)
 assert.match(publicText(result),/结果仅私聊发送/u);assert.ok(!publicText(result).includes('20'));assert.ok(!publicText(result).includes('LEAK'))
 assert.ok(!JSON.stringify(result.events).includes('20/60'));assert.equal(result.events.filter(event=>event.kind==='dice_result').length,0)
 assert.ok(result.effects.filter(effect=>effect.kind==='public').every(effect=>!('eventIndex'in effect)))
})

test('SAN writes only card-backed values, tracks daily losses, and fumble loss uses the maximum without extra random draws',async()=>{
 const result=await run('.sc 1/1d6',{random:randomForD100(100)})
 assert.equal(card(result.state).attrs.SAN,54);assert.match(publicText(result),/理智损失 6，剩余 54/u)
 assert.deepEqual(Object.values(card(result.state).sanLossLog),[{loss:6,baseline:60}])
 const next=await run('.sc 1/1d6 --half --cap=2',{state:result.state,random:randomForD100(100)});assert.equal(card(next.state).attrs.SAN,52)
 const temporary=await run('.sc 1/1d6 70',{random:randomForD100(100)});assert.equal(card(temporary.state).attrs.SAN,60)
 const ctx=context({mentions:['bob'],allows:permission=>['player','delegate'].includes(permission)})
 const other=await run('.sc 1/1d6',{ctx,random:randomForD100(100)});assert.equal(card(other.state,'bob').attrs.SAN,64)
})

test('growth preserves card-backed, explicit temporary and batch growth plus custom failure gain semantics',async()=>{
 let count=0;const rng=()=>[0.901,0.901,0.401][count++%3]
 const result=await run('.en 侦查',{random:rng});assert.equal(card(result.state).skills.侦查,65)
 count=0;const temporary=await run('.en 侦查 60',{random:rng});assert.equal(card(temporary.state).skills.侦查,60);assert.match(publicText(temporary),/临时技能值/u)
 const failed=await run('.en 侦查 +1/2',{random:()=>0.101});assert.equal(card(failed.state).skills.侦查,62)
 const batch=await run('.en 侦查 斗殴',{random:()=>0.99});assert.equal(card(batch.state).skills.侦查,70);assert.equal(card(batch.state).skills.斗殴,60)
})

test('DND utility state preserves slots, cast, rest, buffs and death-save natural-one/twenty behavior',async()=>{
 let result=await run('.buff blessed');assert.deepEqual(card(result.state).dnd.buffs,['blessed'])
 result=await run('.ss 1 2/4',{state:result.state});assert.deepEqual(card(result.state).dnd.spellSlots['1'],{current:2,max:4})
 result=await run('.cast 1',{state:result.state});assert.equal(card(result.state).dnd.spellSlots['1'].current,1)
 result=await run('.ds',{state:result.state,random:()=>0});assert.equal(card(result.state).dnd.deathSaves.failure,2)
 result=await run('.ds',{state:result.state,random:()=>0.999});assert.equal(card(result.state).dnd.deathSaves.success,3)
 result=await run('.longrest',{state:result.state});assert.deepEqual(card(result.state).dnd.deathSaves,{success:0,failure:0});assert.equal(card(result.state).dnd.spellSlots['1'].current,4)
 const ctx=context({allows:permission=>['player','admin'].includes(permission)})
 result=await run('.set dnd',{state:result.state,ctx})
 const check=await run('.rc 敏捷优势+2',{state:result.state,random:()=>0.5});assert.match(publicText(check),/优势.*=13/u)
 assert.match(publicText(await run('.dnd 2',{random:()=>0})),/力量 3/u)
 assert.match(publicText(await run('.db 70 70')),/体格 1，伤害加值 \+1D4/u)
})

test('group changes require current admin approval and names become explicit queued card effects',async()=>{
 const denied=await run('.setcoc 3');assert.equal(denied.state.scene.rule,undefined)
 const ctx=context({allows:permission=>['player','admin','card'].includes(permission)})
 let result=await run('.setcoc 3',{ctx});assert.equal(result.state.scene.rule,'3')
 result=await run('.st fmt SAN:{san}',{state:result.state,ctx});assert.equal(result.state.scene.stFmt,'SAN:{san}')
 result=await run('.sn on',{state:result.state,ctx});assert.equal(result.state.scene.autoCardNames.alice.enabled,true)
 assert.deepEqual(result.effects[0],{kind:'card',subjectId:'alice',name:'Investigator'})
 result=await run('.pc new next',{state:result.state,ctx});assert.deepEqual(result.effects[0],{kind:'card',subjectId:'alice',name:'next'})
 result=await run('.sn off',{state:result.state,ctx});assert.equal(result.state.scene.autoCardNames.alice.enabled,false)
 assert.ok(!JSON.stringify(result.effects).includes('sendApi'))
})

test('initiative, observation, team selection and opposed checks remain deterministic owner-local state transitions',async()=>{
 let result=await run('.ri +3',{random:()=>0.5});assert.equal(result.state.scene.initiative[0].value,14)
 result=await run('.init next',{state:result.state});assert.equal(result.state.scene.initiativeTurn.round,1)
 result=await run('.obon',{state:result.state});assert.deepEqual(result.state.scene.observers,['alice'])
 const silent=await run('.ra 侦查',{state:result.state});assert.deepEqual(silent.effects,[])
 result=await run('.oboff',{state:result.state});assert.deepEqual(result.state.scene.observers,[])
 const ctx=context({mentions:['bob','carol'],allows:permission=>['player','admin','delegate'].includes(permission)})
 result=await run('.team investigators add',{state:result.state,ctx});assert.deepEqual(result.state.scene.teams.investigators,['bob','carol'])
 const selected=await run('.team investigators draw 1',{state:result.state,ctx:context(),random:()=>0});assert.match(publicText(selected),/@Bob/u)
 const opposed=await run('.rav 斗殴 50 vs 斗殴 50',{ctx:context({mentions:['bob'],allows:()=>true}),random:randomForD100(20)});assert.match(publicText(opposed),/结果：平手/u)
})

test('all entropy and time-dependent helpers use injected source inputs, and malformed state cannot run accessors',async()=>{
 for(const command of ['.r 2d6','.who one two three','.rsr a b c','.ww 2','.dx 2 10','.ek 1d6','.ekgen','.coc 2','.name en 2','.namednd 2','.ti','.li','.jrrp']){
  const first=await run(command,{random:()=>0.5}),second=await run(command,{random:()=>0.5})
  assert.equal(first.matched,true,command)
  assert.deepEqual(first,second,command)
 }
 let getters=0
 const state=inputState();Object.defineProperty(state.users.alice,'nickname',{get(){getters++;return 'never'}})
 await assert.rejects(run('.st show',{state}),/访问器/u);assert.equal(getters,0)
 await assert.rejects(run('.r 1d6',{random:()=>1}),/随机源无效/u)
 await assert.rejects(run('.pc new __proto__'),/字段无效/u)
 await assert.rejects(run('.st',{ctx:context({source:{...source,messageId:'0'}})}),/来源或成员快照/u)
 await assert.rejects(run('.st',{ctx:context({source:{...source,authorId:'bob'}})}),/来源或成员快照/u)
 await assert.rejects(run('.st',{state:{version:1,users:{},groups:{}}}),/状态版本/u)
 await assert.rejects(run('.st',{ctx:context({source:{...source,authorId:'__proto__'},actor:{id:'__proto__',name:'bad'}})}),/来源或成员快照/u)
})
