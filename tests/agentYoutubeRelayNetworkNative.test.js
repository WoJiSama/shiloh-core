import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo),at=file=>import(pathToFileURL(path.join(release,`dist/backend/modules/media/infrastructure/${file}.js`)).href)
const {createYoutubeHttp,youtubeBody,youtubeGuard,youtubeOfficialUrl,nativeAgentYoutubeConnect,YOUTUBE_USER_AGENT}=await at('agentYoutubeRelayHttp')
const {runAgentYoutubeMetadata,openAgentYoutubeMetadataProxy,nativeAgentYoutubeCommand}=await at('agentYoutubeRelayNative')
const ID='dQw4w9WgXcQ',PAGE=`https://www.youtube.com/watch?v=${ID}`,COOKIE='CHANNEL_AUTH_COOKIE_12345',TOKEN='VALID_PO_TOKEN_+/.=12345'
const scope=overrides=>({signal:new AbortController().signal,isCurrent:()=>true,...overrides}),publicLookup=async()=>[{address:'8.8.8.8',family:4}]
const response=(body,extra={})=>({status:200,headers:{'content-type':'video/mp4'},body,...extra})
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{resolve,promise}}
async function root(t){const directory=await realpath(await mkdtemp(path.join(tmpdir(),'youtube-port-test-')));await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));return directory}
async function bounded(operation){let timer;try{return await Promise.race([operation,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error('fixture timeout')),2500)})])}finally{clearTimeout(timer)}}
async function connectTo(port){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port},()=>resolve(socket));socket.once('error',reject)})}
async function closeServer(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}

