import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
let providerUrl = pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentBilibiliRelayProvider.js')).href
if (process.env.BL_CHAT_AGENT_SOURCE_TEST === '1') {
  const ts = (await import('typescript')).default
  const code = ts.transpileModule(await readFile(path.join(repo, 'src/modules/media/infrastructure/agentBilibiliRelayProvider.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu, (_all, from, quote, specifier) =>
      `${from}${quote}${new URL(specifier, providerUrl).href}${quote}`)
  providerUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
const { createAgentBilibiliRelayProvider } = await import(providerUrl)
const { parseAgentBilibiliReference, validateAgentMediaShare } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentBilibiliRelayReference.js')).href)
const { nativeAgentBilibiliRequest } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentBilibiliRelayHttp.js')).href)
const { createAgentMediaArtifactStore } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaArtifactStore.js')).href)
const MiB = 1024 * 1024
const BV = 'BV1H7Gq6zEiC', EP = '1455179'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const share = (kind = 'video', id = kind === 'episode' ? EP : BV) => ({ provider: 'bilibili', reference: { kind, id } })
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const digest = value => createHash('sha256').update(value).digest('hex')
function mp4(size = 64, fill = 0) { const bytes = Buffer.alloc(size, fill); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
async function* videoStream(size, onChunk) {
  let at = 0
  while (at < size) { const value = at === 0 ? mp4(Math.min(MiB, size)) : Buffer.alloc(Math.min(MiB, size - at)); at += value.length; onChunk?.(value); yield value }
}
const response = (body, mime = 'application/json', extra = {}) => ({ status: 200, headers: { 'content-type': mime }, body: typeof body === 'object' && !(body instanceof Uint8Array) && typeof body?.[Symbol.asyncIterator] !== 'function' ? JSON.stringify(body) : body, ...extra })
function view(overrides = {}) {
  return { code: 0, data: { bvid: BV, aid: 1234, cid: 11, title: '示例视频', desc: '保留完整简介', duration: 60, videos: 1,
    owner: { name: '示例UP', mid: 12345 }, pubdate: 1784304716, stat: { view: 12034, like: 567, coin: 89, favorite: 321, share: 45, reply: 67, danmaku: 88 },
    pages: [{ page: 1, cid: 11, part: 'P1', duration: 60 }], pic: '', ...overrides } }
}
function play(overrides = {}) { return { code: 0, data: { quality: 6, support_formats: [{ quality: 6, new_description: '240P' }], durl: [{ url: 'https://cn-test.bilivideo.com/video.mp4?token=upstream-private', length: 60000, size: 64 }], ...overrides } } }
async function files(directory) { const output = []; for (const name of await readdir(directory)) { const file = path.join(directory, name), info = await stat(file); if (info.isDirectory()) output.push(...await files(file)); else output.push(file) } return output }
async function bounded(promise, ms = 2000) { let timer; try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture operation hung')), ms) })]) } finally { clearTimeout(timer) } }
async function rejected(operation) { await bounded(assert.rejects(operation, error => { assert.equal(error.message, 'B站媒体获取失败：来源、权限、网络或内容不符合要求'); return true })) }
async function fixture(t, settings = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'bilibili-provider-test-')))
  const artifacts = await createAgentMediaArtifactStore({ directory, ...settings.store })
  const requests = [], lookups = [], prepared = [], thumbs = [], events = []
  let responder = settings.respond, metadata = view(settings.view), playback = play(settings.play), closed = 0
  const provider = createAgentBilibiliRelayProvider({ directory, artifacts,
    diagnostics: { emit: event => events.push(event) },
    lookup: async hostname => { lookups.push(hostname); return settings.addresses ?? [{ address: '8.8.8.8', family: 4 }] },
    request: async (url, address, signal, policy) => {
      requests.push({ url: url.href, address, signal, policy })
      const custom = await responder?.(url, policy, signal)
      const result = custom ?? (url.pathname.includes('finger/spi') ? response({ code: 0, data: { b_3: 'BUVID_PRIVATE_3', b_4: 'BUVID_PRIVATE_4' } })
        : url.pathname.includes('web-interface/view') ? response(metadata)
          : url.pathname.includes('player/web/playurl') ? response({ code: 0, result: playback.data })
            : url.pathname.includes('player/playurl') ? response(playback)
              : url.hostname.endsWith('.hdslb.com') ? response(PNG, 'image/png') : response(mp4(), 'video/mp4'))
      return { ...result, async close() { closed++; await result.close?.() } }
    },
    thumbnail: async (input, output, signal) => {
      thumbs.push({ input, output, signal })
      assert.ok(input.startsWith(directory + path.sep)); assert.ok(output.startsWith(path.dirname(input) + path.sep))
      assert.equal((await stat(path.dirname(input))).mode & 0o777, 0o700)
      assert.equal((await stat(input)).mode & 0o777, 0o400)
      assert.equal((await readFile(input)).subarray(4, 8).toString(), 'ftyp')
      await writeFile(output, JPEG)
    }, ...settings.options })
  t.after(async () => { await Promise.allSettled(prepared.map(value => value.release())); await artifacts.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) })
  return { directory, artifacts, requests, lookups, thumbs, events, closed: () => closed,
    setResponder(value) { responder = value }, setMetadata(value) { metadata = value }, setPlayback(value) { playback = value },
    async prepare(input = share(), scope = context()) { const value = await provider.prepare(input, scope); prepared.push(value); return value },
    async read(artifact) { const reader = await artifacts.open(artifact, context()), chunks = []; for await (const bytes of reader.chunks) chunks.push(bytes); return Buffer.concat(chunks) },
    async clean() { assert.deepEqual(await files(directory), []) },
  }
}

test('references contain bounded IDs only and recognize complete official syntax in input order', () => {
  for (const input of [`https://www.bilibili.com/video/${BV}?p=2`, `//m.bilibili.com/video/${BV}`, `bilibili.com/video/${BV}`]) assert.deepEqual(parseAgentBilibiliReference(input), share())
  assert.deepEqual(parseAgentBilibiliReference(`https://b23.tv/bangumi-test?secret=ignored https://www.bilibili.com/video/${BV}`), share('short', 'bangumi-test'))
  assert.deepEqual(parseAgentBilibiliReference(`https://www.bilibili.com/bangumi/play/ep${EP}`), share('episode'))
  assert.equal(parseAgentBilibiliReference(BV), undefined)
  assert.deepEqual(validateAgentMediaShare(share('video', 'bv12345678')), share('video', 'BV12345678'))
  for (const text of [`https://evil.test/video/${BV}`, `https://bilibili.com.evil.test/video/${BV}`, `https://bilibili.com@evil.test/video/${BV}`,
    `https://bilibili.com:444/video/${BV}`, `https://b23.tv/a/b`, `https://bilibili.com/video/${BV}#fragment`]) assert.equal(parseAgentBilibiliReference(text), undefined)
  for (const value of [{ ...share(), path: '/tmp/x' }, share('short', 'https://b23.tv/a'), share('episode', '0'), share('video', 'BV1'),
    { provider: 'bilibili', reference: { kind: 'video', id: BV, url: 'https://evil.test' } }, Object.assign(Object.create({ inherited: true }), share())]) assert.throws(() => validateAgentMediaShare(value))
  let invoked = false
  assert.throws(() => validateAgentMediaShare({ provider: 'bilibili', get reference() { invoked = true; return share().reference } })); assert.equal(invoked, false)
})

test('official metadata, cover and every distinct durl preserve order, safe text and owned resources', async t => {
  const first = mp4(64, 11), second = mp4(80, 22), third = mp4(96, 33)
  const f = await fixture(t, { view: { duration: 120, videos: 2, pages: [{ page: 1, cid: 11, part: '上集', duration: 60 }, { page: 2, cid: 12, part: '下集', duration: 60 }], pic: 'https://i0.hdslb.com/cover.png' },
    respond: async url => url.pathname.includes('player/playurl') ? response(play({ quality: 16, durl: url.searchParams.get('cid') === '11'
      ? [{ url: 'https://cn-test.bilivideo.com/one.mp4', size: 64 }, { url: 'https://cn-test.bilivideo.com/two.mp4', size: 80 }]
      : [{ url: 'https://cn-test.bilivideo.com/three.mp4', size: 96 }] }))
      : url.pathname === '/one.mp4' ? response(first, 'video/mp4') : url.pathname === '/two.mp4' ? response(second, 'video/mp4') : url.pathname === '/three.mp4' ? response(third, 'video/mp4') : undefined })
  const result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.plan.items.length, 4)
  assert.equal(result.plan.items[0].parts[1].kind, 'image'); assert.deepEqual(await f.read(result.plan.items[0].parts[1].artifact), PNG)
  const videos = result.plan.items.slice(1).map(item => item.parts[0])
  assert.deepEqual(videos.map(video => video.artifact.sha256), [first, second, third].map(digest))
  assert.equal(new Set(videos.map(video => video.artifact.id)).size, 3)
  for (const [index, video] of videos.entries()) { assert.deepEqual(await f.read(video.artifact), [first, second, third][index]); assert.deepEqual(await f.read(video.thumbnail), JPEG) }
  for (const text of ['示例视频', 'UP:示例UP', '保留完整简介', '2个分P', '播放:12034', '弹幕:88', '发布日期:2026-07-17', '实际清晰度:qn=16']) assert.ok(result.infoText.includes(text), text)
  assert.deepEqual(f.requests.filter(request => request.url.includes('player/playurl')).map(request => new URL(request.url).searchParams.get('cid')), ['11', '12'])
  assert.ok(f.requests.filter(request => request.url.includes('player/playurl')).every(request => request.url.includes('qn=6&fnval=0&fourk=0')))
  for (const value of ['upstream-private', 'BUVID_PRIVATE', f.directory, 'bilivideo.com', 'hdslb.com']) assert.equal(JSON.stringify(result).includes(value), false)
  assert.equal(f.thumbs.length, 3); await result.release(); await result.release(); await f.clean()
})

