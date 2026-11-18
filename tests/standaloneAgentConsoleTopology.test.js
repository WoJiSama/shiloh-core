import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import net from 'node:net'
import YAML from 'yaml'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {prepareStandaloneAgentTopologyChange:prepare,describeStandaloneAgentTopology:describe}=await load('bootstrap/standaloneAgentConsoleTopology.js')
const {AgentConsoleError}=await load('contracts/agentConsole.js')
const {createStandaloneAgentCandidateValidator}=await load('bootstrap/standaloneAgentConfig.js')
const {agentConversationKey}=await load('modules/runtime/domain/agentBindings.js')
const validate=createStandaloneAgentCandidateValidator('/absent/topology/agent-host.yaml',{}, {requireCredentials:false})
const existingSecret='EXISTING_ENDPOINT_SECRET_6273',unknownSecret='OPAQUE_EXTENSION_SECRET_5836'
function values({host={},personas={personas:[{id:'night',name:'Night',tone:'quiet',opaque:{secret:unknownSecret}}]},bindings={}}={}){
  return {host:YAML.stringify({version:1,instance:'topology',model:{baseUrl:'https://model.example/v1',name:'model',apiKeyEnv:'MODEL_KEY'},
    persona:{name:'Default',identity:'default identity'},
    connections:[{id:'main',url:`ws://127.0.0.1:3001/${existingSecret}`,accessTokenEnv:'EXISTING_QQ_KEY',opaque:unknownSecret}],
    extensionOwned:{opaque:unknownSecret},...host}),
    personas:personas===undefined?undefined:YAML.stringify(personas),
    bindings:YAML.stringify({version:1,agents:[{id:'daily',personaId:'default'}],
      connections:[{id:'main',platform:'qq',namespace:'global',accountId:'19000931'}],
      bindings:[{connectionId:'main',kind:'group',conversationId:'310931',agentId:'daily'}],...bindings})}
}
const connection=extra=>({kind:'connection.add',agentId:'daily',connection:{id:'new-qq',accountId:'19000932',transport:'forward-websocket',url:'ws://localhost:31002/onebot',...extra},
  conversations:[{kind:'group',conversationId:'310931'},{kind:'private',conversationId:'200001'}]})
const create=extra=>({kind:'agent.create',agentId:'new-agent',personaId:'night',...extra})
const invalid=error=>error instanceof AgentConsoleError&&error.code==='invalid_request'&&error.message==='invalid_request'&&error.cause===undefined
function projections(plan){return JSON.stringify({changes:plan.changes,affected:plan.affected,permissions:plan.permissions})}
function noSecrets(value){
  const output=typeof value==='string'?value:JSON.stringify(value)
  for(const secret of [existingSecret,unknownSecret,'EXISTING_QQ_KEY','MODEL_KEY'])assert.equal(output.includes(secret),false,secret)
}

test('safe catalog exposes only Agent, persona and connection identities and transport',()=>{
  const sources=values(),before=structuredClone(sources)
  assert.deepEqual(describe(sources),{agents:[{agentId:'daily',personaId:'default'}],
    personas:[{id:'default',name:'Default'},{id:'night',name:'Night'}],
    connections:[{id:'main',account:{platform:'qq',namespace:'global',id:'19000931'},transport:'forward-websocket'}]})
  noSecrets(describe(sources));assert.deepEqual(sources,before)
  const reverse=values({host:{connections:[{id:'main',transport:'reverse-websocket',url:'ws://127.0.0.1:3001',accessTokenEnv:'EXISTING_QQ_KEY'}]}})
  assert.equal(describe(reverse).connections[0].transport,'reverse-websocket')
})

