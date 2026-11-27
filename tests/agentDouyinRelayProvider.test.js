import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const moduleAt = file => import(pathToFileURL(path.join(release, `dist/backend/modules/media/infrastructure/${file}.js`)).href)
const { createAgentDouyinRelayProvider } = await moduleAt('agentDouyinRelayProvider')
const { createAgentMediaArtifactStore } = await moduleAt('agentMediaArtifactStore')
const { createDouyinHttp, douyinBody, douyinGuard, douyinOfficialUrl, nativeAgentDouyinRequest } = await moduleAt('agentDouyinRelayHttp')
const { nativeAgentDouyinCommand } = await moduleAt('agentDouyinRelayNative')
const { douyinDocumentMetadata, douyinMetadata, inspectDouyinDocument } = await moduleAt('agentDouyinRelayMetadata')
const MiB = 1024 * 1024, ID = '7651971027728274617', OTHER = '7651971027728274618'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const HEIC = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, ...Buffer.from('heicmif1')])
function mp4(size = 64, fill = 0) { const bytes = Buffer.alloc(size, fill); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const scope = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const share = (kind = 'video', id = ID) => ({ provider: 'douyin', reference: { kind, id } })
const response = (body, mime = 'text/html', extra = {}) => ({ status: 200, headers: { 'content-type': mime }, body, ...extra })
function item(overrides = {}) { return { aweme_id: ID, desc: '目标作品', author: { nickname: '作者' }, duration: 16,
  video: { play_addr: { url_list: ['https://v3.douyinvod.com/video.mp4?sign=upstream-private'] }, cover: { url_list: ['https://p3.douyinpic.com/cover.png'] } },
  statistics: { play_count: 0, digg_count: 123, comment_count: 2, share_count: 3, collect_count: 4 }, ...overrides } }
const html = value => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [value] } } } })}</script>`
const gallery = (count = 3, overrides = {}) => item({ duration: 0, video: {}, images: Array.from({ length: count }, (_, index) => ({ url_list: [`https://p3.douyinpic.com/image-${index + 1}.png`] })), ...overrides })
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function allFiles(directory) { const result = []; for (const name of await readdir(directory)) { const file = path.join(directory, name); if ((await stat(file)).isDirectory()) result.push(...await allFiles(file)); else result.push(file) }; return result }
async function bounded(promise, ms = 2500) { let timer; try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture operation hung')), ms) })]) } finally { clearTimeout(timer) } }
function outputProbe(seconds) { return JSON.stringify({ format: { duration: String(seconds) }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] }) }
async function fixture(t, settings = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'douyin-provider-test-'))), artifacts = await createAgentMediaArtifactStore({ directory })
  const requests = [], lookups = [], natives = [], prepared = [], browsers = [], programmes = new Map()
  let metadata = settings.item ?? item(), closed = 0
  const provider = createAgentDouyinRelayProvider({ directory, artifacts,
    lookup: async host => { lookups.push(host); return settings.addresses ?? [{ address: '8.8.8.8', family: 4 }] },
    request: async (url, address, signal, policy) => {
      requests.push({ url: url.href, address, signal, policy })
      const custom = await settings.respond?.(url, signal, policy, requests)
      const result = custom ?? (url.hostname === 'www.douyin.com' || url.hostname === 'www.iesdouyin.com' ? response(html(metadata))
        : url.hostname.endsWith('.douyinpic.com') ? response(PNG, 'image/png')
          : url.hostname.endsWith('.douyinstatic.com') ? response(Buffer.from('ID3synthetic-music'), 'audio/mpeg') : response(mp4(), 'video/mp4'))
      return { ...result, async close() { closed++; await result.close?.() } }
    },
    browser: async (...args) => { browsers.push(args); return settings.browser ? settings.browser(...args) : undefined },
    native: async (command, args, options) => {
      natives.push({ command, args, options })
      assert.ok(path.isAbsolute(options.cwd)); assert.ok(options.cwd.startsWith(directory + path.sep)); assert.equal((await stat(options.cwd)).mode & 0o777, 0o700)
      assert.ok(args.includes('-protocol_whitelist')); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
      assert.equal(args.some(value => /^https?:/u.test(value)), false)
      if (settings.native) { const result = await settings.native(command, args, options); if (result !== undefined) return result }
      if (command === 'ffprobe') return { stdout: args.includes('json') ? outputProbe(programmes.get(args.at(-1)) ?? 7) : `${settings.audioSeconds ?? 7}\n` }
      const output = args.at(-1)
      if (output.endsWith('.mp4')) { programmes.set(output, Number(args[args.lastIndexOf('-t') + 1])); await writeFile(output, mp4()) }
      else await writeFile(output, JPEG)
      return { stdout: '' }
    }, ...settings.options })
  t.after(async () => { await Promise.allSettled(prepared.map(value => value.release())); await artifacts.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) })
  return { directory, artifacts, requests, lookups, natives, browsers, closed: () => closed,
    setItem(value) { metadata = value },
    async prepare(input = share(), context = scope()) { const result = await provider.prepare(input, context); prepared.push(result); return result },
    async bytes(artifact) { const reader = await artifacts.open(artifact, scope()), chunks = []; try { for await (const bytes of reader.chunks) chunks.push(bytes); return Buffer.concat(chunks) } finally { await reader.close() } },
    async empty() { assert.deepEqual(await allFiles(directory), []) },
  }
}

