import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath,pathToFileURL } from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo),at=file=>import(pathToFileURL(path.join(release,`dist/backend/modules/media/infrastructure/${file}.js`)).href)
const {createAgentPixivSearchProvider}=await at('agentPixivSearchProvider')
const BASE=123456700,USER='987654321',COOKIE='PIXIV_SEARCH_SESSION_12345',MiB=1024*1024
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),thumb=id=>`https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/16/${id}_p0_square1200.jpg`
const item=(offset,extra={})=>({id:String(BASE+offset),title:`作品${offset}`,userName:'画师',userId:USER,pageCount:1,xRestrict:0,url:thumb(String(BASE+offset)),...extra})
const body=(data,total=data.length,extra={})=>({illustManga:{data,total},...extra}),reply=value=>({status:200,headers:{'content-type':'application/json'},body:JSON.stringify(value)}),payload=value=>reply({error:false,body:value})
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{resolve,promise}}
function fixture(options={},respond=()=>undefined){const requests=[],provider=createAgentPixivSearchProvider({lookup:async()=>[{address:'8.8.8.8',family:4}],request:async(url,address,signal,policy)=>{requests.push({url:url.href,address,signal,policy});return await respond(url,signal,policy)??payload(body([item(1),item(2)]))},...options});return{requests,...provider}}

for(const [orderBy,native]of [['newest','date_d'],['oldest','date'],['popular','popular_d']])test(`${orderBy} preserves native ordering with a host Cookie`,async()=>{
 const f=fixture({authCookie:`Cookie: PHPSESSID=${COOKIE};`}),result=await f.search({keyword:'初音 未来',orderBy},scope())
 const url=new URL(f.requests[0].url);assert.equal(url.pathname,'/ajax/search/artworks/%E5%88%9D%E9%9F%B3%20%E6%9C%AA%E6%9D%A5');assert.equal(url.searchParams.get('word'),'初音 未来');assert.equal(url.searchParams.get('order'),native);assert.equal(url.searchParams.get('mode'),'safe');assert.equal(f.requests.length,1);assert.equal(f.requests[0].policy.headers.Cookie,`PHPSESSID=${COOKIE};`)
 assert.equal(result.order,orderBy);assert.equal(result.orderSource,'native');assert.deepEqual(result.items.map(entry=>entry.id),[String(BASE+1),String(BASE+2)]);assert.equal(Object.isFrozen(result.items),true)
})

test('anonymous popularity fetches all daily/weekly pages, expands Chinese aliases and merges deduplicated ranking before bookmark rerank',async()=>{
 const queries=[],counts=new Map([[String(BASE+1),20],[String(BASE+2),40]]),f=fixture({},url=>{
  if(url.pathname.includes('/search/'))return payload(body([item(1),item(2)],100,{tagTranslation:{初音ミク:{zh:'初音未来'}}}))
  if(url.pathname==='/ranking.php'){queries.push([url.searchParams.get('mode'),url.searchParams.get('p')]);return reply({contents:[{illust_id:String(BASE+3),title:'未来',user_name:'artist',user_id:USER,rating_count:90,tags:['初音ミク'],url:thumb(String(BASE+3))},{illust_id:String(BASE+4),title:'else',user_name:'artist',user_id:USER,rating_count:200,tags:['初音ミク'],url:thumb(String(BASE+4))}]})}
  const id=url.pathname.split('/').at(-1);return payload({id,bookmarkCount:counts.get(id),xRestrict:0})
 }),result=await f.search({keyword:'初音未来',orderBy:'popular'},scope())
 assert.deepEqual(queries,[['daily','1'],['daily','2'],['weekly','1'],['weekly','2']]);assert.equal(result.orderSource,'ranking');assert.equal(result.total,2);assert.deepEqual(result.items.map(entry=>entry.id),[String(BASE+4),String(BASE+3),String(BASE+2),String(BASE+1)]);assert.equal(result.items[0].xRestrict,undefined);assert.ok(f.requests.every(call=>call.policy.headers.Cookie===undefined))
})