test('connection candidate appends only host connection, account declaration and selected Agent bindings',()=>{
  const sources=values(),before=structuredClone(sources),change=connection({accessTokenEnv:'NEW_QQ_TOKEN'}),input=structuredClone(change)
  const plan=prepare(sources,change),host=YAML.parse(plan.sources.host),bindings=YAML.parse(plan.sources.bindings)
  assert.deepEqual(sources,before);assert.deepEqual(change,input);assert.equal(plan.sources.personas,sources.personas)
  assert.deepEqual(host.connections[1],{id:'new-qq',transport:'forward-websocket',url:'ws://localhost:31002/onebot',accessTokenEnv:'NEW_QQ_TOKEN'})
  const originalHost=YAML.parse(sources.host);delete host.connections;delete originalHost.connections;assert.deepEqual(host,originalHost)
  assert.deepEqual(bindings.connections[1],{id:'new-qq',platform:'qq',namespace:'global',accountId:'19000932'})
  assert.deepEqual(bindings.bindings.slice(1),[
    {connectionId:'new-qq',kind:'group',conversationId:'310931',agentId:'daily'},
    {connectionId:'new-qq',kind:'private',conversationId:'200001',agentId:'daily'},
  ])
  assert.deepEqual(plan.affected,{agents:['daily'],connections:[{id:'main',account:{platform:'qq',namespace:'global',id:'19000931'}},
    {id:'new-qq',account:{platform:'qq',namespace:'global',id:'19000932'}}],conversations:[
    {agentId:'daily',connectionId:'main',target:{account:{platform:'qq',namespace:'global',id:'19000931'},kind:'group',id:'310931'}},
    {agentId:'daily',connectionId:'new-qq',target:{account:{platform:'qq',namespace:'global',id:'19000932'},kind:'group',id:'310931'}},
    {agentId:'daily',connectionId:'new-qq',target:{account:{platform:'qq',namespace:'global',id:'19000932'},kind:'private',id:'200001'}},
  ]})
  assert.deepEqual(plan.changes.map(row=>[row.file,row.path,row.action,row.before]),[
    ['host','connections[1]','add',null],['bindings','connections[1]','add',null],['bindings','bindings[1]','add',null],['bindings','bindings[2]','add',null],
  ])
  noSecrets(projections(plan));assert.ok(validate(plan.sources))
  assert.deepEqual(prepare(sources,change),plan,'candidate planning is deterministic')
})

test('normalized forward and reverse endpoints use the existing transport rules without looking up credentials',()=>{
  for(const [transport,url,expected] of [['forward-websocket','wss://EXAMPLE.COM:443','wss://example.com/'],['reverse-websocket','ws://127.0.0.1:31002','ws://127.0.0.1:31002/']]){
    const plan=prepare(values(),connection({transport,url,accessTokenEnv:'NEW_TOKEN'}))
    assert.equal(YAML.parse(plan.sources.host).connections[1].url,expected)
    assert.equal(plan.changes[0].after.url,expected);assert.ok(validate(plan.sources))
  }
})

test('YAML appends preserve comments, anchors, old nodes and untouched source bytes',()=>{
  const sources={host:`# host heading\nversion: 1\ninstance: topology\nmodel: {baseUrl: 'https://model.example/v1', name: model, apiKeyEnv: MODEL_KEY}\npersona: &base\n  name: Default # default name\nextensionOwned: *base\nconnections: # endpoints retained\n  - id: main # existing endpoint\n    url: 'ws://127.0.0.1:3001/${existingSecret}'\n    accessTokenEnv: EXISTING_QQ_KEY # existing env ref\n# host ending\n`,
    personas:'# library heading\npersonas:\n  - id: night # existing template\n    name: Night\n    tone: quiet # tone comment\n# library ending\n',
    bindings:'# binding heading\nversion: 1\nagents:\n  - id: daily # original Agent\n    personaId: default\nconnections:\n  - id: main # original account\n    platform: qq\n    namespace: global\n    accountId: "19000931"\nbindings:\n  - connectionId: main # original conversation\n    kind: group\n    conversationId: "310931"\n    agentId: daily\n# binding ending\n'}
  const added=prepare(sources,connection())
  for(const comment of ['host heading','default name','endpoints retained','existing endpoint','existing env ref','host ending'])assert.ok(added.sources.host.includes('# '+comment),comment)
  for(const comment of ['binding heading','original Agent','original account','original conversation','binding ending'])assert.ok(added.sources.bindings.includes('# '+comment),comment)
  assert.match(added.sources.host,/&base/u);assert.match(added.sources.host,/\*base/u);assert.equal(added.sources.personas,sources.personas)
  const next=prepare(sources,create({personaId:'new-persona',newPersona:{id:'new-persona',name:'New',tone:'gentle'}}))
  assert.equal(next.sources.host,sources.host)
  for(const comment of ['library heading','existing template','tone comment','library ending'])assert.ok(next.sources.personas.includes('# '+comment),comment)
  assert.deepEqual(YAML.parse(next.sources.personas).personas[0],YAML.parse(sources.personas).personas[0]);assert.ok(validate(added.sources));assert.ok(validate(next.sources))
})

