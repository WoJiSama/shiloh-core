import assert from 'node:assert/strict'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createAgentRedisFixture,redisAvailable} from './helpers/agentRedis.js'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'
const {createAgentRuntime}=await load('core/agentRuntime.js')
const {createAgentBindingDirectory,conversationAddressKey,platformAccountKey}=await load('modules/runtime/domain/agentBindings.js')
const {createAgentTurtleSoup}=await load('modules/games/infrastructure/agentTurtleSoup.js')
const {createAgentUmaRaceHandler}=await load('modules/games/infrastructure/agentUmaRace.js')
const {readStandaloneGamesConfig}=await load('bootstrap/standaloneGamesConfig.js')
const options={skip:!redisAvailable,timeout:20_000}
async function fixture(t, settings={}){
 const redis=await createAgentRedisFixture(t,'group-game-runtime'),sources=new Map(),sends=[],privateSends=[],contexts=[],models=[]
 const account={platform:'qq',namespace:'global',id:'19007801'},actor={...account,id:'17007801'},target={account,kind:'group',id:'31007801'}
 let ready=false,receive,host,version=1,serial=0,active=false,role='member',authorize,stopped=0
 const directory=()=>createAgentBindingDirectory({version:1,agents:[{id:'daily',personaId:'default'}],connections:[{id:'qq',platform:'qq',namespace:'global',accountId:account.id}],bindings:[{connectionId:'qq',kind:'group',conversationId:target.id,agentId:'daily'}]},'games-'+version)
 let bindings=directory()
 const sourceKey=(address,id)=>conversationAddressKey(address)+':'+id
 const adapter={id:'qq',account,botUserId:account.id,isReady:()=>ready,start(accept){receive=accept;ready=true},stop(){ready=false},
  async readMessage(address,id,guard){if(guard?.isCurrent?.()===false)return undefined;return structuredClone(sources.get(sourceKey(address,id)))},
  async readConversationMember(address,user,guard){if(guard?.isCurrent?.()===false)return undefined;return {target:structuredClone(address),observedAt:Date.now(),member:{user:structuredClone(user),displayName:user.id,role:user.id===actor.id?role:'member'}}},
  actions:{async send(action,guard){await settings.beforeDispatch?.(f,guard);await guard.ensureCurrent?.();if(!guard.isCurrent())return {state:'failed'};sends.push(structuredClone(action));return {state:'sent',messageId:'game-sent-'+ ++serial}},
   async sendGamePrivate(request,guard){await guard.ensureCurrent();if(!guard.isCurrent())return {state:'failed'};privateSends.push(structuredClone(request));return {state:'sent',messageId:'game-private-'+ ++serial}}}}
 const makeHost=()=>createAgentRuntime({storage:redis.storage,adapters:[adapter],logger:{info(){},warn(){},error(){}},isExecutionCurrent:redis.isCurrent,
  useTextGroup:()=>true,privateChatEnabled:false,groupLog:{enabled:false},memorySystem:{enabled:false},midtermMemory:{enabled:false},episodicMemory:{enabled:false},semanticMemory:{enabled:false},groupMemory:{enabled:false},
  getSection:()=>({enabled:settings.chatEnabled!==false,allGroups:true,reflection:{enabled:false},rhythm:{enabled:false},mood:{enabled:false},personProfile:{enabled:false},meme:{enabled:false},userStyle:{enabled:false},lifeThreads:{enabled:false},wake:{probability:0,proactiveProbability:0}}),
  resolvePersona(address){const binding=bindings.resolve(address);return binding&&{binding,persona:{name:'游戏角色'},systemContent:'游戏集成测试'}},getExecutionConfig:()=>({useTools:false}),async YTapi(request){models.push(request);return {choices:[{message:{content:'不应进入普通模型'}}]}},
  createGroupGames(ports){authorize=ports.authorizeBackground;return settings.createGroupGames?settings.createGroupGames(ports):[{id:'turtle-soup',isCandidate:source=>source.text.startsWith('.游戏')||active,isActive:()=>active,async handle(context){contexts.push(context);active=true;if(settings.handle)return settings.handle(context,f);await context.sendText('游戏结果已确认。');return true},stop(){stopped++;active=false}}]}})
 const f={...redis,account,actor,target,sources,sends,privateSends,contexts,models,get host(){return host},get stopped(){return stopped},get binding(){return bindings.resolve(target)},
  rebind(){version++;bindings=directory()},setRole(value){role=value},authorize(input){return authorize(input)},
  message(text='.游戏 测试'){return {version:1,conversation:target,sender:actor,messageId:'game-source-'+ ++serial,occurredAt:Date.now(),text,parts:[{kind:'text',text}],mentions:[],directedToAccount:false}},
  async emit(source){sources.set(sourceKey(source.conversation,source.messageId),structuredClone(source));await receive({kind:'message',message:structuredClone(source)});
   const until=performance.now()+7000;while(performance.now()<until){const sizes=await Promise.all(['group-log','group-text'].map(kind=>redis.reader.lLen(redis.prefix+'agent:inbox:'+kind+':'+platformAccountKey(account))));if(sizes.every(size=>Number(size)===0))return;await delay(10)}assert.fail('game inbox did not drain')},
  change(source,text){sources.set(sourceKey(source.conversation,source.messageId),{...structuredClone(source),text,parts:[{kind:'text',text}]})},
  async restart(){await host.stop();host=makeHost();await host.start()},async stop(){await host.stop()}}
 host=makeHost();await host.start();t.after(()=>host.stop());return f
}
test('Core authorizes current group source, keeps active game input and deduplicates original actions across restart',options,async t=>{
 const f=await fixture(t),message=f.message();await f.emit(message)
 assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].member.role,'member');assert.equal(f.sends.length,1);assert.equal(f.models.length,0)
 await f.emit(f.message('下一条游戏问题'));assert.equal(f.contexts.length,2)
 await f.restart();await f.emit(message);assert.equal(f.contexts.length,2);assert.equal(f.stopped,1)
})
test('Core background authority rejects changed source, role, binding and stopped runtime',options,async t=>{
 const f=await fixture(t);const message=f.message();await f.emit(message)
 const context=f.contexts[0];f.setRole('admin');await assert.rejects(context.ensureCurrent(),/权限/u)
 const fresh=await f.authorize({source:message,binding:f.binding});assert.equal(fresh.member.role,'admin')
 f.change(message,'原消息已改');await assert.rejects(fresh.ensureCurrent());assert.equal(await f.authorize({source:message,binding:f.binding}),undefined)
 const next=f.message();await f.emit(next);const previous=f.contexts.at(-1);f.rebind();assert.equal(await f.authorize({source:next,binding:previous.binding}),undefined)
 await f.stop();assert.equal(await f.authorize({source:next,binding:f.binding}),undefined)
})
test('Core merges game cancellation into the final queued adapter guard and consumes unknown attempts',options,async t=>{
 let live=true,executions=0
 const f=await fixture(t,{beforeDispatch(){live=false},async handle(context){executions++;await context.sendText('取消后不得发出。',{isCurrent:()=>live,async ensureCurrent(){if(!live)throw Error('cancelled')}});return true}})
 const message=f.message();await f.emit(message);assert.equal(f.sends.length,0);assert.equal(executions,1)
 await f.restart();live=true;await f.emit(message);assert.equal(executions,1);assert.equal(f.sends.length,0)
})
test('Core private game result retains its original group and verified human source',options,async t=>{
 const f=await fixture(t,{async handle(context){await context.sendPrivate(context.source.sender.id,'本局私密答案。');return true}})
 const message=f.message();await f.emit(message);assert.equal(f.privateSends.length,1);assert.equal(f.sends.length,0)
 const request=f.privateSends[0];assert.deepEqual(request.binding,f.binding);assert.deepEqual(request.recipient,f.actor);assert.equal(request.source.messageId,message.messageId);assert.equal(request.origin.source.messageId,message.messageId)
})
test('explicit games retain their original source and work while ordinary chat is disabled',options,async t=>{
 const f=await fixture(t,{chatEnabled:false,async handle(context){assert.equal(context.source.text,'.游戏 测试  ');await context.sendText('群内游戏结果。');await context.sendPrivate(context.member.id,'原群私密结果。');return true}})
 await f.emit(f.message('.游戏 测试  '));assert.equal(f.contexts.length,1);assert.equal(f.sends.length,1);assert.equal(f.privateSends.length,1);assert.equal(f.models.length,0)
})
test('real TurtleSoup and Uma handlers receive explicit Core commands with ordinary chat disabled',options,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'core-games-installed-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const config=readStandaloneGamesConfig({turtleSoup:{enabled:true},umaRace:{enabled:true}},{dataDir:root});let calls=0
 const f=await fixture(t,{chatEnabled:false,createGroupGames({authorizeBackground}){return [createAgentTurtleSoup({dataDir:path.join(root,'games'),config:()=>config.turtleSoup,authorizeBackground,async callModel(){calls++;throw Error('help must not call model')}}),createAgentUmaRaceHandler({dataDir:path.join(root,'games'),config:config.umaRace,authorizeBackground})]}})
 await f.emit(f.message('.游戏 海龟汤 帮助'));assert.ok(f.sends.some(row=>JSON.stringify(row.parts).includes('海龟汤')))
 const count=f.sends.length;await f.emit(f.message('.赛马娘 帮助'));assert.ok(f.sends.length>count);assert.ok(f.sends.slice(count).some(row=>JSON.stringify(row.parts).includes('赛马娘')))
 assert.equal(calls,0);assert.equal(f.models.length,0)
})
