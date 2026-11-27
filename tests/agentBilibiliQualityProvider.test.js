import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const ts = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1' ? (await import('typescript')).default : undefined
const sourceModules = new Set(['agentBilibiliQualityProvider', 'agentBilibiliRelayProvider', 'agentBilibiliRelayHttp', 'agentBilibiliRelayThumbnail']), urls = new Map()
async function moduleUrl(name) {
  const compiledUrl = pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name + '.js')).href
  if (!ts || !sourceModules.has(name)) return compiledUrl
  if (urls.has(name)) return urls.get(name)
  let code = ts.transpileModule(await readFile(path.join(repo, 'src/modules/media/infrastructure', name + '.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  for (const match of [...code.matchAll(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu)]) {
    const dependency = path.basename(match[3], '.js'), url = sourceModules.has(dependency) ? await moduleUrl(dependency) : new URL(match[3], compiledUrl).href
    code = code.replace(match[0], `${match[1]}${match[2]}${url}${match[2]}`)
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; urls.set(name, url); return url
}
const { createAgentBilibiliQualityProvider, createAgentBilibiliSearchAttachmentProvider } = await import(await moduleUrl('agentBilibiliQualityProvider'))
const { createAgentBilibiliRelayProviderWithProfile } = await import(await moduleUrl('agentBilibiliRelayProvider'))
const { createAgentMediaArtifactStore } = await import(await moduleUrl('agentMediaArtifactStore'))
const { bilibiliGuard, createBilibiliHttp } = await import(await moduleUrl('agentBilibiliRelayHttp'))
const MiB = 1024 * 1024, BV = 'BV1H7Gq6zEiC', COOKIE = 'SESSDATA=AUTHORIZED_ACCOUNT_PRIVATE; bili_jct=CSRF_PRIVATE', PRIVATE = 'SIGNED_CDN_PRIVATE'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const share = (kind = 'video', id = BV) => ({ provider: 'bilibili', reference: { kind, id } })
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const response = (body, mime = 'application/json', status = 200, headers = {}) => ({ status, headers: { 'content-type': mime, ...headers }, body: typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body })
const video = (size = 64, fill = 0) => { const bytes = Buffer.alloc(size, fill); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
function metadata(overrides = {}) { return { code: 0, data: { bvid: BV, title: '授权完整视频', desc: '公开视频介绍', duration: 60, videos: 1, cid: 11,
  pages: [{ page: 1, cid: 11, duration: 60, part: '第一P' }], owner: { name: '作者' }, pic: '', ...overrides } } }
function playback(overrides = {}) { return { code: 0, data: { quality: 64, is_preview: 0, timelength: 60000,
  support_formats: [{ quality: 64, new_description: '720P' }], durl: [{ order: 1, url: `https://cn-test.bilivideo.com/video.mp4?token=${PRIVATE}`, length: 60000, size: 64 }], ...overrides } } }
const videos = result => result.plan.items.flatMap(item => item.parts.filter(part => part.kind === 'video'))
async function failure(operation) { await assert.rejects(operation, { message: 'B站媒体获取失败：来源、权限、网络或内容不符合要求' }) }
async function fixture(t, settings = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'bili-quality-provider-'))), artifacts = await createAgentMediaArtifactStore({ directory })
  const calls = [], credentials = [], prepared = [], thumbnails = [], events = []
  const options = { directory, artifacts: settings.wrapArtifacts ? settings.wrapArtifacts(artifacts) : artifacts,
    diagnostics: { emit: event => events.push(event) },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async (url, address, signal, policy) => {
      calls.push({ url, address, signal, policy })
      const customized = await settings.respond?.(url, policy, signal)
      return customized ?? (url.pathname.endsWith('/spi') ? response({ code: 0, data: { b_3: 'QUALITY_DEVICE_PRIVATE' } })
        : url.pathname.endsWith('/view') ? response(metadata(settings.metadata))
          : url.pathname.includes('/playurl') ? response(playback(settings.playback))
            : url.hostname.endsWith('.hdslb.com') ? response(PNG, 'image/png') : response(video(), 'video/mp4'))
    },
    thumbnail: async (input, output, signal) => {
      thumbnails.push({ input, output, signal }); assert.equal((await stat(input)).mode & 0o777, 0o400); assert.equal((await stat(path.dirname(input))).mode & 0o777, 0o700)
      assert.equal((await readFile(input)).subarray(4, 8).toString(), 'ftyp'); await writeFile(output, JPEG)
    }, ...settings.options }
  const provider = settings.attachment ? createAgentBilibiliSearchAttachmentProvider(options) : createAgentBilibiliQualityProvider({ ...options, credential: async scope => {
    credentials.push(scope); return settings.credential ? settings.credential(scope) : COOKIE
  } })
  t.after(async () => { await Promise.allSettled(prepared.map(result => result.release())); await artifacts.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) })
  return { directory, artifacts, options, provider, calls, credentials, thumbnails, events,
    async prepare(input = settings.attachment ? share() : { share: share(), quality: 80 }, scope = context()) { const result = await provider.prepare(input, scope); prepared.push(result); return result },
    async read(artifact) { const stream = await artifacts.open(artifact, context()), chunks = []; try { for await (const bytes of stream.chunks) chunks.push(bytes); return Buffer.concat(chunks) } finally { await stream.close() } } }
}

