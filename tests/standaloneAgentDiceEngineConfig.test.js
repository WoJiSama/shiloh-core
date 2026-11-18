import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import YAML from 'yaml'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {readStandaloneDiceEngine:read,createStandaloneDiceRuntime:create}=await load('bootstrap/standaloneDice.js')
const {createAgentBindingDirectory}=await load('modules/runtime/domain/agentBindings.js')
const sha=value=>createHash('sha256').update(value).digest('hex')
const clone=value=>structuredClone(value)
const account={platform:'fixture',namespace:'namespace-one',id:'bot-one'}
const pack=(changes={})=>({version:1,id:'heart-rules',name:'骰子配置测试',aliases:['heartdemo'],character:{fields:{agi:{type:'integer',default:6}}},commands:[{id:'strike',aliases:['strike'],output:'{actor} 刺击。'}],...changes})
const yamlInput=(value=pack(),changes={})=>{const source=typeof value==='string'?value:YAML.stringify(value);return {kind:'yaml',source,revision:'rules-one',sourceHash:sha(source),...changes}}
function fixture() {
  const binding={source:'configured',id:'binding-one',revision:'binding-revision-one',agentId:'agent-one',personaId:'persona-one',connectionId:'connection-one',target:{account:clone(account),kind:'group',id:'scene-one'}}
  const grant={binding:clone(binding),revision:'grant-one',actorId:'alice',permissions:['player','admin','delegate','hidden'],subjects:[{id:'bob',permissions:['player','admin']}]}
  return {bindings:[binding],dice:{enabled:true,maxDiceCount:40,maxDiceSides:10000,maxRounds:10,engine:{enabled:true,revision:'engine-one',deliveryTimeoutMs:1000,builtin:{allowHiddenRoll:true,templates:{roll:'{actor}: {result}'}},rulePackages:[yamlInput()],grants:[grant]}}}
}
function source(binding,actorId='alice') {
  return {version:1,conversation:clone(binding.target),sender:{...clone(binding.target.account),id:actorId},senderName:'仅作显示的群管理',messageId:'real-message-one',occurredAt:1_800_000_000_000,text:'.r 1d20',parts:[{kind:'text',text:'.r 1d20'}],mentions:[],directedToAccount:false,binding:clone(binding)}
}
const guard=()=>({signal:new AbortController().signal,isCurrent:()=>true,ensureCurrent:async()=>{}})
const frozen=value=>{if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);for(const item of Object.values(value))frozen(item)}}
const configured=f=>read(f.dice,f.bindings)

test('no engine and an explicitly disabled engine retain the legacy path without implicit grants',async()=>{
  assert.equal(read(undefined,[]),undefined)
  assert.equal(read({enabled:true,maxDiceCount:100,maxDiceSides:100000,maxRounds:20},[]),undefined)
  const legacy=await create(undefined,()=>true)
  assert.equal(legacy.diceEngine,undefined)
  assert.equal(await legacy.readDiceGrant({},guard()),undefined)
  const config=read({enabled:true,engine:{enabled:false}},[]),runtime=await create(config,()=>true)
  assert.equal(config.enabled,false)
  assert.deepEqual(config.grants,[])
  assert.equal(runtime.diceEngine.enabled,false)
  assert.equal(await runtime.readDiceGrant({},guard()),undefined)
})

test('both switches must be true and an enabled engine requires explicit grants',()=>{
  for(const enabled of [undefined,false]){
    const f=fixture();f.dice.enabled=enabled;f.dice.engine.grants=[]
    assert.equal(configured(f).enabled,false)
  }
  const f=fixture();delete f.dice.engine.grants
  assert.throws(()=>configured(f),/骰子/u)
  f.dice.engine.grants=[]
  assert.throws(()=>configured(f),/骰子/u)
  for(const value of [null,{},[],{enabled:true},{enabled:'true'},{enabled:true,roles:{admin:['alice']}}]){
    assert.throws(()=>read({enabled:true,engine:value},f.bindings))
  }
  assert.throws(()=>read({enabled:'true',engine:{enabled:false}},[]))
})

