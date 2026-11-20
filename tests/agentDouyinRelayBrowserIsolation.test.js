import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { access, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const modules = path.join(release, 'dist/backend/modules/media/infrastructure')
const { douyinGuard, createDouyinHttp } = await import(pathToFileURL(path.join(modules, 'agentDouyinRelayHttp.js')).href)
const { nativeAgentDouyinBrowser, openAgentDouyinBrowserSession } = await import(pathToFileURL(path.join(modules, 'agentDouyinRelayBrowser.js')).href)
const id = '7661206883327471737', pageUrl = `https://www.douyin.com/note/${id}`

async function selectChrome() {
  const puppeteer = (await import('puppeteer')).default
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, puppeteer.executablePath(),
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
    ...(process.platform === 'win32' ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')] : []),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
  for (const candidate of candidates) { try { await access(candidate); process.env.PUPPETEER_EXECUTABLE_PATH = candidate; return } catch {} }
  assert.fail('Real browser isolation acceptance requires installed Chrome')
}
async function fixture(t) {
  await selectChrome()
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'douyin-browser-isolation-')))
  const socket = dgram.createSocket('udp4'), packets = [], cancel = new AbortController()
  socket.on('message', (bytes, remote) => packets.push({ size: bytes.length, address: remote.address }))
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening')
  t.after(async () => { cancel.abort(); socket.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, socket, packets, cancel, port: socket.address().port,
    context: { signal: cancel.signal, isCurrent: () => !cancel.signal.aborted } }
}

test('the actual production browser launcher prevents native WebRTC UDP without page constructor interception and removes its owned profile', { timeout: 20000 }, async t => {
  const f = await fixture(t), guard = douyinGuard(f.context, 12000)
  const session = await openAgentDouyinBrowserSession(guard, f.directory)
  t.after(async () => { guard.close(); await session.close() })
  const profile = session.browser.process().spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
  assert.equal((await lstat(profile)).mode & 0o077, 0)
  const page = await session.browser.newPage(); let httpRequests = 0
  await page.setRequestInterception(true)
  page.on('request', request => { httpRequests++; void request.abort().catch(() => {}) })
  const result = await page.evaluate(async port => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] })
    globalThis.isolationPeer = peer
    peer.createDataChannel('local-isolation-review')
    await peer.setLocalDescription(await peer.createOffer())
    return { nativeConstructor: typeof RTCPeerConnection, localDescription: peer.localDescription?.type }
  }, f.port)
  assert.deepEqual(result, { nativeConstructor: 'function', localDescription: 'offer' })
  await delay(1800); await page.evaluate(() => globalThis.isolationPeer.close())
  assert.deepEqual(f.packets, [], 'native ICE cannot contact even a loopback STUN socket outside the pinned HTTP port')
  assert.equal(httpRequests, 0, 'the blocked UDP path never depended on page HTTP interception')
  await session.close()
  assert.deepEqual(await readdir(f.directory), [])
  await assert.rejects(lstat(profile), { code: 'ENOENT' })
})