test('authorized extraction starts at requested quality and reports actual quality with complete private artifacts', async t => {
  const f = await fixture(t, { metadata: { pic: 'https://i0.hdslb.com/cover.png' } }), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.requestedQuality, 80); assert.deepEqual(result.actualQualities, [{ quality: 64, label: '720P' }])
  assert.ok(Object.isFrozen(result.actualQualities) && Object.isFrozen(result.actualQualities[0])); assert.equal(f.credentials.length, 1)
  const plays = f.calls.filter(call => call.url.pathname.includes('/playurl')); assert.equal(plays.length, 1)
  assert.equal(plays[0].url.searchParams.get('qn'), '80'); assert.equal(plays[0].policy.headers.Cookie, COOKIE + '; buvid3=QUALITY_DEVICE_PRIVATE')
  assert.equal(f.calls.find(call => call.url.hostname.endsWith('.bilivideo.com')).policy.headers.Cookie, COOKIE)
  assert.ok(f.calls.filter(call => !call.url.pathname.includes('/playurl') && !call.url.hostname.endsWith('.bilivideo.com')).every(call => !call.policy.headers.Cookie?.includes('AUTHORIZED_ACCOUNT_PRIVATE')))
  assert.match(result.infoText, /请求清晰度:qn=80；实际清晰度:qn=64/u); assert.equal(videos(result).length, 1)
  assert.deepEqual(await f.read(videos(result)[0].artifact), video()); assert.deepEqual(await f.read(videos(result)[0].thumbnail), JPEG)
  assert.deepEqual(await f.read(result.plan.items[0].parts[1].artifact), PNG)
  for (const secret of ['AUTHORIZED_ACCOUNT_PRIVATE', 'CSRF_PRIVATE', PRIVATE, 'QUALITY_DEVICE_PRIVATE', f.directory]) assert.equal(JSON.stringify(result).includes(secret), false)
  await result.release(); await result.release()
})

test('all quality presets and closed numeric range use exactly the selected qn', async t => {
  for (const quality of [1, 6, 16, 32, 64, 80, 112, 120, 127]) await t.test(String(quality), async t => {
    const f = await fixture(t, { playback: { quality, support_formats: [] } }), result = await f.prepare({ share: share(), quality })
    assert.equal(result.status, 'ready'); assert.equal(result.requestedQuality, quality); assert.deepEqual(result.actualQualities, [{ quality, label: `qn=${quality}` }])
    assert.ok(f.calls.filter(call => call.url.pathname.includes('/playurl')).every(call => call.url.searchParams.get('qn') === String(quality)))
  })
})

test('all parts and durl segments retain source order and distinct actual qualities', async t => {
  const f = await fixture(t, { metadata: { duration: 120, videos: 2, pages: [{ page: 1, cid: 11, duration: 60 }, { page: 2, cid: 12, duration: 60 }] },
    respond: url => {
      if (!url.pathname.includes('/playurl')) return
      const first = url.searchParams.get('cid') === '11', quality = first ? 64 : 32
      return response(playback({ quality, support_formats: [{ quality, new_description: first ? '720P' : '480P' }], durl: first
        ? [{ order: 1, url: 'https://cn-test.bilivideo.com/one.mp4', length: 30000, size: 64 }, { order: 2, url: 'https://cn-test.bilivideo.com/two.mp4', length: 30000, size: 64 }]
        : [{ order: 1, url: 'https://cn-test.bilivideo.com/three.mp4', length: 60000, size: 64 }] }))
    } })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 3)
  assert.deepEqual(result.actualQualities, [{ quality: 64, label: '720P' }, { quality: 32, label: '480P' }])
  assert.deepEqual(f.calls.filter(call => call.url.hostname.endsWith('.bilivideo.com')).map(call => call.url.pathname), ['/one.mp4', '/two.mp4', '/three.mp4'])
})

