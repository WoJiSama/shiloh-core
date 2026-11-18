import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { fileURLToPath,pathToFileURL } from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo),at=file=>import(pathToFileURL(path.join(release,`dist/backend/modules/media/infrastructure/${file}.js`)).href)
const {renderAgentPixivList,buildAgentPixivListSvg}=await at('agentPixivListRenderer'),{createAgentPixivSearchProvider}=await at('agentPixivSearchProvider')
const ID='123456789',OTHER='123456790',MiB=1024*1024,THUMBNAIL=`https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/16/${ID}_p0_square1200.jpg`
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),entry=(extra={})=>({id:ID,title:'示例作品 <测试> & 风景',userName:'示例画师',userId:'987654321',pageCount:3,xRestrict:0,bookmarkCount:12345,thumbUrl:THUMBNAIL,...extra}),result=(extra={})=>({keyword:'初音未来',mode:'artworks',order:'newest',orderSource:'native',total:20,items:[entry()],...extra})
const red=await sharp({create:{width:80,height:60,channels:3,background:'#ff0000'}}).png().toBuffer(),options=(extra={})=>({allows:()=>true,secretCheck:()=>true,thumbnail:async()=>({mime:'image/png',bytes:red}),...extra})

test('self-contained sharp card emits a bounded decoded JPEG and composites the verified thumbnail at its original row',async()=>{
 const rendered=await renderAgentPixivList(result(),scope(),options()),bytes=Buffer.from(rendered.base64,'base64'),metadata=await sharp(bytes).metadata()
 assert.equal(rendered.mime,'image/jpeg');assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,1000);assert.equal(metadata.height,388);assert.ok(bytes.length<3*MiB)
 const pixel=await sharp(bytes).extract({left:150,top:200,width:1,height:1}).raw().toBuffer();assert.ok(pixel[0]>220);assert.ok(pixel[1]<20);assert.ok(pixel[2]<20)
 await writeFile('/tmp/bl-core-pixiv-search-card.jpg',bytes)
})

test('SVG escapes every untrusted field, contains no external resource elements and visibly labels order evidence and five-minute download behavior',()=>{
 for(const orderSource of ['native','ranking','rerank']){
  const svg=buildAgentPixivListSvg(result({keyword:'<tag>&"',order:'popular',orderSource,items:[entry({title:'<image href="file:///x"/>',userName:'<script>&画师'})]}))
  assert.equal(svg.includes('<image'),false);assert.equal(svg.includes('<script'),false);assert.equal(svg.includes('<foreignObject'),false);assert.match(svg,/&lt;image href=&quot;file:\/\/\/x&quot;\/&gt;/u);assert.match(svg,/&lt;script&gt;&amp;画师/u);assert.match(svg,new RegExp(orderSource));assert.match(svg,/ID 123456789/);assert.match(svg,/3P/);assert.match(svg,/1.2万/);assert.match(svg,/5分钟/);assert.match(svg,/成功下载会续期/);assert.match(svg,/新搜索会替换/)
 }
 const restricted=buildAgentPixivListSvg(result({items:[entry({xRestrict:1})]}));assert.match(restricted,/R-18/)
 const artist=buildAgentPixivListSvg(result({mode:'artist',artist:{userId:'987654321',userName:'画师名'}}));assert.match(artist,/画师名 的最近作品/)
})

test('only first8 rows render and unknown/restricted thumbnail slots are placeholders without any download',async()=>{
 const calls=[],items=Array.from({length:10},(_,index)=>entry({id:String(Number(ID)+index),thumbUrl:THUMBNAIL.replace(ID,String(Number(ID)+index)),...(index===0?{xRestrict:undefined}:index===1?{xRestrict:1}:index===2?{xRestrict:2}:{})}))
 const rendered=await renderAgentPixivList(result({items}),scope(),options({thumbnail:async item=>{calls.push(item.id);return{mime:'image/png',bytes:red}}})),metadata=await sharp(Buffer.from(rendered.base64,'base64')).metadata()
 assert.deepEqual(calls,items.slice(3,8).map(item=>item.id));assert.equal(metadata.height,1382)
})

