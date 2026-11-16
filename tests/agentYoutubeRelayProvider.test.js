import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name + '.js')).href)
const { createAgentMediaArtifactStore } = await load('agentMediaArtifactStore')
const { createAgentYoutubeRelayProvider } = await load('agentYoutubeRelayProvider')
const ID = 'AbC_123-xYz', PAGE = `https://www.youtube.com/watch?v=${ID}`, MiB = 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const video = (size = 64) => { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('isom', 8); bytes.write('isom', 16); bytes.write('isom', 20); return bytes }
const share = { provider: 'youtube', reference: { kind: 'video', id: ID } }
const context = extra => ({ signal: new AbortController().signal, isCurrent: () => true, ...extra })
const response = (body, mime, extra = {}) => ({ status: 200, headers: { 'content-type': mime }, body, ...extra })
function metadata(extra = {}) { return { id: ID, _type: 'video', extractor_key: 'Youtube', webpage_url: PAGE, original_url: PAGE,
  title: 'Core迁移测试', channel: '测试频道', description: '保留简介和统计', duration: 60, view_count: 12345, like_count: 12,
  thumbnail: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, ext: 'mp4', protocol: 'https', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2',
  url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=1999999999&sig=PRIVATE_CDN_SIGNATURE', filesize: 64, ...extra } }
async function fixture(t, settings = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'youtube-provider-test-')))
  const artifacts = await createAgentMediaArtifactStore({ directory }), calls = [], commands = [], prepared = []
  let closed = 0
  const provider = createAgentYoutubeRelayProvider({ directory, artifacts,
    lookup: async () => settings.addresses ?? [{ address: '8.8.8.8', family: 4 }],
    native: async (command, args, options) => {
      commands.push({ command, args, options })
      if (settings.native) return await settings.native(command, args, options)
      return { stdout: settings.raw ?? JSON.stringify(metadata(settings.metadata)) }
    },
    request: async (url, address, signal, policy) => {
      calls.push({ url: url.href, address, signal, policy })
      const result = await settings.request?.(url, signal, policy) ?? (url.hostname.endsWith('ytimg.com') ? response(PNG, 'image/png') : response(video(), 'video/mp4'))
      return { ...result, async close() { closed++; await result.close?.() } }
    },
    thumbnail: async (_input, output, signal) => { assert.equal(signal.aborted, false); await writeFile(output, JPEG) },
    ...settings.options,
  })
  t.after(async () => { for (const item of prepared) await item.release(); await artifacts.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, artifacts, calls, commands, provider, closed: () => closed,
    async prepare(extra) { const item = await provider.prepare(share, context(extra)); prepared.push(item); return item } }
}
async function bytes(store, artifact) { const reader = await store.open(artifact, context()); try { const chunks = []; for await (const chunk of reader.chunks) chunks.push(chunk); return Buffer.concat(chunks) } finally { await reader.close() } }

test('YouTube selected progressive MP4, cover and full metadata become one ordered neutral item with owned bytes', async t => {
  const f = await fixture(t), prepared = await f.prepare(), parts = prepared.plan.items[0].parts
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.pageUrl, PAGE)
  assert.deepEqual(parts.map(part => part.kind), ['text', 'image', 'video'])
  assert.match(prepared.infoText, /测试频道.*AbC_123-xYz.*1:00/u)
  assert.match(prepared.infoText, /播放:12345 点赞:12/u); assert.match(prepared.infoText, /保留简介和统计/u)
  assert.equal(f.commands.length, 1); assert.equal(f.commands[0].command, 'yt-dlp')
  assert.ok(f.commands[0].args.includes('--skip-download')); assert.ok(f.commands[0].args.includes('--no-playlist'))
  assert.deepEqual(await bytes(f.artifacts, parts[1].artifact), PNG)
  assert.deepEqual(await bytes(f.artifacts, parts[2].artifact), video())
  assert.deepEqual(await bytes(f.artifacts, parts[2].thumbnail), JPEG)
  assert.equal(parts[2].artifact.sha256, createHash('sha256').update(video()).digest('hex'))
  assert.equal(JSON.stringify(prepared.plan).includes('PRIVATE_CDN_SIGNATURE'), false)
  assert.equal(JSON.stringify(prepared.plan).includes(f.directory), false)
  for (const call of f.calls) assert.equal(Object.keys(call.policy.headers).some(key => /cookie|authorization/i.test(key)), false)
  assert.equal(f.closed(), 2)
  await prepared.release(); await prepared.release()
  await assert.rejects(f.artifacts.open(parts[2].artifact, context()))
})