test('the full twenty-part boundary remains complete while malformed page identity fails closed', async t => {
  const pages = Array.from({ length: 20 }, (_, i) => ({ page: i + 1, cid: i + 1, duration: 10 }))
  const f = await fixture(t, { metadata: { duration: 200, videos: 20, pages }, playback: { timelength: 10000,
    durl: [{ url: 'https://cn-test.bilivideo.com/video.mp4', order: 1, length: 10000, size: 64 }] } })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 20)
  assert.equal(f.calls.filter(call => call.url.pathname.includes('/playurl')).length, 20)
  const malformed = await fixture(t, { metadata: { duration: 120, videos: 2, pages: [{ page: 1, cid: 11, duration: 60 }, { page: 1, cid: 12, duration: 60 }] } })
  await failure(malformed.prepare()); assert.equal(malformed.calls.some(call => call.url.pathname.includes('/playurl')), false)
})

test('short references and episode metadata share the same authorized complete extraction engine', async t => {
  const f = await fixture(t, { respond: url => url.hostname === 'b23.tv' ? response('', 'text/html', 302, { location: 'https://www.bilibili.com/bangumi/play/ep123' })
    : url.pathname === '/bangumi/play/ep123' ? response('', 'text/html', 412)
      : url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { episodes: [{ id: 123, cid: 99, long_title: '完整番剧', duration: 60000 }] } })
        : url.pathname === '/pgc/player/web/playurl' ? response({ code: 0, result: playback().data }) : undefined })
  const result = await f.prepare({ share: share('short', 'episode123'), quality: 112 })
  assert.equal(result.status, 'ready'); assert.equal(result.pageUrl, 'https://www.bilibili.com/bangumi/play/ep123')
  const play = f.calls.find(call => call.url.pathname === '/pgc/player/web/playurl'); assert.equal(play.url.searchParams.get('ep_id'), '123'); assert.equal(play.url.searchParams.get('cid'), '99'); assert.equal(play.url.searchParams.get('qn'), '112')
  assert.ok(play.policy.headers.Cookie.includes('AUTHORIZED_ACCOUNT_PRIVATE')); assert.ok(f.calls.filter(call => call.url.hostname !== 'api.bilibili.com' && !call.url.hostname.endsWith('.bilivideo.com')).every(call => call.policy.headers.Cookie === undefined))
  const duplicate = await fixture(t, { respond: url => url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { episodes: [
    { id: 123, cid: 99, long_title: '冲突甲', duration: 60000 }, { id: 123, cid: 100, long_title: '冲突乙', duration: 60000 }] } }) : undefined })
  await failure(duplicate.prepare({ share: share('episode', '123'), quality: 80 })); assert.equal(duplicate.calls.some(call => call.url.pathname.includes('/playurl')), false)
})

test('preview, incomplete segments and incomplete parts never become ready or expose a partial video', async t => {
  const invalid = [
    { is_preview: 1 }, { is_preview: true }, { durl: [{ url: 'https://cn-test.bilivideo.com/short.mp4', size: 64, length: 10000 }] },
    { durl: [{ url: 'https://cn-test.bilivideo.com/missing.mp4', size: 64 }] }, { durl: [{ url: 'https://cn-test.bilivideo.com/missing.mp4', length: 60000 }] },
    { durl: [{ order: 2, url: 'https://cn-test.bilivideo.com/missing.mp4', size: 64, length: 60000 }] }, { timelength: 60001 },
  ]
  for (const playback of invalid) await t.test(JSON.stringify(playback), async t => {
    const f = await fixture(t, { playback }), result = await f.prepare()
    assert.notEqual(result.status, 'ready'); assert.equal(videos(result).length, 0); assert.deepEqual(result.actualQualities, [])
    assert.equal(f.calls.filter(call => call.url.hostname.endsWith('.bilivideo.com')).length, 0)
  })
  const f = await fixture(t, { metadata: { duration: 120, videos: 2, pages: [{ page: 1, cid: 11, duration: 60 }, { page: 2, cid: 12, duration: 60 }] },
    respond: url => url.pathname.includes('/playurl') && url.searchParams.get('cid') === '12' ? response({ code: -101, message: '未登录' }) : undefined })
  const result = await f.prepare(); assert.equal(result.status, 'restricted'); assert.equal(videos(result).length, 0); assert.deepEqual(result.actualQualities, [])
})

