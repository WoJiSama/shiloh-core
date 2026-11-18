import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import YAML from 'yaml'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {createAgentDiceRules,settleAgentDiceRuleDelivery}=await load('modules/dice/infrastructure/agentDiceRules.js')
const {compileAgentDiceRulePackage}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const examples=fileURLToPath(new URL('../docs/dice-rules/examples/',import.meta.url))
const teamSource=fs.readFileSync(path.join(examples,'team-session.yaml'),'utf8')
const hash=source=>createHash('sha256').update(source).digest('hex')
const publicText=result=>result.effects.filter(effect=>effect.kind==='public').map(effect=>effect.text).join('\n')
const privateEffects=result=>result.effects.filter(effect=>effect.kind==='private')
const slot=(id,key='card-one')=>JSON.stringify([id,key])

async function compile(source=teamSource,revision='one') {
  return await compileAgentDiceRulePackage({kind:'yaml',source,revision,sourceHash:hash(source)})
}
async function executable(kind,source,id) {
  const revision='test-one',sourceHash=hash(source)
  return await compileAgentDiceRulePackage({kind,source,revision,sourceHash,trustedPackage:{id,revision,sourceHash}})
}
async function fixture({source=teamSource,additional=[],random=()=>0.5}={}) {
  const packages=[await compile(source),...await Promise.all(additional.map(source=>compile(source)))]
  const engine=createAgentDiceRules({packages})
  let state=null,cards={
    alice:{key:'card-one',name:'爱丽丝卡',attrs:{力量:60},skills:{侦查:50}},
    bob:{key:'card-one',name:'鲍勃卡',attrs:{敏捷:55},skills:{}},
    keeper:{key:'card-one',name:'主持人卡',attrs:{},skills:{}},
  },sequence=0,randomCalls=0
  const members=[{id:'alice',name:'爱丽丝'},{id:'bob',name:'鲍勃'},{id:'keeper',name:'主持人'}]
  const context=(id='alice',extra={})=>({source:{messageId:`real-message-${++sequence}`,authorId:id,at:1_800_000_000_000+sequence},
    actor:{id,name:members.find(member=>member.id===id)?.name??id},members,groupId:'owner-scene',logActive:false,
    allows:(permission,subjectId=id)=>permission==='player'||subjectId==='keeper'&&['gm','admin'].includes(permission),...extra})
  return {engine,packages,members,context,
    get state(){return state},set state(value){state=value},get cards(){return cards},set cards(value){cards=value},get randomCalls(){return randomCalls},
    async run(command,id='alice',extra={}) {
      const ctx=context(id,extra),visibleCards=Object.fromEntries(Object.entries(cards).filter(([id])=>ctx.members.some(member=>member.id===id)))
      const result=await engine.evaluate({state,command,context:ctx,cards:visibleCards,random:()=>{randomCalls++;return random()}})
      if(result.matched){state=result.state;cards=result.cards??cards}
      return {...result,source:ctx.source}
    },
  }
}

test('compiled configured packages have stable fingerprints and recognize prefixes without rolling or creating legacy state',async()=>{
  const f=await fixture(),same=await fixture()
  assert.equal(f.engine.definitionId,same.engine.definitionId)
  assert.equal(f.engine.isCandidate('.ember check'),true)
  assert.equal(f.engine.isCandidate('。余烬 卡'),true)
  assert.equal(f.engine.isCandidate('.ember-team check'),true)
  assert.equal(f.engine.isCandidate('.embered check'),false)
  assert.equal(f.engine.isCandidate('.r 1d100'),false)
  assert.equal(f.randomCalls,0)
  const help=await f.run('.ember')
  assert.match(publicText(help),/人物卡|团务/u)
  assert.equal(f.randomCalls,0)
  const unknown=await f.engine.evaluate({state:null,command:'.other check',context:f.context(),random:()=>assert.fail('unmatched cannot roll')})
  assert.equal(unknown.matched,false)
  assert.deepEqual(unknown.effects,[])
  for(const state of [{users:{},groups:{}},{version:1,packs:[]},{version:1,packs:{bad:{players:{}}}}]){
    await assert.rejects(f.engine.evaluate({state,command:'.ember check',context:f.context(),random:()=>0.5}),/持久状态无效/u)
  }
})