test('static video owns all media and JPEG thumbnail, keeps metadata and never exposes upstream URLs or local paths', async t => {
  const f = await fixture(t), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.douyin.com/video/${ID}`)
  assert.equal(result.plan.items.length, 2)
  const info = result.plan.items[0].parts, video = result.plan.items[1].parts[0]
  assert.deepEqual(info.map(part => part.kind), ['image']); assert.equal(video.kind, 'video')
  const card = await f.bytes(info[0].artifact)
  assert.deepEqual(card.subarray(0, 8), PNG.subarray(0, 8)); assert.ok(card.readUInt32BE(16) > 100, 'the intro is a rendered card')
  assert.deepEqual(await f.bytes(video.artifact), mp4()); assert.deepEqual(await f.bytes(video.thumbnail), JPEG)
  assert.equal(video.artifact.sha256, digest(mp4()))
  for (const value of ['目标作品', '作者:作者', `作品:${ID}`, '时长:0:16', '点赞:123', '播放:0']) assert.ok(result.infoText.includes(value), value)
  for (const value of ['upstream-private', 'douyinvod.com', 'douyinpic.com', f.directory]) assert.equal(JSON.stringify(result).includes(value), false)
  assert.equal(f.browsers.length, 0); assert.equal(f.natives.length, 1); assert.ok(f.requests.every(value => value.policy.headers.Cookie === undefined))
  await result.release(); await result.release(); await f.empty()
})

test('astral descriptions prepare successfully and preserve the exact one-thousand-code-point display ceiling', async t => {
  for (const count of [501, 1001]) {
    const f = await fixture(t, { item: item({ desc: '😀'.repeat(count) }) }), result = await f.prepare()
    assert.equal(result.status, 'ready')
    const description = result.infoText.split('\n').find(line => line.startsWith('简介:'))?.slice('简介:'.length)
    assert.equal(description, '😀'.repeat(Math.min(count, 1000)))
    assert.equal(Array.from(description).length, Math.min(count, 1000))
    assert.equal(result.plan.items.length, 2)
  }
})

test('note preserves twenty-image cap, exact failed positions, independent images then bounded music slideshow', async t => {
  const f = await fixture(t, { item: gallery(25, { duration: 1800, music: { play_url: { url_list: ['https://sf3.douyinstatic.com/music.mp3'] } } }),
    respond: url => url.pathname === '/image-3.png' ? response('', '', { status: 404 }) : undefined })
  const result = await f.prepare(share('note'))
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.douyin.com/note/${ID}`)
  assert.deepEqual(result.plan.items[0].parts.map(part => part.kind), ['image'])
  assert.equal(result.plan.items.length, 21); assert.ok(result.plan.items.slice(1, -1).every(node => node.parts[0].kind === 'image'))
  assert.equal(result.plan.items.at(-1).parts[0].kind, 'video'); assert.ok(result.plan.items.at(-1).parts[0].thumbnail)
  assert.match(result.infoText, /共25张，仅附前20张/); assert.match(result.infoText, /第3张图片暂时获取失败/)
  assert.equal(f.requests.some(value => value.url.includes('image-21')), false)
  assert.equal(f.requests.some(value => value.url.includes('video.mp4')), false, 'a positive note duration cannot turn a gallery into a video')
  const encode = f.natives.find(call => call.args.includes('-filter_complex'))
  assert.ok(encode.args.includes('-fs')); assert.equal(encode.args[encode.args.indexOf('-fs') + 1], String(512 * MiB))
  assert.ok(encode.args.some(arg => arg.includes('concat=n=19'))); assert.ok(encode.args.some(arg => arg.includes('scale=720:1280')))
  assert.equal(f.natives.filter(call => call.command === 'ffprobe').length, 2)
})