test('overlong, unknown duration and too many parts retain safe information without playback', async t => {
  for (const metadata of [{ duration: 1801 }, { duration: 60, pages: [{ page: 1, cid: 11, duration: 1801 }] },
    { duration: 0 }, { pages: [{ page: 1, cid: 11, duration: 0 }] },
    { duration: 210, videos: 21, pages: Array.from({ length: 21 }, (_, i) => ({ page: i + 1, cid: i + 1, duration: 10 })) }]) await t.test(JSON.stringify(metadata), async t => {
    const f = await fixture(t, { metadata }), result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(videos(result).length, 0)
    assert.equal(f.calls.filter(call => call.url.pathname.includes('/playurl')).length, 0)
  })
})

test('known account failure is not retried anonymously or described as a successful quality', async t => {
  const f = await fixture(t, { respond: url => url.pathname.includes('/playurl') ? response({ code: -403, message: '地区版权限制' }) : undefined }), result = await f.prepare()
  assert.equal(result.status, 'restricted'); assert.deepEqual(result.actualQualities, []); assert.equal(videos(result).length, 0)
  assert.equal(f.calls.filter(call => call.url.pathname.includes('/playurl')).length, 1)
})

test('quality and actual quality inputs are closed and invalid values fail without provider disclosure', async t => {
  const f = await fixture(t); let touched = 0
  for (const input of [{ share: share(), quality: 0 }, { share: share(), quality: 128 }, { share: share(), quality: 80.5 }, { share: share(), quality: '80' },
    { share: share(), quality: 80, cookie: COOKIE }, { share: { provider: 'douyin', reference: { kind: 'video', id: '123456' } }, quality: 80 },
    { share: share(), get quality() { touched++; return 80 } }, new Proxy({}, { ownKeys() { touched++; return [] } })]) await failure(f.prepare(input))
  assert.equal(touched, 0); assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0)
  for (const playback of [{ quality: undefined }, { quality: 128 }, { quality: 0 }, { is_preview: '1' }]) {
    const q = await fixture(t, { playback }); await failure(q.prepare()); assert.equal(q.calls.some(call => call.url.hostname.endsWith('.bilivideo.com')), false)
  }
})

test('profiles and host configuration reject accessors, proxies and added authority without executing traps', async t => {
  const f = await fixture(t); let touched = 0
  for (const profile of [null, { mode: 'quality', quality: 80, extra: true }, { mode: 'automatic', quality: 80 }, { mode: 'attachment', quality: 6 },
    { mode: 'quality', get quality() { touched++; return 80 } }, new Proxy({}, { ownKeys() { touched++; return [] } })]) assert.throws(() => createAgentBilibiliRelayProviderWithProfile(f.options, profile))
  for (const options of [{ ...f.options, authCookie: COOKIE, credential() { return COOKIE } }, { ...f.options, credential: COOKIE },
    { ...f.options, get credential() { touched++; return () => COOKIE } }, new Proxy({}, { ownKeys() { touched++; return [] } })]) assert.throws(() => createAgentBilibiliQualityProvider(options))
  assert.throws(() => createAgentBilibiliSearchAttachmentProvider({ ...f.options, credential: () => COOKIE }))
  assert.equal(touched, 0); assert.equal(f.calls.length, 0)
})

test('missing or malformed credentials fail before any network access', async t => {
  for (const cookie of ['', 'not-a-cookie', 'SESSDATA=bad\r\nHeader: injected', {}, undefined]) {
    const f = await fixture(t, { credential: () => cookie }); await failure(f.prepare()); assert.equal(f.calls.length, 0)
  }
})

test('permission revocation while waiting for trusted authorization prevents every late request', async t => {
  const held = gate(), entered = gate(), controller = new AbortController()
  const f = await fixture(t, { credential: async scope => { entered.resolve(scope); return held.promise } })
  const pending = f.prepare(undefined, context({ signal: controller.signal })), scope = await entered.promise
  controller.abort(); await failure(pending); held.resolve(COOKIE); await delay(20)
  assert.equal(scope.isCurrent(), false); assert.equal(scope.signal.aborted, true); assert.equal(f.calls.length, 0)
})

test('playback redirects cannot change qn, cid or metadata endpoint while carrying authorization', async t => {
  for (const destination of [`https://api.bilibili.com/x/player/playurl?bvid=${BV}&cid=11&qn=6&fnval=0&fourk=0`,
    `https://api.bilibili.com/x/player/playurl?bvid=${BV}&cid=99&qn=80&fnval=0&fourk=0`, `https://api.bilibili.com/x/web-interface/view?bvid=${BV}`]) {
    const f = await fixture(t, { respond: url => url.pathname.includes('/playurl') ? response('', 'application/json', 302, { location: destination }) : undefined })
    await failure(f.prepare()); assert.equal(f.calls.filter(call => call.url.pathname.includes('/playurl')).length, 1)
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/view')).length, 1)
  }
})

