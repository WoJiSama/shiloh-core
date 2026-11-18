import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {compileAgentDiceRulePackage,createAgentDiceRulePackages}=await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const {evaluateDiceRuleExpression}=await load('modules/dice/infrastructure/DiceRuleExpression.js')
const {AGENT_DICE_SCRIPT_LIMITS}=await load('modules/dice/infrastructure/agentDiceScriptProcess.js')
// Pending until a real host adapter proves OS hard total-process memory limits.
// The Darwin diagnostic is deliberately never substituted for that adapter.
const scriptRunner=undefined
const scriptOptions={skip:'pending: no host-verified runner with an OS hard total-process memory quota',timeout:20000}
const compileExecutable=input=>compileAgentDiceRulePackage(input,{scriptRunner})
const at=1_800_000_000_000
const sha=source=>createHash('sha256').update(source).digest('hex')
const pack=(changes={})=>({version:1,id:'heart-rules',name:'匕心测试',aliases:['heartdemo','匕心'],character:{fields:{agi:{type:'integer',default:6,min:1,max:20},eye:{type:'integer',default:1,min:0,max:5}}},commands:[{id:'strike',aliases:['strike','刺击'],output:'{actor} 刺击。'}],...changes})
const yamlInput=(value=pack(),changes={})=>{const source=typeof value==='string'?value:YAML.stringify(value);return {kind:'yaml',source,revision:'revision-one',sourceHash:sha(source),...changes}}
const jsSource=(functions,changes={},prefix='')=>`${prefix}\nlet counter=0;module.exports=${JSON.stringify(pack(changes))};module.exports.functions={${functions}};`
const jsInput=(source,changes={})=>{const revision='revision-one',sourceHash=sha(source);return {kind:'js',source,revision,sourceHash,trustedPackage:{id:'heart-rules',revision,sourceHash},...changes}}
const evaluate=(instance,expression,context={},random=()=>assert.fail('a pure formula must not consume host entropy'))=>evaluateDiceRuleExpression(expression,context,{customFunctions:instance.__functions,random}).value

test('YAML compilation binds the exact source and revision, applies schema defaults and instantiates without entropy',async()=>{
 const input=yamlInput(),first=await compileAgentDiceRulePackage(input),same=await compileAgentDiceRulePackage({...input})
 assert.equal(first.id,'heart-rules');assert.equal(first.kind,'yaml');assert.equal(first.source,input.source);assert.equal(first.sourceHash,sha(input.source));assert.equal(first.revision,input.revision)
 assert.equal(first.definitionId,same.definitionId);assert.match(first.definitionId,/^agent-dice-rule:v3:[a-f0-9]{64}$/u)
 assert.notEqual(first.definitionId,(await compileAgentDiceRulePackage({...input,revision:'revision-two'})).definitionId)
 const whitespace=input.source+'\n';assert.notEqual(first.definitionId,(await compileAgentDiceRulePackage(yamlInput(whitespace))).definitionId)
 assert.deepEqual(first.pack.compatibility,{min_runtime:'2.0',package_version:'1.0.0'})
 assert.deepEqual(first.pack.group,{fields:{}});assert.deepEqual(first.pack.statuses,{});assert.deepEqual(first.pack.templates,{})
 assert.deepEqual(first.pack.limits,{max_dice_count:100,max_rolls:12,max_expression_length:512,max_output_length:2000,max_table_entries:100})
 assert.deepEqual(first.commands,['strike','刺击'])
 assert.equal(await first.instantiate(()=>assert.fail('YAML instantiation cannot roll'),at),first.pack)
 assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first.pack.character.fields.agi),true);assert.equal(Object.isFrozen(first.commands),true)
 assert.throws(()=>{first.pack.character.fields.agi.default=99},TypeError)
})

test('YAML rejects changed bytes, malformed documents and invalid schema instead of accepting an altered package',async()=>{
 const input=yamlInput()
 for(const invalid of [{...input,source:input.source+'\n'},{...input,sourceHash:'0'.repeat(64)},{...input,sourceHash:input.sourceHash.toUpperCase()},yamlInput('version: [')])await assert.rejects(compileAgentDiceRulePackage(invalid))
 for(const value of [pack({version:2}),pack({id:'r'}),pack({unknown:true}),pack({aliases:['heartdemo','HEARTDEMO']}),pack({limits:{max_dice_count:101}}),pack({character:{fields:{bad:{type:'integer',default:0,formula:'1'}}}}),pack({commands:[{id:'bad',aliases:['bad'],let:{value:'unapproved(1)'},output:'{let.value}'}]})]){
  await assert.rejects(compileAgentDiceRulePackage(yamlInput(value)),/规则包校验失败/u)
 }
})

