import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { validateAgentMediaArtifact, validateAgentMediaRelayPlan } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/domain/agentMediaRelayPlan.js')).href)
const { validateAgentMediaRelayConfig } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/domain/agentMediaRelayConfig.js')).href)
const MiB = 1024 * 1024
const artifact = (index = 1, kind = 'image', overrides = {}) => ({ id: index.toString(16).padStart(32, '0'), kind,
  mime: kind === 'image' ? 'image/png' : 'video/mp4', sizeBytes: kind === 'image' ? 32 * MiB : 512 * MiB, sha256: 'a'.repeat(64), ...overrides })
const text = value => ({ kind: 'text', text: value })
const image = value => ({ kind: 'image', artifact: value })
const video = (value, thumbnail) => ({ kind: 'video', artifact: value, ...(thumbnail === undefined ? {} : { thumbnail }) })
const plan = parts => ({ version: 1, items: [{ parts }] })
const good = () => plan([text('保持这段原文。'), image(artifact())])

test('provider activation preserves old defaults and owns a bounded closed provider list', () => {
  assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true }), { enabled: true })
  const providers = ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv'], config = validateAgentMediaRelayConfig({ enabled: true, providers })
  providers.pop(); assert.deepEqual(config.providers, ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv']); assert.ok(Object.isFrozen(config.providers))
  assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['xiaohongshu'] }), { enabled: true, providers: ['xiaohongshu'] })
  assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['youtube'] }), { enabled: true, providers: ['youtube'] })
  assert.deepEqual(validateAgentMediaRelayConfig({ enabled: true, providers: ['pixiv'] }), { enabled: true, providers: ['pixiv'] })
  let touched = false
  const accessor = []; Object.defineProperty(accessor, '0', { enumerable: true, get() { touched = true; return 'douyin' } })
  for (const list of [[], ['douyin', 'douyin'], ['youtube', 'youtube'], ['other'], ['bilibili', 'douyin', 'bilibili'],
    ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv', 'pixiv'], ['pixiv', 'pixiv'], [, 'douyin'], accessor,
    Object.assign(['douyin'], { extra: true })]) assert.throws(() => validateAgentMediaRelayConfig({ enabled: true, providers: list }))
  assert.equal(touched, false)
})

