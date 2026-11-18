import {createHash} from 'node:crypto'
import {types} from 'node:util'
import YAML from 'yaml'
import type {DiceRulePack} from '../../../contracts/diceRuleSchema.js'
import type {ExpressionOptions} from './DiceRuleExpression.js'
import {validateDiceRulePack,DICE_RULE_MAX_PACKAGE_BYTES} from './DiceRuleSchema.js'
import {executeAgentDiceScript,executeAgentDiceScriptSync,toAgentDiceScriptJson,captureAgentDiceScriptRunner,type AgentDiceScriptRunner} from './agentDiceScriptProcess.js'

export interface AgentDiceTrustedPackage {readonly id:string;readonly revision:string;readonly sourceHash:string}
export interface AgentDiceRulePackageInput {
  readonly kind:'yaml'|'js'|'seal'
  readonly source:string
  readonly revision:string
  readonly sourceHash:string
  /** Explicit content authorization does not grant scripts native capabilities. */
  readonly trustedPackage?:AgentDiceTrustedPackage
}
export interface AgentDiceCompiledRulePackage {
  readonly kind:'yaml'|'js'|'seal'
  readonly id:string
  readonly revision:string
  readonly sourceHash:string
  readonly definitionId:string
  readonly source:string
  readonly pack:DiceRulePack
  readonly commands:readonly string[]
  readonly scriptRunner?:AgentDiceScriptRunner
  instantiate(random:()=>number,at:number):Promise<DiceRulePack & {__functions?:ExpressionOptions['customFunctions']}>
}
export interface AgentDiceRulePackageOptions {readonly scriptRunner?:AgentDiceScriptRunner}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const calls=new WeakMap<()=>number,number>()
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))freeze(item)}
  return value
}
function own(input:unknown,allowed:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('规则包配置无效')
  const result:Record<string,unknown>=Object.create(null)
  for(const key of Reflect.ownKeys(input)){
    const field=Object.getOwnPropertyDescriptor(input,key)
    if(typeof key!=='string'||!allowed.includes(key)||!field||!('value'in field)||!field.enumerable)throw new Error('规则包配置无效')
    result[key]=field.value
  }
  return result
}
const setup='var module={exports:{}};var exports=module.exports;'
const exported='(module.exports.pack || module.exports.default || module.exports)'
const inspect=`(()=>{const p=${exported};if(!p || typeof p!=='object' || Array.isArray(p))throw Error('invalid pack');const f=p.functions || {};const names=Object.keys(f);if(names.length>32 || names.some(n=>!/^[A-Za-z][A-Za-z0-9_]*$/.test(n) || typeof f[n]!=='function'))throw Error('invalid functions');return {raw:JSON.parse(JSON.stringify(p,(k,v)=>typeof v==='function'?undefined:v)),names}})()`
const sourceCode=(source:string)=>source.replace(/\bexport\s+default\s+/u,'module.exports = ').replace(/\bexport\s+const\s+(pack|rules)\s*=/gu,'module.exports =')
function validated(raw:unknown,names:string[]=[]):DiceRulePack {
  const result=validateDiceRulePack(raw,{extraFunctions:names})
  if(!result.ok)throw new Error('规则包校验失败')
  return freeze(result.pack)
}
function inspected(value:unknown):{pack:DiceRulePack;names:string[]} {
  const row=value as {raw?:unknown;names?:unknown}
  if(!row||!Array.isArray(row.names)||row.names.length>32||!row.names.every(name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)))throw new Error('JS规则导出无效')
  const data={...(row.raw as Record<string,unknown>)};delete data.functions
  return {pack:validated(data,row.names),names:row.names}
}
function trust(input:AgentDiceRulePackageInput,id:string):void {
  const record=input.trustedPackage
  if(!record||!id||record.id!==id||record.revision!==input.revision||record.sourceHash!==input.sourceHash)throw new Error('可执行规则缺少精确配置授权')
}

