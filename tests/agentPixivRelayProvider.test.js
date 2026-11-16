import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo),at=file=>import(pathToFileURL(path.join(release,`dist/backend/modules/media/infrastructure/${file}.js`)).href)
const {createAgentPixivRelayProvider}=await at('agentPixivRelayProvider'),{createAgentMediaArtifactStore}=await at('agentMediaArtifactStore'),{createPixivHttp,pixivBody,pixivGuard,pixivOfficialUrl}=await at('agentPixivRelayHttp')
const ID='123456789',OTHER='123456790',MiB=1024*1024,COOKIE='PIXIV_HOST_SESSION_12345'
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=','base64')
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),share=()=>({provider:'pixiv',reference:{kind:'artwork',id:ID}})
const image=(index,id=ID,variant='regular')=>`https://i.pximg.net/img-master/img/2026/11/16/00/00/00/${id}_p${index}_${variant}.png`
const pages=(count=3)=>Array.from({length:count},(_,index)=>({urls:{regular:image(index),small:image(index,ID,'small'),original:image(index,ID,'original')}}))
const detail=(extra={})=>({id:ID,title:'目标作品',description:'完整<br>简介 &amp; 文字',userName:'画师',pageCount:3,xRestrict:0,width:100,height:200,tags:{tags:[{tag:'风景'},{tag:'艺术'}]},viewCount:0,likeCount:22,bookmarkCount:9,commentCount:2,urls:{regular:image(0)},...extra})
const response=(body,mime='application/json',extra={})=>({status:200,headers:{'content-type':mime},body:typeof body==='object'&&!(body instanceof Uint8Array)&&!body[Symbol.asyncIterator]?JSON.stringify(body):body,...extra})
const payload=body=>response({error:false,body}),gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
async function bounded(operation){let timer;try{return await Promise.race([operation,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error('fixture timeout')),2500)})])}finally{clearTimeout(timer)}}
async function fixture(t,settings={}){
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'pixiv-provider-test-')));await chmod(directory,0o700);const artifacts=await createAgentMediaArtifactStore({directory}),requests=[],prepared=[]
 const provider=createAgentPixivRelayProvider({directory,artifacts,lookup:async()=>[{address:'8.8.8.8',family:4}],request:async(url,address,signal,policy)=>{
  requests.push({url:url.href,address,signal,policy});return await settings.respond?.(url,signal,policy,requests)??(url.hostname==='www.pixiv.net'?payload(url.pathname.endsWith('/pages')?settings.pages??pages():settings.detail??detail()):response(PNG,'image/png'))
 },...settings.options})
 t.after(async()=>{await Promise.allSettled(prepared.map(item=>item.release()));await artifacts.close();assert.deepEqual(await readdir(directory),[]);await rm(directory,{recursive:true,force:true})})
 return{directory,requests,async prepare(input=share(),context=scope()){const result=await provider.prepare(input,context);prepared.push(result);return result},async bytes(artifact){const reader=await artifacts.open(artifact,scope()),chunks=[];try{for await(const bytes of reader.chunks)chunks.push(Buffer.from(bytes));return Buffer.concat(chunks)}finally{await reader.close()}},async empty(){for(const entry of await readdir(directory,{withFileTypes:true})){assert.equal(entry.isDirectory(),true);assert.match(entry.name,/^agent-media-/u);assert.deepEqual(await readdir(path.join(directory,entry.name)),[])}}}
}

test('fixed artwork metadata and pages prepare parallel, regular images stay in page order and every byte is leased',async t=>{
 const entered=gate(),held=gate();let metadata=0
 const f=await fixture(t,{respond:async url=>{if(url.hostname==='www.pixiv.net'){metadata++;if(metadata===2)entered.resolve();await held.promise}}}),operation=f.prepare();await entered.promise;held.resolve();const result=await operation
 assert.equal(result.status,'ready');assert.equal(result.pageUrl,`https://www.pixiv.net/artworks/${ID}`);assert.deepEqual(result.plan.items.map(item=>item.parts[0].kind),['text','image','image','image'])
 assert.match(result.infoText,/画师:画师/);assert.match(result.infoText,/浏览:0/);assert.match(result.infoText,/风景、艺术/);assert.match(result.infoText,/完整 简介 & 文字/)
 assert.deepEqual(f.requests.slice(2).map(call=>call.url),[image(0),image(1),image(2)])
 for(const item of result.plan.items.slice(1)){assert.deepEqual(await f.bytes(item.parts[0].artifact),PNG);assert.equal(item.parts[0].artifact.sha256,createHash('sha256').update(PNG).digest('hex'))}
 for(const value of ['pximg.net',f.directory])assert.equal(JSON.stringify(result).includes(value),false)
 await result.release();await result.release();await f.empty()
})