test('anonymous popularity falls back to at most24 strictly bound details with four active calls and stable bookmark ordering',async()=>{
 let active=0,maximum=0,detailCalls=0
 const f=fixture({},async url=>{
  if(url.pathname.includes('/search/'))return payload(body(Array.from({length:30},(_,i)=>item(i+1)),300))
  if(url.pathname==='/ranking.php')return reply({contents:[]})
  active++;maximum=Math.max(maximum,active);detailCalls++;await delay(2);active--
  const id=url.pathname.split('/').at(-1),offset=Number(id)-BASE
  return payload({id:offset===24?String(BASE+999):id,bookmarkCount:offset,xRestrict:offset===23?1:0})
 }),result=await f.search({keyword:'风景',orderBy:'popular'},scope())
 assert.equal(maximum,4);assert.equal(detailCalls,24);assert.equal(result.orderSource,'rerank');assert.equal(result.total,24);assert.equal(result.items.length,23);assert.equal(result.items[0].id,String(BASE+23));assert.equal(result.items[0].xRestrict,1);assert.equal(result.items.some(entry=>entry.id===String(BASE+24)),false)
})

test('ranking and detail failures preserve the native recent list instead of inventing popularity evidence',async()=>{
 const f=fixture({},url=>url.pathname.includes('/search/')?payload(body([item(1)])):reply({error:true,message:'HOST_UPSTREAM_FAILURE'})),result=await f.search({keyword:'风景',orderBy:'popular'},scope())
 assert.equal(result.orderSource,'native');assert.equal(result.items.length,1);assert.equal(JSON.stringify(result).includes('HOST_UPSTREAM_FAILURE'),false)
})

test('artist mode chooses the most matching name hits then16 latest candidates, verifies detail id/userId and returns the first8 recent works',async()=>{
 let active=0,maximum=0;const details=[]
 const initial=[item(1,{userName:'wlop'}),item(2,{userName:'WLOP',userId:USER}),item(3,{userName:'wlop fan',userId:'987654322'})]
 const f=fixture({authCookie:`PHPSESSID=${COOKIE}`},async url=>{
  if(url.pathname.includes('/search/'))return payload(body(initial))
  if(url.pathname.includes('/profile/')){assert.equal(url.pathname,`/ajax/user/${USER}/profile/all`);return payload({illusts:Object.fromEntries(Array.from({length:20},(_,i)=>[String(BASE+i+1),null]))})}
  const id=url.pathname.split('/').at(-1);details.push(id);active++;maximum=Math.max(maximum,active);await delay(2);active--
  const offset=Number(id)-BASE;return payload(item(offset,{id:offset===20?String(BASE+99):id,userId:offset===19?'987654322':USER,title:`recent${offset}`,bookmarkCount:offset}))
 }),result=await f.search({keyword:'wlop',searchType:'artist',orderBy:'popular'},scope())
 assert.equal(result.mode,'artist');assert.deepEqual(result.artist,{userId:USER,userName:'wlop'});assert.equal(result.order,'newest');assert.equal(result.orderSource,'native');assert.equal(details.length,16);assert.equal(maximum,4);assert.deepEqual(result.items.map(entry=>entry.id),Array.from({length:8},(_,i)=>String(BASE+18-i)));assert.ok(f.requests.every(call=>call.policy.headers.Cookie===`PHPSESSID=${COOKIE}`))
})

test('unmatched artist names return the normal search order and no profile requests',async()=>{
 const f=fixture(),result=await f.search({keyword:'不匹配画师',searchType:'artist',orderBy:'oldest'},scope())
 assert.equal(result.mode,'artworks');assert.equal(result.order,'oldest');assert.equal(result.artist,undefined);assert.equal(f.requests.length,1)
})