test('a shared anchored append target is rejected instead of changing unrelated alias consumers',()=>{
  const sources=values(),host=YAML.parseDocument(sources.host)
  host.get('connections',true).anchor='shared-endpoints'
  host.set('extensionAlias',new YAML.Alias('shared-endpoints'))
  sources.host=host.toString()
  const before=structuredClone(sources)
  assert.throws(()=>prepare(sources,connection()),invalid);assert.deepEqual(sources,before)
  const library=YAML.parseDocument(sources.personas)
  library.get('personas',true).anchor='shared-personas';library.set('extensionAlias',new YAML.Alias('shared-personas'))
  sources.personas=library.toString()
  assert.throws(()=>prepare(sources,create({personaId:'new',newPersona:{id:'new',name:'New'}})),invalid)
})

test('Agent creation reuses an existing persona without duplicating templates or connections',()=>{
  const sources=values(),plan=prepare(sources,create())
  assert.equal(plan.sources.host,sources.host);assert.equal(plan.sources.personas,sources.personas)
  assert.deepEqual(YAML.parse(plan.sources.bindings).agents,[{id:'daily',personaId:'default'},{id:'new-agent',personaId:'night'}])
  assert.deepEqual(plan.affected,{agents:['daily','new-agent'],connections:[{id:'main',account:{platform:'qq',namespace:'global',id:'19000931'}}],conversations:[
    {agentId:'daily',connectionId:'main',target:{account:{platform:'qq',namespace:'global',id:'19000931'},kind:'group',id:'310931'}},
  ]});assert.deepEqual(plan.permissions,[])
  assert.deepEqual(plan.changes,[{file:'bindings',path:'agents[1]',action:'add',before:null,after:{id:'new-agent',personaId:'night'}}])
  noSecrets(projections(plan));assert.ok(validate(plan.sources))
  assert.equal(YAML.parse(prepare(sources,create({personaId:'default'})).sources.bindings).agents[1].personaId,'default')
})