for (const failure of ['download', 'long-audio', 'short-output', 'wrong-codec', 'encode']) test(`music ${failure} preserves every prepared gallery image and describes the downgrade`, async t => {
  const f = await fixture(t, { item: gallery(2, { music: { play_url: { url_list: ['https://sf3.douyinstatic.com/music.mp3'] } } }),
    respond: url => failure === 'download' && url.pathname === '/music.mp3' ? response('', '', { status: 403 }) : undefined,
    audioSeconds: failure === 'long-audio' ? 301 : 7,
    native: async (command, args) => {
      if (command === 'ffmpeg' && args.includes('-filter_complex') && failure === 'encode') throw new Error('synthetic encode failure')
      if (command === 'ffprobe' && args.includes('json') && failure === 'short-output') return { stdout: outputProbe(1) }
      if (command === 'ffprobe' && args.includes('json') && failure === 'wrong-codec') return { stdout: outputProbe(7).replace('h264', 'mpeg4') }
    } })
  const result = await f.prepare(share('note'))
  assert.equal(result.status, 'ready'); assert.equal(result.plan.items.length, 3); assert.ok(result.plan.items.slice(1).every(node => node.parts[0].kind === 'image'))
  assert.match(result.infoText, /配乐视频暂时无法合成/)
})

test('HEIC conversion occurs inside Core and conversion failure names the original image position', async t => {
  let conversions = 0
  const f = await fixture(t, { item: gallery(3), respond: url => /image-[12]\.png/u.test(url.pathname) ? response(HEIC, 'image/heic') : undefined,
    native: async (_command, args) => { if (args.includes('scale=2048:2048:force_original_aspect_ratio=decrease') && ++conversions === 2) throw new Error('synthetic HEIC failure') } })
  const result = await f.prepare(share('note'))
  assert.equal(result.plan.items.length, 3); assert.equal(result.plan.items[1].parts[0].artifact.mime, 'image/jpeg')
  assert.deepEqual(await f.bytes(result.plan.items[1].parts[0].artifact), JPEG); assert.match(result.infoText, /第2张图片暂时获取失败/)
})

test('thumbnail failure keeps complete neutral video for channels that do not require thumbnails', async t => {
  const f = await fixture(t, { native: async () => { throw new Error('ffmpeg absent') } }), result = await f.prepare()
  assert.equal(result.status, 'ready'); const video = result.plan.items[1].parts[0]
  assert.equal(video.thumbnail, undefined); assert.deepEqual(await f.bytes(video.artifact), mp4())
  await result.release(); await f.empty()
})

for (const duration of [0, 1801]) test(`video duration ${duration} leaves its page and avoids downloading any video body`, async t => {
  const f = await fixture(t, { item: item({ duration }) }), result = await f.prepare()
  assert.equal(result.status, 'metadata-only'); assert.equal(f.requests.some(value => value.url.includes('douyinvod')), false)
  assert.match(result.infoText, duration ? /超过30分钟/ : /时长未通过验证/)
})

test('unavailable metadata retains the original official page and records the page and browser results', async t => {
  const diagnostics = []
  const f = await fixture(t, { item: item({ video: {} }), options: {
    diagnostics: { emit(event) { diagnostics.push(event) } },
  } })
  const result = await f.prepare()
  assert.equal(result.status, 'metadata-only')
  assert.equal(result.pageUrl, `https://www.douyin.com/video/${ID}`)
  assert.deepEqual(diagnostics.map(({ operation, outcome, code, httpStatus, details }) => [operation, outcome, code, httpStatus, details.step]), [
    ['douyin_metadata_page', 'cancelled', 'douyin_page_metadata_incomplete', 200, 'douyin_page_parse'],
    ['douyin_provider_prepare', 'failed', 'metadata_unavailable', undefined, 'douyin_browser_extract'],
  ])
  assert.equal(diagnostics[1].details.result, 'fallback_used')
  assert.equal(diagnostics[1].details.cause, 'douyin_browser_target_missing')
  assert.ok(diagnostics[1].details.queueMs >= 0)
  assert.doesNotMatch(JSON.stringify(diagnostics), /https?:|7651971027728274617/u)
})

test('static JSON with a literal percent sign does not unnecessarily launch the browser', async t => {
  const f = await fixture(t, { respond: url => url.hostname === 'www.douyin.com'
    ? response(`<script id="RENDER_DATA">${JSON.stringify(item({ desc: '进度到 100%' }))}</script>`) : undefined })
  const result = await f.prepare()
  assert.equal(result.status, 'ready')
  assert.match(result.infoText, /进度到 100%/u)
  assert.equal(f.browsers.length, 0)
})

