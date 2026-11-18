import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createClient} from '@redis/client'
import sharp from 'sharp'
import {WebSocketServer} from 'ws'

const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo),entry=path.join(release,'scripts/start-agent.mjs'),preload=fileURLToPath(new URL('./helpers/pixivRelayPreload.mjs',import.meta.url))
const {simulationAddressKey}=await import(pathToFileURL(path.join(release,'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const {simulationBusyKey,simulationSessionKey}=await import(pathToFileURL(path.join(release,'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const BOT=19000991,USER=330991,GROUP=319901,A='123456789',B='123456790',KEY='PIXIV_TOOLS_MODEL_PRIVATE_12345',TOKEN='PIXIV_TOOLS_ONEBOT_PRIVATE_12345',COOKIE_VALUE='PIXIV_TOOLS_COOKIE_PRIVATE_12345',COOKIE=`PHPSESSID=${COOKIE_VALUE}`
const address={account:{platform:'qq',namespace:'global',id:String(BOT)},kind:'group',id:String(GROUP)},scope=simulationAddressKey(address)
const image=(id,index)=>`https://i.pximg.net/img-master/img/2026/11/16/${id}_p${index}_master1200.png?sign=PIXIV_TOOLS_UPSTREAM_PRIVATE_${index}`
const thumbnail=id=>`https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/16/${id}_p0_square1200.png?sign=PIXIV_TOOLS_THUMB_PRIVATE`
const images=await Promise.all([40,80,120].map(red=>sharp({create:{width:2,height:2,channels:3,background:{r:red,g:60,b:120}}}).png().toBuffer()))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const completion=(name,input,id)=>JSON.stringify({choices:[{message:{content:'',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(input)}}]}}],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}})
async function waitFor(probe,label,timeout=30000){const until=Date.now()+timeout;while(Date.now()<until){const value=await probe();if(value)return value;await delay(25)}assert.fail(`timed out: ${label}`)}
async function redisText(reader,prefix){const rows=[];for(const key of await reader.keys(prefix+'*')){const type=await reader.type(key),value=type==='string'?await reader.get(key):type==='hash'?await reader.hGetAll(key):type==='list'?await reader.lRange(key,0,-1):type==='set'?await reader.sMembers(key):type==='zset'?await reader.zRangeWithScores(key,0,-1):type==='stream'?await reader.xRange(key,'-','+'):null;rows.push(JSON.stringify({key,value}))}return rows.join('\n')}
async function files(directory){const rows=[];for(const item of await readdir(directory,{withFileTypes:true}).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){const file=path.join(directory,item.name);if(item.isDirectory())rows.push(await files(file));else if(item.isFile())rows.push(await readFile(file,'utf8'))}return rows.join('\n')}