test('pure capture detaches and freezes builtin limits, inline YAML and exact grants',async()=>{
  const f=fixture(),config=configured(f),snapshot=JSON.stringify(config)
  frozen(config)
  assert.equal(config.builtin.maxDiceCount,40)
  assert.equal(config.builtin.maxDiceSides,10000)
  assert.equal(config.builtin.maxRounds,10)
  assert.equal(config.builtin.allowHiddenRoll,true)
  assert.notEqual(config.grants[0],f.dice.engine.grants[0])
  f.dice.engine.grants[0].permissions.push('master')
  f.dice.engine.grants[0].binding.target.account.namespace='mutated'
  f.dice.engine.builtin.templates.roll='mutated'
  f.dice.engine.rulePackages[0].source='mutated'
  assert.equal(JSON.stringify(config),snapshot)
  const runtime=await create(config,()=>true)
  frozen(runtime.diceEngine)
  assert.equal(runtime.diceEngine.enabled,true)
  assert.equal(runtime.diceEngine.revision,'engine-one')
  assert.equal(runtime.diceEngine.deliveryTimeoutMs,1000)
  assert.equal(runtime.diceEngine.rulePackages[0].kind,'yaml')
  assert.equal(runtime.diceEngine.rulePackages[0].id,'heart-rules')
  assert.equal(runtime.diceEngine.rulePackages[0].source,config.rulePackages[0].source)
  assert.equal(runtime.diceEngine.rulePackages[0].pack.character.fields.agi.default,6)
  assert.equal(await runtime.diceEngine.rulePackages[0].instantiate(()=>assert.fail('YAML compilation needs no entropy'),1),runtime.diceEngine.rulePackages[0].pack)
  assert.equal('grants'in runtime.diceEngine,false)
})

test('YAML bytes, hash, revision and schema are checked synchronously before startup',()=>{
  const first=yamlInput()
  const invalid=[{...first,source:first.source+'\n'},{...first,sourceHash:'0'.repeat(64)},{...first,sourceHash:first.sourceHash.toUpperCase()},
    {...first,revision:''},{...first,revision:' '},{...first,revision:'x'.repeat(257)},yamlInput('version: ['),yamlInput(pack({version:2})),
    yamlInput(pack({unknown:true})),yamlInput(pack({character:{fields:{bad:{type:'integer',default:0,formula:'1'}}}})),
    yamlInput(pack({commands:[{id:'execute',let:{value:'unapproved(1)'},output:'{let.value}'}]})),
    yamlInput('x'.repeat(65537))]
  for(const input of invalid){const f=fixture();f.dice.engine.rulePackages=[input];assert.throws(()=>configured(f))}
})

test('standalone packages never accept executable kinds, paths, URLs or runner/native authority fields',()=>{
  const first=yamlInput()
  for(const input of [{...first,kind:'js'},{...first,kind:'seal'},{...first,kind:'file'},
    {...first,path:'/tmp/rules.yaml'},{...first,url:'https://example.test/rules.yaml'},{...first,trustedPackage:{id:'heart-rules',revision:first.revision,sourceHash:first.sourceHash}},
    yamlInput('/tmp/rules.yaml'),yamlInput('https://example.test/rules.yaml'),yamlInput('file:///tmp/rules.yaml'),yamlInput('module.exports = {}')]){
    const f=fixture();f.dice.engine.rulePackages=[input];assert.throws(()=>configured(f))
  }
  for(const extra of [{scriptRunner:{}},{nativeRoles:{admin:['alice']}},{roles:{player:'everyone'}},{rulePackagePaths:['/tmp/rules.yaml']}]){
    const f=fixture();Object.assign(f.dice.engine,extra);assert.throws(()=>configured(f))
  }
})

test('pure package sets reject duplicate IDs and cross-package aliases before asynchronous compilation',()=>{
  for(const second of [yamlInput(),yamlInput(pack({id:'thread-rules',aliases:['HEARTDEMO']})),yamlInput(pack({id:'thread-rules',aliases:['heart-rules']}))]){
    const f=fixture();f.dice.engine.rulePackages.push(second);assert.throws(()=>configured(f))
  }
  const f=fixture();f.dice.engine.rulePackages.push(yamlInput(pack({id:'thread-rules',aliases:['thread']})))
  assert.equal(configured(f).rulePackages.length,2)
})