function desktopPage(...props) {
  const element = values => ['$', 'div', null, { children: values.map(value => ['$', 'main', null, { children: ['$', '$L1', null, value] }]) }]
  const text = '中文首段\n0:' + JSON.stringify(element([{ awemeId: ID, statusCode: 999, aweme: null }]))
  const records = '1:T' + Buffer.byteLength(text).toString(16) + ',' + text + '2:' + JSON.stringify(element(props)) + '\n'
  const split = records.lastIndexOf('awemeId') + 2
  return '<script id="RENDER_DATA">' + encodeURIComponent(JSON.stringify({ app: { isLogin: false } })) + '</script>' +
    [records.slice(0, split), records.slice(split)].map(part => '<script>self.__pace_f.push(' + JSON.stringify([1, part]) + ')</script>').join('')
}

test('desktop streamed work data keeps the exact work, skips unrelated rows and prepares a card plus its video', async t => {
  const authorized = { awemeId: ID, description: '桌面作品', author: { nickname: '源作者' },
    video: { duration: 16_000, playAddr: { urlList: ['https://v3.douyinvod.com/video.mp4'] } } }
  const page = desktopPage({ awemeId: OTHER, statusCode: 0, aweme: { ...authorized, awemeId: OTHER } },
    { awemeId: ID, statusCode: 0, aweme: { ...authorized, awemeId: OTHER } }, { awemeId: ID, statusCode: 0, aweme: authorized })
  const f = await fixture(t, { respond: url => url.hostname === 'www.douyin.com' ? response(page) : undefined })
  const result = await f.prepare()
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.plan.items.map(item => item.parts.map(part => part.kind)), [['image'], ['video']])
  assert.match(result.infoText, /桌面作品.+源作者/su)
  assert.equal(f.browsers.length, 0)
  assert.deepEqual(inspectDouyinDocument(desktopPage({ awemeId: OTHER, statusCode: 0, aweme: authorized }), ID, 'video'),
    { issue: 'douyin_page_target_missing' })
})

test('HTTP 200 verification and an empty target work remain distinguishable when only the card can be delivered', async t => {
  const diagnostics = []
  const verification = '<script>document.cookie; __ac_nonce; window.location.reload()</script>'
  const empty = desktopPage({ awemeId: ID, statusCode: 0, aweme: null })
  const f = await fixture(t, {
    respond: url => url.hostname === 'www.douyin.com' ? response(verification) : undefined,
    browser: async input => {
      const { issue, nativeCode } = inspectDouyinDocument(empty, input.id, input.kind)
      input.observeStep('douyin_browser_document', 200, { cause: issue, nativeCode })
    },
    options: { diagnostics: { emit(event) { diagnostics.push(event) } } },
  })
  const result = await f.prepare()
  assert.equal(result.status, 'metadata-only')
  assert.deepEqual(result.plan.items.map(item => item.parts.map(part => part.kind)), [['image']])
  assert.match(result.infoText, /抖音网页未提供原作品媒体/u)
  assert.deepEqual(diagnostics.map(({ operation, code, httpStatus, details }) => [operation, code, httpStatus, details.step]), [
    ['douyin_metadata_page', 'douyin_page_verification_required', 200, 'douyin_page_parse'],
    ['douyin_provider_prepare', 'metadata_unavailable', 200, 'douyin_browser_document'],
  ])
  assert.equal(diagnostics[1].details.cause, 'douyin_page_work_empty')
  assert.equal(diagnostics[1].details.nativeCode, 0)
  assert.equal(diagnostics[1].details.result, 'fallback_used')
  assert.doesNotMatch(JSON.stringify(diagnostics), /__ac_nonce|7651971027728274617/u)
})

test('a first HTTP failure is recorded even when the browser supplies a full result', async t => {
  const diagnostics = []
  const f = await fixture(t, { respond: url => url.hostname === 'www.douyin.com' ? response('PRIVATE-HTTP-BODY', 'text/html', { status: 503 }) : undefined,
    browser: async () => douyinMetadata(item(), ID, 'video'), options: { diagnostics: { emit: event => diagnostics.push(event) } } })
  assert.equal((await f.prepare()).status, 'ready')
  assert.deepEqual(diagnostics.map(({ operation, outcome, code, httpStatus, details }) => [operation, outcome, code, httpStatus, details.step]),
    [['douyin_metadata_page', 'failed', 'douyin_page_failed', 503, 'douyin_http_status']])
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE-HTTP-BODY|https?:/u)
})