test('public YAML rolls, weighted tables and branches preserve readable results with actual source audit provenance',async()=>{
  const f=await fixture({random:()=>0.75}),result=await f.run('.ember check')
  assert.match(publicText(result),/爱丽丝卡检定：1D20\[16\].*成功/u)
  assert.equal(f.randomCalls,2,'one d20 and one table draw are evaluated once')
  const audit=f.state.packs['ember-team'].group.audit.at(-1)
  assert.deepEqual(audit.source,result.source)
  assert.equal(audit.rolls.main.total,16)
  assert.equal(audit.result,'成功')
  const ruleEvent=result.events.find(event=>event.kind==='rule_event')
  assert.ok(ruleEvent)
  assert.deepEqual(ruleEvent.source,result.source)
  assert.equal(result.effects.find(effect=>effect.kind==='public').eventIndex,result.events.indexOf(ruleEvent))
  assert.equal('messageId'in result.effects[0],false)
})

test('YAML character state follows the active builtin card slot while builtin attrs and skills stay separate',async()=>{
  const f=await fixture()
  await f.run('.ember 设 hp=7')
  assert.equal(f.state.packs['ember-team'].players[slot('alice')].values.hp,7)
  assert.deepEqual({...f.cards.alice.attrs},{力量:60})
  assert.deepEqual({...f.cards.alice.skills},{侦查:50})
  f.cards.alice={...f.cards.alice,key:'card-two',name:'第二张卡'}
  assert.match(publicText(await f.run('.ember 查 hp')),/12/u)
  await f.run('.ember 设 hp=4')
  assert.equal(f.state.packs['ember-team'].players[slot('alice','card-two')].values.hp,4)
  f.cards.alice={...f.cards.alice,key:'card-one',name:'爱丽丝卡'}
  assert.match(publicText(await f.run('.ember 查 hp')),/7/u)
  assert.match(publicText(await f.run('.ember 卡')),/爱丽丝卡/u)
})

test('card displays and direct field reads compute derived values from the learned ability state',async()=>{
  const pack=YAML.parse(teamSource)
  pack.character.fields.mastery={type:'integer',formula:'abilities.fireball.rank'}
  const f=await fixture({source:YAML.stringify(pack)})
  await f.run('.ember 技能 学习 user:alice fireball 2','keeper')
  assert.match(publicText(await f.run('.ember 卡')),/mastery\(mastery\)：2/u)
  assert.match(publicText(await f.run('.ember 查 mastery')),/mastery\(mastery\)=2/u)
})

test('trusted per-package GM roles honor the host ceiling and never become admin, master or another package GM',async()=>{
  const sibling=YAML.parse(teamSource);sibling.id='sibling-rules';sibling.aliases=['sibling']
  const f=await fixture({additional:[YAML.stringify(sibling)]})
  await assert.rejects(f.run('.ember npc 创建 slime 史莱姆'),/需要GM/u)
  await f.run('.ember 权限 设置 gm user:alice','keeper')
  assert.equal(f.state.packs['ember-team'].group.roles.alice,'gm')
  await f.run('.ember npc 创建 slime 史莱姆')
  assert.equal(f.state.packs['ember-team'].group.npcs.slime.name,'史莱姆')
  await assert.rejects(f.run('.ember 权限 设置 gm user:bob'),/需要管理员/u)
  await assert.rejects(f.run('.sibling npc 创建 slime 史莱姆'),/需要GM/u)
  const before=JSON.stringify(f.state)
  await assert.rejects(f.run('.ember npc 创建 denied 不允许','alice',{allows:()=>false}),/来源或成员授权无效/u)
  assert.equal(JSON.stringify(f.state),before)
})

test('member/NPC target resolution requires fresh unambiguous members and verified reply authors',async()=>{
  const f=await fixture()
  await f.run('.ember 攻击 user:bob 2')
  assert.equal(f.state.packs['ember-team'].players[slot('bob')].values.hp,10)
  const replay=JSON.stringify(f.state)
  await assert.rejects(f.run('.ember 攻击 user:bob 2','alice',{members:f.members.filter(member=>member.id!=='bob')}),/不属于当前已验证成员/u)
  assert.equal(JSON.stringify(f.state),replay)
  await assert.rejects(f.run('.ember 攻击 reply 1'),/已验证引用/u)
  await f.run('.ember 攻击 reply 1','alice',{replyAuthorId:'bob'})
  assert.equal(f.state.packs['ember-team'].players[slot('bob')].values.hp,9)
  const ambiguous=f.members.map(member=>member.id==='bob'?{...member,name:'爱丽丝'}:member)
  await assert.rejects(f.run('.ember 攻击 爱丽丝 1','alice',{members:ambiguous}),/歧义/u)
})