test('official b23 redirects to the matching episode and accepts its 412 landing page without parsing HTML', async t => {
  const f = await fixture(t, { respond: async url => url.hostname === 'b23.tv' ? response('', '', { status: 302, headers: { location: `https://www.bilibili.com/bangumi/play/ep${EP}` } })
    : url.hostname === 'www.bilibili.com' ? response('', '', { status: 412 })
      : url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { episodes: [{ id: Number(EP), cid: 99, duration: 721000, long_title: '番剧第九集', cover: '' }] } }) : undefined })
  const result = await f.prepare(share('short', 'bangumi-test'))
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, `https://www.bilibili.com/bangumi/play/ep${EP}`)
  assert.match(result.infoText, /番剧第九集/); assert.match(result.infoText, /12:01/)
  assert.ok(f.requests.some(request => request.url.includes(`/pgc/player/web/playurl?ep_id=${EP}&cid=99`)))
  assert.equal(f.requests.find(request => request.url.includes('pgc/view/web/season')).policy.headers.Cookie, 'buvid3=BUVID_PRIVATE_3; buvid4=BUVID_PRIVATE_4')
})

test('ordinary automatic relay uses anonymous fingerprint cookies and never the configured authorization', async t => {
  const f = await fixture(t, { options: { authCookie: 'SESSDATA=ACCOUNT_PRIVATE_VALUE; bili_jct=CSRF_PRIVATE_VALUE', autoAuthorizedRetry: true } })
  const result = await f.prepare(); assert.equal(result.status, 'ready')
  assert.ok(f.requests.every(request => !String(request.policy.headers.Cookie).includes('PRIVATE_VALUE')))
  assert.equal(f.requests.filter(request => request.url.includes('player/playurl')).length, 1)
  assert.equal(f.requests.find(request => request.url.includes('bilivideo.com')).policy.headers.Cookie, undefined)
})

