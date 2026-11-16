import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { access, lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const moduleAt = file => import(pathToFileURL(path.join(release, `dist/backend/modules/media/infrastructure/${file}.js`)).href)
const { xiaohongshuGuard } = await moduleAt('agentXiaohongshuRelayHttp')
const { openAgentXiaohongshuBrowserSession } = await moduleAt('agentXiaohongshuRelayBrowser')
const { createAgentXiaohongshuRelayProvider } = await moduleAt('agentXiaohongshuRelayProvider')
const { createAgentMediaArtifactStore } = await moduleAt('agentMediaArtifactStore')
const ID = '6ad4a9c200000000290162d4', OTHER = '6ad4a9c200000000290162d5', TOKEN = 'TRANSIENT_XHS_ACCESS_TOKEN_12345=', HOST_COOKIE = 'HOST_XHS_COOKIE_PRIVATE_123456'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
function mp4() { const bytes = Buffer.alloc(64); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
async function selectChrome(t) {
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH, puppeteer = (await import('puppeteer')).default
  for (const candidate of [previous, puppeteer.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await access(candidate); process.env.PUPPETEER_EXECUTABLE_PATH = candidate; t.after(() => { if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH; else process.env.PUPPETEER_EXECUTABLE_PATH = previous }); return } catch {}
  }
  assert.fail('Real XHS browser regression requires an installed Chrome')
}
async function directory() { return realpath(await mkdtemp(path.join(tmpdir(), 'xhs-browser-test-'))) }
const scope = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })

test('XHS production launcher blocks native WebRTC outside HTTP interception and removes its own profile', { timeout: 20000 }, async t => {
  await selectChrome(t)
  const root = await directory(t), socket = dgram.createSocket('udp4'), packets = []
  socket.on('message', data => packets.push(data.length)); socket.bind(0, '127.0.0.1'); await once(socket, 'listening'); t.after(() => socket.close())
  const guard = xiaohongshuGuard(scope(), 12000), session = await openAgentXiaohongshuBrowserSession(guard, root)
  t.after(async () => { guard.close(); await session.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal((await lstat(path.join(root, 'browser-profile'))).mode & 0o077, 0)
  const page = await session.browser.newPage(); let intercepted = 0
  await page.setRequestInterception(true); page.on('request', request => { intercepted++; void request.abort().catch(() => {}) })
  await page.evaluate(async port => { const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] }); globalThis.fixturePeer = peer; peer.createDataChannel('xhs-isolation'); await peer.setLocalDescription(await peer.createOffer()) }, socket.address().port)
  await delay(1200); await page.evaluate(() => globalThis.fixturePeer.close()); assert.deepEqual(packets, []); assert.equal(intercepted, 0)
  await session.close(); assert.deepEqual(await readdir(root), [])
})

