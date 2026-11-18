import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const [{readStandaloneDeferredActionsConfig},
  {createAgentBindingDirectory,agentBindingIdentity,agentConversationKey}]=await Promise.all([
  load('bootstrap/standaloneDeferredActions.js'),load('modules/runtime/domain/agentBindings.js'),
])
const account={platform:'qq',namespace:'global',id:'200'},target={account,kind:'group',id:'20'}
const directory=createAgentBindingDirectory({version:1,agents:[{id:'daily',personaId:'default'}],
  connections:[{id:'qq-main',platform:'qq',namespace:'global',accountId:'200'}],
  bindings:[{connectionId:'qq-main',kind:'group',conversationId:'20',agentId:'daily'}]},'revision')
const binding=directory.resolve(target)
function rule(extra={}) {
  return {id:'self-poke',revision:'revision-2',bindingIdentity:agentBindingIdentity(binding),scopeKey:agentConversationKey(binding),
    creatorIds:['creator:fixed'],tool:'pokeTool',executor:'builtin',definitionId:'poke-deferred-v1',maxDelayMs:86_400_000,...extra}
}
function approval(extra={}) {
  return {id:'legacy-reminder:1',sourceHash:'a'.repeat(64),authorizedBy:'operator:fixed',at:1_800_000_000_000,...extra}
}
const read=input=>readStandaloneDeferredActionsConfig(input)
function rejected(input,path='tools.deferredActions') {
  assert.throws(()=>read(input),error=>error instanceof Error&&error.message.startsWith(path)&&error.message.endsWith(' 配置无效'))
}

test('missing configuration and explicitly empty grants are deeply frozen and disabled by default',()=>{
  for(const input of [undefined,{}, {enabled:false},{rules:[]},{migrationApprovals:[]}]) {
    const config=read(input)
    assert.deepEqual(config,{enabled:false,rules:[],migrationApprovals:[]})
    assert.equal(Object.isFrozen(config),true);assert.equal(Object.isFrozen(config.rules),true)
    assert.equal(Object.isFrozen(config.migrationApprovals),true)
  }
  assert.deepEqual(read({enabled:true,rules:[]}),{enabled:true,rules:[],migrationApprovals:[]})
})

test('exact rule fields survive, the execution window defaults to five minutes and all layers are copied/frozen',()=>{
  const original=rule(),input={enabled:true,rules:[original]}
  const config=read(input)
  assert.deepEqual(config,{enabled:true,rules:[{...original,executionWindowMs:300_000}],migrationApprovals:[]})
  assert.equal(Object.isFrozen(config),true);assert.equal(Object.isFrozen(config.rules),true)
  assert.equal(Object.isFrozen(config.rules[0]),true);assert.equal(Object.isFrozen(config.rules[0].creatorIds),true)
  original.creatorIds.push('later-creator');original.tool='changed'
  assert.deepEqual(config.rules[0].creatorIds,['creator:fixed']);assert.equal(config.rules[0].tool,'pokeTool')
  assert.throws(()=>{config.enabled=false},TypeError)
  assert.throws(()=>{config.rules[0].creatorIds.push('another')},TypeError)
  const noPrototype=Object.assign(Object.create(null),{enabled:true,rules:[Object.assign(Object.create(null),rule())]})
  assert.equal(read(noPrototype).rules.length,1)
})

