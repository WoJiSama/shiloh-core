import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo)
const {createAgentVideoAnalysisTool,validateAgentBigmodelUploadUrl,validateAgentVideoUploadHosts}=await import(pathToFileURL(path.join(release,'dist/backend/modules/media/infrastructure/agentVideoAnalysis.js')).href)
const KEY='VIDEO_PROVIDER_PRIVATE_KEY_12345',SECRET='OTHER_HOST_CREDENTIAL_12345',UPLOAD='https://www.bigmodel.cn/api/biz/file/uploadTemporaryImage',TEMP='https://www.bigmodel.cn/temporary/video-fixture.mp4'
const mp4=()=>{const bytes=Buffer.alloc(24);bytes.writeUInt32BE(24);bytes.write('ftyp',4);bytes.write('isom',8);bytes.write('isom',16);bytes.write('mp42',20);return bytes},video=()=>({mime:'video/mp4',base64:mp4().toString('base64')})
const context=extra=>({binding:{id:'binding',revision:'revision',agentId:'daily',personaId:'default',connectionId:'main',source:'configured',target:{account:{platform:'qq',namespace:'global',id:'19000001'},kind:'group',id:'310001'}},actor:{kind:'user',user:{platform:'qq',namespace:'global',id:'330001'}},request:{messageId:'91001',text:'总结当前视频的内容',mentions:[]},signal:new AbortController().signal,isCurrent:()=>true,async ensureCurrent(){},async readVideo(){return video()},...extra})
const result=(text='画面中是一段合成测试视频。',usage={prompt_tokens:11,completion_tokens:7,total_tokens:18})=>({choices:[{message:{content:text}}],usage})
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{resolve,promise}}
async function closeServer(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}
async function fixture(t,respond){const calls=[],server=http.createServer(async(req,res)=>{const chunks=[];for await(const bytes of req)chunks.push(bytes);const body=Buffer.concat(chunks);calls.push({url:req.url,headers:req.headers,body});if(respond)await respond(req,res,body,calls);else{res.setHeader('content-type','application/json');res.end(JSON.stringify(result()))}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server));const baseUrl=`http://127.0.0.1:${server.address().port}/video/v1`;return{calls,baseUrl,tool(extra={},options={}){return createAgentVideoAnalysisTool({enabled:true,baseUrl,name:'separate-video-model',apiKey:KEY,...extra},{secrets:[SECRET],...options})}}}

test('real local model receives only an owned inline video and current prompt, preserves {analysis}, and records actual separate-model usage',async t=>{
 const f=await fixture(t),usage=[],tool=f.tool(),out=await tool.execute({},context({recordUsage:(...args)=>usage.push(args)}))
 assert.equal(tool.name,'videoAnalysisTool');assert.equal(tool.dataPolicy,'ephemeral');assert.equal(tool.timeoutMs,240000);assert.deepEqual(tool.parameters.required,[]);assert.deepEqual(Object.keys(tool.parameters.properties),['prompt'])
 assert.equal(out.status,'succeeded');assert.deepEqual(JSON.parse(out.content),{analysis:'画面中是一段合成测试视频。'});assert.equal(f.calls.length,1)
 const call=f.calls[0],body=JSON.parse(call.body);assert.equal(call.url,'/video/v1/chat/completions');assert.equal(call.headers.authorization,`Bearer ${KEY}`);assert.deepEqual(body,{model:'separate-video-model',messages:[{role:'user',content:[{type:'text',text:'总结当前视频的内容'},{type:'video_url',video_url:{url:'data:video/mp4;base64,'+video().base64}}]}],stream:false});assert.deepEqual(usage,[['separate-video-model',{prompt_tokens:11,completion_tokens:7,total_tokens:18}]])
 for(const forbidden of ['binding','19000001','310001','330001','91001','qq.com',KEY,SECRET])assert.equal(call.body.includes(forbidden),false)
})

test('explicit prompt wins; empty prompt uses current request then the fixed default without a URL/source override',async t=>{
 const f=await fixture(t)
 for(const [input,text,wanted]of [[{prompt:'请识别动作'},'原请求','请识别动作'],[{prompt:'  '},'当前真人诉求','当前真人诉求'],[{},'  ','请分析这个视频内容']]){assert.equal((await f.tool().execute(input,context({request:{messageId:'91001',text,mentions:[]}}))).status,'succeeded');assert.equal(JSON.parse(f.calls.at(-1).body).messages[0].content[0].text,wanted)}
 const before=f.calls.length;for(const input of [{url:'https://qq.test/video.mp4'},{prompt:'x',baseUrl:'https://evil.test'},{prompt:'x',sourceSeq:1},{prompt:'x'.repeat(4001)}])assert.equal((await f.tool().execute(input,context())).status,'failed');assert.equal(f.calls.length,before)
})