test('failed rule actions preserve the original state and cards without partially committing an earlier subtraction',async()=>{
  const f=await fixture()
  await f.run('.ember 设 user:bob hp=2','keeper')
  const state=structuredClone(f.state),cards=structuredClone(f.cards)
  await assert.rejects(f.run('.ember 攻击 user:bob 3'),/不能小于/u)
  assert.deepEqual(JSON.parse(JSON.stringify(f.state)),JSON.parse(JSON.stringify(state)))
  assert.deepEqual(JSON.parse(JSON.stringify(f.cards)),JSON.parse(JSON.stringify(cards)))
})

test('custom command error replies roll back nested equipment mutations and newly initialized cards',async()=>{
  const pack=YAML.parse(teamSource)
  pack.commands.push({id:'broken',aliases:['broken'],actions:[{op:'equip',item:'wand'},{op:'subtract',field:'hp',value:99}],output:'不能提交',error_output:'失败：{message}'})
  const source=YAML.stringify(pack),f=await fixture({source})
  await f.run('.ember 物品 添加 user:alice shield 1','keeper')
  await f.run('.ember 物品 装备 user:alice shield','keeper')
  await f.run('.ember 物品 添加 user:alice wand 1','keeper')
  const before=JSON.stringify(f.state),cards=JSON.stringify(f.cards)
  const failed=await f.run('.ember broken')
  assert.match(publicText(failed),/失败：.*不能小于/u)
  assert.equal(JSON.stringify(f.state),before)
  assert.equal(JSON.stringify(f.cards),cards)
  assert.deepEqual(failed.events,[])
  const fresh=await fixture({source})
  delete fresh.cards.alice
  const empty=await fresh.run('.ember broken')
  assert.match(publicText(empty),/失败：/u)
  assert.deepEqual(Object.keys(fresh.state.packs),[])
  assert.equal('alice'in fresh.cards,false)
})

test('YAML lifecycle preserves NPC statuses, cooldowns, shared resources, equipment and exact turn events',async()=>{
  const f=await fixture(),gm=command=>f.run(command,'keeper')
  await gm('.ember npc 创建 slime 史莱姆')
  await gm('.ember 状态 添加 npc:slime poison 2 1')
  await gm('.ember 状态 添加 npc:slime guarding 1 1')
  await gm('.ember 物品 添加 npc:slime shield 1')
  await gm('.ember 物品 装备 npc:slime shield')
  await gm('.ember 技能 学习 npc:slime fireball 1')
  await gm('.ember 技能 使用 npc:slime fireball')
  await gm('.ember 技能 学习 npc:slime rally 1')
  await gm('.ember 技能 使用 npc:slime rally')
  await assert.rejects(gm('.ember 技能 使用 npc:slime rally'),/冷却/u)
  const started=await gm('.ember 团务 开始 可信团务')
  const ownershipId=started.effects[0].ownershipId
  assert.match(ownershipId,/^[a-f0-9]{64}$/u)
  assert.deepEqual(started.effects[0],{kind:'log',operation:'start',ownershipId,title:'可信团务'})
  assert.equal(f.state.packs['ember-team'].group.session.logOwnershipId,ownershipId)
  await gm('.ember npc 创建 scout 斥候')
  await gm('.ember 先攻 添加 npc:slime 10')
  await gm('.ember 先攻 添加 npc:scout 5')
  await gm('.ember 先攻 开始')
  await assert.rejects(gm('.ember 先攻 开始'),/重复/u)
  await gm('.ember 先攻 下一回合')
  await gm('.ember 先攻 下一回合')
  const group=f.state.packs['ember-team'].group,slime=group.npcs.slime.ruleData
  assert.equal(slime.values.hp,11)
  assert.equal(slime.values.armor,0,'guarding on_expire restores armor')
  assert.equal(slime.statuses.guarding,undefined)
  assert.equal(slime.statuses.poison.duration,1)
  assert.equal(slime.values.mp,4)
  assert.equal(slime.inventory.shield.equipped,true)
  assert.equal(slime.abilities.fireball.cooldown,0)
  assert.equal(slime.abilities.fireball.uses,1)
  assert.equal(group.group.values.supplies,4)
  assert.equal(group.group.values.threat,3,'session_start + round_start for first and second round')
  assert.equal(group.session.round,2)
  const ended=await gm('.ember 团务 结束')
  assert.deepEqual(ended.effects[0],{kind:'log',operation:'stop',ownershipId})
  assert.equal(f.state.packs['ember-team'].group.group.values.threat,0)
  assert.equal(f.state.packs['ember-team'].group.sessions.length,1)
})