test('invalid page identities preserve the original slot and safe candidates prefer regular then small then original',async t=>{
 const list=pages();list[0].urls.regular='https://evil.test/borrow.png';list[1].urls={regular:image(2)};list[2].urls={regular:image(2,OTHER),small:image(2,OTHER),original:image(2,ID,'original')}
 const f=await fixture(t,{pages:list}),result=await f.prepare()
 assert.equal(result.plan.items.length,3);assert.deepEqual(f.requests.slice(2).map(call=>call.url),[image(0,ID,'small'),image(2,ID,'original')]);assert.match(result.infoText,/第2页图片暂时获取失败或来源未通过验证/)
 assert.equal(f.requests.some(call=>call.url.includes(OTHER)),false)
})

test('a failed middle page keeps page zero and page two, with exact failure positions',async t=>{
 const f=await fixture(t,{respond:url=>url.href===image(1)?response('',undefined,{status:403}):undefined}),result=await f.prepare()
 assert.deepEqual(f.requests.slice(2).map(call=>call.url),[image(0),image(1),image(2)]);assert.equal(result.plan.items.length,3);assert.match(result.infoText,/第2页图片暂时获取失败/)
})

test('only the first five original slots are attempted; missing entries do not shift later pages into the cap',async t=>{
 const list=pages(7);list[0]={urls:{regular:image(1)}}
 const f=await fixture(t,{detail:detail({pageCount:7}),pages:list}),result=await f.prepare()
 assert.equal(result.plan.items.length,5);assert.match(result.infoText,/共7页，仅附前5页/);assert.match(result.infoText,/第1页图片暂时获取失败/)
 assert.deepEqual(f.requests.slice(2).map(call=>call.url),[image(1),image(2),image(3),image(4)])
})

for(const mode of ['failed','empty','all-invalid'])test(`pages ${mode} falls back only to the target body.urls page zero`,async t=>{
 const f=await fixture(t,{pages:mode==='empty'?[]:pages().map((entry,index)=>({urls:{regular:image(index,OTHER)}})),respond:url=>mode==='failed'&&url.pathname.endsWith('/pages')?response('',undefined,{status:403}):undefined}),result=await f.prepare()
 assert.equal(result.plan.items.length,2);assert.equal(f.requests.at(-1).url,image(0));assert.match(result.infoText,/分页信息暂时不可用/);assert.match(result.infoText,/第2、3页图片暂时获取失败/)
})

test('a mismatched detail ID cannot borrow otherwise valid page URLs',async t=>{
 const f=await fixture(t,{detail:detail({id:OTHER})}),result=await f.prepare()
 assert.equal(result.status,'metadata-only');assert.equal(result.plan.items.length,1);assert.equal(f.requests.length,2);assert.match(result.infoText,/详情暂时未解析完成/)
})

test('ugoira is represented by its verified first frame, never the ZIP or subsequent frames',async t=>{
 const first=`https://i.pximg.net/img-original/img/2026/11/16/${ID}_ugoira0.jpg`
 const f=await fixture(t,{detail:detail({pageCount:1}),pages:[{urls:{regular:first,original:`https://i.pximg.net/img-zip-ugoira/img/${ID}_ugoira1920x1080.zip`}}]}),result=await f.prepare()
 assert.equal(result.status,'ready');assert.equal(f.requests.at(-1).url,first)
 for(const value of [`https://i.pximg.net/a/${ID}_ugoira1.jpg`,`https://i.pximg.net/a/${ID}_ugoira1920x1080.zip`])assert.throws(()=>pixivOfficialUrl(value,'image',{id:ID,index:0}))
})

for(const restriction of [1,2])test(`restriction ${restriction} never sends image bytes by default but explicit host override permits it`,async t=>{
 const f=await fixture(t,{detail:detail({xRestrict:restriction})}),result=await f.prepare()
 assert.equal(result.status,'restricted');assert.equal(f.requests.length,2);assert.match(result.infoText,/未自动附带图片/)
 const allowed=await fixture(t,{detail:detail({xRestrict:restriction}),options:{allowRestricted:true}}),sent=await allowed.prepare();assert.equal(sent.status,'ready');assert.equal(sent.plan.items.length,4)
})

for(const restriction of [undefined,null,-1,3,'unknown'])test(`unverified restriction ${restriction} remains metadata-only even with the host override`,async t=>{
 for(const allowRestricted of [false,true]){
  const f=await fixture(t,{detail:detail({xRestrict:restriction}),options:{allowRestricted}}),result=await f.prepare()
  assert.equal(result.status,'metadata-only');assert.equal(result.plan.items.length,1);assert.equal(f.requests.length,2);assert.match(result.infoText,/受限标记未能验证，未自动附带图片/)
 }
})