test('both candidate kinds include the entire captured topology, including unbound Agents and connections',()=>{
  const sources=values({bindings:{agents:[{id:'daily',personaId:'default'},{id:'other',personaId:'night'},{id:'idle',personaId:'default'}],
    connections:[{id:'main',platform:'qq',namespace:'global',accountId:'19000931'},
      {id:'other-qq',platform:'qq',namespace:'global',accountId:'19000933'},{id:'unused-qq',platform:'qq',namespace:'global',accountId:'19000934'}],
    bindings:[{connectionId:'main',kind:'group',conversationId:'310931',agentId:'daily'},
      {connectionId:'other-qq',kind:'group',conversationId:'310931',agentId:'other'},
      {connectionId:'other-qq',kind:'private',conversationId:'200001',agentId:'other'}]}})
  const expected={agents:['daily','other','idle'],connections:[
    {id:'main',account:{platform:'qq',namespace:'global',id:'19000931'}},
    {id:'other-qq',account:{platform:'qq',namespace:'global',id:'19000933'}},
    {id:'unused-qq',account:{platform:'qq',namespace:'global',id:'19000934'}},
  ],conversations:[
    {agentId:'daily',connectionId:'main',target:{account:{platform:'qq',namespace:'global',id:'19000931'},kind:'group',id:'310931'}},
    {agentId:'other',connectionId:'other-qq',target:{account:{platform:'qq',namespace:'global',id:'19000933'},kind:'group',id:'310931'}},
    {agentId:'other',connectionId:'other-qq',target:{account:{platform:'qq',namespace:'global',id:'19000933'},kind:'private',id:'200001'}},
  ]}
  const reused=prepare(sources,create()),newTemplate=prepare(sources,create({personaId:'new-persona',newPersona:{id:'new-persona',name:'New'}}))
  for(const plan of [reused,newTemplate]){
    assert.deepEqual(plan.affected,{...expected,agents:[...expected.agents,'new-agent']})
    assert.deepEqual(plan.permissions,[]);noSecrets(projections(plan))
  }
  const added=prepare(sources,connection())
  assert.deepEqual(added.affected.agents,expected.agents,'selecting an existing Agent does not duplicate it')
  assert.deepEqual(added.affected.connections.slice(0,3),expected.connections)
  assert.deepEqual(added.affected.conversations.slice(0,3),expected.conversations)
  assert.equal(added.affected.connections.length,4);assert.equal(added.affected.conversations.length,5)
  assert.equal(added.permissions.length,2)
  const newScopes=new Set(added.affected.conversations.slice(3).map(agentConversationKey))
  for(const permission of added.permissions){
    assert.ok(newScopes.has(permission.scopeKey));assert.match(permission.note,/整个宿主.*等待重启/u)
    assert.match(permission.note,/旧版本 grant 须重新核验/u);assert.match(permission.note,/不自动重签/u)
  }
  noSecrets(projections(added))
})

test('topology planning preserves existing grants exactly and never re-signs them for a changed binding version',()=>{
  const dice={engine:{grants:[{bindingToken:'OLD_BINDING_TOKEN',grantId:'original-grant',authority:{operation:'sheet.write'},secret:unknownSecret}]}}
  const sources=values({host:{dice}})
  for(const change of [connection(),create()]){
    const plan=prepare(sources,change)
    assert.deepEqual(YAML.parse(plan.sources.host).dice,dice)
    assert.notEqual(plan.sources.bindings,sources.bindings)
    assert.equal(projections(plan).includes('OLD_BINDING_TOKEN'),false)
    assert.equal(projections(plan).includes('original-grant'),false)
    noSecrets(projections(plan))
  }
})

test('Agent creation adds a new full legal template and never copies existing growth or opaque extensions',()=>{
  const newPersona={id:'p-new',name:'New Persona',identity:'A friendly guide',tone:'calm',speechStyle:['brief','clear'],preferences:['tea'],boundaries:['respect privacy'],notes:'notes',
    moods:[{name:'happy',hint:'gentle smile',probability:0.2}],reactions:'react kindly',samples:'sample text',blacklist:'banned phrase'}
  const plan=prepare(values(),create({personaId:'p-new',newPersona})),templates=YAML.parse(plan.sources.personas).personas
  assert.deepEqual(templates[1],newPersona);assert.equal(templates[1].opaque,undefined);assert.equal(templates[1].growth,undefined)
  assert.equal(plan.changes[0].file,'personas');assert.equal(plan.changes[1].file,'bindings');noSecrets(projections(plan));assert.ok(validate(plan.sources))
  const missing=values();missing.personas=undefined
  const fresh=prepare(missing,create({personaId:'p-new',newPersona}))
  assert.deepEqual(YAML.parse(fresh.sources.personas),{personas:[newPersona]});assert.ok(validate(fresh.sources))
})