test('configured package sets preserve input order while their immutable definition is independent of that order',async()=>{
 const one=yamlInput(),two=yamlInput(pack({id:'thread-rules',name:'细线测试',aliases:['threaddemo']}))
 const forward=await createAgentDiceRulePackages([one,two]),reverse=await createAgentDiceRulePackages([two,one])
 assert.deepEqual(forward.packages.map(item=>item.id),['heart-rules','thread-rules']);assert.deepEqual(reverse.packages.map(item=>item.id),['thread-rules','heart-rules'])
 assert.equal(forward.definitionId,reverse.definitionId);assert.match(forward.definitionId,/^agent-dice-rules:v2:[a-f0-9]{64}$/u)
 assert.equal(Object.isFrozen(forward),true);assert.equal(Object.isFrozen(forward.packages),true)
 assert.deepEqual((await createAgentDiceRulePackages([])).packages,[])
})

test('duplicate package IDs and case-insensitive aliases, including an alias matching another ID, are refused',async()=>{
 const first=yamlInput()
 await assert.rejects(createAgentDiceRulePackages([first,first]),/标识重复/u)
 for(const aliases of [['HEARTDEMO'],['heart-rules']]){
  const second=yamlInput(pack({id:'thread-rules',aliases}))
  await assert.rejects(createAgentDiceRulePackages([first,second]),/命令冲突/u)
 }
 const duplicateSubcommands=pack({commands:[{id:'first',aliases:['strike'],output:'first'},{id:'second',aliases:['STRIKE'],output:'second'}]})
 await assert.rejects(compileAgentDiceRulePackage(yamlInput(duplicateSubcommands)),/规则包校验失败/u)
})

test('JS trust rejects a missing ID or mismatched revision and hash before requesting any runner',async()=>{
 const input=jsInput(jsSource('heartBonus(args){return Math.floor(Number(args[0])/3)}'))
 for(const trustedPackage of [undefined,{}, {...input.trustedPackage,id:''},{...input.trustedPackage,revision:'revision-two'},{...input.trustedPackage,sourceHash:'0'.repeat(64)}]){
  await assert.rejects(compileAgentDiceRulePackage({...input,trustedPackage}),/授权/u)
 }
 const changed=jsInput(input.source+'\n')
 await assert.rejects(compileAgentDiceRulePackage({...changed,trustedPackage:input.trustedPackage}),/授权/u)
})

test('JS package export IDs must match their exact grants',scriptOptions,async()=>{
 const input=jsInput(jsSource('heartBonus(args){return Math.floor(Number(args[0])/3)}'))
 await assert.rejects(compileExecutable({...input,trustedPackage:{...input.trustedPackage,id:'*'}}),/授权/u)
 const compiled=await compileExecutable(input)
 assert.equal(compiled.id,'heart-rules');assert.equal(compiled.sourceHash,input.sourceHash);assert.equal(compiled.kind,'js');assert.equal(Object.hasOwn(compiled.pack,'functions'),false)
 assert.equal(Object.isFrozen(compiled.pack),true)
})

test('trusted JS formulas run through real isolated instantiate callbacks and return only scalar expression values',scriptOptions,async()=>{
 const source=jsSource(`heartBonus(args){const agi=Number(args[0])||0,eye=Number(args[1])||0;return Math.floor((agi/3)*Math.max(1,eye/2))},label(args){return '心眼'+args[0]},eligible(args){return args[0]>=2},nothing(){return null},clock(){return String(Date.now())}`,
  {character:{fields:{agi:{type:'integer',default:6},eye:{type:'integer',default:1},backstab:{type:'integer',formula:'heartBonus(attr.agi, attr.eye)'}}}})
 const compiled=await compileExecutable(jsInput(source)),instance=await compiled.instantiate(()=>assert.fail('JS scalar callbacks cannot roll'),at)
 assert.equal(evaluate(instance,instance.character.fields.backstab.formula,{attr:{agi:9,eye:4}}),6)
 assert.equal(evaluate(instance,'label(2)'),'心眼2');assert.equal(evaluate(instance,'eligible(2)'),true);assert.equal(evaluate(instance,'nothing()'),null);assert.equal(evaluate(instance,'clock()'),String(at))
 assert.equal(instance.__functions.heartBonus instanceof Function,true);assert.equal(Object.hasOwn(compiled.pack,'__functions'),false)
})