test('incomplete static metadata uses target-bound browser fallback and scoped anonymous result only', async t => {
  const resolved = douyinMetadata(gallery(2), ID, 'note')
  const f = await fixture(t, { item: item({ video: {} }), browser: async (input, context, read) => {
    assert.equal(input.id, ID); assert.equal(input.pageUrl, `https://www.douyin.com/video/${ID}`); assert.equal(context.isCurrent(), true); assert.equal(typeof read, 'function')
    return resolved
  } })
  const result = await f.prepare(); assert.equal(result.plan.items.length, 3); assert.equal(result.pageUrl, `https://www.douyin.com/note/${ID}`); assert.equal(f.browsers.length, 1)
})

test('cross-work browser result and recommended JSON never authorize another work or its BGM', async t => {
  const mixed = { recommended: [gallery(1, { aweme_id: OTHER, music: { play_url: { url_list: ['https://sf3.douyinstatic.com/wrong.mp3'] } } })], target: gallery(2) }
  const metadata = douyinMetadata(mixed, ID, 'note')
  assert.equal(metadata.id, ID); assert.equal(metadata.music, ''); assert.equal(metadata.images.length, 2)
  assert.equal(douyinMetadata(mixed, '123456', 'note'), undefined)
  assert.equal(douyinDocumentMetadata(`<script>window._ROUTER_DATA = ${JSON.stringify(mixed)}</script>`, ID, 'note').id, ID)
  const f = await fixture(t, { item: item({ video: {} }), browser: async () => ({ ...metadata, id: OTHER }) })
  await assert.rejects(f.prepare()); assert.equal(f.requests.some(value => value.url.includes('wrong.mp3')), false); await f.empty()
})

test('official short redirects fix the target work before metadata, while a direct ID cannot silently change', async t => {
  const f = await fixture(t, { item: gallery(1), respond: url => url.hostname === 'v.douyin.com' ? response('', '', { status: 302, headers: { location: `https://www.iesdouyin.com/share/note/${ID}/?tracking=1` } }) : undefined })
  const result = await f.prepare(share('short', 'official-token')); assert.equal(result.pageUrl, `https://www.douyin.com/note/${ID}`)
  assert.equal(result.plan.items.length, 2)
  const other = await fixture(t, { respond: url => url.pathname.includes(ID) ? response('', '', { status: 302, headers: { location: `https://www.douyin.com/video/${OTHER}` } }) : undefined })
  const fallback = await other.prepare(); assert.equal(fallback.status, 'metadata-only'); assert.equal(fallback.pageUrl, `https://www.douyin.com/video/${ID}`)
  assert.equal(other.requests.some(value => value.url.includes('douyinvod')), false)
})

