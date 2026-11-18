import {executeAgentDiceScript,toAgentDiceScriptJson,captureAgentDiceScriptRunner,type AgentDiceScriptRunner} from './agentDiceScriptProcess.js'
import type {RuleStored} from '../../../contracts/rulePack.js'
import type {AgentDiceRuleContext,AgentDiceRuleEffect,AgentDiceRuleCards} from './agentDiceRules.js'

export interface AgentDiceSealState {version:1;storage:Record<string,unknown>}
interface SealInput {source:string;packId:string;command:string;args:string;state?:AgentDiceSealState;context:AgentDiceRuleContext;random:()=>number;players:Record<string,RuleStored>;cards?:AgentDiceRuleCards;scriptRunner?:AgentDiceScriptRunner}

// The compatibility API executes entirely in a fresh context. It has no native event,
// module loader, filesystem, timers or network. Writes and replies are draft data.
const bootstrap=String.raw`
Object.defineProperty(globalThis,'__agentDiceSeal',{writable:false,configurable:false,value:(()=>{
var input=JSON.parse(__input),storage=input.storage||{},players=input.players||{},effects=[],extensions={},temp={},templates=[],rules=[],templateMemory=storage.__card_tpl||{};
var done=false,failed=false,matched=true,commandHelp='',delegateText='';
const outputText=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\[CQ:/gi,'［CQ:');
function playerName(id){return input.context.members.find(x=>x.id===String(id))?.name||String(id)}
function validMember(id){return input.context.members.some(x=>x.id===String(id))}
function mayWrite(id){return String(id)===input.context.actor.id || input.context.capabilities.delegate.includes(String(id))}
function ctxFor(id,proxied=false){return {__proxied:proxied,isPrivate:false,player:{userId:String(id),name:playerName(id),lastCommandTime:Date.now(),autoSetNameTemplate:''},group:{groupId:input.context.groupId,groupName:'',active:true,cocRuleIndex:0,logOn:input.context.logActive===true,logCurName:'',enteredTime:Date.now(),showGroupWelcome:false,groupWelcomeMessage:''},endTime:null,deckDepth:0,isCurGroupBotOn:true,privilegeLevel:0,commandHideFlag:false,delegateText:'',notice:()=>true}}
function scoped(ctx,name){const n=String(name),bare=n.replace(/^\$[tmg]/,'');if(n.startsWith('$t'))return ['temp',ctx.player.userId+':'+bare];if(n.startsWith('$m'))return ['storage','__m:'+ctx.player.userId+':'+bare];if(n.startsWith('$g'))return ['storage','__g:'+bare];return ['card',n]}
function getVar(ctx,name,isString=false){
  const [kind,key]=scoped(ctx,name);let value;
  if(kind==='temp')value=temp[key];else if(kind==='storage')value=(storage.__scoped||{})[key];else value=players[ctx.player.userId]?.values?.[key];
  if(value===undefined)return [isString?'':0,false];
  if(!isString&&typeof value==='string'&&!/^-?\d+$/.test(value))return [0,false];
  return [isString?String(value):Number(value)||0,true];
}
function setVar(ctx,name,value){
  if(done)return;if(!validMember(ctx.player.userId)||!mayWrite(ctx.player.userId))throw Error('delegate denied');
  const [kind,key]=scoped(ctx,name);
  if(kind==='temp')temp[key]=value;
  else if(kind==='storage'){storage.__scoped||={};storage.__scoped[key]=value}
  else {players[ctx.player.userId]||={values:{}};players[ctx.player.userId].values[key]=value}
}
const vars={intGet:(ctx,n)=>getVar(ctx,n),strGet:(ctx,n)=>getVar(ctx,n,true),getVar:(ctx,n)=>getVar(ctx,n),intSet:(ctx,n,v)=>setVar(ctx,n,Math.trunc(Number(v)||0)),strSet:(ctx,n,v)=>setVar(ctx,n,String(v)),setVar};
function calculate(ctx,expression){
  let expr=String(expression).replace(/[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z_0-9]*/g,n=>{if(/^[dD]$/.test(n))return n;const [v,e]=vars.intGet(ctx,n);return e?String(v):n});
  expr=expr.replace(/(\d*)d(\d+)(kh\d+|kl\d+)?/gi,(_,count,sides,keep)=>{const n=Math.min(Number(count)||1,100),s=Math.min(Number(sides),1000);if(n<1||s<1)throw Error('invalid dice');let rolls=Array.from({length:n},()=>1+Math.floor(Math.random()*s));if(keep){const k=Math.min(Number(keep.slice(2))||1,n);rolls=keep.toLowerCase().startsWith('kh')?rolls.sort((a,b)=>b-a).slice(0,k):rolls.sort((a,b)=>a-b).slice(0,k)}return String(rolls.reduce((a,b)=>a+b,0))});
  if(!/^[\d+\-*/()%\s.]+$/.test(expr))return null;
  // A bounded arithmetic parser avoids Function/eval and shares no host authority.
  const tokens=expr.match(/\d+(?:\.\d+)?|[()+\-*/%]/g)||[];let i=0,depth=0;
  function term(){if(++depth>32)throw Error('expression depth');let n;if(tokens[i]==='+'||tokens[i]==='-'){const sign=tokens[i++];n=(sign==='-'?-1:1)*term()}else if(tokens[i]==='('){i++;n=add();if(tokens[i++]!==')')throw Error('parenthesis')}else {n=Number(tokens[i++]);if(!Number.isFinite(n))throw Error('number')}depth--;return n}
  function mul(){let n=term();while(['*','/','%'].includes(tokens[i])){const op=tokens[i++],v=term();n=op==='*'?n*v:op==='/'?n/v:n%v}return n}
  function add(){let n=mul();while(['+','-'].includes(tokens[i])){const op=tokens[i++],v=mul();n=op==='+'?n+v:n-v}return n}
  const n=add();return i===tokens.length&&Number.isFinite(n)?n:null;
}
function format(ctx,text){return String(text??'').replace(/\{([^{}]+)\}/g,(raw,name)=>{if(/^\$t玩家(_RAW)?$|^\$tQQ昵称$/.test(name))return ctx.player.name;if(/^\$t骰子(名字|昵称)$/.test(name))return '骰娘';const [n,exists]=vars.intGet(ctx,name);if(exists)return String(n);const [s,hasString]=vars.strGet(ctx,name);if(hasString&&s)return s;try{const n=calculate(ctx,name);if(n!==null)return String(n)}catch{}return raw})}
function card(ctx,template){
  if(done)return false;if(!validMember(ctx.player.userId)||!mayWrite(ctx.player.userId)||!input.context.capabilities.card.includes(ctx.player.userId))throw Error('card denied');
  const key=ctx.player.userId;templateMemory[key]=String(template);storage.__card_tpl=templateMemory;
  const rendered=String(template??'').replace(/\{\$t玩家_RAW\}/g,()=>ctx.player.name).replace(/\{([^{}]+)\}/g,(raw,n)=>{const [v,e]=vars.intGet(ctx,n);return e?String(v):raw});
  if(!rendered.trim()||rendered.length>=60)return false;
  effects.push({kind:'card',subjectId:ctx.player.userId,name:outputText(rendered)});return true;
}
const seal={
  ext:{new:(name,author,version)=>({name:String(name||'ext'),author:String(author||''),version:String(version||'1.0.0'),cmdMap:{},storageGet:key=>storage[String(name)+':'+key]||'',storageSet:(key,value)=>{if(!done)storage[String(name)+':'+key]=String(value??'')}}),find:name=>extensions[String(name)]||null,register:ext=>{if(!ext?.name)throw Error('extension name');extensions[ext.name]=ext;return true},newCmdItemInfo:()=>({name:'',help:'',solve:null,allowDelegate:false}),newCmdExecuteResult:(solved=true)=>({matched:true,solved:Boolean(solved),showHelp:false}),registerStringInterceptor:()=>{throw Error('unsupported interceptor')}},
  vars,format,
  replyToSender:(ctx,msg,text)=>{if(done)return;const prefix=effects.some(e=>e.kind==='public')?'':delegateText;effects.push({kind:'public',text:outputText(prefix+String(text??''))})},
  replyToChannel:(ctx,msg,text)=>{if(!done)effects.push({kind:'public',text:outputText(text)})},
  getCtxProxyFirst:(ctx,args)=>{for(const at of args.at||[]){const id=String(at.userId||'');if(id&&id!==ctx.player.userId&&id!==input.context.botUserId&&validMember(id)&&mayWrite(id))return ctxFor(id,true)}return ctx},
  applyPlayerGroupCardByTemplate:card,
  gameSystem:{newTemplate:json=>{try{const t=JSON.parse(json);templates.push(t);for(const [k,v]of Object.entries(t.defaults||{}))storage['__tpl_default:'+k]=v;const config=t.setConfig||t.setRule;if(config?.keys?.length)rules.push({...config,templateName:String(t.name||'')})}catch{}return true},findTemplate:()=>null},
  setRule:r=>{if(r?.keys?.length)rules.push(JSON.parse(JSON.stringify(r)));return true},
  st:new Proxy({},{get(){throw Error('unsupported st API')}}),deck:new Proxy({},{get(){throw Error('unsupported deck API')}}),cud:new Proxy({},{get(){throw Error('unsupported cud API')}}),tsl:new Proxy({},{get(){throw Error('unsupported tsl API')}}),ban:new Proxy({},{get(){throw Error('unsupported ban API')}}),censor:new Proxy({},{get(){throw Error('unsupported censor API')}})
};
Object.freeze(vars);Object.freeze(seal.ext);Object.freeze(seal.gameSystem);Object.freeze(seal);
Object.defineProperty(globalThis,'seal',{value:seal,writable:false,configurable:false});
for(const name of ['setTimeout','setInterval','clearTimeout','clearInterval'])Object.defineProperty(globalThis,name,{value:()=>{throw Error('unsupported timer')},writable:false,configurable:false});
function commandArgs(){
  const clean=[],kwargs=[];for(const arg of input.args.trim().split(/\s+/).filter(Boolean)){const m=/^--([^=]+)(?:=(.+))?$/.exec(arg);if(m)kwargs.push({name:m[1],valueExists:m[2]!==undefined,value:m[2]??'',asBool:m[2]===undefined||m[2]==='true'||m[2]==='1'});else clean.push(arg)}
  const at=(input.context.mentions||[]).filter(x=>validMember(x.id)).map(x=>({userId:x.id,name:x.name||playerName(x.id)}));
  return {command:input.command,args:clean,kwargs,at,rawArgs:input.args,getArgN:(n=1)=>clean[n-1]??'',getRestArgsFrom:(n=1)=>clean.slice(n-1).join(' '),getKwarg:(name='')=>kwargs.find(x=>x.name===name)||null,isArgEqual:(n=1,value='')=>String(clean[n-1]||'').toLowerCase()===String(value).toLowerCase(),eatPrefixWith:(prefix='')=>String(clean[0]||'').toLowerCase().startsWith(String(prefix).toLowerCase())?String(clean[0]||'').slice(prefix.length):null,chopPrefixToArgsWith:(prefix='')=>String(clean[0]||'').toLowerCase().startsWith(String(prefix).toLowerCase())?[String(clean[0]||'').slice(prefix.length),...clean.slice(1)]:clean,amIBeMentioned:()=>at.some(x=>x.userId===input.context.actor.id),amIBeMentionedFirst:()=>at[0]?.userId===input.context.actor.id,cleanArgs:clean.join(' '),specialExecuteTimes:1,rawText:input.args}
}
return Object.freeze({inspect:()=>Object.values(extensions).flatMap(ext=>Object.entries(ext.cmdMap||{}).filter(([id,cmd])=>typeof cmd?.solve === 'function').map(([id])=>id)),
result:()=>({matched,done,failed,storage,players,effects,commandHelp}),run:()=>{
var command=Object.values(extensions).map(ext=>ext.cmdMap?.[input.command]).find(cmd=>typeof cmd?.solve==='function');
if(!command){matched=false;done=true}else{
  const args=commandArgs(),ctx=ctxFor(input.context.actor.id);
  if(['help','帮助','-h','--help'].includes(String(args.args[0]||'').toLowerCase())){commandHelp=String(command.help||'');done=true}
  else {
    if(!command.allowDelegate&&args.at.some(at=>at.userId!==ctx.player.userId&&at.userId!==input.context.botUserId))throw Error('command delegation denied');
    if(args.at.some(at=>at.userId!==ctx.player.userId&&at.userId!==input.context.botUserId&&!input.context.capabilities.delegate.includes(at.userId)))throw Error('delegate denied');
    if(command.allowDelegate&&args.at.some(at=>at.userId!==ctx.player.userId&&at.userId!==input.context.botUserId))delegateText='由'+ctx.player.name+'代骰：\n';
    Promise.resolve(command.solve(ctx,{},args)).then(result=>{if(result===false)matched=false;if(result?.showHelp)commandHelp=String(command.help||'');done=true},()=>{failed=true;done=true});
  }
}
}});
})()});
`
function payloadContext(context:AgentDiceRuleContext) {
  const check=context.allows as (permission:string,id?:string)=>boolean
  const ids=context.members.map(member=>member.id)
  return {source:{...context.source},actor:{...context.actor},members:context.members.map(member=>({id:member.id,name:member.name})),
    groupId:context.groupId,botUserId:context.botUserId??'',mentions:context.mentions??[],logActive:context.logActive===true,
    capabilities:{delegate:ids.filter(id=>check('delegate',id)),card:ids.filter(id=>check('card',id))}}
}
function registrationCheck(source:string):void {
  // Legacy never executed these hooks. Rejecting them makes the unsupported contract visible.
  if(/\b(?:onNotCommandReceived|onMessageReceived|onMessageSend|onCommandReceived|onGroupMemberIncrease|onGroupMemberDecrease)\b/u.test(source))throw new Error('不支持海豹异步或自动事件hook')
}
export async function inspectAgentDiceSeal(source:string,_packId:string,scriptRunner?:AgentDiceScriptRunner):Promise<readonly string[]> {
  registrationCheck(source)
  const input={storage:{},players:{},args:'',command:'',context:{source:{at:1},actor:{id:'preview'},members:[{id:'preview',name:'preview'}],groupId:'preview',capabilities:{delegate:[],card:[]}}}
  const result=await executeAgentDiceScript({source,kind:'seal',operation:'inspect',at:1,randomValues:[],setupCode:bootstrap,input,
    expression:'__agentDiceSeal.inspect()'},scriptRunner?{runner:scriptRunner}:{})
  const commands=result.value
  if(!Array.isArray(commands)||!commands.length||commands.length>128||!commands.every(command=>typeof command==='string'&&/^[A-Za-z0-9_\u4e00-\u9fff-]{1,128}$/u.test(command)))throw new Error('海豹规则命令无效')
  return Object.freeze(commands as string[])
}
export async function runAgentDiceSeal(input:SealInput):Promise<{matched:boolean;state:AgentDiceSealState;effects:AgentDiceRuleEffect[]}> {
  registrationCheck(input.source)
  const scriptRunner=captureAgentDiceScriptRunner(input.scriptRunner)
  const context=payloadContext(input.context),allowed=new Set([input.context.actor.id,...context.capabilities.delegate])
  const players:Record<string,RuleStored>={}
  for(const [id,card] of Object.entries(input.cards??{}))if(allowed.has(id)&&input.context.members.some(member=>member.id===id))players[id]={values:{...card.attrs,...card.skills}}
  if(!input.cards)for(const [id,value]of Object.entries(input.players))if(allowed.has(id)&&input.context.members.some(member=>member.id===id))players[id]=JSON.parse(JSON.stringify(value)) as RuleStored
  for(const member of input.context.members)if(allowed.has(member.id))players[member.id]??={values:{}}
  const randomValues=Array.from({length:4096},()=>{const value=input.random();if(!Number.isFinite(value)||value<0||value>=1)throw new Error('海豹随机源无效');return value})
  const output=await executeAgentDiceScript({source:input.source,kind:'seal',operation:'execute',at:input.context.source.at,randomValues,setupCode:bootstrap,afterCode:'__agentDiceSeal.run()',
    input:toAgentDiceScriptJson({storage:input.state?.storage??{},players,context,args:input.args,command:input.command}),expression:'__agentDiceSeal.result()'},{runner:scriptRunner})
  const result=output.value as unknown as {matched:boolean;done:boolean;failed:boolean;storage:Record<string,unknown>;players:Record<string,RuleStored>;effects:AgentDiceRuleEffect[];commandHelp:string}
  if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(key=>!['matched','done','failed','storage','players','effects','commandHelp'].includes(key))||typeof result.matched!=='boolean'||result.done!==true||result.failed!==false||
    !result.storage||typeof result.storage!=='object'||Array.isArray(result.storage)||!result.players||typeof result.players!=='object'||Array.isArray(result.players)||typeof result.commandHelp!=='string'||result.commandHelp.length>8000)throw new Error('海豹规则执行未确认')
  if(!Array.isArray(result.effects)||result.effects.length+(result.commandHelp?1:0)>128||result.effects.some(effect=>{
    if(!effect||typeof effect!=='object')return true
    if(effect.kind==='public')return Object.keys(effect).some(key=>!['kind','text'].includes(key))||typeof effect.text!=='string'||effect.text.length>8000
    if(effect.kind==='card')return Object.keys(effect).some(key=>!['kind','subjectId','name'].includes(key))||typeof effect.subjectId!=='string'||!allowed.has(effect.subjectId)||!context.capabilities.card.includes(effect.subjectId)||typeof effect.name!=='string'||!effect.name.trim()||effect.name.length>=60
    return true
  }))throw new Error('海豹规则输出或投递权限无效')
  const effects=[...result.effects]
  if(result.commandHelp)effects.push({kind:'public',text:result.commandHelp})
  if(result.matched){
    if(input.cards){
      const draft=structuredClone(input.cards)
      for(const [id,stored]of Object.entries(result.players)){
        const member=input.context.members.find(member=>member.id===id)
        if(!member||!allowed.has(id)||!stored||typeof stored!=='object'||Array.isArray(stored)||Object.keys(stored).some(key=>key!=='values')||!stored.values||typeof stored.values!=='object'||Array.isArray(stored.values))throw new Error('海豹人物卡目标无效')
        const values=stored.values??{},before=players[id]?.values??{}
        if(JSON.stringify(values)===JSON.stringify(before))continue
        const check=input.context.allows as (permission:string,id?:string)=>boolean
        if(id!==input.context.actor.id&&!check('delegate',id))throw new Error('海豹代骰没有当前授权')
        const card=draft[id]??={key:'默认',name:member.name,attrs:{},skills:{}}
        for(const [key,value]of Object.entries(values)){
          if(['__proto__','constructor','prototype'].includes(key)||typeof value!=='number'||!Number.isFinite(value))throw new Error('海豹人物卡数值无效')
          if(Object.hasOwn(card.attrs,key))card.attrs[key]=value;else card.skills[key]=value
        }
      }
      for(const key of Object.keys(input.cards))delete input.cards[key]
      Object.assign(input.cards,draft)
    }else {for(const key of Object.keys(input.players))delete input.players[key];Object.assign(input.players,result.players)}
  }
  return {matched:result.matched,state:{version:1,storage:result.matched?result.storage:input.state?.storage??{}},effects:result.matched?effects:[]}
}