test('one image exceeding 16 MiB is skipped without consuming its body and later pages remain available',async t=>{
 let consumed=false
 const f=await fixture(t,{respond:(url,_signal,policy)=>url.href===image(1)?(assert.equal(policy.maxBytes,16*MiB),response((async function*(){consumed=true;yield PNG})(),'image/png',{headers:{'content-type':'image/png','content-length':String(16*MiB+1)}})):undefined}),result=await f.prepare()
 assert.equal(consumed,false);assert.equal(result.plan.items.length,3);assert.match(result.infoText,/第2页超过单图16MiB上限/)
})

test('a streamed oversized image stays classified as 16 MiB after artifact staging wraps the stream error',async t=>{
 const large=Buffer.alloc(17*MiB);PNG.copy(large)
 const f=await fixture(t,{respond:url=>url.href===image(0)?response(large,'image/png'):undefined}),result=await f.prepare()
 assert.equal(result.plan.items.length,3);assert.match(result.infoText,/第1页超过单图16MiB上限/);assert.doesNotMatch(result.infoText,/第1页图片暂时获取失败/)
})

for(const mode of ['wrong-mime','json-error','invalid-json','declared-limit','streamed-limit'])test(`invalid detail ${mode} never borrows independently returned page images`,async t=>{
 const f=await fixture(t,{respond:url=>{
  if(url.href!==`https://www.pixiv.net/ajax/illust/${ID}`)return
  if(mode==='wrong-mime')return response(JSON.stringify({error:false,body:detail()}),'text/html')
  if(mode==='json-error')return response({error:true,message:'UNTRUSTED_UPSTREAM_DETAILS',body:detail()})
  if(mode==='invalid-json')return response('{invalid')
  return response(Buffer.alloc(2*MiB+1),'application/json',mode==='declared-limit'?{headers:{'content-type':'application/json','content-length':String(2*MiB+1)}}:{})
 }}),result=await f.prepare()
 assert.equal(result.status,'metadata-only');assert.equal(result.plan.items.length,1);assert.equal(f.requests.length,2);assert.equal(result.infoText.includes('UNTRUSTED_UPSTREAM_DETAILS'),false)
})

test('the total 40 MiB budget bounds the next page by remaining bytes and keeps earlier images',async t=>{
 const large=Buffer.alloc(16*MiB);PNG.copy(large);const sizes=[]
 const f=await fixture(t,{detail:detail({pageCount:4}),pages:pages(4),respond:(url,_signal,policy)=>{if(url.hostname==='i.pximg.net'){sizes.push(policy.maxBytes);return response(large,'image/png',{headers:{'content-type':'image/png','content-length':String(large.length)}})}}}),result=await f.prepare()
 assert.deepEqual(sizes,[16*MiB,16*MiB,8*MiB,8*MiB]);assert.equal(result.plan.items.length,3);assert.match(result.infoText,/40MiB预算限制，第3、4页未附带/)
})

test('the last over-limit consumed chunk of a failed page exhausts the total budget before later page requests',async t=>{
 const large=Buffer.alloc(16*MiB);PNG.copy(large);const sizes=[],last=[]
 const f=await fixture(t,{detail:detail({pageCount:5}),pages:pages(5),respond:(url,_signal,policy)=>{
  if(url.hostname!=='i.pximg.net')return
  sizes.push(policy.maxBytes);last.push(url.href)
  if(url.href===image(2))return response((async function*(){yield large.subarray(0,5*MiB);yield large.subarray(0,4*MiB)})(),'image/png')
  return response(large,'image/png')
 }}),result=await f.prepare()
 assert.deepEqual(sizes,[16*MiB,16*MiB,8*MiB]);assert.deepEqual(last,[image(0),image(1),image(2)]);assert.equal(result.plan.items.length,3);assert.match(result.infoText,/40MiB预算限制，第3、4、5页未附带/)
})

test('Unicode text budgets count codepoints and host credentials never leak through text, URLs or split file chunks',async t=>{
 const unicode=await fixture(t,{detail:detail({title:'😀'.repeat(301),description:'😀'.repeat(1001),userName:'😀'.repeat(121)})}),result=await unicode.prepare()
 assert.ok(result.infoText.startsWith('分享了 Pixiv 作品《'+'😀'.repeat(300)+'》'));assert.ok(result.infoText.includes('画师:'+'😀'.repeat(120)+'\n'));assert.ok(result.infoText.includes('简介:'+'😀'.repeat(240)+'\n'))
 const secret='HOST_SPLIT_CREDENTIAL_123456'
 for(const mode of ['text','url','bytes']){
  const list=pages();if(mode==='url')list[1].urls={regular:image(1)+'?borrow='+encodeURIComponent(secret)}
  const f=await fixture(t,{detail:detail(mode==='text'?{title:secret}:{}),pages:list,options:{secrets:[secret]},respond:url=>mode==='bytes'&&url.href===image(1)?response((async function*(){yield Buffer.concat([PNG,Buffer.from(secret.slice(0,12))]);yield Buffer.from(secret.slice(12))})(),'image/png'):undefined}),prepared=await f.prepare()
  assert.equal(JSON.stringify(prepared).includes(secret),false);assert.ok(f.requests.every(call=>!decodeURIComponent(call.url).includes(secret)));assert.equal(prepared.plan.items.length,mode==='text'?1:mode==='url'?2:3)
 }
})