test('native Douyin browser keeps official scripts and signed detail requests while blocking page, iframe, popup and worker network capabilities', { timeout: 25000 }, async t => {
  const f = await fixture(t), requests = [], blocked = [], reports = []
  const target = { aweme_id: id, desc: '隔离回归作品', author: { nickname: '本地合成' },
    images: [{ url_list: ['https://p3.douyinpic.com/ordered.png'] }] }
  const html = `<html><body><script src="https://lf-douyin-pc-web.douyinstatic.com/isolation.js"></script></body></html>`
  const script = `(() => {
    const outcome = {};
    addEventListener('message', event => { if(event.data?.isolationFrame) outcome.frameRealm = event.data; });
    const capture = (name, fn) => { try { fn(); outcome[name] = 'allowed'; } catch(error) { outcome[name] = error.name; } };
    const rtc = () => { const p = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${f.port}'}]}); p.createDataChannel('native'); p.createOffer().then(v=>p.setLocalDescription(v)); };
    capture('rtc', rtc);
    capture('rtcRewrite', () => { Object.defineProperty(globalThis,'RTCPeerConnection',{value:function(){}}); });
    capture('transport', () => new WebTransport('https://127.0.0.1:${f.port}/'));
    capture('worker', () => new Worker(URL.createObjectURL(new Blob(['new RTCPeerConnection()']))));
    capture('sharedWorker', () => new SharedWorker(URL.createObjectURL(new Blob(['new RTCPeerConnection()']))));
    capture('serviceWorker', () => navigator.serviceWorker.register('/isolation-worker.js'));
    const popup = window.open('about:blank'); outcome.popup = popup === null ? 'blocked' : 'allowed'; if(popup)popup.close();
    const iframe = document.createElement('iframe');
    iframe.srcdoc = '<script>const outcome={isolationFrame:true};try{const p=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${f.port}"}]});p.createDataChannel("frame");p.createOffer().then(v=>p.setLocalDescription(v));outcome.rtc="allowed"}catch(error){outcome.rtc=error.name}try{new Worker(URL.createObjectURL(new Blob(["new RTCPeerConnection()"])));outcome.worker="allowed"}catch(error){outcome.worker=error.name}parent.postMessage(outcome,"*")<\\/script>';
    document.body.append(iframe);
    try { const p = new iframe.contentWindow.RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${f.port}'}]}); p.createDataChannel('frame'); p.createOffer().then(v=>p.setLocalDescription(v)); outcome.iframe = 'allowed'; }
    catch(error) { outcome.iframe = error.name; }
    fetch('https://127.0.0.1:${f.port}/forbidden').catch(()=>{});
    setTimeout(() => fetch('/isolation/report?value='+encodeURIComponent(JSON.stringify(outcome))).then(()=>
      fetch('/aweme/v1/web/aweme/detail/?aweme_id=${id}&msToken=anonymous-signed-detail')).catch(()=>{}), 80);
  })();`
  const read = createDouyinHttp({ allows: () => true, lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (url, address, signal) => {
    requests.push(url.href); assert.equal(address.address, '93.184.216.34'); assert.equal(signal.aborted, false)
    let body, mime = 'application/json'
    if (url.href === pageUrl) { body = html; mime = 'text/html' }
    else if (url.href === 'https://lf-douyin-pc-web.douyinstatic.com/isolation.js') { body = script; mime = 'application/javascript' }
    else if (url.pathname === '/isolation/report') { reports.push(JSON.parse(url.searchParams.get('value'))); body = '{}' }
    else if (url.pathname === '/aweme/v1/web/aweme/detail/') { assert.equal(url.searchParams.get('msToken'), 'anonymous-signed-detail'); body = JSON.stringify({ aweme_detail: target }) }
    else { blocked.push(url.href); throw Error('Unexpected browser endpoint') }
    return { status: 200, headers: { 'content-type': mime, 'content-length': String(Buffer.byteLength(body)) }, body }
  } })
  const result = await nativeAgentDouyinBrowser({ id, kind: 'note', pageUrl, directory: f.directory }, f.context, read)
  assert.equal(result?.id, id); assert.deepEqual(result.images, ['https://p3.douyinpic.com/ordered.png'])
  assert.equal(reports.length, 1)
  for (const key of ['rtc', 'transport', 'worker', 'sharedWorker', 'serviceWorker']) assert.ok(['SecurityError', 'TypeError'].includes(reports[0][key]), key)
  assert.equal(reports[0].rtcRewrite, 'TypeError'); assert.equal(reports[0].popup, 'blocked')
  assert.equal(reports[0].frameRealm?.isolationFrame, true, 'the srcdoc realm actually attempted its own blocked network capabilities')
  for (const key of ['rtc', 'worker']) assert.ok(['SecurityError', 'TypeError'].includes(reports[0].frameRealm[key]), `srcdoc ${key}`)
  assert.notEqual(reports[0].iframe, 'allowed', 'a fresh iframe cannot restore the blocked RTC constructor')
  assert.deepEqual(blocked, []); assert.ok(requests.some(url => url.includes('/aweme/v1/web/aweme/detail/')))
  assert.equal(requests.some(url => url.includes('127.0.0.1')), false)
  await delay(400); assert.deepEqual(f.packets, []); assert.deepEqual(await readdir(f.directory), [])
})