test('YouTube cover survives all pre-download metadata-only conditions without asking for video bytes', async t => {
  for (const [name, patch, notice] of [
    ['long', { duration: 1801 }, /超过30分钟/u], ['live', { is_live: true }, /直播中/u],
    ['upcoming', { live_status: 'is_upcoming' }, /尚未开始/u], ['unknown duration', { duration: null }, /时长未确认/u],
    ['no audio', { acodec: 'none' }, /单文件 MP4/u], ['no video', { vcodec: 'none' }, /单文件 MP4/u],
    ['merged', { requested_formats: [{}] }, /单文件 MP4/u], ['webm', { ext: 'webm' }, /单文件 MP4/u],
    ['HLS', { protocol: 'm3u8_native' }, /单文件 MP4/u], ['DASH', { protocol: 'http_dash_segments' }, /单文件 MP4/u],
    ['fragment', { fragments: [{ url: 'https://rr1.googlevideo.com/fragment' }] }, /单文件 MP4/u],
    ['manifest', { manifest_url: 'https://rr1.googlevideo.com/manifest' }, /单文件 MP4/u],
    ['over512', { filesize: 512 * MiB + 1 }, /单文件 MP4/u],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { metadata: patch }), item = await f.prepare()
    assert.equal(item.status, 'metadata-only'); assert.match(item.infoText, notice)
    assert.deepEqual(item.plan.items[0].parts.map(part => part.kind), ['text', 'image'])
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /ytimg/u)
  })
})

test('YouTube never accepts another work, playlist, extractor, external page, invalid JSON or host secret as metadata', async t => {
  for (const [name, settings] of [
    ['other ID', { metadata: { id: 'ZyX_321-cBa' } }], ['playlist', { metadata: { entries: [] } }],
    ['other page', { metadata: { webpage_url: 'https://www.youtube.com/watch?v=ZyX_321-cBa' } }],
    ['external page', { metadata: { webpage_url: 'https://evil.invalid/watch?v=AbC_123-xYz' } }],
    ['nonvideo', { metadata: { _type: 'url' } }], ['extractor', { metadata: { extractor_key: 'Generic' } }],
    ['JSON', { raw: '{broken' }], ['secret', { metadata: { description: 'HOST_PRIVATE_SECRET' }, options: { secrets: ['HOST_PRIVATE_SECRET'] } }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, settings)
    await assert.rejects(f.prepare(), error => { assert.equal(error.message, 'YouTube 媒体获取失败：来源、权限、网络或内容不符合要求'); return true })
    assert.equal(f.calls.length, 0); assert.equal(f.commands.length, 1)
  })
})

test('YouTube cover failures retain the complete video and thumbnail failures retain the complete neutral video', async t => {
  const f = await fixture(t, { metadata: { thumbnail: 'http://127.0.0.1/secret' }, options: { thumbnail: async () => { throw Error('private native failure') } } })
  const item = await f.prepare(), parts = item.plan.items[0].parts
  assert.equal(item.status, 'ready'); assert.deepEqual(parts.map(part => part.kind), ['text', 'video'])
  assert.equal(parts[1].thumbnail, undefined); assert.equal(f.calls.length, 1)
  assert.deepEqual(await bytes(f.artifacts, parts[1].artifact), video())
})