test('disabled and incomplete configuration never falls back to the main model or reads videos',async t=>{
 let reads=0;const scope=context({readVideo:async()=>{reads++;throw Error('MUST_NOT_READ')}}),disabled=createAgentVideoAnalysisTool({enabled:false})
 assert.equal((await disabled.execute({},scope)).status,'failed');assert.equal(reads,0)
 for(const config of [{enabled:true},{enabled:true,baseUrl:'https://video.example/v1',name:'video'},{enabled:true,baseUrl:'http://user:pass@127.0.0.1/v1',name:'video',apiKey:KEY},{enabled:true,baseUrl:'https://video.example/v1?key=x',name:'video',apiKey:KEY},{enabled:true,baseUrl:'https://video.example/v1',name:'video',apiKey:'x\r\nInjected:y'},{enabled:true,baseUrl:'https://video.example/v1',name:'video',apiKey:KEY,inputMode:'url'}])assert.throws(()=>createAgentVideoAnalysisTool(config),error=>!String(error).includes(KEY))
})

test('autonomous, private, cross-namespace and self requests fail before scoped reads or provider HTTP',async t=>{
 const f=await fixture(t);let reads=0
 for(const extra of [{actor:{kind:'autonomous'}},{actor:{kind:'user',user:{platform:'qq',namespace:'other',id:'330001'}}},{actor:{kind:'user',user:{platform:'qq',namespace:'global',id:'19000001'}}},{binding:{...context().binding,target:{...context().binding.target,kind:'private'}}},{request:undefined},{readVideo:undefined}])assert.equal((await f.tool().execute({},context({readVideo:async()=>{reads++;return video()},...extra}))).status,'failed')
 assert.equal(reads,0);assert.equal(f.calls.length,0)
})

test('secrets and common escaped encodings in prompt, binary, response JSON or analysis never cross the safe boundary',async t=>{
 const f=await fixture(t),variants=[SECRET,encodeURIComponent(SECRET),Buffer.from(SECRET).toString('base64'),'\\u004fTHER_HOST_CREDENTIAL_12345']
 for(const prompt of variants)assert.equal((await f.tool().execute({prompt},context())).status,'failed')
 const bytes=Buffer.concat([mp4(),Buffer.from(SECRET)]);assert.equal((await f.tool().execute({},context({readVideo:async()=>({mime:'video/mp4',base64:bytes.toString('base64')})}))).status,'failed');assert.equal(f.calls.length,0)
 for(const content of variants){const response=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result(content)))}),out=await response.tool().execute({},context());assert.equal(out.status,'failed');assert.equal(JSON.stringify(out).includes(SECRET),false)}
 const rejected=await f.tool({}, {allowsText:value=>!value.includes('blocked')}).execute({prompt:'blocked'},context());assert.equal(rejected.status,'failed')
})

for(const inputMode of ['inline','bigmodel-upload'])test(`${inputMode} rejects returned video bytes, base64 and data URLs before they become tool analysis`,async t=>{
 let echo='',debugOnly=false;const f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(debugOnly?{...result(),debug:echo}:result(echo)).replaceAll('/','\\/'))}),original=globalThis.fetch
 if(inputMode==='bigmodel-upload')t.mock.method(globalThis,'fetch',(url,init)=>url===UPLOAD?Promise.resolve(new Response(JSON.stringify({url:TEMP}),{headers:{'content-type':'application/json'}})):original(url,init))
 for(const value of[video().base64,'data:video/mp4;base64,'+video().base64,mp4().toString('utf8'),'data:video/webm;base64,Ym9ycm93ZWQ=','data%3Avideo%2Fmp4%3Bbase64%2CYm9ycm93ZWQ%3D']){
  echo=value;const out=await f.tool({inputMode}).execute({},context());assert.equal(out.status,'failed');assert.equal(out.content.includes(value),false)
 }
 debugOnly=true;echo='data:video/mp4;base64,Ym9ycm93ZWQ=';assert.equal((await f.tool({inputMode}).execute({},context())).status,'failed')
 assert.equal(f.calls.length,6)
})