test('each JS formula invocation has fresh script state and receives copied JSON rather than host callbacks or mutable objects',scriptOptions,async()=>{
 const source=jsSource('tick(){return ++counter},touch(args,scope){scope.context.attr.agi=99;return scope.context.attr.agi},hostType(args,scope){return typeof scope.context.hostCallback}')
 const compiled=await compileExecutable(jsInput(source)),random=()=>assert.fail('no random'),instance=await compiled.instantiate(random,at)
 let hostCalls=0
 const context={attr:{agi:6},hostCallback(){hostCalls++;return 42}}
 assert.equal(evaluate(instance,'tick()',context,random),1);assert.equal(evaluate(instance,'tick()',context,random),1)
 assert.equal(evaluate(instance,'touch()',context,random),99);assert.equal(context.attr.agi,6)
 assert.equal(evaluate(instance,'hostType()',context,random),'undefined');assert.equal(hostCalls,0)
})

test('JS formulas cannot return objects, arrays, undefined, nonfinite numbers or executable values',scriptOptions,async()=>{
 const source=jsSource('objectValue(){return {value:1}},arrayValue(){return [1]},undefinedValue(){return undefined},nonfinite(){return Infinity},functionValue(){return ()=>1}')
 const compiled=await compileExecutable(jsInput(source)),instance=await compiled.instantiate(()=>0.5,at)
 for(const name of ['objectValue','arrayValue','undefinedValue','nonfinite','functionValue'])assert.throws(()=>evaluate(instance,`${name}()`),/自定义函数.*执行失败/u)
})

test('exact JS trust grants no require, filesystem, network, process or ambient random capability at inspect or formula time',scriptOptions,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dice-package-boundary-')),secret=path.join(directory,'secret.txt'),written=path.join(directory,'must-not-exist')
 await writeFile(secret,'PACKAGE-PRIVATE-CONTENT-MUST-NOT-ENTER-A-FORMULA')
 t.after(()=>rm(directory,{recursive:true,force:true}))
 let connections=0
 const server=createServer(socket=>{connections++;socket.destroy()})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const port=server.address().port
 const source=jsSource(`read(){return require('node:fs').readFileSync(${JSON.stringify(secret)},'utf8')},write(){require('node:fs').writeFileSync(${JSON.stringify(written)},'unsafe');return true},network(){require('node:net').connect(${port},'127.0.0.1');return true},environment(){return process.env.OPENAI_API_KEY},mathRandom(){return Math.random()},stateRandom(args,scope){return scope.state.random()},caughtRandom(){try{Math.random()}catch{}return 7}`)
 const compiled=await compileExecutable(jsInput(source)),instance=await compiled.instantiate(()=>assert.fail('no host entropy may enter a custom formula'),at)
 for(const name of ['read','write','network','environment','mathRandom','stateRandom','caughtRandom'])assert.throws(()=>evaluate(instance,`${name}()`),error=>/自定义函数.*执行失败/u.test(error.message)&&!error.message.includes('PACKAGE-PRIVATE-CONTENT'))
 assert.equal(await stat(written).then(()=>true,()=>false),false);assert.equal(connections,0);assert.match(await readFile(secret,'utf8'),/^PACKAGE-PRIVATE/u)
 for(const prefix of ["require('node:fs');",'Math.random();','try{Math.random()}catch{}'])await assert.rejects(compileExecutable(jsInput(jsSource('okay(){return 1}',{},prefix))),/骰子脚本执行未确认/u)
})

