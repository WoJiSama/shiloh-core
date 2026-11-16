import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo)
const {createPixivHttp,normalizePixivCookie,pixivBody,pixivGuard,pixivOfficialUrl,PIXIV_USER_AGENT}=await import(pathToFileURL(path.join(release,'dist/backend/modules/media/infrastructure/agentPixivRelayHttp.js')).href)
const ID='123456789',OTHER='123456790',META=`https://www.pixiv.net/ajax/illust/${ID}`,IMAGE=`https://i.pximg.net/img-master/img/2026/11/16/${ID}_p0_master1200.png`,COOKIE='HOST_PIXIV_COOKIE_123456'
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),lookup=async()=>[{address:'8.8.8.8',family:4}]
const response=(body,extra={})=>({status:200,headers:{'content-type':'image/png'},body,...extra})
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{resolve,promise}}
async function bounded(operation){let timer;try{return await Promise.race([operation,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error('fixture timeout')),2500)})])}finally{clearTimeout(timer)}}
async function closeServer(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}

test('URL policy fixes exact metadata endpoint and image artwork/page identity before networking',()=>{
 for(const value of [META,META+'/pages'])assert.equal(pixivOfficialUrl(value,'metadata',{id:ID}).href,value)
 for(const value of ['http://www.pixiv.net/ajax/illust/'+ID,META+'?cache=1',META+'#fragment',META+'/',META.replace(ID,OTHER),META.replace('www.pixiv.net','pixiv.net'),META.replace('www.pixiv.net','www.pixiv.net:443'),META.replace('www.pixiv.net','user@www.pixiv.net'),META.replace('www.pixiv.net','127.0.0.1'),'https://www.pixiv.net/a/../ajax/illust/'+ID,'https://www.pixiv.net/ajax/%69llust/'+ID])assert.throws(()=>pixivOfficialUrl(value,'metadata',{id:ID}),value)
 for(const value of [IMAGE,IMAGE+'?signature=public',`https://i.pximg.net/a/${ID}_ugoira0.jpg`])assert.equal(pixivOfficialUrl(value,'image',{id:ID,index:0}).href,value)
 for(const value of [IMAGE.replace(ID,OTHER),IMAGE.replace('_p0_','_p1_'),IMAGE.replace('i.pximg.net','i.pximg.net.evil.test'),IMAGE.replace('i.pximg.net','i.pximg.net:443'),IMAGE.replace('i.pximg.net','i.pximg.net.'),IMAGE.replace('/img-master/','/%2e%2e/'),IMAGE.replace('/img-master/','/a/../'),IMAGE+'%0d',IMAGE+'#fragment',`https://i.pximg.net/a/${ID}_ugoira1.jpg`,`https://i.pximg.net/a/${ID}_ugoira1920x1080.zip`])assert.throws(()=>pixivOfficialUrl(value,'image',{id:ID,index:0}),value)
 for(const index of [undefined,-1,2000,0.5,NaN,'0'])assert.throws(()=>pixivOfficialUrl(IMAGE,'image',{id:ID,index}))
 for(const id of ['0','01','1234567890123',OTHER])assert.throws(()=>pixivOfficialUrl(IMAGE,'image',{id,index:0}))
})

test('host and direct construction use the same normalized bounded Cookie grammar',()=>{
 for(const input of [`PHPSESSID=${COOKIE}`,` Cookie: PHPSESSID=${COOKIE};`,`PHPSESSID=${COOKIE}; token=a=b`])assert.equal(normalizePixivCookie(input),input.replace(/^\s*cookie\s*:\s*/iu,'').trim())
 for(const input of ['Cookie:',' ',';','PHPSESSID=','PHPSESSID=value; PHPSESSID=other','PHPSESSID=value;;','PHPSESSID=value;; token=value','PHPSESSID=value; ; token=value','bad key=value','a'.repeat(101)+'=value','PHPSESSID=has space','PHPSESSID=value\r\nCookie:evil','PHPSESSID=非ASCII','PHPSESSID='+'x'.repeat(32768)]){
  assert.throws(()=>normalizePixivCookie(input));assert.throws(()=>createPixivHttp({authCookie:input,allows:()=>true}))
 }
 assert.equal(normalizePixivCookie(undefined),'');assert.equal(normalizePixivCookie(''),'')
})