/** Content-only, asynchronous compilation. Scripts always cross the OS process boundary. */
export async function compileAgentDiceRulePackage(supplied:AgentDiceRulePackageInput,options:AgentDiceRulePackageOptions={}):Promise<AgentDiceCompiledRulePackage> {
  const raw=own(supplied,['kind','source','revision','sourceHash','trustedPackage'])
  if(typeof raw.kind!=='string'||!['yaml','js','seal'].includes(raw.kind)||typeof raw.source!=='string'||!raw.source||Buffer.byteLength(raw.source)>DICE_RULE_MAX_PACKAGE_BYTES||
    typeof raw.revision!=='string'||!raw.revision.trim()||raw.revision.length>256||typeof raw.sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(raw.sourceHash)||sha(raw.source)!==raw.sourceHash)throw new Error('规则包来源无效')
  const record=raw.trustedPackage===undefined?undefined:own(raw.trustedPackage,['id','revision','sourceHash'])
  const input:AgentDiceRulePackageInput=Object.freeze({kind:raw.kind as AgentDiceRulePackageInput['kind'],source:raw.source,revision:raw.revision,sourceHash:raw.sourceHash,
    ...(record===undefined?{}:{trustedPackage:Object.freeze({...record}) as unknown as AgentDiceTrustedPackage})})
  const suppliedOptions=own(options,['scriptRunner'])
  const scriptRunner=input.kind!=='yaml'&&suppliedOptions.scriptRunner!==undefined?captureAgentDiceScriptRunner(suppliedOptions.scriptRunner):undefined
  const definitionId=`agent-dice-rule:v3:${sha(JSON.stringify([input.kind,input.revision,input.sourceHash,scriptRunner?{id:scriptRunner.definitionId,limits:scriptRunner.limits,isolation:scriptRunner.isolation}:null]))}`
  if(input.kind==='seal'){
    const id=input.trustedPackage?.id??''
    if(!/^[a-z][a-z0-9_-]{1,47}$/u.test(id))throw new Error('海豹规则标识无效')
    trust(input,id)
    const {inspectAgentDiceSeal}=await import('./agentDiceSeal.js')
    const commands=await inspectAgentDiceSeal(input.source,id,scriptRunner)
    const pack=freeze({version:1,id,name:id,aliases:[id],compatibility:{min_runtime:'2.0',package_version:input.revision},character:{fields:{}},group:{fields:{}},statuses:{},items:{},abilities:{},events:{},dice_sets:{},tables:{},commands:[],templates:{},limits:{max_dice_count:100,max_rolls:100,max_expression_length:1000,max_output_length:4000,max_table_entries:1000}} as DiceRulePack)
    return freeze({kind:input.kind,id,revision:input.revision,sourceHash:input.sourceHash,definitionId,source:input.source,pack,commands,...(scriptRunner?{scriptRunner}:{}),async instantiate(){return pack}})
  }
  let pack:DiceRulePack,names:string[]=[]
  const transformed=sourceCode(input.source)
  if(input.kind==='yaml')pack=validated(YAML.parse(input.source,{maxAliasCount:50}))
  else {
    const expected=input.trustedPackage?.id??'';trust(input,expected)
    const output=await executeAgentDiceScript({source:transformed,kind:'js',operation:'inspect',at:1,randomValues:[],setupCode:setup,expression:inspect},scriptRunner?{runner:scriptRunner}:{})
    const loaded=inspected(output.value);pack=loaded.pack;names=loaded.names
    if(pack.id!==expected)throw new Error('可执行规则授权标识不匹配')
  }
  return freeze({kind:input.kind,id:pack.id,revision:input.revision,sourceHash:input.sourceHash,definitionId,source:input.source,pack,
    commands:Object.freeze(pack.commands.flatMap(command=>command.aliases??[command.id])),...(scriptRunner?{scriptRunner}:{}),
    async instantiate(random:()=>number,at:number){
      if(input.kind==='yaml')return pack
      const functions:NonNullable<ExpressionOptions['customFunctions']>={}
      for(const name of names){
        functions[name]=(args,scope)=>{
          const count=(calls.get(random)??0)+1;calls.set(random,count)
          if(count>32)throw new Error('单次来源JS公式次数超限')
          // Only JSON enters the child. In-process callbacks and mutable host state never cross.
          const context=JSON.parse(JSON.stringify(scope.context,(_key,value:unknown)=>typeof value==='function'?undefined:value)) as unknown
          const payload=toAgentDiceScriptJson({args,context,maxDiceCount:scope.state.maxDiceCount,maxAbsValue:scope.state.maxAbsValue})
          const output=executeAgentDiceScriptSync({source:transformed,kind:'js',operation:'execute',at,randomValues:[],setupCode:setup,input:payload,
            expression:`(()=>{const p=${exported};const data=JSON.parse(__input);return p.functions[${JSON.stringify(name)}](data.args,{context:data.context,state:{maxDiceCount:data.maxDiceCount,maxAbsValue:data.maxAbsValue,random:()=>Math.random()}})})()`},scriptRunner?{runner:scriptRunner}:{})
          const value=output.value
          if(value!==null&&!['number','string','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new Error('JS规则函数结果无效')
          return value
        }
      }
      return {...pack,__functions:functions}
    }})
}

/** Configured immutable package revisions, never an implicit import from old files. */
export async function createAgentDiceRulePackages(inputs:readonly AgentDiceRulePackageInput[],options:AgentDiceRulePackageOptions={}) {
  if(!Array.isArray(inputs)||types.isProxy(inputs)||inputs.length>128)throw new Error('规则包配置无效')
  const fields=Reflect.ownKeys(inputs)
  if(Object.getPrototypeOf(inputs)!==Array.prototype||fields.length!==inputs.length+1||fields.some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/u.test(key))))throw new Error('规则包配置无效')
  for(let index=0;index<inputs.length;index++){
    const field=Object.getOwnPropertyDescriptor(inputs,String(index))
    if(!field||!('value'in field)||!field.enumerable)throw new Error('规则包配置无效')
  }
  const packages:AgentDiceCompiledRulePackage[]=[],ids=new Set<string>(),aliases=new Set<string>()
  for(const input of inputs){
    const item=await compileAgentDiceRulePackage(input,options)
    if(ids.has(item.id))throw new Error('规则包标识重复')
    ids.add(item.id)
    for(const alias of new Set(item.kind==='seal'?item.commands:[item.id,...(item.pack.aliases??[])])){
      const key=alias.toLowerCase();if(aliases.has(key))throw new Error('规则包命令冲突');aliases.add(key)
    }
    packages.push(item)
  }
  return freeze({packages:Object.freeze(packages),definitionId:`agent-dice-rules:v2:${sha(JSON.stringify(packages.map(item=>[item.id,item.definitionId]).sort()))}`})
}