test('package configuration rejects unsupported sources and active object fields without invoking getters or proxies',async()=>{
 const input=yamlInput()
 let getters=0,traps=0
 const accessor={...input};Object.defineProperty(accessor,'source',{enumerable:true,get(){getters++;return input.source}})
 const proxy=new Proxy(input,{get(){traps++;throw Error('must not inspect proxy')}})
 const symbol={...input,[Symbol('hidden')]:true},hidden={...input};Object.defineProperty(hidden,'hidden',{value:true})
 for(const invalid of [null,[],{},new Date(),accessor,proxy,symbol,hidden,{...input,kind:'file'},{...input,source:''},{...input,source:'x'.repeat(65537)},{...input,revision:''},{...input,revision:' '},{...input,revision:'x'.repeat(257)},{...input,sourceHash:'invalid'},{...input,path:'unconfigured.yaml'},{...input,trustedPackage:{...jsInput('').trustedPackage,unknown:true}}])await assert.rejects(compileAgentDiceRulePackage(invalid))
 for(const invalid of [null,{},new Proxy([],{get(){traps++;throw Error('must not inspect proxy')}}),Array(129).fill(input),[undefined]])await assert.rejects(createAgentDiceRulePackages(invalid))
 assert.equal(getters,0);assert.equal(traps,0)
})

test('a non-string package kind is rejected without calling its user-defined conversion',async()=>{
 let conversions=0
 const input={...yamlInput(),kind:{toString(){conversions++;return 'yaml'}}}
 await assert.rejects(compileAgentDiceRulePackage(input))
 assert.equal(conversions,0)
})

test('exactly trusted JS and Seal packages remain unavailable by default without a host-verified constrained runner',async()=>{
 const sealSource="const ext=seal.ext.new('compat','tests','1');seal.ext.register(ext);const command=seal.ext.newCmdItemInfo();command.solve=()=>seal.ext.newCmdExecuteResult(true);ext.cmdMap.probe=command;"
 const inputs=[jsInput(jsSource('value(){return 1}')),jsInput(sealSource,{kind:'seal'})]
 for(const input of inputs){
  await assert.rejects(compileAgentDiceRulePackage(input),/骰子脚本隔离环境不可用/u)
  await assert.rejects(createAgentDiceRulePackages([input]),/骰子脚本隔离环境不可用/u)
 }
})

test('Seal grant revision and hash mismatches are rejected before runner availability is considered',async()=>{
 const input=jsInput("seal.ext.register(seal.ext.new('compat','tests','1'))",{kind:'seal'})
 for(const changes of [{revision:'another-revision'},{sourceHash:'0'.repeat(64)}])await assert.rejects(compileAgentDiceRulePackage({...input,trustedPackage:{...input.trustedPackage,...changes}}),/授权/u)
 for(const trustedPackage of [undefined,{}, {...input.trustedPackage,id:'*'}])await assert.rejects(compileAgentDiceRulePackage({...input,trustedPackage}),/标识无效/u)
})

test('malformed runner metadata and package options are rejected without executing a runner or changing YAML definitions',async()=>{
 let calls=0,getters=0
 const never=()=>{calls++;throw Error('an invalid runner must never execute')}
 const invalidRunner={definitionId:'intentionally-unqualified-test-only',limits:{...AGENT_DICE_SCRIPT_LIMITS},isolation:{execution:'separate-process',filesystem:'deny',network:'deny',subprocess:'deny',totalMemory:'language-heap-only',evidence:'test-only invalid metadata'},execute:never,executeSync:never}
 const input=jsInput(jsSource('value(){return 1}'))
 for(const runner of [{},invalidRunner,{...invalidRunner,definitionId:' '},{...invalidRunner,definitionId:'bad\nidentity'},{...invalidRunner,definitionId:'x'.repeat(257)},{...invalidRunner,limits:{...invalidRunner.limits,totalMemoryBytes:AGENT_DICE_SCRIPT_LIMITS.totalMemoryBytes+1}}]){
  await assert.rejects(compileAgentDiceRulePackage(input,{scriptRunner:runner}),/骰子脚本隔离环境不可用/u)
 }
 const accessor={get scriptRunner(){getters++;return invalidRunner}}
 for(const options of [null,[],{unexpected:true},accessor])await assert.rejects(compileAgentDiceRulePackage(yamlInput(),options),/规则包配置无效/u)
 const plain=await compileAgentDiceRulePackage(yamlInput()),ignored=await compileAgentDiceRulePackage(yamlInput(),{scriptRunner:invalidRunner})
 assert.equal(plain.definitionId,ignored.definitionId);assert.equal(Object.hasOwn(ignored,'scriptRunner'),false)
 assert.equal(calls,0);assert.equal(getters,0)
})
