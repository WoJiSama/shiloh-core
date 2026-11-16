import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import https from 'node:https'
import net, { isIP, type Socket } from 'node:net'
import tls from 'node:tls'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'

export type AgentYoutubeFailureCode = 'youtube_downloader_unavailable'|'youtube_access_required'|'youtube_region_restricted'|'youtube_metadata_timeout'|'youtube_metadata_failed'
export const youtubeFailure = (code:AgentYoutubeFailureCode='youtube_metadata_failed') => Object.assign(new Error('YouTube 媒体获取失败：来源、权限、网络或内容不符合要求'),{code})
export type YoutubeRequestKind = 'video' | 'image'
export interface AgentYoutubeRequestPolicy { readonly maxBytes: number; readonly headers: Readonly<Record<string, string>> }
export interface AgentYoutubeResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array> | Uint8Array | string
  readonly setCookies?: readonly string[]
  close?(): Promise<void> | void
}
export type AgentYoutubeRequest = (url: URL, address: LookupAddress, signal: AbortSignal, policy: AgentYoutubeRequestPolicy) => Promise<AgentYoutubeResponse>
export type AgentYoutubeLookup = (hostname: string) => Promise<readonly LookupAddress[]>

export { douyinGuard as youtubeGuard } from './agentDouyinRelayHttp.js'
import { douyinGuard as youtubeGuard } from './agentDouyinRelayHttp.js'
export const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const suffix = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)
export function youtubeOfficialUrl(input: string, kind: YoutubeRequestKind): URL {
  if (typeof input !== 'string' || !input || input.length > 16_384 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw youtubeFailure()
  const authority = /^https:\/\/([^/?#]+)/u.exec(input)?.[1]
  if (!authority || /[:@]/u.test(authority) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(input) || /%(?:2e|2f|5c)/iu.test(input.split('?')[0]!)) throw youtubeFailure()
  const url = new URL(input), host = url.hostname
  if (url.username || url.password || url.port || url.hash || isIP(host) || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) || !(kind === 'image' ? suffix(host, 'ytimg.com') : suffix(host, 'googlevideo.com'))) throw youtubeFailure()
  return url
}
export function youtubeExtractorHost(host: string): boolean { return ['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtubei.googleapis.com','www.youtube-nocookie.com','consent.youtube.com','consent.google.com'].includes(host) || suffix(host,'ytimg.com') || suffix(host,'googlevideo.com') }
export async function youtubePublicAddresses(host: string, guard: ReturnType<typeof youtubeGuard>, lookup?: AgentYoutubeLookup) {
  await guard.ensure()
  const addresses = await guard.wait((lookup ?? (name => dnsLookup(name, {all:true,verbatim:true})))(host))
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(value => !value || isIP(value.address) !== value.family || !isPublicAddress(value.address))) throw youtubeFailure()
  await guard.ensure(); return addresses
}
export function createNativeYoutubeRequest(proxyUrl?: string, connect: AgentYoutubeConnect = nativeAgentYoutubeConnect): AgentYoutubeRequest {
  const proxy = validateYoutubeProxyUrl(proxyUrl)
  return async (url, address, signal, policy) => {
    let raw: Socket | undefined, secure: tls.TLSSocket | undefined, agent: https.Agent | undefined
    try {
      raw = await connect({hostname:url.hostname,address,port:443},signal,proxy)
      secure = tls.connect({socket:raw,servername:url.hostname,rejectUnauthorized:true}); await connected(secure,'secureConnect',signal)
      const owned = secure; agent = new https.Agent({keepAlive:false,maxSockets:1}); agent.createConnection = () => owned
      const owner = agent
      return await new Promise<AgentYoutubeResponse>((resolve,reject) => {
        const request = https.request(url,{method:'GET',signal,agent:owner,maxHeaderSize:16_384,headers:{...policy.headers,'Accept-Encoding':'identity'}},response=>{
          response.on('error',()=>{})
          resolve({status:response.statusCode??0,headers:{'content-type':response.headers['content-type'],'content-length':response.headers['content-length'],'content-encoding':response.headers['content-encoding'],location:response.headers.location},body:response,
            close(){response.destroy();request.destroy();owned.destroy();owner.destroy()}})
        });request.once('error',()=>reject(youtubeFailure()));request.end()
      })
    } catch { secure?.destroy();raw?.destroy();agent?.destroy();throw youtubeFailure() }
  }
}
export const nativeAgentYoutubeRequest: AgentYoutubeRequest = (url,address,signal,policy)=>createNativeYoutubeRequest()(url,address,signal,policy)

export function createYoutubeHttp(options: { lookup?: AgentYoutubeLookup; request?: AgentYoutubeRequest; proxyUrl?: string; connect?: AgentYoutubeConnect; allows(value: string): boolean }) {
  const native = createNativeYoutubeRequest(options.proxyUrl, options.connect)
  return async (input: string, kind: YoutubeRequestKind, guard: ReturnType<typeof youtubeGuard>, maxBytes: number) => {
    let url = youtubeOfficialUrl(input, kind)
    for (let hop = 0; hop <= 4; hop++) {
      if (!options.allows(url.href)) throw youtubeFailure()
      await guard.ensure()
      const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw youtubeFailure()
      await guard.ensure()
      const response = await guard.wait((options.request ?? native)(url, addresses[0]!, guard.signal, {
        maxBytes, headers: { 'User-Agent': YOUTUBE_USER_AGENT, Referer: 'https://www.youtube.com/', Accept: '*/*' },
      }), late => late.close?.())
      let closed = false
      const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status)) throw youtubeFailure()
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || /[\\\s]/u.test(location) ||
            /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw youtubeFailure()
          const authority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
          if (authority && /[:@]/u.test(authority)) throw youtubeFailure()
          const redirected = youtubeOfficialUrl(new URL(location, url).href, kind)
          if (!options.allows(redirected.href)) throw youtubeFailure()
          url = redirected; await close(); continue
        }
        if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw youtubeFailure()
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw youtubeFailure()
        const body = response.body
        const iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array
          ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw youtubeFailure()
        let consumed = false
        return { url, mime: (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), close,
          chunks: (async function* () {
            if (consumed) throw youtubeFailure(); consumed = true
            let size = 0
            const iterator = iterable[Symbol.asyncIterator]()
            try {
              while (true) {
                await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next()))
                if (next.done) break
                if (!(next.value instanceof Uint8Array)) throw youtubeFailure()
                size += next.value.byteLength
                if (size > maxBytes) throw youtubeFailure()
                for (let at = 0; at < next.value.byteLength; at += 1024 * 1024) { await guard.ensure(); yield Buffer.from(next.value.subarray(at, at + 1024 * 1024)) }
              }
              if (!size || length !== undefined && Number(length) !== size) throw youtubeFailure()
              await guard.ensure()
            } finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {}; await close() }
          })() }
      } catch { await close(); throw youtubeFailure() }
    }
    throw youtubeFailure()
  }
}