test('builtin and delivery validation runs during configuration capture using the existing builtin contract',()=>{
  const bad=[{maxDiceCount:0},{maxDiceCount:10001},{maxDiceSides:1},{maxRounds:1001},{enabled:'true'},{allowHiddenRoll:'yes'},
    {timeZone:'invalid/timezone'},{defaultRule:'custom-unapproved'},{templates:{roll:'x'.repeat(8001)}},{unknown:true}]
  for(const builtin of bad){const f=fixture();f.dice.engine.builtin=builtin;assert.throws(()=>configured(f))}
  for(const deliveryTimeoutMs of [0,99,120001,NaN,1.5,'1000']){const f=fixture();f.dice.engine.deliveryTimeoutMs=deliveryTimeoutMs;assert.throws(()=>configured(f))}
  for(const revision of ['', '0',' ',128]){const f=fixture();f.dice.engine.revision=revision;assert.throws(()=>configured(f))}
  const f=fixture();f.dice.engine.builtin.maxDiceCount=25
  assert.equal(configured(f).builtin.maxDiceCount,25,'an explicit builtin limit overrides the legacy fallback')
})

test('grants require full configured binding equality across every ownership dimension',()=>{
  const changes={source:b=>{b.source='legacy'},id:b=>{b.id='binding-two'},revision:b=>{b.revision='other'},agentId:b=>{b.agentId='other'},personaId:b=>{b.personaId='other'},
    connectionId:b=>{b.connectionId='other'},kind:b=>{b.target.kind='private'},scene:b=>{b.target.id='other'},platform:b=>{b.target.account.platform='other'},namespace:b=>{b.target.account.namespace='other'},account:b=>{b.target.account.id='other'}}
  for(const [name,change]of Object.entries(changes)){const f=fixture();change(f.dice.engine.grants[0].binding);assert.throws(()=>configured(f),undefined,name)}
  for(const field of ['id','revision','agentId','personaId','connectionId','target']){const f=fixture();delete f.dice.engine.grants[0].binding[field];assert.throws(()=>configured(f),undefined,field)}
  const f=fixture();f.bindings=[]
  assert.throws(()=>configured(f))
  const privateBinding=clone(f.dice.engine.grants[0].binding);privateBinding.target.kind='private';privateBinding.id='other-binding'
  f.bindings=[clone(f.dice.engine.grants[0].binding),privateBinding]
  assert.ok(configured(f),'other valid configured conversation kinds do not grant dice access')
})

test('actor and subject grants are explicit, unique and follow the authorization validator',()=>{
  const changes={noPlayer:g=>{g.permissions=['admin']},unknown:g=>{g.permissions=['player','owner']},duplicatePermission:g=>{g.permissions=['player','player']},
    zeroActor:g=>{g.actorId='0'},botActor:g=>{g.actorId='bot-one'},blankActor:g=>{g.actorId=' '},zeroRevision:g=>{g.revision='0'},zeroBinding:g=>{g.binding.id='0'},
    zeroSubject:g=>{g.subjects[0].id='0'},actorSubject:g=>{g.subjects[0].id='alice'},duplicateSubject:g=>{g.subjects.push(clone(g.subjects[0]))},
    unknownSubject:g=>{g.subjects[0].permissions=['player','owner']},duplicateSubjectPermission:g=>{g.subjects[0].permissions=['player','player']},
    wildcard:g=>{g.actorId='*';g.permissions=['all']},nativeRole:g=>{g.role='admin'}}
  for(const [name,change]of Object.entries(changes)){const f=fixture();change(f.dice.engine.grants[0]);assert.throws(()=>configured(f),undefined,name)}
  const duplicate=fixture();duplicate.dice.engine.grants.push(clone(duplicate.dice.engine.grants[0]));assert.throws(()=>configured(duplicate))
  const f=fixture();delete f.dice.engine.grants[0].subjects
  assert.deepEqual(configured(f).grants[0].permissions,['player','admin','delegate','hidden'])
})

