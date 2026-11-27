import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const moduleAt = file => import(pathToFileURL(path.join(release, `dist/backend/modules/media/infrastructure/${file}.js`)).href)
const { createAgentXiaohongshuRelayProvider } = await moduleAt('agentXiaohongshuRelayProvider')
const { createAgentMediaArtifactStore } = await moduleAt('agentMediaArtifactStore')
const { createXiaohongshuHttp, xiaohongshuBody, xiaohongshuGuard, xiaohongshuOfficialUrl } = await moduleAt('agentXiaohongshuRelayHttp')
const { xiaohongshuDocumentMetadata, xiaohongshuMetadata } = await moduleAt('agentXiaohongshuRelayMetadata')
const ID = '6ad4a9c200000000290162d4', OTHER = '6ad4a9c200000000290162d5', MiB = 1024 * 1024
const TOKEN = 'XHS_SOURCE_ACCESS_TOKEN_abcd=', COOKIE = 'HOST_XHS_AUTH_COOKIE_123456'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const HEIC = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, ...Buffer.from('heicmif1')])
function mp4(size = 64) { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
const scope = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const share = (kind = 'note', id = ID) => ({ provider: 'xiaohongshu', reference: { kind, id } })
const response = (body, mime = 'text/html', extra = {}) => ({ status: 200, headers: { 'content-type': mime }, body, ...extra })
const imageUrl = index => `https://sns-webpic-qc.xhscdn.com/20261116/signed/1040g2sg00000000000000000000${String(index).padStart(2, '0')}!h5_1080jpg`
function imageSlot(index, live = false) { return { url: imageUrl(index), livePhoto: live, stream: live ? { h264: [{ masterUrl: `https://sns-video-qc.xhscdn.com/stream/live-${index}.mp4?sign=cdn`, duration: 2 }] } : {} } }
function note(overrides = {}) { return { noteId: ID, type: 'video', title: '目标笔记', desc: '第一行正文\n第二行 #话题[话题]#', user: { nickname: '作者' }, interactInfo: { liked: '1.2万', collected: '8', commentCount: '2' },
  imageList: [imageSlot(1)], video: { media: { stream: { h265: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/stream/h265.mp4', duration: 999 }], h264: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/stream/main.mp4?sign=cdn', duration: 42 }] } } }, ...overrides } }