for(const mode of ['http-error','redirect','oversized','stream-limit','wrong-mime','invalid-json','tool-call','empty','secret-json'])test(`model ${mode} returns a fixed safe failure with one attempt`,async t=>{
 const f=await fixture(t,(_req,res)=>{
  if(mode==='redirect'){res.writeHead(302,{location:'https://evil.example/private'}).end('UPSTREAM_PRIVATE_BODY');return}
  if(mode==='http-error'){res.writeHead(429,{'content-type':'application/json'}).end(JSON.stringify({error:'UPSTREAM_PRIVATE_BODY'}));return}
  res.setHeader('content-type',mode==='wrong-mime'?'text/html':'application/json')
  if(mode==='oversized'){res.setHeader('content-length',String(2*1024*1024+1));res.end('x');return}
  if(mode==='stream-limit'){res.write('x'.repeat(1024*1024));res.end('x'.repeat(1024*1024+1));return}
  if(mode==='invalid-json'){res.end('{UPSTREAM_PRIVATE_BODY');return}
  const data=result(mode==='empty'?'  ':'正常内容');if(mode==='tool-call')data.choices[0].message.tool_calls=[];if(mode==='secret-json')data.debug=KEY;res.end(JSON.stringify(data))
 }),out=await f.tool().execute({},context());assert.equal(out.status,'failed');assert.equal(f.calls.length,1);for(const secret of[KEY,SECRET,'UPSTREAM_PRIVATE_BODY','evil.example'])assert.equal(JSON.stringify(out).includes(secret),false)
})

test('analysis is sanitized before preserving its legacy {analysis} content shape',async t=>{
 const f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result('<think>内部推理</think>视频展示了公开画面。')))}),out=await f.tool().execute({},context())
 assert.equal(out.status,'succeeded');assert.deepEqual(JSON.parse(out.content),{analysis:'视频展示了公开画面。'})
})

test('BigModel upload always sends verified bytes first, never forwards an original platform URL, and strips transport URLs from analysis',async t=>{
 const f=await fixture(t,(req,res,body)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/upload'){res.end(JSON.stringify({url:TEMP}));return}
  res.end(JSON.stringify(result('已分析上传后的视频。')))
 }),original=globalThis.fetch;let upload=0
 t.mock.method(globalThis,'fetch',(url,init)=>{assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);if(url===UPLOAD){upload++;return original(f.baseUrl.replace('/video/v1','/upload'),init)}return original(url,init)})
 const out=await f.tool({inputMode:'bigmodel-upload'}).execute({},context());assert.equal(out.status,'succeeded');assert.equal(upload,1);assert.equal(f.calls.length,2)
 const first=f.calls[0];assert.equal(first.url,'/upload');assert.equal(first.headers.authorization,`Bearer ${KEY}`);assert.match(first.headers['content-type'],/^multipart\/form-data; boundary=/u)
 const form=await new Response(first.body,{headers:{'content-type':first.headers['content-type']}}).formData(),file=form.get('file');assert.equal(file.name,'video.mp4');assert.equal(file.type,'video/mp4');assert.deepEqual(Buffer.from(await file.arrayBuffer()),mp4())
 const body=JSON.parse(f.calls[1].body);assert.equal(body.messages[0].content[1].video_url.url,TEMP);assert.equal(out.content.includes(TEMP),false)
})

test('BigModel return URL accepts documented exact official hosts and bounded signed query without credentials or borrowed CDN domains',()=>{
 for(const input of[TEMP,'https://open.bigmodel.cn/temporary/test.mp4','https://cdn.bigmodel.cn/agent-demos/lark/113123.mov',TEMP+'?token=temporary-signature&expires=123456&path=a%2Fb'])assert.equal(validateAgentBigmodelUploadUrl(input,()=>true),input)
 for(const input of['http://www.bigmodel.cn/test.mp4','https://www.bigmodel.cn:443/test.mp4','https://www.bigmodel.cn@evil.test/test.mp4','https://bigmodel.cn/test.mp4','https://other.cdn.bigmodel.cn/test.mp4','https://bucket.cos.example/test.mp4',TEMP+'?token=bad%0Avalue',TEMP+'#x','https://www.bigmodel.cn/a/../test.mp4','https://www.bigmodel.cn/%2e%2e/test.mp4'])assert.throws(()=>validateAgentBigmodelUploadUrl(input,()=>true))
 assert.throws(()=>validateAgentBigmodelUploadUrl(TEMP,()=>false))
 assert.throws(()=>validateAgentBigmodelUploadUrl(TEMP+'?token='+SECRET,value=>!value.includes(SECRET)))
 assert.throws(()=>validateAgentBigmodelUploadUrl(TEMP+'?token='+'x'.repeat(8192),()=>true))
})