test('real anonymous mobile Chrome resolves only the target note and aligned live slots through pinned HTTP without host cookies or access exfiltration', { timeout: 35000 }, async t => {
  await selectChrome(t)
  const root = await directory(t), artifacts = await createAgentMediaArtifactStore({ directory: root }), requests = [], seen = []
  const anon = 'ANONYMOUS_XHS_HTTP_SESSION_12345', js = 'ANONYMOUS_XHS_JS_SESSION_12345'
  let pages = 0, contentCookie = '', active = 0, maximum = 0, prepared, report
  const target = { noteId: ID, title: '目标移动笔记', desc: '完整正文\n#实况[话题]#', type: 'normal', user: { nickname: '作者' }, imageList: [
    { url: 'https://sns-webpic-qc.xhscdn.com/first.png' },
    { url: 'https://sns-webpic-qc.xhscdn.com/second.png', livePhoto: true, stream: { h264: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/live.mp4?sign=cdn', duration: 2 }] } },
    { url: 'https://sns-webpic-qc.xhscdn.com/third.png' },
  ] }
  const state = { note: { noteDetailMap: { [OTHER]: { note: { ...target, noteId: OTHER, title: '推荐内容' } }, [ID]: { note: target } } } }
  const script = `(() => {
    const out={}; const attempt=(name, fn)=>{try{fn();out[name]='allowed'}catch(error){out[name]=error.name}};
    attempt('rtc',()=>new RTCPeerConnection()); attempt('worker',()=>new Worker(URL.createObjectURL(new Blob(['new RTCPeerConnection()']))));
    attempt('transport',()=>new WebTransport('https://127.0.0.1:9/')); attempt('serviceWorker',()=>navigator.serviceWorker.register('/sw.js'));
    const popup=window.open('about:blank');out.popup=popup===null?'blocked':'allowed';if(popup)popup.close();
    document.cookie='a1=${js}; Secure; Path=/';
    const token=new URL(location.href).searchParams.get('xsec_token');
    fetch('https://fe-static.xiaohongshu.com/leak.js?foo='+encodeURIComponent(token)).catch(()=>{});
    fetch('/api/leak?foo='+encodeURIComponent(token)).catch(()=>{});
    fetch('http://127.0.0.1:9/forbidden').catch(()=>{});fetch('https://evil.test/forbidden').catch(()=>{});
    fetch('https://sns-webpic-private.xhscdn.com/private').catch(()=>{});
    fetch('/fixture/report?value='+encodeURIComponent(JSON.stringify(out))).then(()=>fetch('/api/sns/web/v1/content?note_id=${ID}')).then(r=>r.json()).then(value=>{window.__INITIAL_STATE__=value;document.body.innerHTML='<main data-note-id="${ID}"><h1>目标</h1></main>'});
  })();`
  const server = http.createServer((request, output) => {
    seen.push({ path: request.url, cookie: request.headers.cookie }); active++; maximum = Math.max(maximum, active); output.on('close', () => active--)
    if (request.url.startsWith(`/explore/${ID}`)) {
      output.setHeader('content-type', 'text/html')
      if (++pages === 1) { assert.equal(request.headers.cookie, `web_session=${HOST_COOKIE}`); output.end('<html>Static challenge</html>'); return }
      assert.equal(request.headers.cookie, undefined); output.setHeader('set-cookie', `webId=${anon}; Secure; HttpOnly; Path=/`)
      output.end(`<html><body><script src="https://fe-static.xiaohongshu.com/fixture.js"></script></body></html>`)
    } else if (request.url === '/fixture.js') { output.setHeader('content-type', 'application/javascript'); output.end(script) }
    else if (request.url.startsWith('/fixture/report')) { report = JSON.parse(new URL(request.url, 'https://www.xiaohongshu.com').searchParams.get('value')); output.setHeader('content-type', 'application/json'); output.end('{}') }
    else if (request.url.startsWith('/api/sns/web/v1/content')) { contentCookie = request.headers.cookie || ''; output.setHeader('content-type', 'application/json'); output.end(JSON.stringify(state)) }
    else if (request.url.startsWith('/live.mp4')) { output.setHeader('content-type', 'video/mp4'); output.end(mp4()) }
    else { output.setHeader('content-type', 'image/png'); output.end(PNG) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => {
    try { await prepared?.release(); await artifacts.close(); assert.deepEqual(await readdir(root), []) }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
  })
  const provider = createAgentXiaohongshuRelayProvider({ directory: root, artifacts, secrets: [HOST_COOKIE], authCookie: `web_session=${HOST_COOKIE}`,
    lookup: async host => [{ address: host === 'sns-webpic-private.xhscdn.com' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
    request: (url, address, signal, policy) => new Promise((resolve, reject) => {
      assert.equal(address.address, '8.8.8.8'); requests.push({ url: url.href, headers: policy.headers }); const request = http.get({ host: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, signal, headers: { ...policy.headers } }, output => resolve({ status: output.statusCode, headers: { 'content-type': output.headers['content-type'] }, body: output, ...(output.headers['set-cookie'] ? { setCookies: output.headers['set-cookie'] } : {}), close() { output.destroy(); request.destroy() } })); request.on('error', reject)
    }), native: async (_command, args) => { await writeFile(args.at(-1), JPEG); return { stdout: '' } } })
  prepared = await provider.prepare({ provider: 'xiaohongshu', reference: { kind: 'note', id: ID } }, scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', xsecToken: TOKEN, xsecSource: 'app_share', mediaKind: 'image' }) }))
  assert.equal(prepared.status, 'ready'); assert.deepEqual(prepared.plan.items.map(item => item.parts[0].kind), ['text', 'text', 'image', 'video', 'image'])
  assert.equal(pages, 2); assert.ok(contentCookie.includes(`webId=${anon}`)); assert.ok(contentCookie.includes(`a1=${js}`)); assert.equal(contentCookie.includes(HOST_COOKIE), false)
  assert.ok(maximum <= 4); assert.equal(seen.some(value => /leak|private|forbidden/u.test(value.path)), false)
  assert.ok(requests.filter(value => new URL(value.url).hostname !== 'www.xiaohongshu.com').every(value => value.headers.Cookie === undefined && !value.url.includes('xsec_')))
  for (const secret of [HOST_COOKIE, TOKEN, anon, js, '推荐内容', 'xhscdn.com', root]) assert.equal(JSON.stringify(prepared).includes(secret), false)
  for (const key of ['rtc', 'worker', 'transport', 'serviceWorker']) assert.ok(['SecurityError', 'TypeError'].includes(report[key]), key)
  assert.equal(report.popup, 'blocked')
  await prepared.release(); await artifacts.close(); assert.deepEqual(await readdir(root), [])
})

test('real mobile Chrome posts the exact signed target feed with anonymous parent cookies and rejects all other POST access', { timeout: 35000 }, async t => {
  await selectChrome(t)
  const root = await directory(t), artifacts = await createAgentMediaArtifactStore({ directory: root }), audit = [], feed = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed'
  const anonymous = 'PARENT_XHS_ANONYMOUS_COOKIE_12345', js = 'PARENT_XHS_JS_COOKIE_12345', signature = 'XYW_SYNTHETIC_REQUEST_SIGNATURE_12345'
  const body = ` {\n "source_note_id": "${ID}", "image_formats": ["jpg","webp"], "extra": {"need_body_topic": "1"}, "xsec_source":"app_share", "xsec_token": "${TOKEN}"\n } `
  const target = { noteId: ID, title: 'POST目标笔记', desc: 'POST完整正文', type: 'normal', imageList: [
    { url: 'https://sns-webpic-qc.xhscdn.com/post-first.png' }, { url: 'https://sns-webpic-qc.xhscdn.com/post-live.png', livePhoto: true, stream: { h264: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/post-live.mp4', duration: 2 }] } },
  ] }
  let pages = 0, prepared
  const server = http.createServer(async (request, output) => {
    const chunks = []; for await (const bytes of request) chunks.push(bytes)
    audit.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
    if (request.url.startsWith('/explore/')) {
      output.setHeader('content-type', 'text/html'); if (++pages === 1) { output.end('<html>Static challenge</html>'); return }
      output.setHeader('set-cookie', `webId=${anonymous}; Domain=.xiaohongshu.com; Secure; HttpOnly; Path=/`)
      const invalid = [
        { url: feed, body: JSON.stringify({ source_note_id: OTHER, xsec_token: TOKEN }) },
        { url: feed, body: JSON.stringify({ source_note_id: ID, xsec_token: 'BORROWED_UNVERIFIED_TOKEN_12345' }) },
        { url: feed, body: JSON.stringify({ source_note_id: ID, foo: TOKEN }) },
        { url: feed + '?foo=1', body }, { url: feed.replace('/feed', '/other'), body }, { url: feed.replace('edith.', 'fe-static.'), body },
      ]
      output.end(`<html><body><script>
        document.cookie='a1=${js}; Domain=.xiaohongshu.com; Secure; Path=/';
        const headers={'Content-Type':'application/json','x-s':${JSON.stringify(signature)},'X-T':'1700000000123','X-S-Common':'COMMON_SYNTHETIC_SIGNATURE'};
        document.cookie='poison='+${JSON.stringify(TOKEN)}+'; Domain=.xiaohongshu.com; Secure; Path=/';
        Promise.all([fetch('/api/poison').catch(()=>{}),fetch(${JSON.stringify(feed)},{method:'POST',credentials:'include',headers,body:${JSON.stringify(body)}}).catch(()=>{})]).then(()=>{
          document.cookie='poison=; Domain=.xiaohongshu.com; Secure; Path=/; Max-Age=0';
          return fetch(${JSON.stringify(feed)},{method:'POST',credentials:'include',headers:{...headers,'x-untrusted-native':'must-not-pass'},body:${JSON.stringify(body)}}).catch(()=>{});
        }).then(()=>Promise.all(${JSON.stringify(invalid)}.map(value=>fetch(value.url,{method:'POST',credentials:'include',headers,body:value.body}).catch(()=>{})))).then(()=>
          fetch(${JSON.stringify(feed)},{method:'POST',credentials:'include',headers,body:${JSON.stringify(body)}})).then(r=>r.json()).then(value=>{window.__INITIAL_STATE__=value;document.body.innerHTML='<main data-note-id="${ID}"><h1>POST</h1></main>'}).catch(()=>{});
      </script></body></html>`)
    } else if (request.url === '/api/sns/web/v1/feed') { output.setHeader('content-type', 'application/json'); output.end(JSON.stringify({ data: { items: [{ note_card: target }] } })) }
    else if (request.url.endsWith('.mp4')) { output.setHeader('content-type', 'video/mp4'); output.end(mp4()) }
    else { output.setHeader('content-type', 'image/png'); output.end(PNG) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { try { await prepared?.release(); await artifacts.close(); assert.deepEqual(await readdir(root), []) } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) } })
  const provider = createAgentXiaohongshuRelayProvider({ directory: root, artifacts, authCookie: `web_session=${HOST_COOKIE}`, secrets: [HOST_COOKIE], lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (url, address, signal, policy) => new Promise((resolve, reject) => {
      assert.equal(address.address, '8.8.8.8')
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, signal, method: policy.method ?? 'GET', headers: { ...policy.headers } }, output => resolve({ status: output.statusCode, headers: { 'content-type': output.headers['content-type'], location: output.headers.location }, body: output, ...(output.headers['set-cookie'] ? { setCookies: output.headers['set-cookie'] } : {}), close() { output.destroy(); request.destroy() } })); request.on('error', reject); request.end(policy.body)
    }), native: async (_command, args) => { await writeFile(args.at(-1), JPEG); return { stdout: '' } } })
  prepared = await provider.prepare({ provider: 'xiaohongshu', reference: { kind: 'note', id: ID } }, scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', xsecToken: TOKEN, xsecSource: 'app_share', mediaKind: 'image' }) }))
  assert.equal(prepared.status, 'ready'); assert.deepEqual(prepared.plan.items.map(item => item.parts[0].kind), ['text', 'text', 'image', 'video'])
  assert.equal(audit.some(value => value.path === '/api/poison'), false)
  const posts = audit.filter(value => value.method === 'POST'); assert.equal(posts.length, 1); assert.equal(posts[0].path, '/api/sns/web/v1/feed'); assert.equal(posts[0].body, body)
  assert.equal(posts[0].headers['x-s'], signature); assert.equal(posts[0].headers['x-t'], '1700000000123'); assert.equal(posts[0].headers['x-s-common'], 'COMMON_SYNTHETIC_SIGNATURE'); assert.equal(posts[0].headers['x-untrusted-native'], undefined)
  assert.equal(posts[0].headers.origin, 'https://www.xiaohongshu.com'); assert.equal(posts[0].headers.referer, 'https://www.xiaohongshu.com/')
  assert.ok(posts[0].headers.cookie.includes(`webId=${anonymous}`)); assert.ok(posts[0].headers.cookie.includes(`a1=${js}`)); assert.equal(posts[0].headers.cookie.includes(HOST_COOKIE), false)
  assert.equal(audit.filter(value => !value.path.startsWith('/explore/') && value.method !== 'POST').some(value => value.headers.cookie), false)
  for (const value of [TOKEN, HOST_COOKIE, anonymous, js, signature]) assert.equal(JSON.stringify(prepared).includes(value), false)
})