test('failed downloads discard all already staged segments and actual quality receipts', async t => {
  const f = await fixture(t, { playback: { durl: [{ order: 1, url: 'https://cn-test.bilivideo.com/one.mp4', length: 30000, size: 64 },
    { order: 2, url: 'https://cn-test.bilivideo.com/two.mp4', length: 30000, size: 64 }] }, respond: url => url.pathname === '/two.mp4' ? response('bad', 'text/plain') : undefined })
  const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(videos(result).length, 0); assert.deepEqual(result.actualQualities, [])
  assert.match(result.infoText, /未完整获取/u)
})

test('signed resource URLs and query credentials cannot be echoed through titles or actual quality labels', async t => {
  const signed = `https://cn-test.bilivideo.com/video.mp4?token=${PRIVATE}`
  for (const echo of [PRIVATE, signed, encodeURIComponent(PRIVATE), Buffer.from(PRIVATE).toString('base64')]) {
    const f = await fixture(t, { playback: { support_formats: [{ quality: 64, new_description: echo }] } })
    await failure(f.prepare())
  }
  const f = await fixture(t, { metadata: { title: PRIVATE } }); await failure(f.prepare())
})

test('revocation during playback or CDN transfer cancels pending resources and ignores late replies', async t => {
  for (const stage of ['playback', 'cdn']) await t.test(stage, async t => {
    const held = gate(), entered = gate(), controller = new AbortController(); let pendingSignal
    const f = await fixture(t, { respond: async (url, _policy, signal) => {
      if (stage === 'playback' && url.pathname.includes('/playurl') || stage === 'cdn' && url.hostname.endsWith('.bilivideo.com')) {
        pendingSignal = signal; entered.resolve(); await held.promise
        return stage === 'playback' ? response(playback()) : response(video(), 'video/mp4')
      }
    } })
    const pending = f.prepare(undefined, context({ signal: controller.signal })); await entered.promise; controller.abort(); await failure(pending)
    held.resolve(); await delay(20); assert.equal(pendingSignal.aborted, true)
  })
})

test('the optional search attachment is anonymous qn16 with cover and at most two complete videos', async t => {
  const f = await fixture(t, { attachment: true, metadata: { pic: 'https://i0.hdslb.com/cover.png' }, playback: { quality: 16,
    durl: [{ order: 1, url: 'https://cn-test.bilivideo.com/one.mp4', length: 30000, size: 64 }, { order: 2, url: 'https://cn-test.bilivideo.com/two.mp4', length: 30000, size: 64 }] } })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 2); assert.equal(result.plan.items[0].parts[1].kind, 'image')
  assert.ok(f.calls.filter(call => call.url.pathname.includes('/playurl')).every(call => call.url.searchParams.get('qn') === '16'))
  assert.ok(f.calls.every(call => !call.policy.headers.Cookie?.includes('AUTHORIZED_ACCOUNT_PRIVATE'))); assert.equal(f.credentials.length, 0)
})

test('attachment and quality size limits reject whole plans before downloading oversized segments', async t => {
  for (const attachment of [false, true]) {
    const f = await fixture(t, { attachment, playback: { durl: [{ order: 1, url: 'https://cn-test.bilivideo.com/large.mp4', length: 60000, size: (attachment ? 30 : 512) * MiB + 1 }] } })
    const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(videos(result).length, 0); assert.equal(f.calls.some(call => call.url.hostname.endsWith('.bilivideo.com')), false)
    assert.match(result.infoText, attachment ? /30 MiB/u : /512 MiB/u)
  }
  const f = await fixture(t, { attachment: true, playback: { durl: Array.from({ length: 3 }, (_, i) => ({ order: i + 1, url: `https://cn-test.bilivideo.com/${i}.mp4`, length: 20000, size: 64 })) } })
  const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(videos(result).length, 0); assert.match(result.infoText, /超过2段/u)
})