test('public DNS validation rejects any private/malformed answer before dispatch and pins the first public address',async()=>{
 const invalid=[[],[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'::ffff:127.0.0.1',family:6}],[{address:'8.8.8.8',family:6}],Array(33).fill({address:'8.8.8.8',family:4})]
 for(const addresses of invalid){let requests=0;const read=createPixivHttp({lookup:async()=>addresses,allows:()=>true,request:async()=>{requests++;return response('x')}}),guard=pixivGuard(scope(),1000);try{await assert.rejects(read(IMAGE,'image',guard,1024,{id:ID,index:0}))}finally{guard.close()};assert.equal(requests,0)}
 let pinned;const read=createPixivHttp({lookup:async()=>[{address:'8.8.4.4',family:4},{address:'8.8.8.8',family:4}],allows:()=>true,request:async(_url,address)=>{pinned=address;return response('x')}}),guard=pixivGuard(scope(),1000)
 try{assert.equal((await pixivBody(await read(IMAGE,'image',guard,1024,{id:ID,index:0}))).toString(),'x')}finally{guard.close()};assert.deepEqual(pinned,{address:'8.8.4.4',family:4})
})

test('Cookie is metadata-only and all requests use fixed host-owned headers',async()=>{
 const seen=[],read=createPixivHttp({authCookie:`Cookie: PHPSESSID=${COOKIE};`,lookup,allows:()=>true,request:async(url,_address,signal,policy)=>{seen.push({url:url.href,signal,policy});return response('x')}}),guard=pixivGuard(scope(),1000)
 try{for(const [url,kind,target] of [[META,'metadata',{id:ID}],[META+'/pages','metadata',{id:ID}],[IMAGE,'image',{id:ID,index:0}]])await pixivBody(await read(url,kind,guard,1024,target))}finally{guard.close()}
 assert.deepEqual(seen.map(call=>call.policy.headers.Cookie),[`PHPSESSID=${COOKIE};`,`PHPSESSID=${COOKIE};`,undefined])
 for(const call of seen){assert.equal(call.policy.maxBytes,1024);assert.equal(call.policy.headers['User-Agent'],PIXIV_USER_AGENT);assert.equal(call.policy.headers.Referer,'https://www.pixiv.net/');assert.equal(call.policy.headers['Proxy-Authorization'],undefined)}
})

test('every redirect revalidates artwork/page/path before DNS or credentials are reused',async()=>{
 for(const location of [META.replace(ID,OTHER),META+'/pages',IMAGE,'https://evil.test/borrow','//www.pixiv.net:443/ajax/illust/'+ID,'/ajax/illust/'+ID+'?borrow=1','/ajax/illust/../illust/'+ID]){
  let dns=0,requests=0,closed=0;const read=createPixivHttp({authCookie:`PHPSESSID=${COOKIE}`,allows:()=>true,lookup:async()=>{dns++;return lookup()},request:async()=>{requests++;return response('',{status:302,headers:{location},close(){closed++}})}}),guard=pixivGuard(scope(),1000)
  try{await assert.rejects(read(META,'metadata',guard,1024,{id:ID}))}finally{guard.close()};assert.equal(dns,1);assert.equal(requests,1);assert.equal(closed,1)
 }
 for(const location of [IMAGE.replace(ID,OTHER),IMAGE.replace('_p0_','_p1_'),META]){let requests=0;const read=createPixivHttp({lookup,allows:()=>true,request:async()=>{requests++;return response('',{status:302,headers:{location}})}}),guard=pixivGuard(scope(),1000);try{await assert.rejects(read(IMAGE,'image',guard,1024,{id:ID,index:0}))}finally{guard.close()};assert.equal(requests,1)}
})

test('legal same-page redirects are bounded, re-resolve public DNS and honor URL secret policy',async()=>{
 const seen=[],hosts=[];let closed=0;const read=createPixivHttp({lookup:async host=>{hosts.push(host);return lookup()},allows:value=>!value.includes('HOST_SECRET'),request:async(url)=>{seen.push(url.href);return seen.length===1?response('',{status:302,headers:{location:'?size=regular'},close(){closed++}}):response('pixels',{close(){closed++}})}}),guard=pixivGuard(scope(),1000)
 try{assert.equal((await pixivBody(await read(IMAGE,'image',guard,1024,{id:ID,index:0}))).toString(),'pixels')}finally{guard.close()};assert.deepEqual(seen,[IMAGE,IMAGE+'?size=regular']);assert.deepEqual(hosts,['i.pximg.net','i.pximg.net']);assert.equal(closed,2)
 let calls=0;const blocked=createPixivHttp({lookup,allows:value=>!value.includes('HOST_SECRET'),request:async()=>{calls++;return response('',{status:302,headers:{location:'?borrow=HOST_SECRET'}})}}),second=pixivGuard(scope(),1000)
 try{await assert.rejects(blocked(IMAGE,'image',second,1024,{id:ID,index:0}))}finally{second.close()};assert.equal(calls,1)
 let loops=0;const circular=createPixivHttp({lookup,allows:()=>true,request:async()=>{loops++;return response('',{status:302,headers:{location:IMAGE}})}}),third=pixivGuard(scope(),1000)
 try{await assert.rejects(circular(IMAGE,'image',third,1024,{id:ID,index:0}))}finally{third.close()};assert.equal(loops,5)
})