test('YouTube rejects unavailable, partial, compressed and size-mismatched media but keeps info and cover', async t => {
  for (const [name, settings] of [
    ['external CDN', { metadata: { url: 'https://evil.invalid/video.mp4' } }],
    ['private DNS', { addresses: [{ address: '127.0.0.1', family: 4 }] }],
    ['announced size mismatch', { metadata: { filesize: 65 } }],
    ['partial', { request: url => url.hostname.endsWith('googlevideo.com') ? response(video(), 'video/mp4', { status: 206 }) : undefined }],
    ['compressed', { request: url => url.hostname.endsWith('googlevideo.com') ? response(video(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip' } }) : undefined }],
    ['incomplete', { request: url => url.hostname.endsWith('googlevideo.com') ? response(video(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': '65' } }) : undefined }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, settings), item = await f.prepare()
    assert.equal(item.status, 'metadata-only'); assert.match(item.infoText, /单文件 MP4/u)
    assert.equal(item.plan.items[0].parts.some(part => part.kind === 'video'), false)
  })
})

test('YouTube cancellation during the cover body blocks video download and releases staged resources', async t => {
  const cancel = new AbortController()
  const f = await fixture(t, { request: url => url.hostname.endsWith('ytimg.com') ? response((async function* () { yield PNG; cancel.abort() })(), 'image/png') : undefined })
  await assert.rejects(f.prepare({ signal: cancel.signal }))
  assert.equal(f.calls.length, 1)
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('youtube-metadata-')), false)
})

test('YouTube PO token is allowed only in the exact private playback pot field and never in plans', async t => {
  const token = 'PRIVATE_PO_TOKEN_+/=', url = `https://rr1---sn-test.googlevideo.com/videoplayback?sig=CDN_ONLY&pot=${encodeURIComponent(token)}`
  const f = await fixture(t, { metadata: { url }, options: { poToken: token } })
  const item = await f.prepare()
  assert.equal(item.status, 'ready'); assert.ok(f.calls.some(call => new URL(call.url).searchParams.get('pot') === token))
  assert.ok(!JSON.stringify(item.plan).includes(token)); assert.ok(!JSON.stringify(item.plan).includes(encodeURIComponent(token)))
  for (const [name, patch] of [
    ['wrong field', { url: url.replace('pot=', 'authorization=') }], ['duplicate', { url: url + '&pot=' + encodeURIComponent(token) }],
    ['other URL', { thumbnail: `https://i.ytimg.com/vi/${ID}/image.jpg?pot=${encodeURIComponent(token)}` }],
    ['text', { title: token }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, { metadata: patch, options: { poToken: token } })
    await assert.rejects(f.prepare()); assert.equal(f.calls.length, 0)
  })
})

test('YouTube refuses host credentials and escaped encodings split across otherwise valid image and video chunks', async t => {
  const secret = 'PRIVATE_MEDIA_SECRET'
  for (const kind of ['image', 'video']) for (const encoded of [secret, encodeURIComponent(secret + '+'), Buffer.from(secret).toString('base64')]) await t.test(`${kind} ${encoded}`, async t => {
    const guarded = encoded.startsWith(secret) && encoded !== secret ? secret + '+' : secret
    const f = await fixture(t, { options: { secrets: [guarded] }, request: url => {
      if ((kind === 'image') !== url.hostname.endsWith('ytimg.com')) return undefined
      const start = kind === 'image' ? PNG : video(), split = Math.floor(encoded.length / 2)
      return response((async function* () { yield Buffer.concat([start, Buffer.from(encoded.slice(0, split))]); yield Buffer.from(encoded.slice(split)) })(), kind === 'image' ? 'image/png' : 'video/mp4')
    } })
    const item = await f.prepare(), parts = item.plan.items[0].parts
    assert.equal(parts.some(part => part.kind === kind), false)
    assert.equal(item.status, kind === 'image' ? 'ready' : 'metadata-only')
  })
})

test('YouTube source invalidation while metadata is pending forbids all downloads and late results', async t => {
  let finish, started, current = true
  const begins = new Promise(resolve => { started = resolve }), pending = new Promise(resolve => { finish = resolve })
  const f = await fixture(t, { native: async () => { started(); await pending; return { stdout: JSON.stringify(metadata()) } } })
  const operation = f.prepare({ isCurrent: () => current })
  await begins; current = false; finish()
  await assert.rejects(operation); assert.equal(f.calls.length, 0)
})

test('YouTube permits exactly the 512MiB transport budget and retains every byte', { timeout: 60000 }, async t => {
  const size = 512 * MiB, expected = createHash('sha256')
  const stream = async function* () { for (let at = 0; at < size; at += MiB) { const chunk = at ? Buffer.alloc(MiB, 17) : video(MiB); expected.update(chunk); yield chunk } }
  const f = await fixture(t, { metadata: { thumbnail: '', filesize: size },
    request: () => response(stream(), 'video/mp4', { headers: { 'content-type': 'video/mp4', 'content-length': String(size) } }),
    options: { thumbnail: async () => { throw Error('synthetic transport needs no codec') } } })
  const item = await f.prepare(), part = item.plan.items[0].parts.find(part => part.kind === 'video')
  assert.equal(item.status, 'ready'); assert.equal(part.artifact.sizeBytes, size)
  assert.equal(part.artifact.sha256, expected.digest('hex'))
  const reader = await f.artifacts.open(part.artifact, context()), actual = createHash('sha256'); let read = 0
  try { for await (const chunk of reader.chunks) { read += chunk.byteLength; actual.update(chunk) } } finally { await reader.close() }
  assert.equal(read, size); assert.equal(actual.digest('hex'), part.artifact.sha256)
})