test('metadata uses fixed extraction flags, isolated environment and owner-only credentials without argv leakage',async t=>{
 const directory=await root(t),guard=youtubeGuard(scope(),3000);let cwd,proxy
 process.env.YOUTUBE_TEST_HOST_SECRET='MUST_NOT_BE_IN_CHILD';process.env.HTTPS_PROXY='http://secret.invalid';t.after(()=>{delete process.env.YOUTUBE_TEST_HOST_SECRET;delete process.env.HTTPS_PROXY})
 try{const text=await runAgentYoutubeMetadata({directory,pageUrl:PAGE,authCookie:`SAPISID=${COOKIE}; __Secure-3PAPISID=value;`,poToken:TOKEN,native:async(command,args,options)=>{
  assert.equal(command,'yt-dlp');cwd=options.cwd;assert.equal((await stat(cwd)).mode&0o777,0o700);assert.equal(options.maxOutputBytes,2*1024*1024)
  for(const flag of ['--ignore-config','--no-plugin-dirs','--no-cache-dir','--skip-download','--dump-single-json','--ignore-no-formats-error','--no-playlist'])assert.ok(args.includes(flag),flag)
  assert.equal(args[args.indexOf('-f')+1],'worst[ext=mp4][vcodec!=none][acodec!=none]');assert.equal(args[args.indexOf('--user-agent')+1],YOUTUBE_USER_AGENT)
  assert.equal(args.includes(COOKIE),false);assert.equal(args.includes(TOKEN),false);proxy=args[args.indexOf('--proxy')+1];assert.match(proxy,/^http:\/\/127\.0\.0\.1:\d+$/u)
  const cookies=args[args.indexOf('--cookies')+1],config=args[args.indexOf('--config-locations')+1]
  assert.equal((await stat(cookies)).mode&0o777,0o600);assert.equal((await stat(config)).mode&0o777,0o600)
  assert.match(await readFile(cookies,'utf8'),new RegExp(`SAPISID\\t${COOKIE}`));assert.ok((await readFile(config,'utf8')).includes(`youtube:po_token=web+${TOKEN}`))
  for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR'])assert.equal(options.env[key],cwd)
  for(const key of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','YOUTUBE_TEST_HOST_SECRET','PYTHONPATH','PYTHONHOME'])assert.equal(options.env[key],undefined)
  return{stdout:JSON.stringify({id:ID,title:'selected metadata',url:'https://rr1.googlevideo.com/videoplayback?signature=ok'})}
 }},guard,2000);assert.equal(JSON.parse(text).id,ID)}finally{guard.close()}
 assert.deepEqual(await readdir(directory),[]);await assert.rejects(connectTo(Number(new URL(proxy).port)))
})

test('real yt-dlp subprocess is bounded, stderr maps only safe codes, and cancellation waits for killed child close',async t=>{
 const directory=await root(t),previous=process.env.PATH,executable=path.join(directory,'yt-dlp')
 t.after(()=>{process.env.PATH=previous})
 await writeFile(executable,`#!${process.execPath}\nconst mode=process.argv.at(-1);if(mode==='large')process.stdout.write('x'.repeat(4096));else if(mode==='access'){process.stderr.write('Sign in required PRIVATE_STDERR_SECRET');process.exitCode=1}else if(mode==='region'){process.stderr.write('not available in your country PRIVATE_STDERR_SECRET');process.exitCode=1}else if(mode==='hold')setInterval(()=>{},10);else process.stdout.write('metadata\\n')\n`);await chmod(executable,0o700)
 const options={cwd:directory,env:{PATH:directory},signal:new AbortController().signal,timeoutMs:1000,maxOutputBytes:128}
 assert.equal((await nativeAgentYoutubeCommand('yt-dlp',['ok'],options)).stdout,'metadata\n')
 for(const [mode,code]of [['large','youtube_metadata_failed'],['access','youtube_access_required'],['region','youtube_region_restricted']])await assert.rejects(nativeAgentYoutubeCommand('yt-dlp',[mode],options),error=>error.code===code&&!String(error).includes('PRIVATE_STDERR_SECRET'))
 const cancel=new AbortController(),operation=nativeAgentYoutubeCommand('yt-dlp',['hold'],{...options,signal:cancel.signal});await delay(30);cancel.abort();await bounded(assert.rejects(operation))
 await assert.rejects(nativeAgentYoutubeCommand('yt-dlp',['ok'],{...options,env:{PATH:path.join(directory,'missing')}}),error=>error.code==='youtube_downloader_unavailable')
})

test('actual metadata subprocess traverses the job CONNECT proxy and exits with no residual profile/auth files',async t=>{
 const directory=await root(t),executable=path.join(directory,'yt-dlp'),previous=process.env.PATH,audit=[];process.env.PATH=directory;t.after(()=>{process.env.PATH=previous})
 const upstream=net.createServer(socket=>{socket.on('data',data=>{audit.push(data.toString());socket.write('SYNTHETIC_TLS_BYTES')})});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(upstream))
 await writeFile(executable,`#!${process.execPath}\nconst net=require('node:net');const args=process.argv.slice(2);const proxy=new URL(args[args.indexOf('--proxy')+1]);const socket=net.connect({host:proxy.hostname,port:Number(proxy.port)});let phase=0,header='';socket.on('connect',()=>socket.write('CONNECT www.youtube.com:443 HTTP/1.1\\r\\nHost: www.youtube.com:443\\r\\n\\r\\n'));socket.on('data',data=>{if(!phase){header+=data.toString();if(header.includes('200 Connection Established')){phase=1;socket.write('CLIENT_HELLO_SYNTHETIC')}}else{process.stdout.write(JSON.stringify({id:'${ID}',title:data.toString()}));socket.end()}});socket.on('error',()=>{process.exitCode=1});\n`);await chmod(executable,0o700)
 const guard=youtubeGuard(scope(),3000),seen=[]
 try{const text=await runAgentYoutubeMetadata({directory,pageUrl:PAGE,lookup:publicLookup,connect:async(target,signal)=>{seen.push(target);assert.equal(signal.aborted,false);return connectTo(upstream.address().port)}},guard,2000);assert.equal(JSON.parse(text).id,ID);assert.deepEqual(audit,['CLIENT_HELLO_SYNTHETIC']);assert.equal(seen[0].hostname,'www.youtube.com');assert.equal(seen[0].address.address,'8.8.8.8')}finally{guard.close()}
 assert.deepEqual(await readdir(directory),['yt-dlp'])
})

