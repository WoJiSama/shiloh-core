import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo)
const {createPixivSearchHttp,pixivSearchMetadataUrl,pixivSearchOfficialUrl,pixivSearchGuard}=await import(pathToFileURL(path.join(release,'dist/backend/modules/media/infrastructure/agentPixivSearchHttp.js')).href)
const ID='123456789',OTHER='123456790',USER='987654321',MiB=1024*1024,COOKIE='PIXIV_SEARCH_COOKIE_12345',IMAGE=`https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/16/${ID}_p0_square1200.jpg`
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),lookup=async()=>[{address:'8.8.8.8',family:4}],response=(body='{}',extra={})=>({status:200,headers:{'content-type':'application/json'},body,...extra})
const targets=[{kind:'search',keyword:'初音 未来',order:'date_d'},{kind:'ranking',mode:'daily',page:1},{kind:'profile',userId:USER},{kind:'detail',id:ID}]
async function closeServer(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}

test('closed metadata vocabulary accepts only its own search/ranking/profile/detail path and exact parameters',()=>{
 for(const target of targets){const url=pixivSearchMetadataUrl(target);assert.equal(pixivSearchOfficialUrl(url,target).href,url)
  for(const input of [url+'&extra=1',url.replace('https:','http:'),url.replace('www.pixiv.net','www.pixiv.net:443'),url.replace('www.pixiv.net','www.pixiv.net@evil.test'),url.replace('www.pixiv.net','pixiv.net'),url+'#x',url.replace('/ajax/','/a/../ajax/'),url.replace('lang=zh','lang=en')])if(input!==url)assert.throws(()=>pixivSearchOfficialUrl(input,target),input)
 }
 const search=targets[0],url=pixivSearchMetadataUrl(search)
 for(const input of [url.replace('word=%E5%88%9D%E9%9F%B3%20%E6%9C%AA%E6%9D%A5','word=borrowed'),url+'&word=borrowed',url.replace('mode=safe','mode=all'),url.replace('p=1','p=2'),url.replace('order=date_d','order=popular_d')])assert.throws(()=>pixivSearchOfficialUrl(input,search))
 for(const target of [{kind:'search',keyword:'..',order:'date_d'},{kind:'search',keyword:'x',order:'unknown'},{kind:'ranking',mode:'male',page:1},{kind:'ranking',mode:'daily',page:3},{kind:'profile',userId:'01'},{kind:'detail',id:'0'},{kind:'unknown'}])assert.throws(()=>pixivSearchMetadataUrl(target))
})

test('thumbnail policy permits safe Pixiv page-zero names and rejects artwork borrowing, profile icons and later pages',()=>{
 const target={kind:'thumbnail',id:ID}
 for(const input of [IMAGE,`https://i.pximg.net/img-original/img/2026/${ID}_p0.png`,`https://i.pximg.net/a/${ID}_p0_custom1200.jpg`,`https://i.pximg.net/a/${ID}_ugoira0.jpg`])assert.equal(pixivSearchOfficialUrl(input,target).href,input)
 for(const input of [IMAGE.replace(ID,OTHER),IMAGE.replace('_p0_','_p1_'),IMAGE.replace('i.pximg.net','i.pximg.net.evil.test'),IMAGE.replace('i.pximg.net','i.pximg.net:443'),IMAGE.replace('i.pximg.net','i.pximg.net.'),IMAGE.replace('/c/','/%2e%2e/'),IMAGE.replace('/c/','/a/../'),IMAGE+'#x',`https://i.pximg.net/user-profile/img/${ID}.png`,`https://i.pximg.net/a/${ID}_ugoira1.jpg`,`https://i.pximg.net/a/${ID}_ugoira1920x1080.zip`])assert.throws(()=>pixivSearchOfficialUrl(input,target))
})

test('metadata Cookie stays on its original exact route and is never emitted to thumbnail CDN',async()=>{
 const seen=[],read=createPixivSearchHttp({authCookie:`Cookie: PHPSESSID=${COOKIE};`,lookup,allows:()=>true,request:async(url,address,signal,policy)=>{seen.push({url:url.href,address,signal,policy});return response(url.hostname==='i.pximg.net'?'pixels':'{}',{headers:{'content-type':url.hostname==='i.pximg.net'?'image/jpeg':'application/json'}})}}),guard=pixivSearchGuard(scope(),1000)
 try{for(const target of targets)await read(pixivSearchMetadataUrl(target),target,guard,2*MiB);await read(IMAGE,{kind:'thumbnail',id:ID},guard,3*MiB)}finally{guard.close()}
 assert.deepEqual(seen.map(call=>call.policy.headers.Cookie),[...targets.map(()=>`PHPSESSID=${COOKIE};`),undefined]);assert.ok(seen.every(call=>call.address.address==='8.8.8.8'&&call.policy.headers.Referer==='https://www.pixiv.net/'))
})

test('metadata redirects cannot switch kind/identity/query before a second DNS lookup or Cookie disclosure',async()=>{
 const target={kind:'detail',id:ID},url=pixivSearchMetadataUrl(target)
 for(const location of [url.replace(ID,OTHER),url.replace('/illust/','/user/'),url+'&borrow=1',IMAGE,'https://evil.test/data','//www.pixiv.net:443/ajax/illust/'+ID+'?lang=zh','/ajax/illust/../illust/'+ID+'?lang=zh']){
  let dns=0,requests=0,closed=0;const read=createPixivSearchHttp({authCookie:`PHPSESSID=${COOKIE}`,allows:()=>true,lookup:async()=>{dns++;return lookup()},request:async()=>{requests++;return response('',{status:302,headers:{location},close(){closed++}})}}),guard=pixivSearchGuard(scope(),1000)
  try{await assert.rejects(read(url,target,guard,2*MiB))}finally{guard.close()};assert.equal(dns,1);assert.equal(requests,1);assert.equal(closed,1)
 }
})