function assertMetadataEvents(f) {
  assert.ok(f.events.length)
  for (const event of f.events) {
    const { details, ...eventFields } = event
    assert.ok(Object.keys(eventFields).every(field => ['code', 'operation', 'outcome', 'stage', 'durationMs', 'httpStatus'].includes(field)))
    if (details) {
      assert.ok(Object.keys(details).every(field => ['step', 'field', 'nativeCode', 'cause', 'limit', 'stepMs', 'dispatched', 'attempt', 'maxAttempts', 'result'].includes(field)))
      assert.match(details.step, /^(?:bilibili|response)_[a-z_]+$/u)
    }
    assert.equal(event.stage, 'runtime'); assert.match(event.operation, /^bilibili_[a-z_]+$/u); assert.match(event.code, /^[a-z_]+$/u)
    assert.ok(['failed', 'cancelled'].includes(event.outcome) || event.outcome === 'succeeded' && event.code === 'bilibili_candidate_recovered')
  }
  for (const secret of [COOKIE, 'AUTHORIZED_ACCOUNT_PRIVATE', 'CSRF_PRIVATE', PRIVATE, 'QUALITY_DEVICE_PRIVATE', f.directory, BV, 'https:', 'stack']) assert.equal(JSON.stringify(f.events).includes(secret), false)
}

test('provider metadata events expose optional fingerprint, cover and thumbnail degradation without provider secrets', async t => {
  for (const invalidFingerprint of [true, false]) await t.test(invalidFingerprint ? 'invalid fingerprint' : 'failed fingerprint', async t => {
    const f = await fixture(t, { metadata: { pic: 'https://i0.hdslb.com/cover.png' }, respond: url => {
      if (url.pathname.endsWith('/spi')) { if (invalidFingerprint) return response({ code: -400 }); throw Error(COOKIE + PRIVATE) }
      if (url.hostname.endsWith('.hdslb.com')) throw Error(COOKIE + PRIVATE)
    }, options: { async thumbnail() { throw Error(COOKIE + PRIVATE) } } })
    const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 1); assert.equal(videos(result)[0].thumbnail, undefined)
    assert.equal(result.plan.items[0].parts.length, 1); assert.match(result.infoText, /封面暂时获取失败/u); assert.match(result.infoText, /预览图暂不可用/u)
    for (const code of [invalidFingerprint ? 'fingerprint_invalid_fallback' : 'fingerprint_unavailable_fallback', 'image_candidate_failed', 'cover_unavailable', 'thumbnail_unavailable']) assert.ok(f.events.some(event => event.code === code && event.outcome === 'failed'), code)
    assert.equal(f.calls.filter(call => call.url.hostname.endsWith('.bilivideo.com')).length, 1); assertMetadataEvents(f)
  })
})

test('a failed video candidate remains observable when its existing authorized backup succeeds', async t => {
  const f = await fixture(t, { playback: { durl: [{ order: 1, url: `https://cn-test.bilivideo.com/primary.mp4?token=${PRIVATE}`,
    backup_url: [`https://cn-test.bilivideo.com/backup.mp4?token=${PRIVATE}`], length: 60000, size: 64 }] },
  respond: url => url.pathname === '/primary.mp4' ? response('unavailable', 'text/plain', 503) : undefined })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 1)
  const downloads = f.calls.filter(call => call.url.hostname.endsWith('.bilivideo.com'))
  assert.deepEqual(downloads.map(call => call.url.pathname), ['/primary.mp4', '/backup.mp4']); assert.ok(downloads.every(call => call.policy.headers.Cookie === COOKIE))
  const failures = f.events.filter(event => event.code === 'video_candidate_failed')
  assert.equal(failures.length, 1); assert.equal(failures[0].httpStatus, 503)
  assert.equal(failures[0].details.step, 'response_headers'); assert.equal(failures[0].details.attempt, 1)
  assert.equal(f.events.find(event => event.code === 'bilibili_candidate_recovered').details.attempt, 2)
  assert.equal(f.events.some(event => event.code === 'video_plan_incomplete'), false); assertMetadataEvents(f)
})

const rejectingRelease = artifacts => ({ ...artifacts, async stage(...args) {
  const lease = await artifacts.stage(...args)
  return { ...lease, async release() { await lease.release(); throw Error(COOKIE + PRIVATE) } }
} })

test('idempotent prepared release records rejected lease cleanup while retaining the confirmed ready result', async t => {
  const f = await fixture(t, { wrapArtifacts: rejectingRelease }), result = await f.prepare()
  assert.equal(result.status, 'ready'); await result.release()
  const failures = f.events.filter(event => event.code === 'artifact_release_failed').length
  assert.ok(failures >= 1); await result.release(); assert.equal(f.events.filter(event => event.code === 'artifact_release_failed').length, failures)
  assertMetadataEvents(f)
})