test('one bounded thumbnail retry recovers a transient failure and two failures degrade to a usable placeholder JPEG',async()=>{
 for(const succeeds of [true,false]){
  let attempts=0;const rendered=await renderAgentPixivList(result(),scope(),options({thumbnail:async()=>{attempts++;if(attempts===1||!succeeds)throw Error('PRIVATE_CDN_ERROR');return{mime:'image/png',bytes:red}}}));assert.equal(attempts,2);assert.equal(rendered.mime,'image/jpeg')
 }
})

for(const mode of ['svg','wrong-mime','large','corrupt','pixel-bomb'])test(`untrusted ${mode} thumbnails never become arbitrary raster input and retain placeholders`,async()=>{
 let attempts=0;let bytes=red,mime='image/png'
 if(mode==='svg')bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>')
 if(mode==='wrong-mime')mime='image/jpeg'
 if(mode==='large')bytes=Buffer.alloc(3*MiB+1)
 if(mode==='corrupt')bytes=Buffer.from([137,80,78,71,13,10,26,10])
 if(mode==='pixel-bomb'){bytes=Buffer.from(red);bytes.writeUInt32BE(100000,16);bytes.writeUInt32BE(100000,20)}
 const rendered=await renderAgentPixivList(result(),scope(),options({thumbnail:async()=>{attempts++;return{mime,bytes}}})),pixel=await sharp(Buffer.from(rendered.base64,'base64')).extract({left:100,top:155,width:1,height:1}).raw().toBuffer()
 assert.equal(attempts,2);assert.ok(pixel[0]<245);assert.ok(pixel[1]>150)
})

test('renderer input schema rejects accessors, injected paths, duplicate IDs and secret text before downloading',async()=>{
 let calls=0;const settings=options({allows:value=>!value.includes('PRIVATE_RENDER_SECRET'),thumbnail:async()=>{calls++;return{mime:'image/png',bytes:red}}})
 for(const input of [result({path:'/etc/passwd'}),result({items:[entry(),entry()]}),result({items:[entry({id:'0'})]}),result({items:[entry({thumbUrl:THUMBNAIL.replace(ID,OTHER)})]}),result({items:[entry({title:'PRIVATE_RENDER_SECRET'})]}),result({items:[entry({xRestrict:3})]}),Object.defineProperty({},'keyword',{get(){throw Error('SECRET_GETTER')},enumerable:true})])await assert.rejects(renderAgentPixivList(input,scope(),settings),error=>!String(error).includes('SECRET_GETTER'))
 assert.equal(calls,0)
})

test('public provider render path caps CDN response at3MiB, omits Cookie and suppresses split binary credentials',async()=>{
 const secret='PRIVATE_RENDER_BYTES_12345',calls=[],provider=createAgentPixivSearchProvider({authCookie:'PHPSESSID=PIXIV_PRIVATE_HOST_12345',secrets:[secret],lookup:async()=>[{address:'8.8.8.8',family:4}],request:async(url,address,_signal,policy)=>{calls.push({url:url.href,address,policy});return{status:200,headers:{'content-type':'image/png'},body:(async function*(){yield Buffer.concat([red,Buffer.from(secret.slice(0,12))]);yield Buffer.from(secret.slice(12))})()}}})
 const rendered=await provider.renderList(result(),scope());assert.equal(rendered.mime,'image/jpeg');assert.equal(calls.length,2);for(const call of calls){assert.equal(call.policy.maxBytes,3*MiB);assert.equal(call.policy.headers.Cookie,undefined);assert.equal(call.address.address,'8.8.8.8')}
})

test('direct rendering checks secret-bearing IDs and numeric captions before rasterizing',async()=>{
 const provider=createAgentPixivSearchProvider({secrets:[ID],lookup:async()=>{throw Error('NETWORK_MUST_NOT_RUN')}})
 await assert.rejects(provider.renderList(result({items:[entry({thumbUrl:undefined})]}),scope()))
 const numeric=createAgentPixivSearchProvider({secrets:['12345'],lookup:async()=>{throw Error('NETWORK_MUST_NOT_RUN')}})
 await assert.rejects(numeric.renderList(result({items:[entry({thumbUrl:undefined,bookmarkCount:12345})]}),scope()))
})

test('already-cancelled rendering produces no image or network request',async()=>{
 const cancel=new AbortController();cancel.abort();let calls=0
 await assert.rejects(renderAgentPixivList(result(),scope({signal:cancel.signal}),options({thumbnail:async()=>{calls++;return{mime:'image/png',bytes:red}}})));assert.equal(calls,0)
})