for(const mode of ['partial','compressed','invalid-length','length-limit','incomplete','empty','stream-limit','stream-error'])test(`response ${mode} fails safely and closes its transport`,async()=>{
 let closed=0,iterated=false;const body=(async function*(){iterated=true;if(mode==='stream-error')throw Error('PRIVATE_TRANSPORT_COOKIE');yield Buffer.alloc(mode==='stream-limit'?1025:4)})()
 const read=createPixivHttp({lookup,allows:()=>true,request:async()=>response(mode==='empty'?'':body,{...(mode==='partial'?{status:206}:{}),headers:{'content-type':'image/png',...(mode==='compressed'?{'content-encoding':'gzip'}:mode==='invalid-length'?{'content-length':'1e3'}:mode==='length-limit'?{'content-length':'1025'}:mode==='incomplete'?{'content-length':'8'}:{})},close(){closed++}})}),guard=pixivGuard(scope(),1000)
 try{await assert.rejects(async()=>pixivBody(await read(IMAGE,'image',guard,1024,{id:ID,index:0})),error=>!String(error).includes('PRIVATE_TRANSPORT_COOKIE'))}finally{guard.close()};assert.equal(closed,1)
 if(['partial','compressed','invalid-length','length-limit'].includes(mode))assert.equal(iterated,false)
})

test('consumption observes the full over-limit chunk and earlier chunks, including a failed stream',async()=>{
 const observed=[],read=createPixivHttp({lookup,allows:()=>true,request:async()=>response((async function*(){yield Buffer.alloc(600);yield Buffer.alloc(600)})())}),guard=pixivGuard(scope(),1000)
 try{await assert.rejects(pixivBody(await read(IMAGE,'image',guard,1024,{id:ID,index:0},bytes=>observed.push(bytes))),error=>error.code==='pixiv_bytes_limit')}finally{guard.close()};assert.deepEqual(observed,[600,600])
})

test('real loopback HTTP stream seam counts overflow and cancellation closes the live socket',async t=>{
 let disconnected=false;const server=http.createServer((request,output)=>{output.setHeader('content-type','image/png');if(request.url.includes('_good.')){output.setHeader('content-length','4');output.end('PNG!')}else if(request.url.includes('_large.')){output.write(Buffer.alloc(600));output.end(Buffer.alloc(600))}else{output.on('close',()=>{disconnected=true});output.write('PN')}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server))
 const read=createPixivHttp({lookup,allows:()=>true,request:(url,address,signal)=>new Promise((resolve,reject)=>{assert.equal(address.address,'8.8.8.8');const request=http.get({host:'127.0.0.1',port:server.address().port,path:url.pathname,signal},incoming=>{incoming.on('error',()=>{});resolve(response(incoming,{status:incoming.statusCode,headers:{'content-type':incoming.headers['content-type'],'content-length':incoming.headers['content-length']},close(){incoming.destroy();request.destroy()}}))});request.on('error',reject)})}),guard=pixivGuard(scope(),2000)
 try{assert.equal((await pixivBody(await read(`https://i.pximg.net/a/${ID}_p0_good.png`,'image',guard,1024,{id:ID,index:0}))).toString(),'PNG!');let consumed=0;await assert.rejects(pixivBody(await read(`https://i.pximg.net/a/${ID}_p0_large.png`,'image',guard,1024,{id:ID,index:0},bytes=>{consumed+=bytes})));assert.equal(consumed,1200)}finally{guard.close()}
 const cancel=new AbortController(),own=pixivGuard(scope({signal:cancel.signal}),2000)
 try{const result=await read(`https://i.pximg.net/a/${ID}_p0_hold.png`,'image',own,1024,{id:ID,index:0}),operation=pixivBody(result);cancel.abort();await bounded(assert.rejects(operation))}finally{own.close()}
 for(let at=0;at<50&&!disconnected;at++)await delay(5);assert.equal(disconnected,true)
})

test('cancellation and stale context reject ignored late responses and close them once delivered',async()=>{
 for(const mode of ['abort','stale']){const entered=gate(),held=gate(),cancel=new AbortController();let current=true,closed=0
  const read=createPixivHttp({lookup,allows:()=>true,request:async()=>{entered.resolve();await held.promise;return response('late',{close(){closed++}})}}),guard=pixivGuard(scope({signal:cancel.signal,isCurrent:()=>current}),1000),operation=read(IMAGE,'image',guard,1024,{id:ID,index:0})
  await entered.promise;if(mode==='abort')cancel.abort();else current=false
  try{await bounded(assert.rejects(operation));held.resolve();for(let at=0;at<50&&!closed;at++)await delay(5);assert.equal(closed,1)}finally{held.resolve();guard.close()}
 }
})