test('a 24-hour SPI refresh can repeat only its learned device tokens while metadata still rejects them', async t => {
  const original = Date.now; let clock = original()
  Date.now = () => clock
  try {
    const f = await fixture(t), first = await f.prepare(); await first.release()
    clock += 24 * 60 * 60 * 1000 + 1
    const second = await f.prepare(); assert.equal(second.status, 'ready')
    assert.equal(f.requests.filter(request => request.url.includes('finger/spi')).length, 2)
    assert.equal(f.requests.filter(request => request.url.includes('web-interface/view')).at(-1).policy.headers.Cookie, 'buvid3=BUVID_PRIVATE_3; buvid4=BUVID_PRIVATE_4')
    f.setMetadata(view({ title: 'echo BUVID_PRIVATE_3' })); await rejected(f.prepare())
    await second.release(); await f.clean()
  } finally { Date.now = original }
})

test('SPI may never receive a configured host or account secret as its device credential', async t => {
  for (const value of ['HOST_PRIVATE_KEY', 'ACCOUNT_PRIVATE_VALUE']) await t.test(value, async t => {
    const f = await fixture(t, { options: { authCookie: 'SESSDATA=ACCOUNT_PRIVATE_VALUE', secrets: ['HOST_PRIVATE_KEY'] },
      respond: async url => url.pathname.includes('finger/spi') ? response({ code: 0, data: { b_3: value, b_4: 'allowed-device-token' } }) : undefined })
    const result = await f.prepare(); assert.equal(result.status, 'ready')
    assert.ok(f.requests.every(request => request.policy.headers.Cookie === undefined))
    assert.equal(JSON.stringify(result).includes(value), false)
  })
})