test('artifact metadata accepts all shared image/video MIME contracts at their own exact size ceilings', () => {
  for (const [kind, mimes, maximum] of [
    ['image', ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'], 32 * MiB],
    ['video', ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'], 512 * MiB],
  ]) for (const mime of mimes) {
    const source = artifact(1, kind, { mime, sizeBytes: maximum }), owned = validateAgentMediaArtifact(source)
    assert.deepEqual(owned, source); assert.notEqual(owned, source); assert.equal(Object.isFrozen(owned), true)
    assert.deepEqual(validateAgentMediaArtifact({ ...source, sizeBytes: 1 }), { ...source, sizeBytes: 1 })
    assert.throws(() => validateAgentMediaArtifact({ ...source, sizeBytes: maximum + 1 }))
  }
})

test('mixed relay plans retain text, twenty full-size images and multiple full-size videos in exact order', () => {
  const images = Array.from({ length: 20 }, (_, index) => image(artifact(index + 1)))
  const source = { version: 1, items: [
    { parts: [text('开头\n  保留间距。'), ...images, video(artifact(21, 'video'), artifact(22)), text('第一段尾声')] },
    { parts: [video(artifact(23, 'video')), text('第二段'), video(artifact(24, 'video'))] },
  ] }
  const checked = []
  const owned = validateAgentMediaRelayPlan(source, { allowsText: value => { checked.push(value); return true } })
  assert.deepEqual(owned, source)
  assert.deepEqual(checked, ['开头\n  保留间距。', '第一段尾声', '第二段'])
  assert.equal(owned.items[0].parts.filter(part => part.kind === 'image').length, 20)
  assert.equal(owned.items[1].parts[0].artifact.sizeBytes, 512 * MiB)
  assert.equal(owned.items[0].parts[21].thumbnail.kind, 'image')
})

test('owned plans isolate every mutable input layer and freeze node, part, artifact and thumbnail data', () => {
  const source = plan([text('原文'), image(artifact()), video(artifact(2, 'video'), artifact(3))])
  const expected = structuredClone(source), owned = validateAgentMediaRelayPlan(source)
  source.version = 2; source.items[0].parts[0].text = '换掉原文'; source.items[0].parts[1].artifact.sizeBytes = 1
  source.items[0].parts[2].artifact.id = 'f'.repeat(32); source.items[0].parts[2].thumbnail.sha256 = 'f'.repeat(64)
  source.items[0].parts.push(text('追加')); source.items.push({ parts: [text('换掉结构')] })
  assert.deepEqual(owned, expected)
  const frozen = [owned, owned.items, owned.items[0], owned.items[0].parts, ...owned.items[0].parts,
    owned.items[0].parts[1].artifact, owned.items[0].parts[2].artifact, owned.items[0].parts[2].thumbnail]
  for (const value of frozen) assert.equal(Object.isFrozen(value), true)
  assert.throws(() => { owned.items[0].parts[2].thumbnail.sizeBytes = 1 }, TypeError)
  assert.throws(() => { owned.items[0].parts.push(text('非法追加')) }, TypeError)
})

test('artifact identities, MIME, positive integral size and closed metadata reject misleading references and bytes', () => {
  for (const invalid of [
    null, [], 'artifact', {}, { ...artifact(), id: 'not-an-opaque-id' }, { ...artifact(), id: 'a'.repeat(31) },
    { ...artifact(), id: 'A'.repeat(32) }, { ...artifact(), sha256: 'b'.repeat(63) }, { ...artifact(), sha256: 'Z'.repeat(64) },
    { ...artifact(), kind: 'audio' }, { ...artifact(), mime: 'video/mp4' }, { ...artifact(1, 'video'), mime: 'image/png' },
    ...['IMAGE/PNG', 'image/png; charset=utf-8', 'image/svg+xml', 'video/mpeg', 'application/octet-stream'].map(mime => ({ ...artifact(), mime })),
    ...[0, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1024'].map(sizeBytes => ({ ...artifact(), sizeBytes })),
    ...['path', 'url', 'base64', 'bytes', 'native', 'target', 'author', 'fileId', 'name'].map(key => ({ ...artifact(), [key]: 'PRIVATE_UNTRUSTED_FIELD' })),
  ]) assert.throws(() => validateAgentMediaArtifact(invalid))
})

test('unknown plan, node or part fields cannot supply authors, recipients, provider routes or inline media', () => {
  for (const source of [
    null, [], { items: [] }, { version: 2, items: [{ parts: [text('x')] }] }, { ...good(), target: 'another-room' },
    { ...good(), author: { user_id: 'forged-author' } }, { ...good(), url: 'https://provider.invalid/path' },
    { version: 1, items: [{ parts: [text('x')], author: 'forged-author' }] },
    { version: 1, items: [{ parts: [text('x')], name: 'forged-display-name' }] },
    plan([{ ...text('x'), artifact: artifact() }]), plan([{ ...image(artifact()), text: 'smuggled text' }]),
    plan([{ ...image(artifact()), thumbnail: artifact(2) }]), plan([{ ...video(artifact(2, 'video')), url: 'https://provider.invalid' }]),
    plan([{ kind: 'image', mime: 'image/png', base64: 'PRIVATE_BYTES' }]), plan([{ kind: 'forward', id: 'native-forward' }]),
    plan([{ kind: 'video', artifact: artifact() }]), plan([{ kind: 'image', artifact: artifact(1, 'video') }]),
    plan([{ ...video(artifact(1, 'video')), thumbnail: artifact(2, 'video') }]), plan([{ ...video(artifact(1, 'video')), thumbnail: undefined }]),
    plan([{ kind: 'text', text: 12 }]), plan([{ kind: 'text' }]),
  ]) assert.throws(() => validateAgentMediaRelayPlan(source))
})

test('getter, custom prototype, sparse array and hidden fields fail without executing input behavior', () => {
  let invoked = 0
  const getterArtifact = { ...artifact() }
  Object.defineProperty(getterArtifact, 'sha256', { enumerable: true, get() { invoked++; return 'a'.repeat(64) } })
  const getterPlan = { version: 1, get items() { invoked++; return good().items } }
  const getterNode = { get parts() { invoked++; return [text('x')] } }
  const getterPart = { kind: 'text', get text() { invoked++; return 'x' } }
  const getterArray = [text('x')]
  Object.defineProperty(getterArray, '0', { get() { invoked++; return text('x') } })
  const customArray = [text('x')]; Object.setPrototypeOf(customArray, Object.create(Array.prototype))
  const extraArray = [text('x')]; Object.defineProperty(extraArray, 'author', { value: 'hidden-native-author' })
  const hiddenArtifact = { ...artifact() }; Object.defineProperty(hiddenArtifact, 'path', { value: '/private/file' })
  const symbolic = { ...good(), [Symbol('target')]: 'another-room' }
  const jsonPrototype = JSON.parse('{"version":1,"items":[{"parts":[{"kind":"text","text":"x"}]}],"__proto__":{"target":"another-room"}}')
  assert.throws(() => validateAgentMediaArtifact(getterArtifact)); assert.throws(() => validateAgentMediaArtifact(hiddenArtifact))
  assert.throws(() => validateAgentMediaArtifact(Object.assign(Object.create({}), artifact())))
  for (const source of [getterPlan, { version: 1, items: [getterNode] }, plan([getterPart]), plan(getterArray), plan(customArray), plan(extraArray),
    plan(new Array(1)), { version: 1, items: new Array(1) }, Object.assign(Object.create({}), good()), symbolic, jsonPrototype,
    plan([Object.assign(Object.create({}), text('x'))]), plan([{ parts: [text('x')] }]),
  ]) assert.throws(() => validateAgentMediaRelayPlan(source))
  assert.equal(invoked, 0)
  assert.deepEqual(validateAgentMediaArtifact(Object.assign(Object.create(null), artifact())), artifact(), 'null-prototype data is ordinary closed data')
})

test('node and part budgets accept exact limits and reject overages instead of silently dropping tail content', () => {
  const nodes = Array.from({ length: 128 }, (_, index) => ({ parts: [text(`节点${index}`)] }))
  assert.equal(validateAgentMediaRelayPlan({ version: 1, items: nodes }).items.length, 128)
  assert.throws(() => validateAgentMediaRelayPlan({ version: 1, items: [...nodes, { parts: [text('不能截掉')] }] }))
  const parts = Array.from({ length: 128 }, (_, index) => text(`片段${index}`))
  assert.equal(validateAgentMediaRelayPlan(plan(parts)).items[0].parts.length, 128)
  assert.throws(() => validateAgentMediaRelayPlan(plan([...parts, text('不能截掉')])))
  const total = { version: 1, items: Array.from({ length: 4 }, () => ({ parts: structuredClone(parts) })) }
  assert.equal(validateAgentMediaRelayPlan(total).items.reduce((sum, item) => sum + item.parts.length, 0), 512)
  assert.throws(() => validateAgentMediaRelayPlan({ ...total, items: [...total.items, { parts: [text('第513段')] }] }))
  for (const source of [{ version: 1, items: [] }, plan([])]) assert.throws(() => validateAgentMediaRelayPlan(source))
})

test('text limits count Unicode code points and enforce the complete plan budget without normalization', () => {
  const unicode = '😀'.repeat(64_000)
  assert.equal(validateAgentMediaRelayPlan(plan([text(unicode)])).items[0].parts[0].text, unicode)
  assert.throws(() => validateAgentMediaRelayPlan(plan([text(unicode + 'x')])))
  const maximum = plan(Array.from({ length: 4 }, () => text(unicode)))
  assert.equal(validateAgentMediaRelayPlan(maximum).items[0].parts.length, 4)
  assert.throws(() => validateAgentMediaRelayPlan(plan([...maximum.items[0].parts, text('x')])))
  assert.equal(validateAgentMediaRelayPlan(plan([text(' \n\t 保持间距 ')])).items[0].parts[0].text, ' \n\t 保持间距 ')
})

test('every text part consults the live host policy and policy errors cannot reveal their private contents', () => {
  const privateValue = 'RELAY_PRIVATE_HOST_SECRET'
  let denied = ''
  const checked = []
  assert.throws(() => validateAgentMediaRelayPlan(plan([text('first'), text(privateValue)]), { allowsText(value) {
    checked.push(value); if (value === 'first') denied = privateValue
    return value !== denied
  } }))
  assert.deepEqual(checked, ['first', privateValue])
  assert.throws(() => validateAgentMediaRelayPlan(plan([text('x')]), { allowsText() { throw new Error(privateValue) } }), error => !error.message.includes(privateValue))
  assert.throws(() => validateAgentMediaRelayPlan(plan([text(privateValue)]), { allowsText: () => false }))
  assert.throws(() => validateAgentMediaRelayPlan(good(), { allowsText: 'not-a-policy' }))
})

test('the resource budget counts distinct IDs once and includes thumbnails at the exact sixteen GiB limit', () => {
  const videos = Array.from({ length: 32 }, (_, index) => video(artifact(index + 1, 'video')))
  assert.equal(validateAgentMediaRelayPlan(plan(videos)).items[0].parts.length, 32)
  assert.throws(() => validateAgentMediaRelayPlan(plan([...videos, image(artifact(33, 'image', { sizeBytes: 1 }))])))
  const withThumbnail = structuredClone(videos)
  withThumbnail[0].thumbnail = artifact(33, 'image', { sizeBytes: 1 })
  assert.throws(() => validateAgentMediaRelayPlan(plan(withThumbnail)))
  const duplicate = artifact(1, 'video')
  const repeated = { version: 1, items: Array.from({ length: 4 }, () => ({ parts: Array.from({ length: 128 }, () => video(duplicate)) })) }
  assert.equal(validateAgentMediaRelayPlan(repeated).items.length, 4, 'repeated descriptors retain ordering without charging the same bytes 512 times')
  assert.throws(() => validateAgentMediaRelayPlan(plan([...videos, video(artifact(33, 'video'))])))
})

test('a reused artifact ID cannot change its kind, MIME, declared bytes or digest anywhere in the plan', () => {
  for (const changed of [
    { mime: 'image/jpeg' }, { sizeBytes: 1 }, { sha256: 'b'.repeat(64) },
  ]) assert.throws(() => validateAgentMediaRelayPlan(plan([image(artifact()), image(artifact(1, 'image', changed))])))
  assert.throws(() => validateAgentMediaRelayPlan(plan([image(artifact()), video(artifact(1, 'video'))])))
  assert.throws(() => validateAgentMediaRelayPlan(plan([image(artifact()), video(artifact(2, 'video'), artifact(1, 'image', { sha256: 'b'.repeat(64) }))])))
  const source = plan([image(artifact()), video(artifact(2, 'video'), artifact())])
  assert.deepEqual(validateAgentMediaRelayPlan(source), source)
})