export async function youtubeBody(response: { chunks: AsyncIterable<Uint8Array> }): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const bytes of response.chunks) chunks.push(Buffer.from(bytes))
  return Buffer.concat(chunks)
}

export interface AgentYoutubeTunnelTarget { readonly hostname: string; readonly address: LookupAddress; readonly port: 443 }
export type AgentYoutubeConnect = (target: AgentYoutubeTunnelTarget, signal: AbortSignal, proxyUrl?: string) => Promise<Socket>
function proxyAddress(input: string): URL {
  if (typeof input !== 'string' || input.length > 2048 || /[?#\s\\\u0000-\u001f\u007f]/u.test(input)) throw youtubeFailure()
  const url = new URL(input)
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.hash || url.search || !['', '/'].includes(url.pathname) || !url.hostname) throw youtubeFailure()
  for (const value of [url.username,url.password]) { let text:string;try{text=decodeURIComponent(value)}catch{throw youtubeFailure()};if(Buffer.byteLength(text)>255||/[\s\u0000-\u001f\u007f]/u.test(text))throw youtubeFailure() }
  return url
}
export function validateYoutubeProxyUrl(input: string | undefined): string | undefined { return input === undefined || input === '' ? undefined : proxyAddress(input).href }
async function connected(socket: Socket, event: 'connect'|'secureConnect', signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{socket.removeListener(event,ready);socket.removeListener('error',fail);socket.removeListener('close',fail);signal.removeEventListener('abort',fail)}
    const fail=()=>{cleanup();socket.destroy();reject(youtubeFailure())},ready=()=>{cleanup();if(signal.aborted)fail();else resolve(socket)}
    socket.once(event,ready);socket.once('error',fail);socket.once('close',fail);if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true})
  })
}
async function bytes(socket: Socket, length:number,signal:AbortSignal):Promise<Buffer> {
  if(signal.aborted||socket.destroyed)throw youtubeFailure()
  const found=socket.read(length) as Buffer|null;if(found)return found
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{socket.removeListener('readable',ready);socket.removeListener('error',fail);socket.removeListener('end',fail);socket.removeListener('close',fail);signal.removeEventListener('abort',fail)}
    const ready=()=>{cleanup();resolve()},fail=()=>{cleanup();reject(youtubeFailure())}
    socket.once('readable',ready);socket.once('error',fail);socket.once('end',fail);socket.once('close',fail);if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true})
  });return bytes(socket,length,signal)
}
function ipBytes(address:LookupAddress):Buffer {
  if(address.family===4)return Buffer.from(address.address.split('.').map(Number))
  const parts=address.address.split('::'),left=parts[0]!.split(':').filter(Boolean),right=(parts[1]??'').split(':').filter(Boolean)
  const fields=[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right]
  if(fields.length!==8||fields.some(value=>!/^[a-f0-9]{1,4}$/iu.test(value)))throw youtubeFailure()
  const result=Buffer.alloc(16);fields.forEach((value,index)=>result.writeUInt16BE(Number.parseInt(value,16),index*2));return result
}
/** The optional upstream proxy is host-owned; every destination is already a locally pinned public IP. */
export const nativeAgentYoutubeConnect:AgentYoutubeConnect=async(target,signal,proxyUrl)=>{
  if(target.port!==443||isIP(target.address.address)!==target.address.family||!isPublicAddress(target.address.address)||signal.aborted)throw youtubeFailure()
  let socket:Socket|undefined
  try{
    if(!proxyUrl)socket=await connected(net.connect({host:target.address.address,port:443,family:target.address.family}),'connect',signal)
    else{
      const proxy=proxyAddress(proxyUrl),host=proxy.hostname.replace(/^\[|\]$/gu,''),port=Number(proxy.port||(proxy.protocol==='https:'?443:proxy.protocol.startsWith('socks')?1080:80))
      const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await dnsLookup(host,{all:true,verbatim:true}),address=addresses[0]
      if(!address||![4,6].includes(address.family))throw youtubeFailure()
      socket=await connected(net.connect({host:address.address,port,family:address.family}),'connect',signal)
      if(proxy.protocol==='https:')socket=await connected(tls.connect({socket,servername:isIP(host)?undefined:host,rejectUnauthorized:true}),'secureConnect',signal)
      if(proxy.protocol==='http:'||proxy.protocol==='https:'){
        const authority=`${target.address.family===6?`[${target.address.address}]`:target.address.address}:443`,auth=proxy.username||proxy.password?`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`:''
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
        let header='';while(!header.endsWith('\r\n\r\n')){if(header.length>=16_384)throw youtubeFailure();header+=(await bytes(socket,1,signal)).toString('latin1')}
        if(!/^HTTP\/1\.[01] 200(?: |\r)/u.test(header))throw youtubeFailure()
      }else{
        const user=Buffer.from(decodeURIComponent(proxy.username)),pass=Buffer.from(decodeURIComponent(proxy.password))
        socket.write(user.length||pass.length?Buffer.from([5,2,0,2]):Buffer.from([5,1,0]))
        const greeting=await bytes(socket,2,signal);if(greeting[0]!==5||![0,2].includes(greeting[1]!))throw youtubeFailure()
        if(greeting[1]===2){if(!user.length&&!pass.length)throw youtubeFailure();socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([pass.length]),pass]));const auth=await bytes(socket,2,signal);if(auth[0]!==1||auth[1]!==0)throw youtubeFailure()}
        socket.write(Buffer.concat([Buffer.from([5,1,0,target.address.family===4?1:4]),ipBytes(target.address),Buffer.from([1,187])]))
        const result=await bytes(socket,4,signal);if(result[0]!==5||result[1]!==0||result[2]!==0)throw youtubeFailure()
        const size=result[3]===1?4:result[3]===4?16:result[3]===3?(await bytes(socket,1,signal))[0]!:0;if(!size)throw youtubeFailure();await bytes(socket,size+2,signal)
      }
    }
    const owned=socket,abort=()=>owned.destroy();owned.on('error',()=>{});signal.addEventListener('abort',abort,{once:true});owned.once('close',()=>signal.removeEventListener('abort',abort));if(signal.aborted){owned.destroy();throw youtubeFailure()};return owned
  }catch{socket?.destroy();throw youtubeFailure()}
}
