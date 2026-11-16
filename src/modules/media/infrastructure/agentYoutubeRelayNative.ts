import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import type { AgentYoutubeConnect, AgentYoutubeFailureCode, AgentYoutubeLookup } from './agentYoutubeRelayHttp.js'
import { nativeAgentYoutubeConnect, validateYoutubeProxyUrl, youtubeExtractorHost, youtubeFailure, youtubeGuard, youtubePublicAddresses, YOUTUBE_USER_AGENT } from './agentYoutubeRelayHttp.js'

export interface AgentYoutubeNativeOptions { readonly cwd:string;readonly signal:AbortSignal;readonly timeoutMs:number;readonly maxOutputBytes:number;readonly env:Readonly<Record<string,string>> }
export type AgentYoutubeNative=(command:'yt-dlp',args:readonly string[],options:AgentYoutubeNativeOptions)=>Promise<{readonly stdout:string}>
function failureCode(error:unknown,stderr:string,signal:AbortSignal):AgentYoutubeFailureCode {
  const code=error&&typeof error==='object'?'code' in error?error.code:undefined:undefined
  if(code==='ENOENT')return 'youtube_downloader_unavailable'
  if(signal.aborted||error&&typeof error==='object'&&'killed'in error&&error.killed)return 'youtube_metadata_timeout'
  if(/confirm you.?re not a bot|cookies(?:-from-browser)?|sign in|login|members.only|private video|premium/iu.test(stderr))return 'youtube_access_required'
  if(/not available in your country|geo.?restrict/iu.test(stderr))return 'youtube_region_restricted'
  return 'youtube_metadata_failed'
}
/** Fixed executable, no shell. Rejection is delayed until the actual child close event. */
export const nativeAgentYoutubeCommand:AgentYoutubeNative=(command,args,options)=>new Promise((resolve,reject)=>{
  let callbackDone=false,closed=false,stdout='',code:AgentYoutubeFailureCode|undefined
  const finish=()=>{if(callbackDone&&closed){if(code||options.signal.aborted)reject(youtubeFailure(code??'youtube_metadata_timeout'));else resolve({stdout})}}
  const child=execFile(command,[...args],{cwd:options.cwd,env:{...options.env},signal:options.signal,timeout:options.timeoutMs,killSignal:'SIGKILL',windowsHide:true,encoding:'utf8',maxBuffer:options.maxOutputBytes},(error,output,stderr)=>{
    callbackDone=true
    if(error)code=failureCode(error,stderr,options.signal)
    else if(Buffer.byteLength(output)>options.maxOutputBytes)code='youtube_metadata_failed'
    else stdout=output
    finish()
  })
  child.on('error',error=>{code=failureCode(error,'',options.signal)});child.once('close',()=>{closed=true;finish()})
})