for (const trigger of ['preview', 'login']) test(`one authorized retry occurs only after anonymous ${trigger} and the final full video is used`, async t => {
  const cookies = [], f = await fixture(t, { options: { authCookie: 'SESSDATA=ACCOUNT_PRIVATE_VALUE', autoAuthorizedRetry: true }, respond: async (url, policy) => {
    if (!url.pathname.includes('player/playurl')) return
    cookies.push(policy.headers.Cookie ?? '')
    return response(policy.headers.Cookie?.includes('ACCOUNT_PRIVATE_VALUE') ? play() : trigger === 'login' ? { code: -101, message: '账号未登录' } : play({ is_preview: true, durl: [{ url: 'https://cn-test.bilivideo.com/preview.mp4', length: 6000, size: 64 }] }))
  } })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(cookies.length, 2)
  assert.equal(cookies[0], 'buvid3=BUVID_PRIVATE_3; buvid4=BUVID_PRIVATE_4'); assert.ok(cookies[1].includes('SESSDATA=ACCOUNT_PRIVATE_VALUE'))
  assert.equal(f.requests.filter(request => request.url.includes('/preview.mp4')).length, 0)
  assert.equal(f.requests.find(request => request.url.includes('bilivideo.com')).policy.headers.Cookie, 'SESSDATA=ACCOUNT_PRIVATE_VALUE')
})

test('anonymous previews remain explicitly labeled while authorized previews never publish video artifacts', async t => {
  for (const authorized of [false, true]) await t.test(String(authorized), async t => {
    const f = await fixture(t, { play: { is_preview: true }, options: { authCookie: 'SESSDATA=ACCOUNT_PRIVATE_VALUE', autoAuthorizedRetry: authorized } })
    const result = await f.prepare(); assert.equal(result.status, authorized ? 'restricted' : 'preview'); assert.match(result.infoText, /试看/)
    assert.equal(result.plan.items.some(item => item.parts.some(part => part.kind === 'video')), !authorized)
    assert.equal(f.requests.filter(request => request.url.includes('bilivideo.com')).length, authorized ? 0 : 1)
    if (authorized) assert.match(result.infoText, /授权账号复试/)
  })
})