test('connection input rejects unknown fields at every object level and rejects raw YAML',()=>{
  const base=connection(),cases=['connections: []',null,[],{},
    {...base,rawYaml:'host: hacked'}, {...base,permissions:['sendGiftTool']}, {...base,source:'raw'},
    {...base,connection:{...base.connection,token:'secret'}}, {...base,connection:{...base.connection,accessToken:'secret'}},
    {...base,connection:{...base.connection,platform:'other'}}, {...base,connection:{...base.connection,namespace:'other'}},
    {...base,conversations:[{kind:'group',conversationId:'310932',agentId:'other'}]},
    {...base,conversations:[{kind:'group',conversationId:'310932',tools:['sendGiftTool']}]},
    {...base,conversations:[{kind:'group',conversationId:'310932',accountId:'19000931'}]},
  ]
  for(const value of cases)assert.throws(()=>prepare(values(),value),invalid)
})

test('new connection IDs, QQ identifiers, existing accounts and duplicate conversations are strictly checked',()=>{
  const base=connection(),cases=[
    {...base,agentId:'missing'},{...base,agentId:'../daily'},{...base,connection:{...base.connection,id:'main'}},
    {...base,connection:{...base.connection,id:'new/connection'}},{...base,connection:{...base.connection,id:'a'.repeat(65)}},
    {...base,connection:{...base.connection,accountId:'19000931'}},
    ...['0','000123',' 19000932','19000932 ','-1','1.5',19000932,'abc'].map(accountId=>({...base,connection:{...base.connection,accountId}})),
    ...['001','0','-1',310932,'abc','1 '.repeat(80)].map(conversationId=>({...base,conversations:[{kind:'group',conversationId}]})),
    {...base,conversations:[{kind:'channel',conversationId:'310932'}]},
    {...base,conversations:[{kind:'group',conversationId:'310932'},{kind:'group',conversationId:'310932'}]},
  ]
  for(const value of cases)assert.throws(()=>prepare(values(),value),invalid)
  const plan=prepare(values(),{...base,conversations:[{kind:'group',conversationId:'310932'},{kind:'private',conversationId:'310932'}]})
  assert.equal(plan.affected.conversations.length,3)
})

test('conversation list requires one through sixty-four entries and preserves exact scopes at the limit',()=>{
  const base=connection()
  for(const conversations of [undefined,{},[],Array.from({length:65},(_,index)=>({kind:'group',conversationId:String(310932+index)}))]){
    assert.throws(()=>prepare(values(),{...base,conversations}),invalid)
  }
  const plan=prepare(values(),{...base,conversations:Array.from({length:64},(_,index)=>({kind:'group',conversationId:String(310932+index)}))})
  assert.equal(plan.affected.conversations.length,65);assert.equal(plan.permissions.length,64);assert.ok(validate(plan.sources))
  for(const row of plan.affected.conversations.slice(1))assert.equal(row.target.account.id,'19000932')
})

test('URL credentials, queries, fragments, malformed transports and non-env token references are refused',()=>{
  const cases=[
    ...['https://example.com','ws://user:password@example.com','ws://user@example.com','ws://example.com?token=secret','ws://example.com/?','ws://example.com#secret',
      'ws://example.com/#','ws://example.com/\nsecret',' ws://example.com','not-a-url'].map(url=>({url})),
    {transport:'http'},{transport:undefined},{transport:'reverse-websocket',url:'wss://example.com',accessTokenEnv:'NEW_TOKEN'},
    {transport:'reverse-websocket'},{accessTokenEnv:'literal-token'},{accessTokenEnv:'TOKEN=secret'},{accessTokenEnv:'${TOKEN}'},
    {accessTokenEnv:''},{accessTokenEnv:'lowercase'},{accessTokenEnv:'TOKEN\n'},{accessTokenEnv:'A'.repeat(129)},{accessTokenEnv:42},
  ]
  for(const change of cases)assert.throws(()=>prepare(values(),connection(change)),invalid)
})