test('campaign registration, chapters, notes, snapshots and pause restore state without assuming manual log ownership',async()=>{
  const f=await fixture(),gm=command=>f.run(command,'keeper',{logActive:true})
  await gm('.ember 战役 创建 ash 灰烬战役')
  await f.run('.ember 战役 登记 self 调查员')
  await gm('.ember 战役 章节 开始 第一章')
  await gm('.ember 战役 记录 clue 钥匙在门后')
  const started=await gm('.ember 团务 开始 第一场')
  assert.equal(started.effects.some(effect=>effect.kind==='log'),false)
  await f.run('.ember 设 hp=8')
  await gm('.ember 团务 快照 门前')
  await f.run('.ember 设 hp=5')
  await assert.rejects(gm('.ember 团务 回退 1'),/必须先暂停/u)
  await gm('.ember 团务 暂停')
  await gm('.ember 团务 回退 1')
  assert.equal(f.state.packs['ember-team'].players[slot('alice')].values.hp,8)
  const ended=await gm('.ember 团务 结束')
  assert.equal(ended.effects.some(effect=>effect.kind==='log'),false)
  const campaign=f.state.packs['ember-team'].group.campaigns.ash
  assert.equal(campaign.members.alice.character,'调查员')
  assert.equal(campaign.chapters[0].title,'第一章')
  assert.equal(campaign.records[0].content,'钥匙在门后')
  assert.equal(campaign.sessions.length,1)
  await gm('.ember 战役 章节 结束')
  await gm('.ember 战役 归档 ash')
  await gm('.ember 战役 恢复 ash')
  assert.equal(f.state.packs['ember-team'].group.campaigns.ash.status,'active')
})

test('hidden rolls and secret fields reach only authorized private recipients and never public effects or event bodies',async()=>{
  const pack=YAML.parse(teamSource)
  pack.commands.find(command=>command.id==='secret_search').branches=[{result:'机密分支结论',tags:['机密分支标签']}]
  const f=await fixture({source:YAML.stringify(pack),random:()=>0.1}),hidden=await f.run('.ember secret')
  assert.equal(privateEffects(hidden).length,1)
  assert.equal(privateEffects(hidden)[0].recipientId,'keeper')
  assert.match(privateEffects(hidden)[0].text,/1D100\[11\]/u)
  assert.doesNotMatch(publicText(hidden),/1D100|\[11\]/u)
  assert.doesNotMatch(JSON.stringify(hidden.events),/1D100|\[11\]/u)
  assert.doesNotMatch(JSON.stringify(hidden.events),/机密分支/u)
  assert.equal(hidden.events.find(event=>event.kind==='rule_event').visibility,'private')
  assert.equal(hidden.effects[0].kind,'private')
  await assert.rejects(f.run('.ember 查 secret_note'),/仅 GM/u)
  const secret=await f.run('.ember 查 secret_note','keeper')
  assert.match(privateEffects(secret)[0].text,/未记录/u)
  assert.doesNotMatch(publicText(secret),/未记录/u)
  const audit=await f.run('.ember 审计 20','keeper')
  assert.equal(audit.effects[0].kind,'private')
  assert.doesNotMatch(publicText(audit),/1D100|骰点/u)
})