async function fixture(t,enabled,{holdSearch=false}={}){
 assert.equal(spawnSync('redis-server',['--version'],{stdio:'ignore'}).status,0,'Pixiv tool CLI acceptance requires real Redis')
 const directory=await mkdtemp(path.join(tmpdir(),'agent-pixiv-tools-cli-')),socketPath=path.join(directory,'redis.sock'),instance=`pixiv-tools-${enabled?'enabled':'disabled'}`,prefix=`bl-agent:${instance}:`,dataDir=path.join(directory,'data')
 const redis=spawn('redis-server',['--port','0','--unixsocket',socketPath,'--save','','--appendonly','no'],{stdio:'ignore'}),redisExit=once(redis,'exit'),sockets=new WebSocketServer({noServer:true})
 const requests=[],external=[],deliveries=[],lookups=[],errors=[],models=[],toolResults=[],sources=new Map(),capabilities=[]
 let child,exited,reader,websocket,log='',epoch=0,turn,finished=false,bridgePort,phase='check',abortedSearch=0,configCurrent=true
 const server=createServer(async(req,res)=>{
  try{
   if(req.url==='/audit/request'){
    const url=new URL(decodeURIComponent(req.headers['x-pixiv-source-url']));external.push(url.href)
    assert.equal(enabled,true);assert.equal(req.method,'GET');assert.equal(req.headers['x-pixiv-pinned'],'93.184.216.34');assert.equal(req.headers['x-pixiv-agent'],'owned-pinned-socket');assert.equal(req.headers['accept-encoding'],'identity');assert.equal(req.headers.referer,'https://www.pixiv.net/');assert.equal(req.headers.authorization,undefined)
    for(const value of [KEY,TOKEN,String(BOT),String(GROUP),'仅群内背景'])assert.equal(JSON.stringify(req.headers).includes(value),false)
    let bytes,mime='application/json'
    if(url.hostname==='www.pixiv.net'){
     assert.equal(req.headers.cookie,COOKIE)
     if(url.pathname.startsWith('/ajax/search/artworks/')){
      const keyword=url.searchParams.get('word'),id=keyword==='合成甲'?A:keyword==='合成乙'?B:undefined;assert.ok(id);assert.equal(url.searchParams.get('order'),'date_d');assert.equal(url.searchParams.get('mode'),'safe')
      bytes=Buffer.from(JSON.stringify({error:false,body:{illustManga:{total:1,data:[{id,title:`列表作品${id===A?'甲':'乙'}`,userName:'合成画师',userId:'987654321',pageCount:3,xRestrict:0,url:thumbnail(id)}]}}}))
      if(holdSearch){res.once('close',()=>{if(!res.writableEnded)abortedSearch++});return}
     }else{
      const match=/^\/ajax\/illust\/(123456789|123456790)(\/pages)?$/u.exec(url.pathname);assert.ok(match);assert.equal(url.search,'')
      const id=match[1];bytes=Buffer.from(JSON.stringify({error:false,body:match[2]?images.map((_,index)=>({urls:{regular:image(id,index)}})):{id,title:`原图作品${id===A?'甲':'乙'}`,description:'完整三页作品说明',userName:'合成画师',pageCount:3,xRestrict:0,urls:{regular:image(id,0)},width:2,height:2}}))
     }
    }else{
     assert.equal(url.hostname,'i.pximg.net');assert.equal(req.headers.cookie,undefined);assert.equal(JSON.stringify(req.headers).includes(COOKIE_VALUE),false)
     const thumb=[A,B].find(id=>url.href===thumbnail(id)),match=[A,B].flatMap(id=>images.map((_,index)=>({id,index,url:image(id,index)}))).find(item=>item.url===url.href)
     assert.ok(thumb||match,'only fixed artwork thumbnail or page URLs may be requested');bytes=images[match?.index??0];mime='image/png'
    }
    res.writeHead(200,{'content-type':mime,'content-length':String(bytes.length)});res.end(bytes);return
   }
   assert.equal(req.url,'/model/v1/chat/completions');assert.equal(req.headers.authorization,`Bearer ${KEY}`)
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());models.push(body);assert.equal(phase,'run');assert.ok(turn)
   // A model request may retain the schema captured at the start of this turn.
   // The live definition fence owns cancellation and execution authorization.
   if(!configCurrent){finished=true;res.end(completion('simFinishTurn',{choice:'silent',reason:'配置修订已取消Pixiv操作，保持安静'},`${epoch}-cancelled`));return}
   const names=body.tools.map(tool=>tool.function.name);for(const name of ['pixivSearchTool','pixivDownloadTool'])assert.equal(names.includes(name),enabled)
   const result=id=>body.messages.findLast(item=>item.role==='tool'&&item.tool_call_id===`${epoch}-${id}`),first=result('first'),retry=result('retry'),fallback=result('fallback')
   for(const value of [first,retry,fallback])if(value&&!toolResults.some(row=>row.tool_call_id===value.tool_call_id))toolResults.push(value)
   if(finished){res.end(completion('simDecide',{decision:'silent',reason:'本轮已经结束'},`${epoch}-decide`));return}
   if(fallback||first&&!turn.unknown){finished=true;res.end(completion('simFinishTurn',{choice:'silent',reason:'Pixiv回执已核实，本轮保持安静'},`${epoch}-finish`));return}
   if(retry){res.end(completion('simSendMessage',{continuation:'chat',messages:['未知回执后的文字补发必须被禁止。']},`${epoch}-fallback`));return}
   if(first&&turn.unknown){res.end(completion('pixivDownloadTool',{target:A},`${epoch}-retry`));return}
   const visible=body.messages.filter(row=>row.role==='user').map(row=>String(row.content)).join('\n');assert.ok(visible.includes(turn.text),'actual human request reaches the simulated model')
   res.end(completion(enabled?turn.tool:'simSendMessage',enabled?turn.input:{continuation:'chat',messages:['本轮未开放Pixiv工具。']},`${epoch}-first`))
  }catch(error){errors.push(String(error));res.writeHead(500).end('{}')}
 })
 server.on('upgrade',(req,socket,head)=>{if(req.url!=='/onebot'||req.headers.authorization!==`Bearer ${TOKEN}`){socket.destroy();return}sockets.handleUpgrade(req,socket,head,peer=>sockets.emit('connection',peer))})
 sockets.on('connection',peer=>{websocket=peer;peer.on('message',async frame=>{
  let echo
  try{
   const {action,params,echo:tag}=JSON.parse(String(frame));echo=tag;requests.push({action,params});let data
   if(action==='get_login_info')data={user_id:BOT,nickname:'Pixiv工具验收机器人'}
   else if(action==='get_msg'){lookups.push(String(params.message_id));data=sources.get(String(params.message_id));assert.ok(data,'source lookup stays within actual recorded human requests')}
   else if(action==='send_group_msg'){
    assert.equal(String(params.group_id),String(GROUP));deliveries.push({kind:'card',epoch,params})
    if(enabled){assert.equal(params.message.length,1);assert.equal(params.message[0].type,'image');assert.match(params.message[0].data.file,/^base64:\/\//u);const bytes=Buffer.from(params.message[0].data.file.slice('base64://'.length),'base64'),metadata=await sharp(bytes).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,1000)}
    else assert.ok(params.message.some(item=>item.type==='text'&&item.data.text==='本轮未开放Pixiv工具。'))
    data={message_id:98200+deliveries.length}
   }else if(action==='send_group_forward_msg'){
    assert.equal(enabled,true);assert.equal(String(params.group_id),String(GROUP));assert.equal(params.messages.length,4)
    const info=params.messages[0].data.content[0].data.text,id=info.includes(A)?A:info.includes(B)?B:undefined;assert.ok(id);assert.equal(id,turn.id)
    assert.ok(info.includes('页数:3'));assert.ok(info.includes('完整三页作品说明'));assert.deepEqual(params.messages.map(node=>node.data.content.map(part=>part.type)),[['text'],['image'],['image'],['image']])
    const owned=[];for(const [index,node]of params.messages.entries()){assert.equal(String(node.data.uin),String(BOT));if(!index)continue;const url=node.data.content[0].data.file;assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/agent-media-relay\/[a-f\d]{64}$/u);capabilities.push(url);const incoming=await fetch(url);assert.equal(incoming.status,200);const bytes=Buffer.from(await incoming.arrayBuffer());assert.deepEqual(bytes,images[index-1]);owned.push(sha(bytes))}
    deliveries.push({kind:'relay',epoch,id,owned});if(turn.unknown){peer.send(JSON.stringify({status:'failed',retcode:1200,data:null,echo,message:'synthetic receipt lost'}));return}data={message_id:98200+deliveries.length}
   }else assert.fail(`unexpected OneBot action ${action}`)
   if(peer.readyState===peer.OPEN)peer.send(JSON.stringify({status:'ok',retcode:0,echo,data}))
  }catch(error){errors.push(String(error));if(echo&&peer.readyState===peer.OPEN)peer.send(JSON.stringify({status:'failed',retcode:1200,echo,data:null}))}
 })})
 t.after(async()=>{
  if(t.error){t.diagnostic(log);t.diagnostic(JSON.stringify({errors,external,lookups,deliveries:deliveries.map(({params,...rest})=>rest),toolResults,models:models.length}))}
  if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(exited)await exited;for(const peer of sockets.clients)peer.terminate();await new Promise(resolve=>sockets.close(resolve));server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));if(reader?.isOpen)await reader.close();if(redis.exitCode===null&&redis.signalCode===null)redis.kill('SIGTERM');await redisExit;await rm(directory,{recursive:true,force:true})
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,allocator=createServer();await new Promise(resolve=>allocator.listen(0,'127.0.0.1',resolve));bridgePort=allocator.address().port;await new Promise(resolve=>allocator.close(resolve))
 await waitFor(()=>stat(socketPath).then(()=>true,()=>false),'Redis socket');reader=createClient({socket:{path:socketPath,reconnectStrategy:false}});reader.on('error',()=>{});await reader.connect()
 const configFile=path.join(directory,'agent-host.yaml'),bindingsFile=path.join(directory,'agent-bindings.yaml')
 const configText=JSON.stringify({version:1,instance,dataDir,model:{baseUrl:`http://127.0.0.1:${port}/model/v1`,name:'pixiv-tool-fixture',apiKeyEnv:'PIXIV_TOOLS_MODEL_KEY'},connections:[{id:'main',url:`ws://127.0.0.1:${port}/onebot`,accessTokenEnv:'PIXIV_TOOLS_QQ_TOKEN'}],tools:{pixiv:{enabled,cookieEnv:enabled?'PIXIV_TOOLS_COOKIE':'PIXIV_MISSING_COOKIE'}},mediaRelay:{enabled:false,bridges:[{connectionId:'main',listen:{host:'127.0.0.1',port:bridgePort},advertisedOrigin:`http://127.0.0.1:${bridgePort}`,allowedPeers:['127.0.0.1']}]},memorySystem:{enabled:false},midtermMemory:{enabled:false},episodicMemory:{enabled:false},groupMemory:{enabled:false},simulation:{wake:{batchWindowMs:1000,proactiveProbability:0,probability:0},rhythm:{enabled:false},reflection:{enabled:false},turn:{minSendGapMs:0}}})
 const bindingsText=JSON.stringify({version:1,agents:[{id:'daily',personaId:'default'}],connections:[{id:'main',platform:'qq',namespace:'global',accountId:String(BOT)}],bindings:[{connectionId:'main',kind:'group',conversationId:String(GROUP),agentId:'daily'}]})
 await writeFile(configFile,configText);await writeFile(bindingsFile,bindingsText)
 const env={...process.env,BL_AGENT_REDIS_URL:`unix://${socketPath}`,PIXIV_TOOLS_MODEL_KEY:KEY,PIXIV_TOOLS_QQ_TOKEN:TOKEN,PIXIV_TOOLS_COOKIE:COOKIE,PIXIV_RELAY_AUDIT_URL:`http://127.0.0.1:${port}/audit`};delete env.PIXIV_MISSING_COOKIE
 const launch=check=>{child=spawn(process.execPath,['--import',pathToFileURL(preload).href,entry,'--config',configFile,...check?['--check']:[]],{cwd:directory,env});exited=once(child,'exit');for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk})}
 const drained=async()=>{const state=JSON.parse(await reader.get(prefix+simulationSessionKey(scope))||'null');return state?.lastWakeAt&&!state.queuedIngressWake&&!await reader.exists(prefix+simulationBusyKey(scope))}
 const ingress=next=>{epoch++;turn=next;finished=false;const source={post_type:'message',message_type:'group',sub_type:'normal',self_id:BOT,group_id:GROUP,user_id:USER,sender:{user_id:USER,nickname:'Pixiv工具验收员'},message_id:98100+epoch,time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:String(BOT)}},{type:'text',data:{text:next.text}}],raw_message:next.text};sources.set(String(source.message_id),source);websocket.send(JSON.stringify(source));return source}
 let currentConfigText=configText
 const assertNoBridge=()=>assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
 return{external,deliveries,models,toolResults,lookups,errors,reader,prefix,ingress,assertNoBridge,get abortedSearch(){return abortedSearch},async settled(){return!await reader.exists(prefix+simulationBusyKey(scope))},async invalidateConfig(){configCurrent=false;currentConfigText=configText+'\n# fixture invalidates the exact active host revision\n';await writeFile(configFile,currentConfigText)},async start(){launch(true);assert.deepEqual(await exited,[0,null],log);assert.equal(JSON.parse(log).mode,'check');assert.deepEqual(external,[]);assert.equal(models.length,0);assert.deepEqual(await reader.keys(prefix+'*'),[]);await assert.rejects(stat(dataDir),{code:'ENOENT'});await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`));log='';phase='run';launch(false);await waitFor(()=>{if(child.exitCode!==null)assert.fail(`CLI exited early: ${log}`);return log.includes('已启动')&&websocket},'CLI ready')},async run(next){const source=ingress(next);await waitFor(()=>finished,'model consumed Pixiv tool receipt');await waitFor(drained,'simulated human turn drained');assert.deepEqual(errors,[]);return source},async session(){const keys=await reader.keys(prefix+'agent:pixiv-tools:v1:session:*');assert.equal(keys.length,1);return JSON.parse(await reader.get(keys[0]))},async stop(){child.kill('SIGTERM');assert.deepEqual(await exited,[0,null],log);await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`));assert.deepEqual(errors,[])},async clean(){assert.equal(await readFile(configFile,'utf8'),currentConfigText);assert.equal(await readFile(bindingsFile,'utf8'),bindingsText);const variants=[COOKIE_VALUE,COOKIE,KEY,TOKEN].flatMap(value=>[value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('base64url')]);for(const content of[log,await redisText(reader,prefix),await files(dataDir),JSON.stringify(models)])for(const value of[...variants,'i.pximg.net','PIXIV_TOOLS_UPSTREAM_PRIVATE','PIXIV_TOOLS_THUMB_PRIVATE',...capabilities,...images.map(bytes=>bytes.toString('base64'))])assert.equal(content.includes(value),false,'persisted state/log/model exclude credentials, CDN URLs, image bytes and capabilities');for(const url of capabilities)await assert.rejects(fetch(url));}}
}