test('Agent create rejects undeclared fields, missing persona references, duplicate IDs and invalid templates',()=>{
  const base=create(),cases=[
    {...base,agentId:'daily'},{...base,agentId:'../new'},{...base,personaId:'missing'}, {...base,personaId:undefined},
    {...base,connections:[]},{...base,growth:{copyFrom:'daily'}},{...base,redisKey:'arbitrary'},
    {...base,newPersona:{id:'another',name:'New'}},{...base,newPersona:{id:'night',name:'Duplicate'}},
    ...[{id:'p-new'}, {id:'p-new',name:''},{id:'p-new',name:'   '},{id:'p-new',name:'Night'},
      {id:'default',name:'Reserved'},{id:'p-new',name:'New',growth:{}},{id:'p-new',name:'New',badPatterns:[]},
      {id:'p-new',name:'New',speechStyle:'not a list'}, {id:'p-new',name:'New',boundaries:[42]},
      {id:'p-new',name:'New',tone:42},{id:'p-new',name:'New',moods:[{name:'mood',hint:'hint',probability:2}]},
      {id:'p-new',name:'New',moods:[{name:'mood',hint:'hint',secret:'extra'}]},
    ].map(newPersona=>({...base,personaId:newPersona.id,newPersona})),
  ]
  for(const value of cases)assert.throws(()=>prepare(values(),value),invalid)
})

test('Agent state namespace collision is rejected before introducing a new Agent or template',()=>{
  const stateCollision=values({personas:{personas:[{id:'agent:new-agent',name:'Reserved state'}]}})
  assert.throws(()=>prepare(stateCollision,create({personaId:'default'})),invalid)
  for(const id of ['agent:new-agent','agent:daily'])assert.throws(()=>prepare(values(),create({personaId:id,newPersona:{id,name:'Conflict'}})),invalid)
})

test('strict source decoding rejects malformed YAML, duplicate entries, QQ addresses and broken references with fixed diagnostics',()=>{
  const base=values(),bad=[
    {...base,host:'secret: [UPSTREAM_SECRET'},{...base,bindings:'not: [UPSTREAM_SECRET'}, {...base,personas:'personas: [UPSTREAM_SECRET'},
    {...base,host:'[]'},{...base,host:'connections: []'}, {...base,bindings:'{}'}, {...base,personas:'[]'}, {...base,personas:''},
    values({bindings:{agents:[{id:'daily',personaId:'missing'}]}}),
    values({bindings:{agents:[{id:'daily',personaId:'default'},{id:'daily',personaId:'night'}]}}),
    values({bindings:{connections:[{id:'main',platform:'qq',namespace:'global',accountId:'019000931'}]}}),
    values({bindings:{connections:[{id:'main',platform:'qq',namespace:'global',accountId:'19000931'},{id:'unused',platform:'qq',namespace:'global',accountId:'000123'}]}}),
    values({bindings:{bindings:[{connectionId:'main',kind:'group',conversationId:'0310931',agentId:'daily'}]}}),
    values({bindings:{bindings:[{connectionId:'main',kind:'group',conversationId:'310931',agentId:'daily'},{connectionId:'main',kind:'group',conversationId:'310931',agentId:'daily'}]}}),
    values({personas:{personas:[{id:'night',name:'N'},{id:'night',name:'Other'}]}}),
    values({personas:{personas:[{id:'a',name:'Same'},{id:'b',name:'same'}]}}),
    values({personas:{personas:[],accountBindings:{'19000931':'missing'}}}),
  ]
  for(const sources of bad){
    assert.throws(()=>describe(sources),invalid);assert.throws(()=>prepare(sources,connection()),invalid)
  }
})

test('existing duplicate host connections and account declarations never produce a misleading catalog',()=>{
  const original=YAML.parse(values().host).connections[0]
  const cases=[values({host:{connections:[original,original]}}),
    values({bindings:{connections:[{id:'main',platform:'qq',namespace:'global',accountId:'19000931'},{id:'different',platform:'qq',namespace:'global',accountId:'19000931'}]}}),
    values({host:{connections:[{id:'missing',url:'ws://127.0.0.1:3001'}]}})]
  for(const sources of cases){assert.throws(()=>describe(sources),invalid);assert.throws(()=>prepare(sources,connection()),invalid)}
})