test('no-recipient private commands roll back and unknown private deliveries cannot replay on a new source',async()=>{
  const f=await fixture(),members=f.members.filter(member=>member.id!=='keeper')
  await assert.rejects(f.run('.ember secret','alice',{members}),/没有找到可接收/u)
  assert.equal(f.state,null)
  const hidden=await f.run('.ember secret'),item=privateEffects(hidden)[0]
  assert.equal(f.state.packs['ember-team'].group.privateDeliveries[0].state,'unknown')
  assert.equal(privateEffects(await f.run('.ember 投递 重试','keeper')).length,0)
  f.state=settleAgentDiceRuleDelivery(f.state,{packId:item.packId,deliveryId:item.deliveryId,state:'failed'})
  const retry=await f.run('.ember 投递 重试','keeper')
  assert.equal(privateEffects(retry)[0].deliveryId,item.deliveryId)
  assert.equal(f.state.packs['ember-team'].group.privateDeliveries[0].state,'unknown')
  assert.equal(privateEffects(await f.run('.ember 投递 重试','keeper')).length,0)
  f.state=settleAgentDiceRuleDelivery(f.state,{packId:item.packId,deliveryId:item.deliveryId,state:'sent'})
  assert.deepEqual(f.state.packs['ember-team'].group.privateDeliveries,[])
})

test('private retries require current membership and preserve the original recipient permission level',async()=>{
  const f=await fixture(),hidden=await f.run('.ember secret'),item=privateEffects(hidden)[0]
  f.state=settleAgentDiceRuleDelivery(f.state,{packId:item.packId,deliveryId:item.deliveryId,state:'failed'})
  const noLongerGm=(permission,subjectId)=>permission==='player'||subjectId==='alice'&&['gm','admin'].includes(permission)
  const blocked=await f.run('.ember 投递 重试','alice',{allows:noLongerGm})
  assert.deepEqual(privateEffects(blocked),[])
  assert.equal(f.state.packs['ember-team'].group.privateDeliveries[0].state,'failed')
  const absent=await f.run('.ember 投递 重试','alice',{allows:noLongerGm,members:f.members.filter(member=>member.id!=='keeper')})
  assert.deepEqual(privateEffects(absent),[])
  const selfPack=YAML.parse(teamSource)
  selfPack.commands.find(command=>command.id==='secret_search').visibility='private'
  const self=await fixture({source:YAML.stringify(selfPack)}),own=privateEffects(await self.run('.ember secret'))[0]
  self.state=settleAgentDiceRuleDelivery(self.state,{packId:own.packId,deliveryId:own.deliveryId,state:'failed'})
  assert.equal(privateEffects(await self.run('.ember 投递 重试','keeper'))[0].recipientId,'alice')
})

test('current package migrations preserve renamed stored fields and missing reverse migration fails before mutation',async()=>{
  const original=YAML.parse(teamSource),next=structuredClone(original)
  next.compatibility.package_version='3.0.0'
  next.compatibility.migrations=[{from:'2.0.0',to:'3.0.0',rename_fields:{hp:'vitality'},add_defaults:{hp:12}}]
  next.character.fields.vitality={type:'integer',default:12,min:0,max:12}
  const f=await fixture()
  await f.run('.ember 设 hp=6')
  const nextEngine=createAgentDiceRules({packages:[await compile(YAML.stringify(next),'three')]})
  const migrated=await nextEngine.evaluate({state:f.state,cards:f.cards,command:'.ember 查 vitality',context:f.context(),random:()=>0.5})
  assert.match(publicText(migrated),/6/u)
  await nextEngine.evaluate({state:f.state,cards:f.cards,command:'.ember check',context:f.context(),random:()=>0.5})
  // A normal command commits the version migration; merely reading never silently rebinds another slot.
  const committed=await nextEngine.evaluate({state:f.state,cards:f.cards,command:'.ember 设 hp=10',context:f.context(),random:()=>0.5})
  assert.equal(committed.state.packs['ember-team'].players[slot('alice')]._packageVersion,'3.0.0')
  const before=JSON.stringify(committed.state)
  await assert.rejects(f.engine.evaluate({state:committed.state,cards:f.cards,command:'.ember check',context:f.context(),random:()=>0.5}),/没有从该版本出发的迁移/u)
  assert.equal(JSON.stringify(committed.state),before)
})

test('all documented YAML packages compile, route help and execute their parameter-free first command',async()=>{
  for(const file of fs.readdirSync(examples).filter(file=>file.endsWith('.yaml'))){
    const source=fs.readFileSync(path.join(examples,file),'utf8'),f=await fixture({source}),pack=f.packages[0].pack
    assert.ok(f.engine.isCandidate(`.${pack.id}`),file)
    assert.ok(publicText(await f.run(`.${pack.id}`)),file)
    const first=pack.commands[0]
    if(!(first.arguments??[]).some(argument=>argument.required)){
      const result=await f.run(`.${pack.id} ${first.aliases[0]}`)
      assert.equal(result.matched,true,file)
      assert.ok(result.effects.length,file)
    }
  }
})