test('a short link landing on a public browser challenge still fixes its work before the browser fallback', async t => {
  const f = await fixture(t, { browser: async input => { assert.equal(input.id, ID); return douyinMetadata(gallery(1), ID, 'note') },
    respond: url => url.hostname === 'v.douyin.com' ? response('', '', { status: 302, headers: { location: `https://www.douyin.com/note/${ID}` } })
      : url.hostname === 'www.douyin.com' ? response('challenge', 'text/html', { status: 403 }) : undefined })
  const result = await f.prepare(share('short', 'challenge-token')); assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.douyin.com/note/${ID}`)
})

test('host credentials in metadata, escaped text, URLs or split media chunks never enter outgoing artifacts or information', async t => {
  const secret = 'HOST_PRIVATE_TEST_CREDENTIAL_123'
  for (const value of [secret, Array.from(secret).map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''), Buffer.from(secret).toString('base64')]) {
    const f = await fixture(t, { item: item({ desc: value }), options: { secrets: [secret] } }), result = await f.prepare()
    assert.equal(result.status, 'metadata-only'); assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes(value), false)
  }
  const binary = await fixture(t, { options: { secrets: [secret] }, respond: url => url.hostname.endsWith('.douyinvod.com') ? response((async function* () {
    yield mp4(); yield Buffer.from(secret.slice(0, 8)); yield Buffer.from(secret.slice(8))
  })(), 'video/mp4') : undefined })
  const rejected = await binary.prepare(); assert.equal(rejected.plan.items.length, 1); assert.match(rejected.infoText, /视频本体暂时获取失败/)
  assert.equal(JSON.stringify(rejected).includes(secret), false)
  const unicodeSecret = '私有凭据跨字节边界'
  const unicode = await fixture(t, { options: { secrets: [unicodeSecret] }, respond: url => url.hostname.endsWith('.douyinvod.com') ? response((async function* () {
    yield mp4(); for (const byte of Buffer.from(unicodeSecret)) yield Buffer.from([byte])
  })(), 'video/mp4') : undefined })
  const unicodeResult = await unicode.prepare(); assert.equal(unicodeResult.plan.items.length, 1); assert.match(unicodeResult.infoText, /视频本体暂时获取失败/)
})

test('provider applies independent image and video byte ceilings before writing oversized upstream bodies', async t => {
  const f = await fixture(t, { respond: url => url.hostname.endsWith('.douyinvod.com') ? response(mp4(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(512 * MiB + 1) } }) : undefined })
  const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.match(result.infoText, /视频本体暂时获取失败/)
  assert.equal(f.requests.find(value => value.url.includes('douyinvod.com')).policy.maxBytes, 512 * MiB)
  assert.equal(f.requests.find(value => value.url.includes('douyinpic.com')).policy.maxBytes, 32 * MiB)
  const galleryFixture = await fixture(t, { item: gallery(2), respond: url => url.pathname === '/image-1.png' ? response(PNG, 'image/png', { headers: { 'content-type': 'image/png', 'content-length': String(32 * MiB + 1) } }) : undefined })
  const note = await galleryFixture.prepare(share('note')); assert.equal(note.plan.items.length, 2); assert.match(note.infoText, /第1张图片暂时获取失败/)
})

test('recall, binding loss and ignored late HTTP responses clean their private job and never return usable artifacts', async t => {
  const held = gate(), entered = gate(), controller = new AbortController(); let lateClosed = false
  const f = await fixture(t, { respond: async url => { if (url.hostname.endsWith('.douyinvod.com')) { entered.resolve(); await held.promise; return response(mp4(), 'video/mp4', { close() { lateClosed = true } }) } } })
  const operation = f.prepare(share(), scope({ signal: controller.signal }))
  await entered.promise; controller.abort(); await bounded(assert.rejects(operation)); await f.empty()
  held.resolve(); for (let at = 0; at < 50 && !lateClosed; at++) await delay(5)
  assert.equal(lateClosed, true); await f.empty()
})

test('browser preparation is serial per provider and a cancelled queued browser does not run', async t => {
  const hold = gate(), entered = gate(); let active = 0, maximum = 0, calls = 0
  const f = await fixture(t, { item: item({ video: {} }), browser: async () => { calls++; active++; maximum = Math.max(maximum, active); entered.resolve(); await hold.promise; active--; return undefined } })
  const first = f.prepare(), controller = new AbortController(); await entered.promise
  const second = f.prepare(share(), scope({ signal: controller.signal })); controller.abort(); await bounded(assert.rejects(second)); hold.resolve(); await first
  assert.equal(maximum, 1); assert.equal(calls, 1)
})

test('only fixed official HTTPS names are eligible, every DNS answer must be public, redirects never forward cookies to CDN', async () => {
  for (const input of ['http://www.douyin.com/video/' + ID, 'https://www.douyin.com:443/video/' + ID, 'https://www.douyin.com@evil.test/video/' + ID,
    'https://www.douyin.com.evil.test/video/' + ID, 'https://127.0.0.1/video/' + ID, 'https://www.douyin.com/a/../video/' + ID,
    'https://www.douyin.com/%2e%2e/video/' + ID]) assert.throws(() => douyinOfficialUrl(input, 'page'))
  let requested = 0
  for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '::1', '::ffff:127.0.0.1']) {
    const read = createDouyinHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }], request: async () => { requested++; return response(PNG, 'image/png') } })
    const guard = douyinGuard(scope(), 1000); try { await assert.rejects(read('https://p3.douyinpic.com/x.png', 'image', guard, 32 * MiB)) } finally { guard.close() }
  }
  assert.equal(requested, 0)
  const requests = [], read = createDouyinHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async (url, _address, _signal, policy) => {
    requests.push({ url: url.href, headers: policy.headers }); return requests.length === 1 ? response('', '', { status: 302, headers: { location: 'https://lf3.bytegoofy.com/app.js' } }) : response('ok', 'application/javascript')
  } })
  const guard = douyinGuard(scope(), 1000)
  try { assert.equal((await douyinBody(await read('https://www.douyin.com/app.js', 'browser', guard, 1000, { cookie: 'ttwid=ANONYMOUS_ONLY_VALUE' }))).toString(), 'ok') } finally { guard.close() }
  assert.equal(requests[0].headers.Cookie, 'ttwid=ANONYMOUS_ONLY_VALUE'); assert.equal(requests[1].headers.Cookie, undefined)
})

test('host-secret checks reject anonymous-looking cookies containing host credentials before any first-party dispatch', async () => {
  let dispatched = false
  const read = createDouyinHttp({ allows: value => !value.includes('HOST_CREDENTIAL_PRIVATE'), lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { dispatched = true; return response('ok') } })
  const guard = douyinGuard(scope(), 1000)
  try { await assert.rejects(read('https://www.douyin.com/app.js', 'browser', guard, 1024, { cookie: 'ttwid=HOST_CREDENTIAL_PRIVATE' })) } finally { guard.close() }
  assert.equal(dispatched, false)
})

for (const invalid of ['partial', 'length', 'stream', 'compression']) test(`bounded HTTP rejects ${invalid} before complete media can be published`, async () => {
  let closed = false
  const read = createDouyinHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => response(Buffer.alloc(1025), 'image/png', {
    ...(invalid === 'partial' ? { status: 206 } : {}), headers: { 'content-type': 'image/png', ...(invalid === 'length' ? { 'content-length': '1025' } : invalid === 'compression' ? { 'content-encoding': 'gzip' } : {}) }, close() { closed = true },
  }) })
  const guard = douyinGuard(scope(), 1000)
  try { await assert.rejects(async () => douyinBody(await read('https://p3.douyinpic.com/x.png', 'image', guard, 1024))) } finally { guard.close() }
  assert.equal(closed, true)
})

test('real loopback HTTP transport exercises streamed byte caps and cancellation behind the official pinned request seam', async t => {
  let disconnected = false
  const server = http.createServer((request, output) => { output.setHeader('content-type', 'image/png'); if (request.url === '/large') { output.write(Buffer.alloc(512)); output.end(Buffer.alloc(513)) }
    else if (request.url === '/hold') { output.on('close', () => { disconnected = true }); output.write(PNG.subarray(0, 32)) }
    else output.end(PNG) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port, calls = []
  const read = createDouyinHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: (url, address, signal, policy) => new Promise((resolve, reject) => {
    calls.push({ url, address, policy }); const request = http.get({ host: '127.0.0.1', port, path: url.pathname, signal }, result => resolve({ status: result.statusCode, headers: { 'content-type': result.headers['content-type'] }, body: result, close() { result.destroy(); request.destroy() } })); request.on('error', reject)
  }) })
  const guard = douyinGuard(scope(), 1000)
  try { assert.deepEqual(await douyinBody(await read('https://p3.douyinpic.com/small', 'image', guard, 1024)), PNG); await assert.rejects(douyinBody(await read('https://p3.douyinpic.com/large', 'image', guard, 1024))) } finally { guard.close() }
  const controller = new AbortController(), cancelGuard = douyinGuard(scope({ signal: controller.signal }), 1000)
  try {
    const response = await read('https://p3.douyinpic.com/hold', 'image', cancelGuard, 1024), operation = douyinBody(response)
    controller.abort(); await bounded(assert.rejects(operation))
  } finally { cancelGuard.close() }
  for (let at = 0; at < 30 && !disconnected; at++) await delay(5)
  assert.equal(disconnected, true); assert.equal(calls.length, 3); assert.ok(calls.every(call => call.address.address === '8.8.8.8' && call.url.protocol === 'https:'))
})

test('native process boundary uses fixed executable without a shell, bounds output and waits for killed child close', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'douyin-native-test-'))), previous = process.env.PATH
  t.after(async () => { process.env.PATH = previous; await rm(directory, { recursive: true, force: true }) })
  const executable = path.join(directory, 'ffprobe')
  await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('large'))process.stdout.write('x'.repeat(4096));else if(process.argv.includes('hold'))setInterval(()=>{},100);else process.stdout.write('7.0\\n')\n`); await chmod(executable, 0o700)
  process.env.PATH = directory
  const base = { cwd: directory, timeoutMs: 5000, maxOutputBytes: 128 }
  assert.equal((await nativeAgentDouyinCommand('ffprobe', ['duration'], { ...base, signal: new AbortController().signal })).stdout, '7.0\n')
  await assert.rejects(nativeAgentDouyinCommand('ffprobe', ['large'], { ...base, signal: new AbortController().signal }))
  const controller = new AbortController(), operation = nativeAgentDouyinCommand('ffprobe', ['hold'], { ...base, signal: controller.signal })
  await delay(30); controller.abort(); await bounded(assert.rejects(operation))
  // This is a real child-process boundary proof with a local synthetic executable,
  // not a claim that ffmpeg decoded or encoded real media on this host.
})