test('artist empty profile and borrowed details fail safely without falling back to a different artist',async()=>{
 for(const mode of ['empty','borrowed']){
  const f=fixture({},url=>url.pathname.includes('/search/')?payload(body([item(1,{userName:'目标画师'})])):url.pathname.includes('/profile/')?payload({illusts:mode==='empty'?{}:{[String(BASE+1)]:null}}):payload(item(1,{userId:'987654322'})))
  await assert.rejects(f.search({keyword:'目标画师',searchType:'artist'},scope()),error=>String(error).includes('Pixiv 搜索暂时不可用'))
 }
})

test('normalization keeps original result order, deduplicates artwork IDs and refuses borrowed or unknown thumbnail identities',async()=>{
 const f=fixture({},()=>payload(body([item(1),item(1),item(2,{url:thumb(String(BASE+99))}),item(3,{xRestrict:undefined,url:thumb(String(BASE+3))}),item(4,{id:'0'})]))),result=await f.search({keyword:'😀'.repeat(81)},scope())
 assert.equal(Array.from(result.keyword).length,80);assert.equal(result.items.length,3);assert.equal(result.items[1].thumbUrl,undefined);assert.equal(result.items[2].xRestrict,undefined)
})

for(const mode of ['text','url','metadata-size','wrong-mime','invalid-json'])test(`untrusted ${mode} metadata is a generic failure and never leaks to result text`,async()=>{
 const secret='PRIVATE_SEARCH_CREDENTIAL_12345',f=fixture({secrets:[secret]},()=>{
  if(mode==='text')return payload(body([item(1,{title:secret})]))
  if(mode==='url')return payload(body([item(1,{url:thumb(String(BASE+1))+'?borrow='+encodeURIComponent(secret)})]))
  if(mode==='metadata-size')return{status:200,headers:{'content-type':'application/json'},body:Buffer.alloc(2*MiB+1)}
  if(mode==='wrong-mime')return{status:200,headers:{'content-type':'text/html'},body:'PRIVATE_UPSTREAM'}
  return{status:200,headers:{'content-type':'application/json'},body:'{PRIVATE_UPSTREAM'}
 })
 await assert.rejects(f.search({keyword:'风景'},scope()),error=>!String(error).includes(secret)&&!String(error).includes('PRIVATE_UPSTREAM'))
})

test('full proxy URL and encoded/decoded components are secret across direct search construction',async()=>{
 const proxyUrl='http://SEARCH%2BUSER_12345:SEARCH%3FPASSWORD_12345@127.0.0.1:7890',proxy=new URL(proxyUrl)
 for(const secret of [proxyUrl,proxy.username,proxy.password,decodeURIComponent(proxy.username),decodeURIComponent(proxy.password)]){
  const f=fixture({proxyUrl},()=>payload(body([item(1,{title:secret})])));await assert.rejects(f.search({keyword:'风景'},scope()),error=>!String(error).includes(secret))
 }
})

test('input extensions/accessors/enums and unsafe text are rejected before any request',async()=>{
 const f=fixture({secrets:['HOST_INPUT_SECRET_12345']})
 for(const input of [{keyword:''},{keyword:'x',searchType:'user'},{keyword:'x',orderBy:'random'},{keyword:'x',url:'https://evil.test'},{keyword:'HOST_INPUT_SECRET_12345'},{keyword:'x',orderBy:{toString(){throw Error('getter')}}},Object.defineProperty({},'keyword',{get(){throw Error('getter')},enumerable:true})])await assert.rejects(f.search(input,scope()))
 assert.equal(f.requests.length,0)
})

test('cancelled and timed out searches close late metadata and return no stale search session',async()=>{
 for(const mode of ['cancel','timeout']){
  const entered=gate(),held=gate(),cancel=new AbortController();let closed=0
  const f=fixture({timeoutMs:30},async()=>{entered.resolve();await held.promise;return{...payload(body([item(1)])),close(){closed++}}}),operation=f.search({keyword:'风景'},scope({signal:cancel.signal}))
  await entered.promise;const rejected=assert.rejects(operation);if(mode==='cancel')cancel.abort();else await delay(40);await rejected;held.resolve();for(let i=0;i<40&&!closed;i++)await delay(5);assert.equal(closed,1)
 }
})