test('exact executable package trust is insufficient without a qualified total-memory-isolated runner',async()=>{
  const pack=YAML.parse(teamSource)
  pack.id='js-fixture'
  const js=`module.exports=${JSON.stringify(pack)}`
  const seal="const ext=seal.ext.new('compat','tests','1');seal.ext.register(ext);ext.cmdMap.compat={solve(){return seal.ext.newCmdExecuteResult(true)}}"
  await assert.rejects(executable('js',js,pack.id),/隔离|runner|不支持/u)
  await assert.rejects(executable('seal',seal,'seal-fixture'),/隔离|runner|不支持/u)
})

test('authorized JS formulas execute through the isolated package callback with deterministic neutral state',{skip:'total-memory-isolated runner unavailable'},async()=>{
  const pack=YAML.parse(teamSource)
  pack.id='js-fixture';pack.aliases=['jsfixture']
  pack.character.fields.bonus={type:'integer',formula:'score(attr.hp, 2)'}
  pack.commands=[{id:'score',aliases:['score'],let:{computed:'score(attr.hp, 3)'},output:'{derived.bonus}/{let.computed}'}]
  const source=`module.exports={...${JSON.stringify(pack)},functions:{score(args){return Number(args[0])+Number(args[1])}}}`
  const compiled=await executable('js',source,pack.id),engine=createAgentDiceRules({packages:[compiled]}),f=await fixture()
  const result=await engine.evaluate({state:null,command:'.jsfixture score',context:f.context(),cards:f.cards,random:()=>assert.fail('pure custom functions cannot consume DSL randomness')})
  assert.equal(publicText(result),'14/15')
  assert.equal(result.state.packs[pack.id].players[slot('alice')].values.hp,12)
  assert.equal(result.events.find(event=>event.kind==='rule_event').source.messageId,'real-message-1')
})

test('Seal compatibility writes current builtin cards and scoped storage without contaminating YAML card slots',{skip:'total-memory-isolated runner unavailable'},async()=>{
  const source=`const ext=seal.ext.new('compat','tests','1');seal.ext.register(ext);
const command=seal.ext.newCmdItemInfo();command.allowDelegate=true;command.help='兼容帮助';
command.solve=(ctx,msg,args)=>{const target=seal.getCtxProxyFirst(ctx,args),old=seal.vars.intGet(target,'力量')[0];
seal.vars.intSet(target,'力量',old+2);seal.vars.intSet(target,'护甲',3);
const n=seal.vars.intGet(ctx,'$mcharges')[0]+1;seal.vars.intSet(ctx,'$mcharges',n);
seal.applyPlayerGroupCardByTemplate(target,'{$t玩家_RAW} {力量}');seal.replyToSender(ctx,msg,'次数='+n);return seal.ext.newCmdExecuteResult(true)};
ext.cmdMap.compat=command;`
  const compiled=await executable('seal',source,'seal-fixture'),engine=createAgentDiceRules({packages:[compiled]}),f=await fixture()
  const context=f.context('alice',{allows:()=>true}),result=await engine.evaluate({state:null,command:'.compat',context,cards:f.cards,random:()=>0.5})
  assert.match(publicText(result),/次数=1/u)
  assert.equal(result.cards.alice.attrs.力量,62)
  assert.equal(result.cards.alice.skills.护甲,3)
  assert.equal(result.cards.alice.key,'card-one')
  assert.deepEqual({...result.state.packs['seal-fixture'].players},{})
  assert.equal(result.events.filter(event=>event.kind==='card_change').length,1)
  assert.ok(result.effects.some(effect=>effect.kind==='card'&&effect.subjectId==='alice'))
  const next=await engine.evaluate({state:result.state,command:'.compat',context:f.context('alice',{allows:()=>true}),cards:result.cards,random:()=>0.5})
  assert.match(publicText(next),/次数=2/u)
  assert.equal(next.cards.alice.attrs.力量,64)
  const before=JSON.stringify(next.state),cards=JSON.stringify(next.cards)
  await assert.rejects(engine.evaluate({state:next.state,command:'.compat',context:f.context('alice',{mentions:[{id:'bob'}]}),cards:next.cards,random:()=>0.5}))
  assert.equal(JSON.stringify(next.state),before)
  assert.equal(JSON.stringify(next.cards),cards)
})