test('host-owned uploadHosts exactly replaces documented defaults and rejects ports, wildcards, URLs, IPs, localhost and accessors',()=>{
 const custom=['video-cdn.fixture.example'],source=[...custom],hosts=validateAgentVideoUploadHosts(source);source[0]='mutated.example';assert.deepEqual(hosts,custom);assert.equal(Object.isFrozen(hosts),true)
 assert.equal(validateAgentBigmodelUploadUrl('https://video-cdn.fixture.example/upload/video.mp4?signature=opaque',()=>true,hosts),'https://video-cdn.fixture.example/upload/video.mp4?signature=opaque')
 for(const url of[TEMP,'https://cdn.bigmodel.cn/agent-demos/lark/113123.mov','https://other.video-cdn.fixture.example/a.mp4'])assert.throws(()=>validateAgentBigmodelUploadUrl(url,()=>true,hosts))
 let accessed=false;const getter=[];Object.defineProperty(getter,'0',{get(){accessed=true;throw Error('PRIVATE_GETTER')},enumerable:true})
 for(const value of[[],Array(9).fill('cdn.fixture.example'),['cdn.fixture.example','CDN.fixture.example'],['https://cdn.fixture.example'],['*.fixture.example'],['cdn.fixture.example:443'],['127.0.0.1'],['0177.0.0.1'],['0x7f.0.0.1'],['[::1]'],['localhost'],['video.localhost'],['cdn.fixture.example.'],['bad_host.example'],getter])assert.throws(()=>validateAgentVideoUploadHosts(value))
 assert.equal(accessed,false)
})

test('explicit uploadHosts permit a custom signed CDN only after the fixed BigModel upload response and never from model input',async t=>{
 const selected='https://video-cdn.fixture.example/temporary/v.mp4?signature=opaque',f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result()))}),original=globalThis.fetch;let uploads=0
 t.mock.method(globalThis,'fetch',(url,init)=>{if(url===UPLOAD){uploads++;return Promise.resolve(new Response(JSON.stringify({url:selected}),{headers:{'content-type':'application/json'}}))}return original(url,init)})
 const out=await f.tool({inputMode:'bigmodel-upload',uploadHosts:['video-cdn.fixture.example']}).execute({},context());assert.equal(out.status,'succeeded');assert.equal(uploads,1);assert.equal(JSON.parse(f.calls[0].body).messages[0].content[1].video_url.url,selected)
 assert.equal((await f.tool({inputMode:'bigmodel-upload'}).execute({prompt:'x',uploadHosts:['evil.example']},context())).status,'failed');assert.equal(uploads,1)
})

test('untrusted upload JSON never triggers the model and upload receives no retry',async t=>{
 const f=await fixture(t),original=globalThis.fetch
 for(const bad of[{url:'https://evil.test/video.mp4'},{url:TEMP+'?api_key='+KEY},{url:TEMP,error:{message:'PRIVATE_UPLOAD_BODY'}},{}]){
  let calls=0;const mocked=t.mock.method(globalThis,'fetch',(url,init)=>{assert.equal(url,UPLOAD);assert.equal(init.redirect,'error');calls++;return Promise.resolve(new Response(JSON.stringify(bad),{headers:{'content-type':'application/json'}}))})
  const out=await f.tool({inputMode:'bigmodel-upload'}).execute({},context());assert.equal(out.status,'failed');assert.equal(calls,1);assert.equal(f.calls.length,0);assert.equal(out.content.includes('PRIVATE_UPLOAD_BODY'),false);mocked.mock.restore()
 }
 assert.equal(globalThis.fetch,original)
})