test('catalog ignores opaque stored extensions rather than echoing them; changes contain only newly added safe values',()=>{
  const sources=values({personas:{personas:[{id:'night',name:'Night',privateAuth:{secret:unknownSecret}}],opaque:unknownSecret}})
  const catalog=describe(sources),plan=prepare(sources,create())
  noSecrets(catalog);noSecrets(projections(plan))
  assert.ok(plan.sources.host.includes(unknownSecret));assert.ok(plan.sources.personas.includes(unknownSecret))
  assert.deepEqual(Object.keys(catalog),['agents','personas','connections'])
  assert.equal(JSON.stringify(plan.changes).includes('privateAuth'),false)
})

test('private permissions reflect the existing global enable flag and only supported declared tools',()=>{
  for(const [privateChat,expectedMode,expectedTools] of [[undefined,'private-disabled',[]],[{enabled:false,allowTools:['likeTool']},'private-disabled',[]],
    [{enabled:true,allowTools:['likeTool','recallTool']},'private',['likeTool','recallTool']],[{enabled:true},'private',[]]]){
    const host=privateChat===undefined?{}:{privateChat},plan=prepare(values({host}),connection()),row=plan.permissions[1]
    assert.equal(row.mode,expectedMode);assert.deepEqual(row.tools,expectedTools);assert.match(row.note,/不新增工具授权/u)
    assert.equal(row.scopeKey,agentConversationKey(plan.affected.conversations[2]))
  }
  for(const privateChat of [{enabled:'yes'},{enabled:true,allowTools:['sendGiftTool']},{enabled:true,allowTools:['likeTool','likeTool']},{enabled:true,extension:'unknown'}]){
    assert.throws(()=>prepare(values({host:{privateChat}}),connection()),invalid)
  }
})

test('text permissions match connection ID as well as group ID and cannot inherit another account\'s tools',()=>{
  const newRule={connectionId:'new-qq',conversationId:'310931',tools:['commitmentTool','delegateMemoryTool']}
  const plan=prepare(values({host:{textGroups:[{connectionId:'main',conversationId:'310931',tools:['sendGiftTool']},newRule]}}),connection())
  assert.equal(plan.permissions[0].mode,'text');assert.deepEqual(plan.permissions[0].tools,['commitmentTool','delegateMemoryTool']);assert.match(plan.permissions[0].note,/不新增工具授权/u)
  const foreign=prepare(values({host:{textGroups:[{connectionId:'main',conversationId:'310931',tools:['sendGiftTool']}]}}),connection())
  assert.equal(foreign.permissions[0].mode,'simulation');assert.equal(foreign.permissions[0].tools.includes('sendGiftTool'),false)
  assert.equal(plan.sources.host.includes('textGroups'),true)
  assert.equal(YAML.parse(plan.sources.host).textGroups.length,2)
  for(const tools of [['unknownTool'],['commitmentTool','commitmentTool'],{}])assert.throws(()=>prepare(values({host:{textGroups:[{...newRule,tools}]}}),connection()),invalid)
})

test('simulation permissions use real explicit allow, deny, per-group deny and legacy extraTools behavior',()=>{
  const host={simulation:{extraTools:['extraTool','deniedExtra'],toolPolicy:{mode:'open',allowTools:['sendGiftTool','explicitTool'],denyTools:['deniedExtra'],groups:{'310931':['explicitTool']}}}}
  const plan=prepare(values({host}),connection()),row=plan.permissions[0]
  assert.equal(row.mode,'simulation');assert.deepEqual(row.tools,['sendGiftTool','extraTool'])
  assert.match(row.note,/仅列显式声明/u);assert.match(row.note,/默认内置工具面/u);assert.match(row.note,/不新增工具授权/u)
  assert.deepEqual(YAML.parse(plan.sources.host).simulation,host.simulation)
  const legacy=prepare(values({host:{simulation:{extraTools:['explicitExtra'],toolPolicy:{mode:'legacy',denyTools:['explicitExtra'],allowTools:['sendGiftTool']}}}}),connection())
  assert.deepEqual(legacy.permissions[0].tools,['explicitExtra'],'existing legacy semantics use only extraTools')
})