test('direct proxy configuration protects its whole URL and encoded/decoded user and password in metadata, URLs and file chunks',async t=>{
 const proxyUrl='http://PIXIV%2BUSER_123456:PIXIV%3FPASSWORD_123456@127.0.0.1:7890',proxy=new URL(proxyUrl)
 for(const secret of [proxyUrl,proxy.username,proxy.password,decodeURIComponent(proxy.username),decodeURIComponent(proxy.password)]){
  for(const mode of ['text','url','bytes']){
   const list=pages();if(mode==='url')list[1].urls={regular:image(1)+'?borrow='+encodeURIComponent(secret)}
   const f=await fixture(t,{detail:detail(mode==='text'?{title:secret}:{}),pages:list,options:{proxyUrl},respond:url=>mode==='bytes'&&url.href===image(1)?response((async function*(){const mid=Math.floor(secret.length/2);yield Buffer.concat([PNG,Buffer.from(secret.slice(0,mid))]);yield Buffer.from(secret.slice(mid))})(),'image/png'):undefined}),result=await f.prepare()
   assert.equal(result.plan.items.length,mode==='text'?1:mode==='url'?2:3);assert.equal(JSON.stringify(result).includes(secret),false);assert.ok(f.requests.every(call=>!decodeURIComponent(call.url).includes(secret)))
  }
 }
})

test('public provider construction rejects malformed Cookie and normalizes a supported header prefix',async t=>{
 const {directory}=await fixture(t),artifacts={stage:async()=>{throw Error('not used')}}
 for(const authCookie of ['Cookie:','PHPSESSID=','PHPSESSID=x;PHPSESSID=y','PHPSESSID=x;;','PHPSESSID=x; ;token=y','bad key=x','a'.repeat(101)+'=x','PHPSESSID=x\r\nX-Evil:x'])assert.throws(()=>createAgentPixivRelayProvider({directory,artifacts,authCookie}))
 const f=await fixture(t,{options:{authCookie:` Cookie: PHPSESSID=${COOKIE};`}});await f.prepare();assert.ok(f.requests.slice(0,2).every(call=>call.policy.headers.Cookie===`PHPSESSID=${COOKIE};`))
})

test('configured Cookie is sent only to the exact original metadata endpoints and redirects cannot switch work or resource kind',async t=>{
 const f=await fixture(t,{options:{authCookie:`PHPSESSID=${COOKIE}`}}),result=await f.prepare()
 assert.equal(result.status,'ready');assert.ok(f.requests.slice(0,2).every(call=>call.policy.headers.Cookie===`PHPSESSID=${COOKIE}`));assert.ok(f.requests.slice(2).every(call=>call.policy.headers.Cookie===undefined))
 for(const location of [`https://www.pixiv.net/ajax/illust/${OTHER}`,image(0),`https://www.pixiv.net/ajax/illust/${ID}/pages`]){
  const calls=[],read=createPixivHttp({authCookie:`PHPSESSID=${COOKIE}`,allows:()=>true,lookup:async()=>[{address:'8.8.8.8',family:4}],request:async(url,_addr,_signal,policy)=>{calls.push({url:url.href,policy});return response('',undefined,{status:302,headers:{location}})}}),guard=pixivGuard(scope(),1000)
  try{await assert.rejects(read(`https://www.pixiv.net/ajax/illust/${ID}`,'metadata',guard,2*MiB,{id:ID}))}finally{guard.close()};assert.equal(calls.length,1)
 }
})

test('recall and ignored late image responses release staged pages, close transport and return no usable artifacts',async t=>{
 const held=gate(),entered=gate(),cancel=new AbortController();let closed=false
 const f=await fixture(t,{respond:async url=>{if(url.href===image(1)){entered.resolve();await held.promise;return response(PNG,'image/png',{close(){closed=true}})}}}),operation=f.prepare(share(),scope({signal:cancel.signal}))
 await entered.promise;cancel.abort();await bounded(assert.rejects(operation));await f.empty();held.resolve();for(let at=0;at<50&&!closed;at++)await delay(5);assert.equal(closed,true);await f.empty()
})