test('regional restrictions do not expose a server message or trigger account authorization', async t => {
  const f = await fixture(t, { options: { authCookie: 'SESSDATA=ACCOUNT_PRIVATE_VALUE', autoAuthorizedRetry: true }, respond: async url => url.pathname.includes('player/playurl') ? response({ code: -403, message: '地区版权限制' }) : undefined })
  const result = await f.prepare(); assert.equal(result.status, 'restricted'); assert.match(result.infoText, /地区或版权限制/)
  assert.equal(f.requests.filter(request => request.url.includes('player/playurl')).length, 1)
  assert.ok(f.requests.every(request => !String(request.policy.headers.Cookie).includes('ACCOUNT_PRIVATE_VALUE')))
})

for (const limit of ['duration', 'parts']) test(`${limit} limit preserves information and cover with an explicit whole-video explanation`, async t => {
  const pages = Array.from({ length: 21 }, (_, index) => ({ page: index + 1, cid: index + 1, part: `P${index + 1}`, duration: 10 }))
  const f = await fixture(t, { view: limit === 'duration' ? { duration: 1801, pic: 'https://i0.hdslb.com/cover.png' } : { duration: 210, videos: 21, pages, pic: 'https://i0.hdslb.com/cover.png' } })
  const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.match(result.infoText, limit === 'duration' ? /超过30分钟/ : /21个分P，超过20个分P/)
  assert.equal(result.plan.items[0].parts[1].kind, 'image'); assert.equal(f.requests.filter(request => request.url.includes('player/playurl')).length, 0)
})

test('one failed or oversized durl never leaves a partial relay plan', async t => {
  for (const type of ['oversized', 'download']) await t.test(type, async t => {
    const f = await fixture(t, { play: { durl: [{ url: 'https://cn-test.bilivideo.com/first.mp4', size: 64 }, { url: 'https://cn-test.bilivideo.com/fail.mp4', size: type === 'oversized' ? 512 * MiB + 1 : 64 }] },
      respond: async url => url.pathname === '/fail.mp4' ? response('', '', { status: 500 }) : undefined })
    const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(result.plan.items.length, 1)
    assert.match(result.infoText, type === 'oversized' ? /512 MiB/ : /未完整获取/); await f.clean()
  })
})

test('segment capacity derives from 128 owned artifacts and never applies the old arbitrary forty segment cap', async t => {
  for (const [segments, cover, ready] of [[41, false, true], [64, false, true], [64, true, false], [65, false, false]]) await t.test(`${segments}/${cover}`, async t => {
    const durl = Array.from({ length: segments }, (_, index) => ({ url: `https://cn-test.bilivideo.com/segment-${index}.mp4`, size: 64 }))
    const f = await fixture(t, { view: { pic: cover ? 'https://i0.hdslb.com/cover.png' : '' }, play: { durl } })
    const result = await f.prepare()
    assert.equal(result.status, ready ? 'ready' : 'metadata-only')
    assert.equal(result.plan.items.length, ready ? segments + 1 : 1)
    if (!ready) { assert.match(result.infoText, cover ? /超过63段资源容量上限/ : /超过64段资源容量上限/); assert.equal(f.requests.filter(request => request.url.includes('bilivideo.com')).length, 0) }
    await result.release(); await f.clean()
  })
})