/** Job-owned CONNECT gate for conventional yt-dlp HTTP(S), not an OS sandbox. */
export async function openAgentYoutubeMetadataProxy(guard:ReturnType<typeof youtubeGuard>,options:{lookup?:AgentYoutubeLookup;connect?:AgentYoutubeConnect;proxyUrl?:string}={}) {
  const upstream=validateYoutubeProxyUrl(options.proxyUrl),sockets=new Set<Duplex>(),work=new Set<Promise<void>>()
  let requests=0,totalBytes=0,closing:Promise<void>|undefined
  const server=http.createServer({maxHeaderSize:8192},(_request,response)=>{response.writeHead(405,{'Connection':'close'});response.end()})
  server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket))})
  server.on('clientError',(_error,socket)=>socket.destroy())
  server.on('connect',(request,client,head)=>{
    const operation=(async()=>{
      let remote:Awaited<ReturnType<AgentYoutubeConnect>>|undefined
      try{
        await guard.ensure()
        const match=/^([a-z0-9.-]+):443$/u.exec(request.url??''),host=match?.[1]
        if(++requests>128||sockets.size>16||!host||!youtubeExtractorHost(host)||head.byteLength>16_384)throw youtubeFailure()
        const addresses=await youtubePublicAddresses(host,guard,options.lookup)
        remote=await guard.wait((options.connect??nativeAgentYoutubeConnect)({hostname:host,address:addresses[0]!,port:443},guard.signal,upstream),late=>late.destroy())
        await guard.ensure();sockets.add(remote);remote.on('error',()=>{});remote.once('close',()=>sockets.delete(remote!))
        let ownBytes=head.byteLength
        const close=()=>{client.destroy();remote?.destroy()}
        const count=(chunk:Buffer)=>{ownBytes+=chunk.length;totalBytes+=chunk.length;if(ownBytes>16*1024*1024||totalBytes>64*1024*1024||guard.signal.aborted)close()}
        client.on('data',count);remote.on('data',count);client.once('error',close);remote.once('error',close);client.once('close',close);remote.once('close',close)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client)
      }catch{remote?.destroy();client.destroy()}
    })();work.add(operation);void operation.finally(()=>work.delete(operation)).catch(()=>{})
  })
  const close=():Promise<void>=>closing??=(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await Promise.allSettled([...work])})()
  const abort=()=>{void close()};guard.signal.addEventListener('abort',abort,{once:true})
  try{
    await guard.wait(new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve())}));await guard.ensure()
    const address=server.address();if(!address||typeof address==='string')throw youtubeFailure()
    return {url:`http://127.0.0.1:${address.port}`,async close(){guard.signal.removeEventListener('abort',abort);await close()}}
  }catch{guard.signal.removeEventListener('abort',abort);await close();throw youtubeFailure()}
}
export interface AgentYoutubeMetadataOptions {readonly directory:string;readonly pageUrl:string;readonly authCookie?:string;readonly poToken?:string;readonly proxyUrl?:string;readonly lookup?:AgentYoutubeLookup;readonly connect?:AgentYoutubeConnect;readonly native?:AgentYoutubeNative;readonly allows?:(value:string)=>boolean}
function cookieJar(input:string|undefined):string {
  if(input===undefined||input==='')return ''
  const text=input.replace(/^\s*cookie\s*:\s*/iu,'').trim()
  if(text.length>32768||/[^\x20-\x7e]/u.test(text))throw youtubeFailure()
  const rows:string[]=[]
  for(const part of text.split(';')){
    if(!part.trim())continue
    const index=part.indexOf('='),name=part.slice(0,index).trim(),value=part.slice(index+1).trim()
    if(index<1||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)||/[^\x21-\x7e]/u.test(value))throw youtubeFailure()
    rows.push(`.youtube.com\tTRUE\t/\tTRUE\t0\t${name}\t${value}`)
  }
  return ['# Netscape HTTP Cookie File',...rows,''].join('\n')
}
export async function runAgentYoutubeMetadata(options:AgentYoutubeMetadataOptions,parent:ReturnType<typeof youtubeGuard>,timeoutMs:number):Promise<string> {
  if(!options||!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/u.test(options.pageUrl)||!path.isAbsolute(options.directory)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw youtubeFailure()
  const guard=youtubeGuard(parent.context,timeoutMs)
  let directory='',proxy:Awaited<ReturnType<typeof openAgentYoutubeMetadataProxy>>|undefined,operation:Promise<{readonly stdout:string}>|undefined
  try{
    await guard.ensure()
    const root=await guard.wait(realpath(options.directory)),stat=await guard.wait(lstat(options.directory))
    if(root!==options.directory||!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||options.allows?.(options.pageUrl)===false)throw youtubeFailure()
    const cookie=cookieJar(options.authCookie),token=options.poToken??''
    if(typeof token!=='string'||token.length>8192||token&&!/^[A-Za-z0-9_+./=-]+$/u.test(token))throw youtubeFailure()
    directory=await guard.wait(mkdtemp(path.join(root,'yt-dlp-')),late=>rm(late,{recursive:true,force:true}));await chmod(directory,0o700)
    proxy=await openAgentYoutubeMetadataProxy(guard,{...(options.lookup?{lookup:options.lookup}:{}),...(options.connect?{connect:options.connect}:{}),...(options.proxyUrl?{proxyUrl:options.proxyUrl}:{})})
    const args=['--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--dump-single-json','--skip-download','--ignore-no-formats-error','--no-warnings','--no-progress','--retries','1','--extractor-retries','1','--socket-timeout','10','--user-agent',YOUTUBE_USER_AGENT,'--proxy',proxy.url,'-f','worst[ext=mp4][vcodec!=none][acodec!=none]']
    if(cookie){const file=path.join(directory,'cookies.txt');await guard.wait(writeFile(file,cookie,{mode:0o600,flag:'wx'}));args.push('--cookies',file)}
    if(token){const file=path.join(directory,'yt-dlp.conf');await guard.wait(writeFile(file,`--extractor-args\nyoutube:po_token=web+${token}\n`,{mode:0o600,flag:'wx'}));args.push('--config-locations',file)}
    args.push(options.pageUrl)
    const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:directory,USERPROFILE:directory,XDG_CONFIG_HOME:directory,XDG_CACHE_HOME:directory,XDG_DATA_HOME:directory,APPDATA:directory,LOCALAPPDATA:directory,TMPDIR:directory,TMP:directory,TEMP:directory,PYTHONNOUSERSITE:'1',PYTHONSAFEPATH:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',LANG:'C',LC_ALL:'C'}
    operation=Promise.resolve().then(()=>{guard.check();return(options.native??nativeAgentYoutubeCommand)('yt-dlp',args,{cwd:directory,env,signal:guard.signal,timeoutMs,maxOutputBytes:2*1024*1024})})
    const result=await guard.wait(operation);await guard.ensure()
    if(typeof result?.stdout!=='string'||Buffer.byteLength(result.stdout)>2*1024*1024)throw youtubeFailure()
    return result.stdout
  }catch(error){
    try{await parent.ensure()}catch{throw youtubeFailure()}
    if(guard.signal.aborted)throw youtubeFailure('youtube_metadata_timeout')
    const code=error&&typeof error==='object'&&'code'in error?error.code:undefined
    if(['youtube_downloader_unavailable','youtube_access_required','youtube_region_restricted','youtube_metadata_timeout'].includes(String(code)))throw youtubeFailure(code as AgentYoutubeFailureCode)
    throw youtubeFailure()
  }finally{guard.close();await proxy?.close();await operation?.catch(()=>{});if(directory)await rm(directory,{recursive:true,force:true})}
}