test('real directory snapshots retain long binding labels and exact fresh grant matching',async()=>{
  const target={account:{platform:'fixture',namespace:'n'.repeat(100),id:'b'.repeat(100)},kind:'group',id:'g'.repeat(100)}
  const directory=createAgentBindingDirectory({version:1,agents:[{id:'agent-one',personaId:'persona-one'}],
    connections:[{id:'connection-one',platform:target.account.platform,namespace:target.account.namespace,accountId:target.account.id}],
    bindings:[{connectionId:'connection-one',kind:'group',conversationId:target.id,agentId:'agent-one'}]},'revision-'.repeat(20))
  const f=fixture(),binding=directory.resolve(target)
  assert.ok(binding.id.length>128);assert.ok(binding.revision.length>128)
  f.bindings=directory.listBindings();f.dice.engine.grants[0].binding=clone(binding)
  const runtime=await create(configured(f),()=>true)
  assert.equal((await runtime.readDiceGrant({binding,source:source(binding)},guard())).binding.id,binding.id)
  const changed=clone(binding);changed.revision+='changed'
  assert.equal(await runtime.readDiceGrant({binding:changed,source:source(changed)},guard()),undefined)
  for(const invalidLabel of ['', '0',' spaced ','label\nline','x'.repeat(4097)]){
    const bad=clone(f);bad.bindings[0].id=invalidLabel;bad.dice.engine.grants[0].binding.id=invalidLabel
    assert.throws(()=>configured(bad))
  }
})

test('configuration refuses proxies, getters, sparse arrays and unknown fields without invoking caller code',()=>{
  let calls=0
  const trap=()=>{calls++;throw Error('caller code must not run')}
  const paths=[[],['engine'],['engine','builtin'],['engine','builtin','templates'],['engine','rulePackages'],['engine','rulePackages',0],
    ['engine','grants'],['engine','grants',0],['engine','grants',0,'binding'],['engine','grants',0,'binding','target'],['engine','grants',0,'binding','target','account'],
    ['engine','grants',0,'permissions'],['engine','grants',0,'subjects'],['engine','grants',0,'subjects',0],['engine','grants',0,'subjects',0,'permissions']]
  for(const path of paths){
    const f=fixture(),parent=path.slice(0,-1).reduce((v,k)=>v[k],f.dice),key=path.at(-1),value=path.length?parent[key]:f.dice
    const proxy=new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap})
    if(path.length){parent[key]=proxy;assert.throws(()=>configured(f))}else assert.throws(()=>read(proxy,f.bindings))
  }
  for(const path of [['engine','enabled'],['engine','rulePackages',0,'source'],['engine','grants',0,'actorId'],['engine','builtin','templates','roll']]){
    const f=fixture(),parent=path.slice(0,-1).reduce((v,k)=>v[k],f.dice)
    Object.defineProperty(parent,path.at(-1),{enumerable:true,get:trap});assert.throws(()=>configured(f))
  }
  for(const path of [['engine','rulePackages'],['engine','grants'],['engine','grants',0,'permissions'],['engine','grants',0,'subjects']]){
    const f=fixture(),array=path.reduce((v,k)=>v[k],f.dice);delete array[0];assert.throws(()=>configured(f))
  }
  for(const bindings of [new Proxy([],{get:trap,ownKeys:trap,getPrototypeOf:trap}),[new Proxy(fixture().bindings[0],{get:trap,ownKeys:trap,getPrototypeOf:trap})]])assert.throws(()=>read(fixture().dice,bindings))
  assert.equal(calls,0)
})