test('backup download candidates remain ordered and use independently bounded streams', async t => {
  const f = await fixture(t, { play: { durl: [{ url: 'https://cn-test.bilivideo.com/failed.mp4', backup_url: ['https://cn-backup.bilivideo.cn/backup.mp4'], size: 64 }] },
    respond: async url => url.pathname === '/failed.mp4' ? response('', '', { status: 503 }) : undefined })
  assert.equal((await f.prepare()).status, 'ready')
  assert.deepEqual(f.requests.filter(request => request.url.includes('bilivideo.')).map(request => new URL(request.url).pathname), ['/failed.mp4', '/backup.mp4'])
})

test('a header-valid short CDN body cannot satisfy the larger API size, and a complete backup can recover', async t => {
  for (const backup of [false, true]) await t.test(String(backup), async t => {
    const full = mp4(96, 17), f = await fixture(t, { play: { durl: [{ url: 'https://cn-test.bilivideo.com/short.mp4',
      backup_url: backup ? ['https://cn-test.bilivideo.com/full.mp4'] : [], size: full.length }] }, respond: async url => url.pathname === '/short.mp4'
      ? response(mp4(64), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': '64' } })
      : url.pathname === '/full.mp4' ? response(full, 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(full.length) } }) : undefined })
    const result = await f.prepare(); assert.equal(result.status, backup ? 'ready' : 'metadata-only')
    if (backup) { const video = result.plan.items[1].parts[0].artifact; assert.equal(video.sizeBytes, full.length); assert.deepEqual(await f.read(video), full) }
    else { assert.equal(result.plan.items.length, 1); assert.match(result.infoText, /未完整获取/) }
    await result.release(); await f.clean()
  })
})

test('a real 101 MiB streamed artifact stays hash-exact without whole-file media buffering', { timeout: 30_000 }, async t => {
  const expected = createHash('sha256'), size = 101 * MiB + 17
  const f = await fixture(t, { play: { durl: [{ url: 'https://cn-test.bilivideo.com/video.mp4', size }] }, options: { thumbnail: async (_input, output) => { await writeFile(output, JPEG) } }, respond: async url => url.hostname.endsWith('.bilivideo.com')
    ? response(videoStream(size, bytes => expected.update(bytes)), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(size) } }) : undefined })
  const result = await f.prepare(), artifact = result.plan.items[1].parts[0].artifact
  assert.equal(artifact.sizeBytes, size); assert.equal(artifact.sha256, expected.digest('hex'))
  const reader = await f.artifacts.open(artifact, context()), actual = createHash('sha256'); let total = 0
  for await (const bytes of reader.chunks) { assert.ok(bytes.length <= MiB); total += bytes.length; actual.update(bytes) }
  assert.equal(total, size); assert.equal(actual.digest('hex'), artifact.sha256)
  await result.release(); await f.clean()
})

test('actual streamed video overflow at 512 MiB and image overflow at 32 MiB clean partial staged bytes', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { view: { pic: 'https://i0.hdslb.com/cover.png' }, respond: async url => {
    if (url.hostname.endsWith('.hdslb.com')) return response((async function* () {
      const first = Buffer.alloc(MiB); PNG.copy(first); yield first
      const zero = Buffer.alloc(MiB); for (let index = 1; index < 32; index++) yield zero; yield Buffer.alloc(1)
    })(), 'image/png')
    if (url.hostname.endsWith('.bilivideo.com')) return response(videoStream(512 * MiB + 1), 'video/mp4')
  } })
  const result = await f.prepare(); assert.equal(result.status, 'metadata-only')
  assert.equal(result.plan.items[0].parts.length, 1); assert.match(result.infoText, /封面暂时获取失败/); assert.match(result.infoText, /未完整获取/)
  await f.clean()
})