const gallery = (count = 3, live = [], overrides = {}) => note({ type: 'normal', video: {}, imageList: Array.from({ length: count }, (_, at) => imageSlot(at + 1, live.includes(at + 1))), ...overrides })
const state = value => ({ note: { noteDetailMap: { [OTHER]: { note: note({ noteId: OTHER, title: '推荐笔记不得混入' }) }, [ID]: { note: value } } } })
const html = value => `<script>window.__INITIAL_STATE__=${JSON.stringify(state(value))}</script>`
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function allFiles(directory) { const result = []; for (const name of await readdir(directory)) { const file = path.join(directory, name); if ((await stat(file)).isDirectory()) result.push(...await allFiles(file)); else result.push(file) }; return result }
async function bounded(operation) { let timer; try { return await Promise.race([operation, new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout')), 2500) })]) } finally { clearTimeout(timer) } }
async function fixture(t, settings = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-provider-test-'))), artifacts = await createAgentMediaArtifactStore({ directory })
  const requests = [], natives = [], browsers = [], prepared = []
  const provider = createAgentXiaohongshuRelayProvider({ directory, artifacts,
    lookup: async host => settings.addresses ?? [{ address: '8.8.8.8', family: 4 }],
    request: async (url, address, signal, policy) => {
      requests.push({ url: url.href, address, signal, policy })
      return await settings.respond?.(url, signal, policy, requests) ?? (url.hostname === 'www.xiaohongshu.com' ? response(html(settings.note ?? note())) : url.hostname.startsWith('sns-video') ? response(mp4(), 'video/mp4') : response(PNG, 'image/png'))
    },
    browser: async (...args) => { browsers.push(args); return settings.browser?.(...args) },
    native: async (command, args, options) => {
      natives.push({ command, args, options }); assert.equal(command, 'ffmpeg'); assert.ok(args.includes('-protocol_whitelist')); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
      assert.equal(args.some(value => /^https?:/u.test(value)), false); assert.ok(options.cwd.startsWith(directory + path.sep)); assert.equal((await stat(options.cwd)).mode & 0o777, 0o700)
      if (settings.native) { const custom = await settings.native(command, args, options); if (custom !== undefined) return custom }
      await writeFile(args.at(-1), JPEG); return { stdout: '' }
    }, ...settings.options })
  t.after(async () => { await Promise.allSettled(prepared.map(value => value.release())); await artifacts.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) })
  return { directory, requests, natives, browsers,
    async prepare(input = share(), context = scope()) { const result = await provider.prepare(input, context); prepared.push(result); return result },
    async bytes(artifact) { const reader = await artifacts.open(artifact, scope()), chunks = []; try { for await (const bytes of reader.chunks) chunks.push(Buffer.from(bytes)); return Buffer.concat(chunks) } finally { await reader.close() } },
    async empty() { assert.deepEqual(await allFiles(directory), []) },
  }
}

test('static target video follows its PNG card and retains the complete note text without exposing signed URLs', async t => {
  const f = await fixture(t), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.xiaohongshu.com/explore/${ID}`)
  assert.equal(result.plan.items.length, 3)
  const [info, video, description] = result.plan.items
  assert.deepEqual(info.parts.map(part => part.kind), ['image']); assert.equal(description.parts[0].text, note().desc)
  assert.equal((await f.bytes(info.parts[0].artifact)).readUInt32BE(16), 920)
  assert.equal(video.parts[0].kind, 'video'); assert.deepEqual(await f.bytes(video.parts[0].artifact), mp4()); assert.deepEqual(await f.bytes(video.parts[0].thumbnail), JPEG)
  assert.equal(video.parts[0].artifact.sha256, createHash('sha256').update(mp4()).digest('hex'))
  assert.match(result.infoText, /点赞:12000/); assert.match(result.infoText, /作者:作者/)
  for (const text of ['推荐笔记', 'xhscdn.com', '?sign=', f.directory]) assert.equal(JSON.stringify(result).includes(text), false)
  assert.equal(f.browsers.length, 0); assert.equal(f.requests.some(call => call.url.includes('h265.mp4')), false)
  await result.release(); await result.release(); await f.empty()
})

test('two-thousand codepoint descriptions retain astral characters and newline in a dedicated node', async t => {
  const f = await fixture(t, { note: note({ desc: '😀'.repeat(2001) }) }), result = await f.prepare()
  assert.equal(result.plan.items.at(-1).parts[0].text, '😀'.repeat(2000)); assert.equal(result.infoText.includes('😀'), false)
})

test('gallery keeps original slots: live success replaces its image; live failure falls back to the exact original image', async t => {
  const f = await fixture(t, { note: gallery(4, [2, 3]), respond: url => url.pathname.endsWith('/live-3.mp4') ? response('', '', { status: 403 }) : undefined })
  const result = await f.prepare()
  assert.deepEqual(result.plan.items.map(item => item.parts[0].kind), ['image', 'image', 'video', 'image', 'image', 'text'])
  assert.equal(f.requests.some(call => call.url === imageUrl(2)), false)
  const paths = f.requests.map(call => new URL(call.url).pathname)
  assert.ok(paths.indexOf('/stream/live-3.mp4') < paths.indexOf(new URL(imageUrl(3)).pathname))
  assert.equal(f.requests.some(call => call.url.includes('/main.mp4')), false)
})

test('twenty slot cap preserves failures, does not shift live-photo positions or fetch the twenty-first slot', async t => {
  const value = gallery(23, [2, 20]); value.imageList[0] = { url: '' }
  const f = await fixture(t, { note: value }), result = await f.prepare()
  assert.equal(result.plan.items.length, 21); assert.match(result.infoText, /第1张图片暂时获取失败/); assert.match(result.infoText, /共23张图，仅附前20张/)
  assert.equal(result.plan.items[1].parts[0].kind, 'video'); assert.equal(result.plan.items.at(-2).parts[0].kind, 'video')
  assert.equal(f.requests.some(call => call.url === imageUrl(21)), false)
})

test('original signed images are attempted before unsigned rebuilding; CI wrappers first unwrap the signed image', async t => {
  const original = imageUrl(1), value = gallery(2); value.imageList[1].url = 'https://ci.xiaohongshu.com/' + encodeURIComponent(imageUrl(2))
  const f = await fixture(t, { note: value, respond: url => url.hostname === 'sns-webpic-qc.xhscdn.com' ? response('', '', { status: 403 }) : undefined }), result = await f.prepare()
  const urls = f.requests.slice(1).map(call => call.url)
  assert.deepEqual(urls, [original, `https://sns-img-qc.xhscdn.com/${new URL(original).pathname.split('/').at(-1).split('!')[0]}`, imageUrl(2), `https://sns-img-qc.xhscdn.com/${new URL(imageUrl(2)).pathname.split('/').at(-1).split('!')[0]}`])
  assert.equal(result.status, 'ready'); assert.equal(result.plan.items.length, 4)
})

test('type normal access prevents a main-video interpretation even if a browser hook returns a video kind', async t => {
  const value = note(), media = xiaohongshuMetadata(state(value), ID)
  const f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>challenge</html>') : undefined, browser: async () => media })
  const result = await f.prepare(share(), scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', mediaKind: 'image' }) }))
  assert.equal(result.plan.items.at(-2).parts[0].kind, 'image'); assert.equal(f.requests.some(call => call.url.includes('/main.mp4')), false)
})

for (const duration of [0, 1801]) test(`duration ${duration} avoids the main body and preserves cover/text/page`, async t => {
  const f = await fixture(t, { note: note({ video: { media: { stream: { h264: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/stream/main.mp4', duration }] } } } }) }), result = await f.prepare()
  assert.equal(result.status, 'metadata-only'); assert.equal(f.requests.some(call => call.url.includes('/main.mp4')), false)
  assert.match(result.infoText, duration ? /超过30分钟/ : /时长未通过验证/); assert.equal(result.plan.items[0].parts[0].kind, 'image')
})

test('main video download failure preserves cover and complete original text; thumbnail failure retains a complete neutral video', async t => {
  const failed = await fixture(t, { respond: url => url.hostname.startsWith('sns-video') ? response('', '', { status: 403 }) : undefined }), fallback = await failed.prepare()
  assert.equal(fallback.status, 'metadata-only'); assert.match(fallback.infoText, /视频本体暂时获取失败/); assert.equal(fallback.plan.items[1].parts[0].text, note().desc)
  const thumbnail = await fixture(t, { native: async () => { throw Error('ffmpeg absent') } }), result = await thumbnail.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.plan.items[1].parts[0].thumbnail, undefined); assert.deepEqual(await thumbnail.bytes(result.plan.items[1].parts[0].artifact), mp4())
})

test('HEIC conversion belongs to Core and per-slot conversion failures preserve the remaining gallery', async t => {
  let converted = 0
  const f = await fixture(t, { note: gallery(3), respond: url => url.hostname.startsWith('sns-webpic') ? response(HEIC, 'image/heic') : undefined,
    native: async () => { if (++converted === 2) throw Error('synthetic decode failure') } }), result = await f.prepare()
  assert.equal(result.plan.items.length, 4); assert.equal(result.plan.items[2].parts[0].artifact.mime, 'image/jpeg'); assert.match(result.infoText, /第2张图片暂时获取失败/)
})

test('ephemeral access is decoded once, only allowed note query leaves Core, host cookie never reaches browser or media', async t => {
  let reads = 0
  const f = await fixture(t, { options: { authCookie: `web_session=${COOKIE}`, secrets: [COOKIE] } })
  const result = await f.prepare(share(), scope({ readSourceAccess: async () => { reads++; return { provider: 'xiaohongshu', xsecToken: TOKEN, xsecSource: 'app_share', mediaKind: 'video' } } }))
  assert.equal(reads, 1); const first = f.requests[0], url = new URL(first.url)
  assert.equal(url.searchParams.get('xsec_token'), TOKEN); assert.equal(url.search.includes('%253D'), false); assert.equal(url.search.includes('%3D'), true)
  assert.deepEqual([...url.searchParams.keys()], ['xsec_token', 'xsec_source', 'type']); assert.equal(first.policy.headers.Cookie, `web_session=${COOKIE}`)
  assert.ok(f.requests.slice(1).every(call => call.policy.headers.Cookie === undefined && !call.url.includes('xsec_')))
  for (const secret of [TOKEN, COOKIE, encodeURIComponent(TOKEN)]) assert.equal(JSON.stringify(result).includes(secret), false)
})

test('short redirects retain their access token for the anonymous browser but remove tracking query and host credentials', async t => {
  let anonymousInput
  const media = xiaohongshuMetadata(state(gallery(1)), ID)
  const f = await fixture(t, { options: { authCookie: `web_session=${COOKIE}` }, respond: url => url.hostname === 'xhslink.com' ? response('', '', { status: 302, headers: { location: `https://www.xiaohongshu.com/discovery/item/${ID}?xsec_token=${encodeURIComponent(TOKEN)}&type=normal&xsec_source=app_share&share_channel=qq` } }) : url.hostname === 'www.xiaohongshu.com' ? response('', '', { status: 403 }) : undefined,
    browser: async input => { anonymousInput = input; return media } })
  const result = await f.prepare(share('short', 'a/AbCd'))
  assert.equal(f.requests[0].policy.headers.Cookie, undefined); assert.equal(new URL(anonymousInput.pageUrl).searchParams.get('xsec_token'), TOKEN)
  assert.equal(anonymousInput.pageUrl.includes('share_channel'), false); assert.equal(JSON.stringify(anonymousInput).includes(COOKIE), false)
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.xiaohongshu.com/explore/${ID}`)
})

test('target binding refuses the first recommended note and mismatched browser identity', async t => {
  assert.equal(xiaohongshuMetadata({ note: { noteDetailMap: { [OTHER]: { note: gallery(1, [], { noteId: OTHER }) } } } }, ID), undefined)
  const conflict = state(gallery(1)); conflict.note.noteDetailMap[ID].note.noteId = OTHER; assert.throws(() => xiaohongshuMetadata(conflict, ID))
  const f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>no target</html>') : undefined,
    browser: async () => ({ ...xiaohongshuMetadata(state(gallery(1)), ID), id: OTHER }) })
  await assert.rejects(f.prepare(), /小红书媒体获取失败/); await f.empty()
})

test('SSR undefined parsing never changes literals inside quoted descriptions; durations retain their own preferred stream scope', () => {
  const raw = html(note({ desc: 'undefined remains literal', extra: undefined })).replace('"type":"video"', '"extra":undefined,"type":"video"')
  assert.equal(xiaohongshuDocumentMetadata(raw, ID).description, 'undefined remains literal')
  const value = note({ video: { duration: 250000, media: { stream: { h264: [{ masterUrl: 'https://sns-video-qc.xhscdn.com/a.mp4', duration_ms: 42000 }] } } } })
  assert.equal(xiaohongshuMetadata(state(value), ID).duration, 42)
})

test('access material in returned text, media query or streamed bytes never becomes a usable outgoing artifact', async t => {
  for (const mode of ['text', 'query', 'bytes']) {
    const value = mode === 'text' ? gallery(1, [], { desc: TOKEN }) : gallery(1)
    if (mode === 'query') value.imageList[0].url += '?value=' + encodeURIComponent(TOKEN)
    const f = await fixture(t, { note: value, respond: url => mode === 'bytes' && url.hostname.startsWith('sns-') ? response((async function* () { yield Buffer.concat([PNG, Buffer.from(TOKEN.slice(0, 10))]); yield Buffer.from(TOKEN.slice(10)) })(), 'image/png') : undefined })
    const context = scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', xsecToken: TOKEN }) })
    if (mode === 'text') await assert.rejects(f.prepare(share(), context))
    else { const result = await f.prepare(share(), context); assert.equal(result.status, 'metadata-only'); assert.equal(result.plan.items.length, 2) }
    assert.ok(f.requests.filter(call => new URL(call.url).hostname.endsWith('xhscdn.com')).every(call => !decodeURIComponent(call.url).includes(TOKEN)))
  }
})

test('recall and ignored late responses close transport and remove every private file before publication', async t => {
  const held = gate(), entered = gate(), controller = new AbortController(); let closed = false
  const f = await fixture(t, { respond: async url => { if (url.hostname.startsWith('sns-video')) { entered.resolve(); await held.promise; return response(mp4(), 'video/mp4', { close() { closed = true } }) } } })
  const operation = f.prepare(share(), scope({ signal: controller.signal })); await entered.promise; controller.abort(); await bounded(assert.rejects(operation)); await f.empty()
  held.resolve(); for (let at = 0; at < 50 && !closed; at++) await delay(5); assert.equal(closed, true); await f.empty()
})

test('browser work is serial and a cancelled queued job never opens its anonymous browser', async t => {
  const entered = gate(), held = gate(); let active = 0, maximum = 0, calls = 0
  const f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>no data</html>') : undefined,
    browser: async () => { calls++; active++; maximum = Math.max(maximum, active); entered.resolve(); await held.promise; active--; return undefined } })
  const first = f.prepare(), controller = new AbortController(); await entered.promise
  const second = f.prepare(share(), scope({ signal: controller.signal })); controller.abort(); await bounded(assert.rejects(second)); held.resolve(); await first
  assert.equal(calls, 1); assert.equal(maximum, 1)
})

test('HTTP pins all public DNS answers, rejects ports/private hosts and limits Cookie to explicit first-party requests', async () => {
  for (const url of [`http://www.xiaohongshu.com/explore/${ID}`, `https://www.xiaohongshu.com:443/explore/${ID}`, `https://www.xiaohongshu.com@evil.test/explore/${ID}`, `https://127.0.0.1/explore/${ID}`, `https://www.xiaohongshu.com/a/../explore/${ID}`, `https://www.xiaohongshu.com/%2e%2e/explore/${ID}`]) assert.throws(() => xiaohongshuOfficialUrl(url, 'page'))
  let requested = 0
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    const read = createXiaohongshuHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }], request: async () => { requested++; return response(PNG, 'image/png') } })
    const guard = xiaohongshuGuard(scope(), 1000); try { await assert.rejects(read(imageUrl(1), 'image', guard, 32 * MiB)) } finally { guard.close() }
  }
  assert.equal(requested, 0)
  const requests = [], read = createXiaohongshuHttp({ authCookie: `web_session=${COOKIE}`, allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async (url, address, signal, policy) => { requests.push({ url, policy }); return requests.length === 1 ? response('', '', { status: 302, headers: { location: 'https://fe-static.xiaohongshu.com/app.js' } }) : response('ok', 'application/javascript') } })
  const guard = xiaohongshuGuard(scope(), 1000)
  try { await xiaohongshuBody(await read('https://www.xiaohongshu.com/api/session', 'browser', guard, 1024, { cookie: 'a1=ANONYMOUS_SESSION_12345' })) } finally { guard.close() }
  assert.equal(requests[0].policy.headers.Cookie, 'a1=ANONYMOUS_SESSION_12345'); assert.equal(requests[1].policy.headers.Cookie, undefined)
})

for (const invalid of ['partial', 'length', 'stream', 'compression']) test(`HTTP rejects ${invalid} media, closes response and never publishes incomplete data`, async () => {
  let closed = false
  const read = createXiaohongshuHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => response(Buffer.alloc(1025), 'image/png', { ...(invalid === 'partial' ? { status: 206 } : {}), headers: { 'content-type': 'image/png', ...(invalid === 'length' ? { 'content-length': '1025' } : invalid === 'compression' ? { 'content-encoding': 'gzip' } : {}) }, close() { closed = true } }) })
  const guard = xiaohongshuGuard(scope(), 1000)
  try { await assert.rejects(async () => xiaohongshuBody(await read(imageUrl(1), 'image', guard, 1024))) } finally { guard.close() }
  assert.equal(closed, true)
})

test('real loopback streamed transport exercises byte limits and abort disconnect behind the official pinned seam', async t => {
  let disconnected = false
  const server = http.createServer((request, output) => { output.setHeader('content-type', 'image/png'); if (request.url === '/large') { output.write(Buffer.alloc(512)); output.end(Buffer.alloc(513)) } else { output.on('close', () => { disconnected = true }); output.write(PNG.subarray(0, 32)) } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const read = createXiaohongshuHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: (url, address, signal) => new Promise((resolve, reject) => {
    assert.equal(address.address, '8.8.8.8'); const request = http.get({ host: '127.0.0.1', port: server.address().port, path: url.pathname, signal }, output => resolve({ status: output.statusCode, headers: { 'content-type': output.headers['content-type'] }, body: output, close() { output.destroy(); request.destroy() } })); request.on('error', reject)
  }) })
  const first = xiaohongshuGuard(scope(), 1000)
  try { await assert.rejects(xiaohongshuBody(await read('https://sns-img-qc.xhscdn.com/large', 'image', first, 1024))) } finally { first.close() }
  const cancel = new AbortController(), guard = xiaohongshuGuard(scope({ signal: cancel.signal }), 1000)
  try { const response = await read('https://sns-img-qc.xhscdn.com/hold', 'image', guard, 1024), operation = xiaohongshuBody(response); cancel.abort(); await bounded(assert.rejects(operation)) } finally { guard.close() }
  for (let at = 0; at < 30 && !disconnected; at++) await delay(5); assert.equal(disconnected, true)
})

test('note identity is checked on every redirect before DNS/HTTP and a short link cannot change its first resolved note', async t => {
  for (const short of [false, true]) {
    const f = await fixture(t, { respond: url => url.hostname === 'xhslink.com' ? response('', '', { status: 302, headers: { location: `https://www.xiaohongshu.com/explore/${ID}?xsec_token=${encodeURIComponent(TOKEN)}` } })
      : url.pathname.endsWith(ID) ? response('', '', { status: 302, headers: { location: `https://www.xiaohongshu.com/explore/${OTHER}?xsec_token=${encodeURIComponent(TOKEN)}` } }) : undefined })
    if (short) await assert.rejects(f.prepare(share('short', 'a/Test')))
    else await f.prepare()
    assert.equal(f.requests.some(call => new URL(call.url).pathname.endsWith(OTHER)), false)
  }
})

test('image notes with no gallery preserve their cover fallback and full body', async t => {
  const resolved = { ...xiaohongshuMetadata(state(gallery(1)), ID), images: [], livePhotos: [], cover: imageUrl(1) }
  const f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>no state</html>') : undefined, browser: async () => resolved }), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.deepEqual(result.plan.items.map(item => item.parts[0].kind), ['image', 'image', 'text'])
})

test('current access cannot be renamed into an official script query or used for another note by the anonymous browser', async t => {
  const attempts = [], blocked = [], f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>no state</html>') : undefined,
    browser: async (input, context, read) => {
      const guard = xiaohongshuGuard(context, 1000)
      try {
        for (const url of [`https://fe-static.xiaohongshu.com/app.js?foo=${encodeURIComponent(TOKEN)}`, `https://www.xiaohongshu.com/api/content?foo=${encodeURIComponent(TOKEN)}`, `https://www.xiaohongshu.com/explore/${OTHER}?xsec_token=${encodeURIComponent(TOKEN)}`]) {
          attempts.push(url); try { const response = await read(url, 'browser', guard, 1024); await response.close(); blocked.push(false) } catch { blocked.push(true) }
        }
      } finally { guard.close() }
      return xiaohongshuMetadata(state(gallery(1)), ID)
    } })
  const result = await f.prepare(share(), scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', xsecToken: TOKEN }) }))
  assert.equal(attempts.length, 3); assert.deepEqual(blocked, [true, true, true]); assert.equal(result.status, 'ready'); assert.equal(f.requests.some(call => attempts.includes(call.url)), false)
})

test('video byte budget is 256 MiB and a length one byte above is rejected without consuming a body', async t => {
  let consumed = false
  const f = await fixture(t, { respond: (url, signal, policy) => url.hostname.startsWith('sns-video') ? (assert.equal(policy.maxBytes, 256 * MiB), response((async function* () { consumed = true; yield mp4() })(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(256 * MiB + 1) } })) : undefined }), result = await f.prepare()
  assert.equal(consumed, false); assert.equal(result.status, 'metadata-only'); assert.match(result.infoText, /视频本体暂时获取失败/)
})

test('explicit host Cookie values shorter than eight characters are still protected from outgoing text', async t => {
  const secret = 'sH0rt7', f = await fixture(t, { note: gallery(1, [], { desc: secret }), options: { authCookie: `web_session=${secret}` } })
  await assert.rejects(f.prepare(), /小红书媒体获取失败/)
  assert.equal(f.requests[0].policy.headers.Cookie, `web_session=${secret}`)
  await f.empty()
})

test('a source image hint survives same-note redirects that advertise video and prevents the live-photo main-video path', async t => {
  const f = await fixture(t, { respond: (url, _signal, _policy, calls) => calls.length === 1 ? response('', '', { status: 302, headers: { location: `https://www.xiaohongshu.com/explore/${ID}?type=video` } }) : undefined })
  const result = await f.prepare(share(), scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', mediaKind: 'image' }) }))
  assert.equal(result.plan.items.at(-2).parts[0].kind, 'image'); assert.equal(f.requests.some(call => call.url.includes('/main.mp4')), false)
})

test('signed feed accepts only the closed target body, exact URL and bounded signature fields; POST redirects never replay', async () => {
  const token = 'TASK_XHS_ACCESS_ALPHANUM_12345', feed = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed'
  const valid = ` { "source_note_id" : "${ID}", "xsec_token":"${token}", "extra":{"need_body_topic":1} } `, calls = []
  const read = createXiaohongshuHttp({ allows: text => !text.includes(COOKIE), allowsMedia: text => !text.includes(token), feedContext: () => ({ id: ID, token }), lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (url, address, signal, policy) => { calls.push({ url: url.href, policy }); return response('{}', 'application/json') } })
  const guard = xiaohongshuGuard(scope(), 2000)
  try {
    await xiaohongshuBody(await read(feed, 'browser', guard, 1024, { method: 'POST', body: valid, headers: { 'X-S': 'FIXTURE_SIGNATURE', 'x-t': '1700000000123', 'x-s-common': 'COMMON_SIGNATURE' } }))
    assert.equal(calls.length, 1); assert.equal(calls[0].policy.body, valid); assert.equal(calls[0].policy.method, 'POST'); assert.equal(calls[0].policy.headers['x-s'], 'FIXTURE_SIGNATURE')
    const invalid = [
      { body: JSON.stringify({ source_note_id: OTHER, xsec_token: token }) }, { body: JSON.stringify({ source_note_id: ID, xsec_token: 'UNVERIFIED_OTHER_TOKEN' }) },
      { body: JSON.stringify({ source_note_id: ID, xsec_source: token }) }, { body: JSON.stringify({ source_note_id: ID, foo: token }) },
      { body: `{"source_note_id":"${OTHER}","source_note_id":"${ID}"}` }, { body: JSON.stringify({ source_note_id: ID, image_formats: ['jpg', 'jpg'] }) },
      { body: JSON.stringify({ source_note_id: ID, extra: { need_body_topic: true } }) }, { body: valid + ' '.repeat(16_384) },
      { headers: { 'x-s': token } }, { headers: { 'x-s': COOKIE } }, { headers: { 'x-t': '1e12' } }, { headers: { 'x-s': 'x'.repeat(8193) } },
      { url: feed + '?foo=1' }, { url: feed + '#fragment' }, { url: feed.replace('/feed', '/other') }, { url: feed.replace('edith.', 'fe-static.') },
    ]
    for (const part of invalid) await assert.rejects(read(part.url ?? feed, 'browser', guard, 1024, { method: 'POST', body: part.body ?? valid, headers: part.headers ?? { 'x-s': 'VALID_SIGNATURE' } }))
    assert.equal(calls.length, 1)
  } finally { guard.close() }
  let redirects = 0, closed = false
  const redirected = createXiaohongshuHttp({ allows: () => true, feedContext: () => ({ id: ID, token }), lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => { redirects++; return response('', '', { status: 307, headers: { location: feed }, close() { closed = true } }) } })
  const second = xiaohongshuGuard(scope(), 1000)
  try { await assert.rejects(redirected(feed, 'browser', second, 1024, { method: 'POST', body: valid })) } finally { second.close() }
  assert.equal(redirects, 1); assert.equal(closed, true)
})

test('the native pinned POST transport sends original method/body to a real loopback HTTP stream and closes it on cancellation', async t => {
  const https = (await import('node:https')).default, { nativeAgentXiaohongshuRequest } = await moduleAt('agentXiaohongshuRelayHttp')
  const observed = [], entered = gate(); let disconnected = false
  const server = http.createServer(async (request, output) => {
    const chunks = []; for await (const bytes of request) chunks.push(bytes)
    observed.push({ method: request.method, body: Buffer.concat(chunks).toString('utf8'), headers: request.headers }); output.setHeader('content-type', 'application/json')
    if (observed.length === 1) output.end('{}')
    else { output.on('close', () => { disconnected = true }); output.write('{'); entered.resolve() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const original = https.request, raw = ` { "source_note_id":"${ID}", "extra":{"need_body_topic":"1"} } `
  // Replace only TLS destination plumbing; the production native POST implementation
  // still constructs and drives an actual ClientRequest, real server, body stream and abort.
  https.request = (url, options, listener) => {
    let pinned; options.lookup(url.hostname, {}, (error, address, family) => { assert.ifError(error); pinned = { address, family } })
    assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 }); assert.equal(options.agent, false); assert.equal(options.headers['Accept-Encoding'], 'identity')
    return http.request({ ...options, host: '127.0.0.1', port: server.address().port, path: url.pathname, lookup: undefined }, listener)
  }
  t.after(async () => { https.request = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const make = signal => nativeAgentXiaohongshuRequest(new URL('https://edith.xiaohongshu.com/api/sns/web/v1/feed'), { address: '8.8.8.8', family: 4 }, signal, { method: 'POST', body: raw, maxBytes: 1024, headers: { 'Content-Type': 'application/json', 'x-s': 'VALID_SIGNATURE' } })
  const first = await make(new AbortController().signal); let bytes = ''; try { for await (const part of first.body) bytes += Buffer.from(part).toString('utf8') } finally { await first.close() }
  assert.equal(bytes, '{}'); assert.equal(observed[0].method, 'POST'); assert.equal(observed[0].body, raw); assert.equal(Number(observed[0].headers['content-length']), Buffer.byteLength(raw)); assert.equal(observed[0].headers['x-s'], 'VALID_SIGNATURE')
  const controller = new AbortController(), second = await make(controller.signal), operation = (async () => { try { for await (const _bytes of second.body) {} } finally { await second.close() } })()
  await entered.promise; controller.abort(); await bounded(assert.rejects(operation)); for (let at = 0; at < 30 && !disconnected; at++) await delay(5)
  assert.equal(disconnected, true)
})

test('browser same-note GET cannot prime an unverified feed token; cookie and Set-Cookie cannot carry source access', async t => {
  const borrowed = 'BORROWED_XHS_UNVERIFIED_TOKEN_12345', outcomes = []
  const f = await fixture(t, { respond: url => url.hostname === 'www.xiaohongshu.com' ? response('<html>browser needed</html>') : undefined,
    browser: async (_input, context, read) => {
      const guard = xiaohongshuGuard(context, 1000)
      const reject = async (url, session) => { try { const result = await read(url, 'browser', guard, 1024, session); await result.close(); outcomes.push(false) } catch { outcomes.push(true) } }
      try {
        await reject(`https://www.xiaohongshu.com/explore/${ID}?xsec_token=${borrowed}`)
        await reject('https://edith.xiaohongshu.com/api/sns/web/v1/feed', { method: 'POST', body: JSON.stringify({ source_note_id: ID, xsec_token: borrowed }) })
        await reject('https://www.xiaohongshu.com/api/content', { cookie: `a1=${TOKEN}` })
      } finally { guard.close() }
      return xiaohongshuMetadata(state(gallery(1)), ID)
    } })
  const result = await f.prepare(share(), scope({ readSourceAccess: async () => ({ provider: 'xiaohongshu', xsecToken: TOKEN }) }))
  assert.equal(result.status, 'ready'); assert.deepEqual(outcomes, [true, true, true]); assert.equal(f.requests.some(call => call.url.includes('BORROWED') || call.url.includes('/api/content') || call.url.includes('/v1/feed')), false)
  let closed = false
  const read = createXiaohongshuHttp({ allows: () => true, allowsMedia: value => !value.includes(TOKEN), lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => response('{}', 'application/json', { setCookies: [`a1=${TOKEN}; Domain=.xiaohongshu.com; Path=/`], close() { closed = true } }) })
  const guard = xiaohongshuGuard(scope(), 1000)
  try { await assert.rejects(read('https://www.xiaohongshu.com/api/content', 'browser', guard, 1024)) } finally { guard.close() }
  assert.equal(closed, true)
})