test('type, count and numeric bounds are strict without coercion, truncation or dropped invalid rows',()=>{
  for(const input of [null,true,false,1,'true',[],new Date(),{unknown:true},{enabled:null},{enabled:1},{enabled:'false'},
    {enabled:undefined},{rules:undefined},{rules:null},{rules:{}},{rules:'[]'},
    {rules:Array.from({length:129},(_,index)=>rule({id:`rule-${index}`,creatorIds:[`creator:${index}`]}))},
    {rules:[rule(),null]},{enabled:false,rules:[rule({maxDelayMs:'1000'})]}])rejected(input)
  for(const [field,invalidValues] of Object.entries({
    id:['',null,1,'x'.repeat(129),'has space'],revision:['','  ',null,1,'x'.repeat(257)],
    tool:['','has space','1invalid',1,'x'.repeat(129)],executor:['qq',true,null],
    definitionId:['','  ',true,'x'.repeat(513)],
    maxDelayMs:[undefined,'1000',999,365*86_400_000+1,NaN,Infinity,1000.5],
    executionWindowMs:[undefined,'1000',999,86_400_001,NaN,Infinity,1000.5],
    creatorIds:[[],['duplicate','duplicate'],[' invalid'],[''],[1],Array.from({length:129},(_,i)=>`creator:${i}`)],
  }))for(const value of invalidValues)rejected({rules:[rule({[field]:value})]},`tools.deferredActions.rules[0].${field}`)
  for(const maximum of [1000,365*86_400_000])assert.equal(read({rules:[rule({maxDelayMs:maximum})]}).rules[0].maxDelayMs,maximum)
  for(const window of [1000,86_400_000])assert.equal(read({rules:[rule({executionWindowMs:window})]}).rules[0].executionWindowMs,window)
  assert.equal(read({rules:[rule({creatorIds:Array.from({length:128},(_,index)=>`creator:${index}`)})]}).rules[0].creatorIds.length,128)
  assert.equal(read({rules:Array.from({length:128},(_,index)=>rule({id:`r-${index}`,creatorIds:[`creator:${index}`]}))}).rules.length,128)
})

test('binding identity must be canonical configured data and agree with a valid group scope',()=>{
  const identity=JSON.parse(agentBindingIdentity(binding)),scope=JSON.parse(agentConversationKey(binding))
  for(const bindingIdentity of ['not-json','{}','[]',JSON.stringify(identity,null,2),JSON.stringify([...identity,'extra']),
    JSON.stringify(['legacy',...identity.slice(1)]),JSON.stringify([identity[0],null,...identity.slice(2)]),
    JSON.stringify([identity[0],identity[1],'',...identity.slice(3)]),
    JSON.stringify([...identity.slice(0,3),'',identity[4]]),
    JSON.stringify([...identity.slice(0,4),'bad connection'])])rejected({rules:[rule({bindingIdentity})]},'tools.deferredActions.rules[0].bindingIdentity')
  for(const scopeKey of ['not-json','{}','[]',JSON.stringify(scope,null,2),
    JSON.stringify(['different-agent',...scope.slice(1)]),
    JSON.stringify([...scope.slice(0,4),'private',scope[5]]),
    JSON.stringify([...scope.slice(0,4),'channel',scope[5]])])rejected({rules:[rule({scopeKey})]},'tools.deferredActions.rules[0].scopeKey')
  const otherPlatformScope=JSON.stringify([binding.agentId,'other-platform','tenant','account:opaque','group','group:opaque'])
  assert.equal(read({rules:[rule({scopeKey:otherPlatformScope,executor:'mcp'})]}).rules[0].scopeKey,otherPlatformScope)
})

test('duplicate IDs and intersecting permissions are rejected even with different rule revisions',()=>{
  rejected({rules:[rule(),rule({creatorIds:['different']})]},'tools.deferredActions.rules[1].id')
  rejected({rules:[rule(),rule({id:'other-id',revision:'other-revision'})]},'tools.deferredActions.rules[1]')
  rejected({rules:[rule({creatorIds:['one','two']}),rule({id:'other-id',creatorIds:['two','three']})]},'tools.deferredActions.rules[1]')
  assert.equal(read({rules:[rule(),rule({id:'other-id',creatorIds:['different']})]}).rules.length,2)
  assert.equal(read({rules:[rule(),rule({id:'other-id',definitionId:'other-definition'})]}).rules.length,2)
})