for (const cancellation of ['signal', 'current', 'ensure']) test(`${cancellation} cancellation interrupts a hanging real artifact stream and cleans partial bytes`, async t => {
  const reached = gate(), late = gate(), controller = new AbortController(); let current = true, permission = true
  const f = await fixture(t, { respond: async url => url.hostname.endsWith('.bilivideo.com') ? response((async function* () { yield mp4(MiB); reached.release(); await late.promise; yield Buffer.alloc(MiB) })(), 'video/mp4') : undefined })
  const pending = f.prepare(share(), context({ signal: controller.signal, isCurrent: () => current, async ensureCurrent() { if (!permission) throw new Error('private cancellation reason') } }))
  const checked = rejected(pending); await bounded(reached.promise)
  if (cancellation === 'signal') controller.abort(new Error(f.directory)); else if (cancellation === 'current') current = false; else permission = false
  await checked; late.release(); await delay(30); await f.clean()
  assert.ok(f.requests.find(request => request.url.includes('bilivideo.com')).signal.aborted)
})

test('thumbnail failure preserves complete neutral video artifacts for channels that do not need thumbnails', async t => {
  const f = await fixture(t, { options: { thumbnail: async () => { throw new Error('ffmpeg private path /secret') } } })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(Object.hasOwn(result, 'fallbackReason'), false)
  assert.equal(result.plan.items.length, 2); assert.equal(result.infoText.includes('/secret'), false)
  const video = result.plan.items[1].parts[0]; assert.equal(video.kind, 'video'); assert.equal(video.thumbnail, undefined)
  assert.deepEqual(await f.read(video.artifact), mp4()); assert.match(result.infoText, /预览图暂不可用/)
  await result.release(); await f.clean()
})

test('thumbnail cancellation aborts the runner and cleans its private directory before returning', async t => {
  const reached = gate(), controller = new AbortController(); let signal
  const f = await fixture(t, { options: { thumbnail: async (_input, _output, ownSignal) => { signal = ownSignal; reached.release(); await new Promise((_resolve, reject) => ownSignal.addEventListener('abort', () => reject(new Error('cancel')), { once: true })) } } })
  const pending = f.prepare(share(), context({ signal: controller.signal })), checked = rejected(pending)
  await bounded(reached.promise); controller.abort(); await checked; assert.equal(signal.aborted, true); await f.clean()
})

test('DNS policy rejects every non-public family, mixed answer and family mismatch before request injection', async t => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], [{ address: '::1', family: 6 }],
    [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) await t.test(JSON.stringify(addresses), async t => {
    const f = await fixture(t, { addresses }); await rejected(f.prepare()); assert.equal(f.requests.length, 0); await f.clean()
  })
})

test('official URL policy rejects hostile media, cover and every redirect before DNS/request', async t => {
  for (const hostile of ['http://127.0.0.1/x', 'https://cn-test.bilivideo.com.evil.test/x', 'https://user@cn-test.bilivideo.com/x',
    'https://cn-test.bilivideo.com:443/x', 'https://cn-test.bilivideo.com/a/../x', 'https://cn-test.bilivideo.com/%2e%2e/x']) await t.test(hostile, async t => {
    const f = await fixture(t, { play: { durl: [{ url: hostile, size: 64 }] } }); await rejected(f.prepare()); assert.ok(!f.lookups.some(host => host.includes('evil') || host === '127.0.0.1')); await f.clean()
  })
  const f = await fixture(t, { respond: async url => url.hostname === 'b23.tv' ? response('', '', { status: 302, headers: { location: 'https://private.evil.test/x' } }) : undefined })
  await rejected(f.prepare(share('short', 'safe'))); assert.deepEqual(f.lookups, ['b23.tv']); assert.equal(f.requests.length, 1)
  const cover = await fixture(t, { view: { pic: 'https://evil.test/cover.png' } }); await rejected(cover.prepare()); assert.ok(!cover.lookups.includes('evil.test'))
})