test('safe redirects re-resolve pinned public addresses and cannot bypass a URL secret predicate',async()=>{
 let calls=0,closed=0;const hosts=[],read=createPixivSearchHttp({allows:value=>!value.includes('PRIVATE_TOKEN'),lookup:async host=>{hosts.push(host);return lookup()},request:async()=>++calls===1?response('',{status:302,headers:{location:'?size=regular'},close(){closed++}}):response('pixels',{headers:{'content-type':'image/jpeg'},close(){closed++}})}),guard=pixivSearchGuard(scope(),1000)
 try{assert.equal((await read(IMAGE,{kind:'thumbnail',id:ID},guard,3*MiB)).bytes.toString(),'pixels')}finally{guard.close()};assert.deepEqual(hosts,['i.pximg.net','i.pximg.net']);assert.equal(closed,2)
 let dns=0;const blocked=createPixivSearchHttp({allows:value=>!value.includes('PRIVATE_TOKEN'),lookup:async()=>{dns++;return lookup()},request:async()=>response('',{status:302,headers:{location:'?borrow=PRIVATE_TOKEN'}})}),own=pixivSearchGuard(scope(),1000)
 try{await assert.rejects(blocked(IMAGE,{kind:'thumbnail',id:ID},own,1024))}finally{own.close()};assert.equal(dns,1)
})

test('mixed/private/malformed DNS never reaches a request seam',async()=>{
 for(const records of [[],[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'::ffff:127.0.0.1',family:6}],[{address:'8.8.8.8',family:6}]]){let calls=0;const read=createPixivSearchHttp({allows:()=>true,lookup:async()=>records,request:async()=>{calls++;return response()}}),guard=pixivSearchGuard(scope(),1000)
  try{await assert.rejects(read(pixivSearchMetadataUrl(targets[0]),targets[0],guard,2*MiB))}finally{guard.close()};assert.equal(calls,0)
 }
})

for(const mode of ['partial','compression','length','mismatch','stream','empty','body-error','wrong-mime'])test(`bounded metadata ${mode} rejects safely and closes transport`,async()=>{
 let closed=0;const read=createPixivSearchHttp({allows:()=>true,lookup,request:async()=>response(mode==='empty'?'':mode==='body-error'?(async function*(){throw Error('PRIVATE_STREAM_CREDENTIAL')})():Buffer.alloc(mode==='stream'?1025:4),{...(mode==='partial'?{status:206}:{}),headers:{'content-type':mode==='wrong-mime'?'text/html':'application/json',...(mode==='compression'?{'content-encoding':'gzip'}:mode==='length'?{'content-length':'1025'}:mode==='mismatch'?{'content-length':'8'}:{})},close(){closed++}})}),guard=pixivSearchGuard(scope(),1000)
 try{await assert.rejects(read(pixivSearchMetadataUrl(targets[0]),targets[0],guard,1024),error=>!String(error).includes('PRIVATE_STREAM_CREDENTIAL'))}finally{guard.close()};assert.equal(closed,1)
})

test('real loopback streamed metadata obeys2MiB/complete-body checks and cancellation closes the HTTP socket',async t=>{
 let disconnected=false;const server=http.createServer((request,output)=>{output.setHeader('content-type','application/json');if(request.url.includes('oldest')){output.write('{');output.on('close',()=>{disconnected=true})}else if(request.url.includes('large')){output.write(Buffer.alloc(MiB));output.end(Buffer.alloc(MiB+1))}else output.end('{"error":false,"body":{"ok":true}}')})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server))
 const read=createPixivSearchHttp({lookup,allows:()=>true,request:(url,address,signal)=>new Promise((resolve,reject)=>{assert.equal(address.address,'8.8.8.8');const request=http.get({host:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,signal},incoming=>{incoming.on('error',()=>{});resolve(response(incoming,{status:incoming.statusCode,headers:{'content-type':incoming.headers['content-type'],'content-length':incoming.headers['content-length']},close(){incoming.destroy();request.destroy()}}))});request.on('error',reject)})}),guard=pixivSearchGuard(scope(),2000)
 try{const good={kind:'search',keyword:'good',order:'date_d'},large={kind:'search',keyword:'large',order:'date_d'};assert.equal(JSON.parse((await read(pixivSearchMetadataUrl(good),good,guard,2*MiB)).bytes).body.ok,true);await assert.rejects(read(pixivSearchMetadataUrl(large),large,guard,2*MiB))}finally{guard.close()}
 const cancel=new AbortController(),own=pixivSearchGuard(scope({signal:cancel.signal}),2000),held={kind:'search',keyword:'oldest',order:'date'},operation=read(pixivSearchMetadataUrl(held),held,own,2*MiB),rejected=assert.rejects(operation)
 await delay(20);cancel.abort();await rejected;own.close();for(let i=0;i<40&&!disconnected;i++)await delay(5);assert.equal(disconnected,true)
})