test('explicit migration approvals preserve exactly four source fields and are copied and deeply frozen',()=>{
  const original=approval(),input={enabled:true,rules:[rule()],migrationApprovals:[original]}
  const config=read(input)
  assert.deepEqual(config.migrationApprovals,[original])
  assert.equal(Object.isFrozen(config.migrationApprovals),true)
  assert.equal(Object.isFrozen(config.migrationApprovals[0]),true)
  assert.notEqual(config.migrationApprovals,input.migrationApprovals)
  assert.notEqual(config.migrationApprovals[0],original)
  assert.equal('kind'in config.migrationApprovals[0],false)
  original.sourceHash='b'.repeat(64);original.authorizedBy='different-operator';input.migrationApprovals.push(approval({id:'another'}))
  assert.deepEqual(config.migrationApprovals,[approval()])
  assert.throws(()=>{config.migrationApprovals[0].at=1},TypeError)
  assert.throws(()=>{config.migrationApprovals.push(approval())},TypeError)
  assert.equal(read({migrationApprovals:[Object.assign(Object.create(null),approval())]}).migrationApprovals.length,1)
  assert.equal(read({migrationApprovals:[approval()]}).enabled,false)
  assert.deepEqual(read({migrationApprovals:[approval()]}).rules,[])
})

test('migration approvals require strict identifiers, lowercase sha256 and positive representable integer timestamps',()=>{
  for(const [field,invalidValues] of Object.entries({
    id:[undefined,null,0,'','  ',' leading','trailing ','has\ncontrol','x'.repeat(129)],
    sourceHash:[undefined,null,1,'','a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'z'.repeat(64),` ${'a'.repeat(64)}`],
    authorizedBy:[undefined,null,true,'',' ',' leading','trailing ','has\u007fcontrol','x'.repeat(129)],
    at:[undefined,null,true,'1800000000000',0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,8_640_000_000_000_001],
  }))for(const value of invalidValues)rejected({enabled:false,migrationApprovals:[approval({[field]:value})]},`tools.deferredActions.migrationApprovals[0].${field}`)
  for(const field of ['id','sourceHash','authorizedBy','at']){
    const missing=approval();delete missing[field]
    rejected({migrationApprovals:[missing]},`tools.deferredActions.migrationApprovals[0].${field}`)
  }
  for(const at of [1,8_640_000_000_000_000])assert.equal(read({migrationApprovals:[approval({at})]}).migrationApprovals[0].at,at)
  const identifiers=read({migrationApprovals:[approval({id:'x'.repeat(128),authorizedBy:'操作者:opaque'})]})
  assert.equal(identifiers.migrationApprovals[0].id.length,128)
  assert.equal(identifiers.migrationApprovals[0].authorizedBy,'操作者:opaque')
})

test('migration approval arrays are bounded and reject duplicate source IDs rather than combining authority',()=>{
  for(const migrationApprovals of [undefined,null,true,'[]',{},[null],[approval(),null],
    Array.from({length:129},(_,index)=>approval({id:`legacy-${index}`}))])rejected({migrationApprovals})
  for(const changes of [{},{sourceHash:'b'.repeat(64)},{authorizedBy:'another-operator'},{at:1}]){
    rejected({enabled:false,migrationApprovals:[approval(),approval(changes)]},'tools.deferredActions.migrationApprovals[1].id')
  }
  const config=read({rules:[rule()],migrationApprovals:Array.from({length:128},(_,index)=>approval({id:index===0?'self-poke':`legacy-${index}`}))})
  assert.equal(config.migrationApprovals.length,128)
  assert.equal(config.rules.length,1)
})

test('migration approval data is closed and rejects Proxy, inheritance, sparse arrays and accessors without running them',()=>{
  let getters=0,proxyTraps=0
  const revoked=Proxy.revocable([],{});revoked.revoke()
  const sparse=[];sparse.length=1
  const getterArray=[approval()];Object.defineProperty(getterArray,'0',{get(){getters++;return approval()}})
  const rows=[
    {migrationApprovals:[{...approval(),kind:'migration'}]},
    {migrationApprovals:[{...approval(),unknown:true}]},
    {migrationApprovals:[Object.assign(Object.create({inherited:'secret'}),approval())]},
    {migrationApprovals:[Object.defineProperty(approval(),'id',{get(){getters++;return 'id'}})]},
    {migrationApprovals:[Object.defineProperty(approval(),'at',{value:1,enumerable:false})]},
    {migrationApprovals:[{...approval(),[Symbol('secret')]:true}]},
    {migrationApprovals:[new Proxy(approval(),{get(){proxyTraps++;throw new Error('must not run')}})]},
    {migrationApprovals:new Proxy([approval()],{get(){proxyTraps++;throw new Error('must not run')}})},
    {migrationApprovals:revoked.proxy},{migrationApprovals:sparse},{migrationApprovals:getterArray},
    {get migrationApprovals(){getters++;return [approval()]}},
  ]
  for(const input of rows)rejected(input)
  assert.equal(getters,0);assert.equal(proxyTraps,0)
})

test('inheritance, Proxy, accessor, symbol and non-enumerable fields are rejected without evaluating input code',()=>{
  let getters=0,proxyTraps=0
  const proxy=new Proxy({enabled:true},{get(){proxyTraps++;throw new Error('should not run')}})
  const revoked=Proxy.revocable([],{});revoked.revoke()
  const rows=[Object.create({enabled:true}),proxy,Object.assign([],{enabled:true}),
    {get enabled(){getters++;return true}},
    {rules:[Object.assign(Object.create({id:'inherited'}),rule())]},
    {rules:[new Proxy(rule(),{get(){proxyTraps++;throw new Error('should not run')}})]},
    {rules:new Proxy([rule()],{})},{rules:revoked.proxy},
    {rules:[{...rule(),get creatorIds(){getters++;return ['id']}}]},
    Object.defineProperty({},'enabled',{value:true}),
    {rules:[Object.defineProperty(rule(),'maxDelayMs',{get(){getters++;return 1000}})]},
    {[Symbol('secret')]:true},{rules:[{...rule(),[Symbol('secret')]:true}]},
  ]
  const sparse=[];sparse.length=1;rows.push({rules:sparse})
  const getterArray=[rule()];Object.defineProperty(getterArray,'0',{get(){getters++;return rule()}});rows.push({rules:getterArray})
  const symbolCreators=['one'];symbolCreators[Symbol('extra')]='secret';rows.push({rules:[rule({creatorIds:symbolCreators})]})
  for(const row of rows)rejected(row)
  assert.equal(getters,0);assert.equal(proxyTraps,0)
})

test('disabled configurations still validate every rule and errors contain fixed paths without supplied secrets',()=>{
  const secret='DO-NOT-OUTPUT-THIS-OPERATOR-SECRET'
  for(const input of [
    {enabled:false,rules:[rule({tool:`bad ${secret}`})]},
    {enabled:false,rules:[{...rule(),[secret]:secret}]},
    {enabled:false,rules:[rule({bindingIdentity:secret})]},
    {enabled:false,rules:[rule({creatorIds:[` ${secret}`]})]},
    {enabled:false,migrationApprovals:[approval({id:` ${secret}`})]},
    {enabled:false,migrationApprovals:[approval({sourceHash:secret})]},
    {enabled:false,migrationApprovals:[approval({authorizedBy:` ${secret}`})]},
    {enabled:false,migrationApprovals:[approval({at:secret})]},
    {enabled:false,migrationApprovals:[{...approval(),[secret]:secret}]},
    {[secret]:secret},
  ]) {
    assert.throws(()=>read(input),error=>error.message.startsWith('tools.deferredActions')&&!error.message.includes(secret)&&
      /^tools\.deferredActions(?:\.(?:rules|migrationApprovals)\[\d+\](?:\.[A-Za-z]+)?|\.[A-Za-z]+)? 配置无效$/u.test(error.message))
  }
  assert.equal(read({enabled:false,rules:[rule()]}).rules.length,1)
})