test('a temporary upload URL echoed in model JSON is discarded before any analysis result is returned',async t=>{
 const f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({...result(),debug:TEMP}))}),original=globalThis.fetch
 t.mock.method(globalThis,'fetch',(url,init)=>url===UPLOAD?Promise.resolve(new Response(JSON.stringify({url:TEMP}),{headers:{'content-type':'application/json'}})):original(url,init))
 const out=await f.tool({inputMode:'bigmodel-upload'}).execute({},context());assert.equal(out.status,'failed');assert.equal(out.content.includes(TEMP),false);assert.equal(f.calls.length,1)
})

test('temporary signed upload query values and their decoded or escaped forms never become analysis, while ordinary analysis remains valid',async t=>{
 const token='TEMP_SIGNATURE_PRIVATE_123456/a+b=',encodedToken='TEMP%5FSIGNATURE%5FPRIVATE%5F123456%2Fa%2Bb%3D',selected=TEMP+'?signature='+encodedToken+'&expires=209901010000&empty=',original=globalThis.fetch
 let content='',modelCalls=0,uploadCalls=0
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal)
  if(url===UPLOAD){uploadCalls++;return new Response(JSON.stringify({url:selected}),{headers:{'content-type':'application/json'}})}
  modelCalls++;assert.equal(JSON.parse(init.body).messages[0].content[1].video_url.url,selected)
  return new Response(JSON.stringify(result(content)),{headers:{'content-type':'application/json'}})
 })
 const tool=createAgentVideoAnalysisTool({enabled:true,baseUrl:'https://configured-video-model.example/v1',name:'separate-video-model',apiKey:KEY,inputMode:'bigmodel-upload'})
 for(const value of[token,encodedToken,encodeURIComponent(token),Buffer.from(token).toString('base64'),'\\u0054EMP_SIGNATURE_PRIVATE_123456/a+b=','209901010000']){
  content='视频摘要：'+value;const out=await tool.execute({},context());assert.equal(out.status,'failed');assert.equal(out.content.includes(value),false)
 }
 content='视频展示了一段正常的公开画面。';const out=await tool.execute({},context());assert.equal(out.status,'succeeded');assert.deepEqual(JSON.parse(out.content),{analysis:content});assert.equal(uploadCalls,7);assert.equal(modelCalls,7)
 assert.notEqual(globalThis.fetch,original)
})

test('recall cancels a real active model HTTP body and ignores an injected late upload response',async t=>{
 let disconnected=false;const entered=gate(),f=await fixture(t,(_req,res)=>{res.setHeader('content-type','application/json');res.write('{');res.on('close',()=>{disconnected=true});entered.resolve()}),cancel=new AbortController(),operation=f.tool().execute({},context({signal:cancel.signal}))
 await entered.promise;cancel.abort();assert.equal((await operation).status,'failed');for(let i=0;i<40&&!disconnected;i++)await delay(5);assert.equal(disconnected,true)
 const held=gate(),lateEntered=gate(),cancel2=new AbortController();let closed=0,requests=0
 t.mock.method(globalThis,'fetch',async()=>{requests++;lateEntered.resolve();await held.promise;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({url:TEMP})))},cancel(){closed++}}),{headers:{'content-type':'application/json'}})})
 const pending=f.tool({inputMode:'bigmodel-upload'}).execute({},context({signal:cancel2.signal}));await lateEntered.promise;cancel2.abort();assert.equal((await pending).status,'failed');held.resolve();for(let i=0;i<40&&!closed;i++)await delay(5);assert.equal(closed,1);assert.equal(requests,1)
})

test('source reauthorization runs before bytes, before every external step and after provider results',async t=>{
 const f=await fixture(t);let checks=0,current=true,reads=0
 const out=await f.tool().execute({},context({readVideo:async()=>{reads++;return video()},ensureCurrent:async()=>{checks++;if(checks===3){current=false;throw Error('PRIVATE_RECALL')}},isCurrent:()=>current}))
 assert.equal(out.status,'failed');assert.ok(checks>=3);assert.equal(reads,1);assert.equal(f.calls.length,0);assert.equal(out.content.includes('PRIVATE_RECALL'),false)
 let responseCurrent=true;const returned=await fixture(t,(_req,res)=>{responseCurrent=false;res.setHeader('content-type','application/json');res.end(JSON.stringify(result()))})
 assert.equal((await returned.tool().execute({},context({isCurrent:()=>responseCurrent}))).status,'failed');assert.equal(returned.calls.length,1)
})