test('real isolated Chrome keeps anonymous first-party challenge cookies, uses pinned transport only and extracts the target note', { timeout: 35000 }, async t => {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH]
  try { candidates.push((await import('puppeteer')).default.executablePath()) } catch { /* An explicit host Chrome can still be available. */ }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  let chrome
  for (const candidate of candidates) if (candidate) { try { await access(candidate); chrome = candidate; break } catch { /* Check the next locally installed runtime. */ } }
  if (!chrome) { t.skip('No locally installed Chrome runtime for isolated browser proof'); return }
  const previousChrome = process.env.PUPPETEER_EXECUTABLE_PATH; process.env.PUPPETEER_EXECUTABLE_PATH = chrome
  t.after(() => { if (previousChrome === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH; else process.env.PUPPETEER_EXECUTABLE_PATH = previousChrome })
  const cookie = 'ANONYMOUS_BROWSER_SESSION_12345', jsCookie = 'ANONYMOUS_BROWSER_JS_TOKEN_12345', observations = []
  let pages = 0, detailCookies = '', inFlight = 0, maximum = 0, detailedAt = 0
  const stalledStylesheet = Promise.withResolvers()
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'douyin-browser-test-'))), artifacts = await createAgentMediaArtifactStore({ directory })
  let prepared
  t.after(async () => { await prepared?.release(); await artifacts.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) })
  const server = http.createServer(async (request, output) => {
    observations.push({ path: request.url, cookie: request.headers.cookie }); inFlight++; maximum = Math.max(maximum, inFlight); output.on('close', () => inFlight--)
    if (request.url.startsWith(`/note/${ID}`)) {
      output.setHeader('content-type', 'text/html'); if (++pages === 1) { output.end('<html><body>Static data unavailable</body></html>'); return }
      output.setHeader('set-cookie', `ttwid=${cookie}; Secure; HttpOnly; Path=/`)
      output.end(`<html><head>${Array.from({ length: 8 }, (_, index) => `<script async src="https://lf3.bytegoofy.com/app-${index}.js"></script>`).join('')}</head><body><script>
        document.cookie='msToken=${jsCookie}; Secure; Path=/';
        fetch('/aweme/v1/web/aweme/detail/?aweme_id=${ID}').then(r=>r.json());
        fetch('http://127.0.0.1:${server.address().port}/forbidden').catch(()=>{});
        fetch('https://evil.test/forbidden').catch(()=>{});
        fetch('https://lf-private.bytegoofy.com/private').catch(()=>{});
      </script><link rel="stylesheet" href="https://lf3.bytegoofy.com/slow.css"><script>window.afterStyle=true</script></body></html>`)
    } else if (request.url === '/slow.css') {
      stalledStylesheet.resolve()
    } else if (request.url.startsWith('/aweme/v1/web/aweme/detail/')) {
      await stalledStylesheet.promise
      detailCookies = request.headers.cookie || ''; output.setHeader('content-type', 'application/json')
      detailedAt = performance.now()
      output.end(JSON.stringify({ recommended: [gallery(1, { aweme_id: OTHER })], aweme_detail: gallery(2) }))
    } else if (/^\/app-\d+\.js$/u.test(request.url)) { output.setHeader('content-type', 'application/javascript'); setTimeout(() => output.end('window.fixtureLoaded=true'), 20) }
    else { output.setHeader('content-type', 'image/png'); output.end(PNG) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const provider = createAgentDouyinRelayProvider({ directory, artifacts,
    lookup: async host => [{ address: host === 'lf-private.bytegoofy.com' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
    request: (url, address, signal, policy) => new Promise((resolve, reject) => {
      assert.equal(address.address, '8.8.8.8'); assert.equal(url.protocol, 'https:')
      if (url.hostname !== 'www.douyin.com') assert.equal(policy.headers.Cookie, undefined)
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, signal, headers: { ...policy.headers } }, result => resolve({
        status: result.statusCode, headers: { 'content-type': result.headers['content-type'] }, body: result,
        ...(result.headers['set-cookie'] ? { setCookies: result.headers['set-cookie'] } : {}), close() { result.destroy(); request.destroy() },
      })); request.on('error', reject)
    }) })
  prepared = await provider.prepare(share('note'), scope())
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.plan.items.length, 3); assert.equal(pages, 2)
  assert.ok(detailedAt && performance.now() - detailedAt < 7500, 'the matching detail response finishes while an unrelated stylesheet still blocks page loading')
  assert.ok(detailCookies.includes(`ttwid=${cookie}`)); assert.ok(detailCookies.includes(`msToken=${jsCookie}`))
  assert.ok(maximum <= 4, `browser transport concurrency ${maximum}`)
  assert.equal(observations.some(value => value.path.includes('forbidden') || value.path.includes('private')), false)
  assert.equal(JSON.stringify(prepared).includes(cookie), false); assert.equal(JSON.stringify(prepared).includes(jsCookie), false)
  assert.equal(nativeAgentDouyinRequest.length, 4)
})