test('readDiceGrant matches the original actor, complete source and full binding on each request',async()=>{
  const f=fixture(),runtime=await create(configured(f),()=>true),binding=f.bindings[0],request={binding,source:source(binding)}
  const result=await runtime.readDiceGrant(request,guard())
  assert.equal(result.actorId,'alice');assert.equal(result.revision,'grant-one');frozen(result)
  assert.equal(await runtime.readDiceGrant({binding,source:source(binding,'bob')},guard()),undefined,'subject permissions do not create an actor grant')
  const changes={bindingRevision:r=>{r.binding.revision='other'},bindingAgent:r=>{r.binding.agentId='other'},bindingAccount:r=>{r.binding.target.account.id='other'},
    sourceNamespace:r=>{r.source.sender.namespace='other'},sourcePlatform:r=>{r.source.sender.platform='other'},sourceScene:r=>{r.source.conversation.id='other'},
    sourceAccount:r=>{r.source.conversation.account.id='other'},sourceBinding:r=>{r.source.binding.revision='other'},missingId:r=>{delete r.source.messageId},zeroId:r=>{r.source.messageId='0'},
    sourceText:r=>{r.source.text='altered'},sourceImage:r=>{r.source.parts.push({kind:'image',resource:{kind:'url',value:'https://example.test/a.png'}})},nativeRole:r=>{r.source.role='admin'}}
  for(const [name,change]of Object.entries(changes)){const request={binding:clone(binding),source:source(binding)};change(request);assert.equal(await runtime.readDiceGrant(request,guard()),undefined,name)}
})

test('grant lookup rechecks host and turn guards after awaits and preserves captured original source',async()=>{
  const f=fixture();let hostCurrent=true
  const runtime=await create(configured(f),()=>hostCurrent),request={binding:f.bindings[0],source:source(f.bindings[0])}
  hostCurrent=false;assert.equal(await runtime.readDiceGrant(request,guard()),undefined)
  hostCurrent=true
  let turnCurrent=true
  const currentGuard={...guard(),isCurrent:()=>turnCurrent,ensureCurrent:async()=>{turnCurrent=false}}
  assert.equal(await runtime.readDiceGrant(request,currentGuard),undefined)
  assert.equal(await runtime.readDiceGrant(request,{...guard(),ensureCurrent:async()=>{hostCurrent=false}}),undefined)
  hostCurrent=true
  const controller=new AbortController();controller.abort()
  assert.equal(await runtime.readDiceGrant(request,{...guard(),signal:controller.signal}),undefined)
  assert.equal(await runtime.readDiceGrant(request,{...guard(),ensureCurrent:async()=>{throw Error('stale')}}),undefined)
  const captured=await runtime.readDiceGrant(request,{...guard(),ensureCurrent:async()=>{request.source.sender.id='bob';request.binding.revision='changed-during-await'}})
  assert.equal(captured.actorId,'alice','the grant stays bound to the captured original source')
})

test('runtime refuses active source data and independent actors need independent explicit grants',async()=>{
  const f=fixture(),bob={...clone(f.dice.engine.grants[0]),actorId:'bob',permissions:['player'],subjects:[]}
  f.dice.engine.grants.push(bob)
  const runtime=await create(configured(f),()=>true),binding=f.bindings[0]
  assert.deepEqual((await runtime.readDiceGrant({binding,source:source(binding,'bob')},guard())).permissions,['player'])
  assert.equal(await runtime.readDiceGrant({binding,source:source(binding,'carol')},guard()),undefined)
  let calls=0
  const trap=()=>{calls++;throw Error('must not run')}
  const request={binding,source:source(binding)}
  Object.defineProperty(request.source,'sender',{enumerable:true,get:trap})
  assert.equal(await runtime.readDiceGrant(request,guard()),undefined)
  assert.equal(await runtime.readDiceGrant(new Proxy({binding,source:source(binding)},{get:trap,ownKeys:trap,getPrototypeOf:trap}),guard()),undefined)
  assert.equal(calls,0)
})

test('startup requires a reader-owned immutable configuration and current epoch on both sides of compilation',async()=>{
  const config=configured(fixture())
  await assert.rejects(create(clone(config),()=>true),/骰子/u)
  await assert.rejects(create(config,()=>false),/骰子/u)
  let checks=0
  await assert.rejects(create(config,()=>++checks===1),/骰子/u)
  await assert.rejects(create(config,()=>{throw Error('unavailable')}),/骰子/u)
  assert.throws(()=>{config.grants[0].permissions.push('master')},TypeError)
})