test('both incomplete-video and rejected preparation cleanup report allSettled lease failures', async t => {
  for (const rejectedPreparation of [false, true]) await t.test(rejectedPreparation ? 'rejected prepare' : 'incomplete video', async t => {
    const f = await fixture(t, { wrapArtifacts: rejectingRelease, metadata: { pic: 'https://i0.hdslb.com/cover.png' }, playback: { durl: [
      { order: 1, url: 'https://cn-test.bilivideo.com/first.mp4', length: 30000, size: 64 }, { order: 2, url: 'https://cn-test.bilivideo.com/second.mp4', length: 30000, size: 64 },
    ] }, respond: url => { if (rejectedPreparation && url.pathname.includes('/playurl')) throw Error(COOKIE + PRIVATE); if (url.pathname === '/second.mp4') return response('bad', 'text/plain') } })
    if (rejectedPreparation) { await failure(f.prepare()); assert.ok(f.events.some(event => event.code === 'prepare_unavailable')) }
    else { const result = await f.prepare(); assert.equal(result.status, 'metadata-only'); assert.equal(videos(result).length, 0); assert.ok(f.events.some(event => event.code === 'video_plan_incomplete')) }
    assert.ok(f.events.some(event => event.code === 'artifact_release_failed' && event.outcome === 'failed')); assertMetadataEvents(f)
  })
})

test('credential and download cancellation are distinct from real provider failures in metadata events', async t => {
  const failed = await fixture(t, { credential: async () => { throw Error(COOKIE + PRIVATE) } }); await failure(failed.prepare())
  assert.ok(failed.events.some(event => event.code === 'credential_unavailable' && event.outcome === 'failed')); assertMetadataEvents(failed)
  for (const stage of ['credential', 'download']) await t.test(stage, async t => {
    const entered = gate(), held = gate(), controller = new AbortController()
    const f = await fixture(t, stage === 'credential' ? { credential: async () => { entered.resolve(); return held.promise } }
      : { respond: async url => { if (url.hostname.endsWith('.bilivideo.com')) { entered.resolve(); await held.promise; return response(video(), 'video/mp4') } } })
    const pending = f.prepare(undefined, context({ signal: controller.signal })); await entered.promise; controller.abort(); await failure(pending); held.resolve(COOKIE); await delay(20)
    assert.ok(f.events.some(event => event.outcome === 'cancelled' && event.code === (stage === 'credential' ? 'credential_unavailable' : 'video_candidate_failed')))
    assert.equal(f.events.some(event => event.outcome === 'failed'), false); assertMetadataEvents(f)
  })
})

test('absent or throwing provider observers retain fixed terminal events and cannot alter degradation results', async t => {
  for (const broken of [false, true]) await t.test(broken ? 'throwing observer' : 'absent observer', async t => {
    const terminal = [], original = console.error; console.error = (...args) => terminal.push(args.join(' '))
    try {
      const f = await fixture(t, { options: { diagnostics: broken ? { emit() { throw Error(COOKIE + PRIVATE) } } : undefined, thumbnail: async () => { throw Error(COOKIE + PRIVATE) } } })
      const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.ok(terminal.some(line => line.includes('bilibili_provider_thumbnail failed thumbnail_unavailable')))
      for (const secret of [COOKIE, PRIVATE, f.directory, BV, 'https:']) assert.equal(terminal.join('\n').includes(secret), false)
    } finally { console.error = original }
  })
})

test('new diagnostic options reject accessors and proxies without evaluating observer authority', async t => {
  const f = await fixture(t); let touched = 0
  for (const diagnostics of [{ get emit() { touched++; return () => {} } }, new Proxy({}, { get() { touched++; return () => {} } }), { emit: new Proxy(() => {}, { apply() { touched++ } }) }]) {
    assert.throws(() => createAgentBilibiliQualityProvider({ ...f.options, diagnostics, credential: () => COOKIE }))
  }
  assert.equal(touched, 0)
})

test('HTTP response close and iterator return failures emit fixed metadata without suppressing complete delivery', async t => {
  for (const asynchronous of [false, true]) await t.test(asynchronous ? 'async cleanup' : 'sync cleanup', async t => {
    const f = await fixture(t, { respond: url => {
      if (!url.pathname.includes('/playurl')) return undefined
      const bytes = Buffer.from(JSON.stringify(playback())), body = { [Symbol.asyncIterator]() { let consumed = false; return {
        async next() { if (consumed) return { done: true }; consumed = true; return { done: false, value: bytes } },
        return() { if (asynchronous) return Promise.reject(Error(COOKIE + PRIVATE)); throw Error(COOKIE + PRIVATE) },
      } } }
      return { status: 200, headers: { 'content-type': 'application/json' }, body,
        close() { if (asynchronous) return Promise.reject(Error(COOKIE + PRIVATE)); throw Error(COOKIE + PRIVATE) } }
    } })
    const result = await f.prepare(); await delay(5); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 1)
    for (const code of ['response_close_failed', 'iterator_return_failed']) assert.ok(f.events.some(event => event.operation === 'bilibili_provider_release' && event.code === code), code)
    assertMetadataEvents(f)
  })
})