test('actual CLI Pixiv tools independently send a sharp list, preserve ordered full galleries, replace selection and freeze unknown direct-ID retry/fallback', {timeout:90000},async t=>{
 const run=await fixture(t,true);await run.start()
 const searchA=await run.run({tool:'pixivSearchTool',input:{keyword:'合成甲',orderBy:'newest'},text:'请在Pixiv搜索合成甲。仅群内背景不交给外部。'});assert.equal((await run.session()).data.items[0].id,A)
 await run.run({tool:'pixivDownloadTool',input:{target:'1'},id:A,text:'请下载刚才列表的第1项完整作品。'})
 const searchB=await run.run({tool:'pixivSearchTool',input:{keyword:'合成乙',orderBy:'newest'},text:'请重新在Pixiv搜索合成乙，替换刚才列表。'});assert.equal((await run.session()).data.items[0].id,B)
 await run.run({tool:'pixivDownloadTool',input:{target:'1'},id:B,text:'请下载最新列表的第1项完整作品。'})
 await run.run({tool:'pixivDownloadTool',input:{target:A},id:A,unknown:true,text:`直接下载Pixiv作品ID ${A} 的完整作品。`})
 assert.deepEqual(run.deliveries.map(item=>[item.kind,item.id]),[['card',undefined],['relay',A],['card',undefined],['relay',B],['relay',A]])
 assert.ok(run.lookups.includes(String(searchA.message_id)));assert.ok(run.lookups.includes(String(searchB.message_id)));assert.ok(run.deliveries.filter(item=>item.kind==='relay').every(item=>JSON.stringify(item.owned)===JSON.stringify(images.map(sha))))
 const attempts=await Promise.all((await run.reader.keys(run.prefix+'agent:pixiv-tools:v1:attempt:*')).map(async key=>JSON.parse(await run.reader.get(key))));assert.equal(attempts.filter(item=>item.state==='unknown').length,1)
 assert.equal(run.toolResults.filter(row=>row.tool_call_id.startsWith('5-')).length,3);assert.ok(run.toolResults.filter(row=>row.tool_call_id.startsWith('5-')).every(row=>/unknown|未知|未确认|尚未确认|重发|补发/u.test(String(row.content))))
 await run.stop();await run.clean()
})