test('secrets in any server field, escaped spelling or share ID cannot enter output and errors stay generic', async t => {
  for (const secret of ['AUTH_COMPONENT_PRIVATE', 'HOST_PRIVATE_KEY']) await t.test(secret, async t => {
    const f = await fixture(t, { options: { authCookie: 'SESSDATA=AUTH_COMPONENT_PRIVATE', secrets: ['HOST_PRIVATE_KEY'] }, view: { title: `echo ${secret}` } })
    await rejected(f.prepare()); await f.clean()
  })
  const f = await fixture(t, { options: { secrets: [BV] } }); await rejected(f.prepare()); assert.equal(f.requests.length, 0)
})

test('declared and streamed byte caps, malformed bodies and store quotas never publish partial resources', async t => {
  for (const candidate of ['length', 'stream', 'mime', 'header', 'quota', 'encoding', 'metadata']) await t.test(candidate, async t => {
    const f = await fixture(t, { store: candidate === 'quota' ? { maxTotalBytes: 32 } : undefined, respond: async url => {
      if (candidate === 'metadata' && url.pathname.includes('web-interface/view')) return response(' '.repeat(2 * MiB + 1))
      if (!url.hostname.endsWith('.bilivideo.com')) return
      if (candidate === 'length') return response(mp4(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(512 * MiB + 1) } })
      if (candidate === 'stream') return response((async function* () { yield mp4(); yield { byteLength: 512 * MiB + 1 } })(), 'video/mp4')
      if (candidate === 'mime') return response(mp4(), 'text/html')
      if (candidate === 'header') return response(Buffer.from('not-a-video'), 'video/mp4')
      if (candidate === 'encoding') return response(mp4(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip' } })
    } })
    if (candidate === 'metadata') await rejected(f.prepare())
    else { const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(result.plan.items.length, 1) }
    await f.clean()
  })
})

test('native HTTPS transport pins both validated address and IP family without a second lookup', async () => {
  const original = https.request, captures = []
  https.request = (url, options, callback) => {
    captures.push({ url, options })
    const request = new EventEmitter(); request.destroy = () => {}; request.end = () => {
      const incoming = Readable.from([Buffer.from('ok')]); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' }; callback(incoming)
    }
    return request
  }
  try {
    for (const address of [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]) {
      const response = await nativeAgentBilibiliRequest(new URL('https://api.bilibili.com/x/frontend/finger/spi'), address, new AbortController().signal, { maxBytes: 20, headers: {} })
      const captured = captures.at(-1); assert.equal(captured.options.family, address.family); assert.equal(captured.options.agent, false)
      let found; captured.options.lookup('ignored', {}, (...args) => { found = args }); assert.deepEqual(found, [null, address.address, address.family])
      for await (const _bytes of response.body) {} await response.close()
    }
  } finally { https.request = original }
})

test('native thumbnail execution has fixed demuxer, offline protocols, bounded process and private paths', async t => {
  const original = childProcess.execFile, calls = []
  childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command, args, options }); const child = new EventEmitter()
    void writeFile(args.at(-1), JPEG).then(() => callback(null, '', ''), error => callback(error, '', ''))
    return child
  }
  syncBuiltinESMExports()
  try {
    const f = await fixture(t, { options: { thumbnail: undefined } }), prepared = await f.prepare()
    assert.equal(prepared.status, 'ready'); assert.equal(calls.length, 1)
    const call = calls[0]; assert.equal(call.command, 'ffmpeg'); assert.equal(call.options.timeout, 30_000); assert.equal(call.options.killSignal, 'SIGKILL')
    assert.equal(call.options.maxBuffer, 128 * 1024); assert.ok(call.options.signal instanceof AbortSignal)
    assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
    assert.equal(call.args[call.args.indexOf('-f') + 1], 'mov'); assert.equal(call.args[call.args.indexOf('-vf') + 1], 'scale=640:-2')
    assert.ok(call.args[call.args.indexOf('-i') + 1].startsWith(f.directory + path.sep)); assert.ok(call.args.at(-1).startsWith(f.directory + path.sep))
    await prepared.release(); await f.clean()
  } finally { childProcess.execFile = original; syncBuiltinESMExports() }
})