test('late response cleanup and rejected guard late callbacks remain observable after cancellation', async t => {
  const entered = gate(), held = gate(), controller = new AbortController(), codes = []
  const guard = bilibiliGuard(context({ signal: controller.signal }), 1000, code => codes.push(code))
  t.after(() => guard.close())
  const read = createBilibiliHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }], onCleanupFailure: code => codes.push(code),
    request: async () => { entered.resolve(); return held.promise } })
  const pending = read('https://api.bilibili.com/x/web-interface/view?bvid=' + BV, 'metadata', guard, 1024)
  await entered.promise; controller.abort(); await failure(pending)
  held.resolve({ ...response('{}'), close() { return Promise.reject(Error(COOKIE + PRIVATE)) } }); await delay(10)
  assert.deepEqual(codes, ['response_close_failed'])
  const deferred = gate(), next = bilibiliGuard(context(), 1000, code => codes.push(code))
  const late = next.wait(deferred.promise, async () => { throw Error(COOKIE + PRIVATE) }); next.close(); await failure(late); deferred.resolve('private'); await delay(10)
  assert.deepEqual(codes, ['response_close_failed', 'late_cleanup_failed'])
})

test('throwing cleanup observers fall back to fixed terminal codes and cannot interrupt response cleanup', async () => {
  const terminal = [], original = console.error; console.error = (...args) => terminal.push(args.join(' '))
  const guard = bilibiliGuard(context(), 1000, () => { throw Error(COOKIE + PRIVATE) })
  try {
    const read = createBilibiliHttp({ allows: () => true, lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      onCleanupFailure: () => Promise.reject(Error(COOKIE + PRIVATE)), request: async () => ({ ...response('{}'), close() { throw Error(COOKIE + PRIVATE) } }) })
    const result = await read('https://api.bilibili.com/x/web-interface/view?bvid=' + BV, 'metadata', guard, 1024)
    for await (const _ of result.chunks) {}
    const deferred = gate(), pending = guard.wait(deferred.promise, () => { throw Error(COOKIE + PRIVATE) }); guard.close(); await failure(pending); deferred.resolve('private'); await delay(10)
    assert.ok(terminal.some(line => line.endsWith('response_close_failed'))); assert.ok(terminal.some(line => line.endsWith('late_cleanup_failed')))
    for (const value of [COOKIE, PRIVATE, BV, 'https:']) assert.equal(terminal.join('\n').includes(value), false)
  } finally { guard.close(); console.error = original }
})

test('thumbnail reader close failure is visible, preserves complete video and still removes its private temporary directory', async t => {
  const f = await fixture(t, { wrapArtifacts: artifacts => ({ ...artifacts, async open(...args) {
    const reader = await artifacts.open(...args)
    return { ...reader, async close() { await reader.close(); throw Error(COOKIE + PRIVATE) } }
  } }) })
  const result = await f.prepare(); assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 1); assert.equal(videos(result)[0].thumbnail, undefined)
  assert.ok(f.events.some(event => event.code === 'thumbnail_reader_close_failed')); assert.ok(f.events.some(event => event.code === 'thumbnail_unavailable'))
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('bilibili-thumb-')), false); assertMetadataEvents(f)
})

test('thumbnail directory remove failure reports fixed metadata while retaining already-prepared complete media', async t => {
  const original = fsPromises.rm, f = await fixture(t), failed = []
  fsPromises.rm = async (file, options) => {
    if (path.basename(String(file)).startsWith('bilibili-thumb-')) { failed.push(String(file)); throw Error(COOKIE + PRIVATE) }
    return original(file, options)
  }; syncBuiltinESMExports()
  let result
  try { result = await f.prepare() } finally { fsPromises.rm = original; syncBuiltinESMExports(); for (const file of failed) await original(file, { recursive: true, force: true }) }
  assert.equal(result.status, 'ready'); assert.equal(videos(result).length, 1); assert.equal(failed.length, 1)
  assert.ok(f.events.some(event => event.code === 'thumbnail_directory_remove_failed')); assertMetadataEvents(f)
})