test('actual CLI disabled Pixiv tools expose no model functions, read no missing credential and bind no bridge or platform HTTP', {timeout:75000},async t=>{
 const run=await fixture(t,false);await run.start();await run.assertNoBridge();await run.run({text:'本轮只确认Pixiv工具未开放，不搜索。'});assert.deepEqual(run.external,[]);assert.equal(run.deliveries.length,1);assert.ok(run.models.every(body=>!body.tools.some(item=>['pixivSearchTool','pixivDownloadTool'].includes(item.function.name))));await run.stop();await run.clean()
})

test('actual CLI host revision change aborts a pending Pixiv search socket and permits no late list or relay', {timeout:75000},async t=>{
 const run=await fixture(t,true,{holdSearch:true});await run.start();run.ingress({tool:'pixivSearchTool',input:{keyword:'合成甲'},text:'请在Pixiv搜索合成甲，测试配置修订期间的取消。'})
 await waitFor(()=>run.external.some(value=>new URL(value).pathname.startsWith('/ajax/search/artworks/')),'pending native Pixiv HTTP search')
 await run.invalidateConfig();await waitFor(()=>run.abortedSearch===1,'active provider socket closed on exact config revision change');await waitFor(run.settled,'invalidated simulated turn releases its lock')
 assert.equal(run.deliveries.length,0);assert.equal(run.external.length,1);await run.stop();await run.clean()
})