test('disabled or unrecognized simulation policies never claim a known effective tool grant',()=>{
  const off=prepare(values({host:{simulation:{enabled:false,extraTools:['extraTool']}}}),connection()).permissions[0]
  assert.deepEqual(off.tools,[]);assert.match(off.note,/不会开启仿真/u)
  for(const simulation of [{enabled:'yes'},{extraTools:'raw'},{toolPolicy:{mode:'new-policy'}},{toolPolicy:{futureRule:unknownSecret}},
    {toolPolicy:{allowTools:[{secret:unknownSecret}]}},{toolPolicy:{groups:{'bad-group':['sendGiftTool']}}}]){
    const row=prepare(values({host:{simulation}}),connection()).permissions[0]
    assert.deepEqual(row.tools,[]);assert.match(row.note,/未识别规则/u);noSecrets(JSON.stringify(row))
  }
  const defaultRule=prepare(values(),connection()).permissions[0]
  assert.deepEqual(defaultRule.tools,[]);assert.match(defaultRule.note,/默认内置工具面/u)
})

test('pure planning performs no filesystem, socket, Redis or environment credential reads',()=>{
  const sources=values(),request=connection(),originalFs={},originalConnect=net.Socket.prototype.connect,originalFetch=globalThis.fetch
  const methods=['readFileSync','writeFileSync','statSync','lstatSync','realpathSync','mkdirSync','openSync']
  for(const name of methods){originalFs[name]=fs[name];fs[name]=()=>assert.fail(`filesystem access: ${name}`)}
  net.Socket.prototype.connect=()=>assert.fail('socket access');globalThis.fetch=()=>assert.fail('network access')
  try{
    assert.equal(describe(sources).agents.length,1)
    assert.equal(prepare(sources,request).affected.connections.length,2)
    assert.deepEqual(prepare(sources,create()).affected.agents,['daily','new-agent'])
  }finally{Object.assign(fs,originalFs);net.Socket.prototype.connect=originalConnect;globalThis.fetch=originalFetch}
})

test('hostile request objects cannot execute getters, proxy traps, toJSON or retain unknown fields',()=>{
  let accessed=0
  const getter={...connection()};Object.defineProperty(getter,'kind',{enumerable:true,get(){accessed++;throw Error('UPSTREAM_SECRET')}})
  const proxy=new Proxy(connection(),{ownKeys(){accessed++;throw Error('UPSTREAM_SECRET')}})
  const withJson={...connection(),toJSON(){accessed++;throw Error('UPSTREAM_SECRET')}}
  const cycle=connection();cycle.loop=cycle
  const prototype=Object.assign(Object.create({extra:'inherited'}),connection())
  const hidden={...connection()};Object.defineProperty(hidden,'hidden',{value:'unknown'})
  for(const change of [getter,proxy,withJson,cycle,prototype,hidden,JSON.parse('{"kind":"agent.create","agentId":"new","personaId":"default","__proto__":{}}')]){
    assert.throws(()=>prepare(values(),change),invalid)
  }
  assert.equal(accessed,0)
})

test('complete validation still owns bridge prerequisites that a pure topology addition must not invent',()=>{
  const sources=values({host:{tools:{pixiv:{enabled:true,refreshTokenEnv:'PIXIV_TOKEN'}},mediaRelay:{enabled:false}}})
  const plan=prepare(sources,connection())
  assert.equal(YAML.parse(plan.sources.host).mediaRelay.enabled,false)
  assert.throws(()=>validate(plan.sources));assert.equal(JSON.stringify(plan.changes).includes('mediaRelay'),false)
})