test('CONNECT rejects private DNS, arbitrary hosts, wrong ports and ordinary proxy GETs before dialing',async t=>{
 let dialed=0;const guard=youtubeGuard(scope(),3000),proxy=await openAgentYoutubeMetadataProxy(guard,{lookup:async host=>host==='www.youtube.com'?[{address:'127.0.0.1',family:4}]:await publicLookup(),connect:async()=>{dialed++;throw Error('not permitted')}})
 t.after(async()=>{guard.close();await proxy.close()})
 for(const target of ['www.youtube.com:443','evil.test:443','www.youtube.com:80','www.youtube.com@evil.test:443','127.0.0.1:443']){
  const socket=await connectTo(Number(new URL(proxy.url).port)),ended=new Promise(resolve=>socket.once('close',resolve));socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);await bounded(ended)
 }
 const status=await new Promise((resolve,reject)=>{http.get(proxy.url+'/http://www.youtube.com/',response=>{response.resume();resolve(response.statusCode)}).on('error',reject)});assert.equal(status,405);assert.equal(dialed,0)
})

test('explicit HTTP and SOCKS host proxies receive only the locally pinned numeric destination',async t=>{
 const connects=[],server=http.createServer();server.on('connect',(request,socket)=>{connects.push({authority:request.url,auth:request.headers['proxy-authorization']});socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',data=>socket.write(data));socket.on('end',()=>socket.destroy())});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server))
 const controller=new AbortController(),socket=await nativeAgentYoutubeConnect({hostname:'www.youtube.com',address:{address:'8.8.8.8',family:4},port:443},controller.signal,`http://user:proxy-secret@127.0.0.1:${server.address().port}`)
 assert.equal(connects[0].authority,'8.8.8.8:443');assert.equal(connects[0].auth,'Basic '+Buffer.from('user:proxy-secret').toString('base64'));socket.destroy()
 const socksAudit=[],socks=net.createServer(client=>{let phase=0;client.on('data',data=>{if(!phase++){assert.deepEqual([...data],[5,1,0]);client.write(Buffer.from([5,0]))}else{socksAudit.push([...data]);client.write(Buffer.from([5,0,0,1,127,0,0,1,0,1]))}})});await new Promise(resolve=>socks.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(socks))
 const tunnel=await nativeAgentYoutubeConnect({hostname:'www.youtube.com',address:{address:'8.8.4.4',family:4},port:443},controller.signal,`socks5h://127.0.0.1:${socks.address().port}`);assert.deepEqual(socksAudit[0],[5,1,0,1,8,8,4,4,1,187]);tunnel.destroy()
})

for(const mode of ['partial','length','stream','compression'])test(`media GET rejects ${mode}, closes transport and emits no Cookie`,async()=>{
 let closed=false,headers;const read=createYoutubeHttp({allows:()=>true,lookup:publicLookup,request:async(_url,_address,_signal,policy)=>{headers=policy.headers;return response(Buffer.alloc(1025),{...(mode==='partial'?{status:206}:{}),headers:{'content-type':'video/mp4',...(mode==='length'?{'content-length':'1025'}:mode==='compression'?{'content-encoding':'gzip'}:{})},close(){closed=true}})}}),guard=youtubeGuard(scope(),1000)
 try{await assert.rejects(async()=>youtubeBody(await read('https://rr1.googlevideo.com/videoplayback?pot=VALID_TOKEN','video',guard,1024)))}finally{guard.close()}
 assert.equal(closed,true);assert.equal(headers.Cookie,undefined);assert.equal(headers['User-Agent'],YOUTUBE_USER_AGENT);assert.equal(headers.Referer,'https://www.youtube.com/')
})

test('real HTTP streamed media seam enforces complete length, redirected public DNS and cancellation disconnect',async t=>{
 let disconnected=false;const server=http.createServer((request,output)=>{output.setHeader('content-type','video/mp4');if(request.url==='/small'){output.setHeader('content-length','4');output.end('MP4!')}else if(request.url==='/large'){output.write(Buffer.alloc(512));output.end(Buffer.alloc(513))}else{output.on('close',()=>{disconnected=true});output.write('MP')}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeServer(server))
 const read=createYoutubeHttp({allows:()=>true,lookup:publicLookup,request:(url,address,signal)=>new Promise((resolve,reject)=>{assert.equal(address.address,'8.8.8.8');const request=http.get({host:'127.0.0.1',port:server.address().port,path:url.pathname,signal},result=>resolve(response(result,{status:result.statusCode,headers:{'content-type':result.headers['content-type'],'content-length':result.headers['content-length']},close(){result.destroy();request.destroy()}})));request.on('error',reject)})}),guard=youtubeGuard(scope(),1000)
 try{assert.equal((await youtubeBody(await read('https://rr1.googlevideo.com/small','video',guard,1024))).toString(),'MP4!');await assert.rejects(youtubeBody(await read('https://rr1.googlevideo.com/large','video',guard,1024)))}finally{guard.close()}
 const cancel=new AbortController(),second=youtubeGuard(scope({signal:cancel.signal}),1000);try{const result=await read('https://rr1.googlevideo.com/hold','video',second,1024),operation=youtubeBody(result);cancel.abort();await bounded(assert.rejects(operation))}finally{second.close()}
 for(let at=0;at<30&&!disconnected;at++)await delay(5);assert.equal(disconnected,true)
})

test('media endpoint policy excludes ports, credentials, private hosts and cross-kind redirects before dispatch',async()=>{
 for(const input of ['http://i.ytimg.com/a.jpg','https://i.ytimg.com:443/a.jpg','https://i.ytimg.com@evil.test/a.jpg','https://127.0.0.1/a.jpg','https://i.ytimg.com/a/../a.jpg','https://i.ytimg.com/%2e%2e/a.jpg'])assert.throws(()=>youtubeOfficialUrl(input,'image'))
 let calls=0;const read=createYoutubeHttp({allows:()=>true,lookup:publicLookup,request:async()=>{calls++;return response('',{status:302,headers:{location:'https://evil.test/a.jpg'}})}}),guard=youtubeGuard(scope(),1000)
 try{await assert.rejects(read('https://i.ytimg.com/a.jpg','image',guard,1024))}finally{guard.close()};assert.equal(calls,1)
})

test('relative media redirects validate the absolute official target before the legal PO query policy',async()=>{
 let calls=0;const seen=[],read=createYoutubeHttp({lookup:publicLookup,allows:value=>value.startsWith('https://rr1.googlevideo.com/videoplayback')&&new URL(value).searchParams.getAll('pot').length<=1,request:async url=>{seen.push(url.href);return++calls===1?response('',{status:302,headers:{location:'?pot=LEGAL_TASK_PO_TOKEN'}}):response(Buffer.from('MP4!'))}}),guard=youtubeGuard(scope(),1000)
 try{assert.equal((await youtubeBody(await read('https://rr1.googlevideo.com/videoplayback','video',guard,1024))).toString(),'MP4!')}finally{guard.close()}
 assert.deepEqual(seen,['https://rr1.googlevideo.com/videoplayback','https://rr1.googlevideo.com/videoplayback?pot=LEGAL_TASK_PO_TOKEN'])
})

test('direct provider host-proxy configuration matches the bounded bootstrap syntax',async()=>{
 const {validateYoutubeProxyUrl}=await at('agentYoutubeRelayHttp')
 for(const value of ['http://127.0.0.1:7890?','http://127.0.0.1:7890#','http://user:has%20space@127.0.0.1:7890','http://'+('a'.repeat(2040))+':7890'])assert.throws(()=>validateYoutubeProxyUrl(value),value)
 assert.equal(validateYoutubeProxyUrl('socks5h://user:literal%3Fpassword@127.0.0.1:7890'),'socks5h://user:literal%3Fpassword@127.0.0.1:7890')
})
