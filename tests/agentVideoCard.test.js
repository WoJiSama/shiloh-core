import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { validateAgentVideoCard } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentVideoCard.js')).href)
const card = (overrides = {}) => ({ provider: 'bilibili', id: 'BV1xx411c7mD', title: '公开视频', author: '作者', durationSeconds: 60,
  pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', ...overrides })

test('public video card validation owns an immutable snapshot and supports canonical episodes', () => {
  const input = card(), validated = validateAgentVideoCard(input)
  assert.deepEqual(validated, input); assert.notEqual(validated, input); assert.equal(Object.isFrozen(validated), true)
  input.title = 'later mutation'; assert.equal(validated.title, '公开视频')
  const episode = card({ id: 'ep123456', pageUrl: 'https://www.bilibili.com/bangumi/play/ep123456', author: '', durationSeconds: 1.25 })
  let observed
  assert.deepEqual(validateAgentVideoCard(episode, text => { observed = text; return true }), episode)
  assert.equal(observed, [episode.id, episode.title, episode.pageUrl].join('\n'))
  assert.deepEqual(validateAgentVideoCard(Object.assign(Object.create(null), episode)), episode)
})
test('closed fields reject extras, missing properties, arrays and exotic prototypes', () => {
  const missing = card(); delete missing.author
  const nonenumerableExtra = card(); Object.defineProperty(nonenumerableExtra, 'native', { value: 'private' })
  for (const value of [null, undefined, [], 'text', missing, { ...card(), native: 'private' }, { ...card(), thumbnail: 'https://private.invalid' },
    { ...card(), [Symbol('private')]: 'secret' }, nonenumerableExtra, Object.assign(Object.create({ inherited: true }), card()), new Date()]) {
    assert.throws(() => validateAgentVideoCard(value), /视频卡片内容或来源无效/u)
  }
})
test('proxies and property accessors are rejected without executing any supplied code', () => {
  let touched = 0
  const malicious = new Proxy(card(), { get() { touched++; throw Error('should never execute') }, getPrototypeOf() { touched++; throw Error('should never execute') }, ownKeys() { touched++; throw Error('should never execute') } })
  const revoked = Proxy.revocable(card(), {}); revoked.revoke()
  for (const key of Object.keys(card())) {
    const input = card(); Object.defineProperty(input, key, { get() { touched++; throw Error('should never execute') } })
    assert.throws(() => validateAgentVideoCard(input), /视频卡片内容或来源无效/u)
  }
  for (const value of [malicious, revoked.proxy]) assert.throws(() => validateAgentVideoCard(value), /视频卡片内容或来源无效/u)
  assert.equal(touched, 0)
})
test('card identity and public page URL must match exactly without credentials, queries or fragments', () => {
  for (const override of [{ provider: 'youtube' }, { id: 'BV123' }, { id: 'ep0' }, { id: 'ep0123' }, { id: 'ep' + '1'.repeat(21) },
    { pageUrl: 'http://www.bilibili.com/video/BV1xx411c7mD' }, { pageUrl: card().pageUrl + '/' }, { pageUrl: card().pageUrl + '?token=private' },
    { pageUrl: card().pageUrl + '#private' }, { pageUrl: 'https://user:secret@www.bilibili.com/video/BV1xx411c7mD' },
    { pageUrl: 'https://b23.tv/private' }, { pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mE' },
    { id: 'ep123', pageUrl: card().pageUrl }]) assert.throws(() => validateAgentVideoCard(card(override)))
})
test('duration accepts finite bounded fractional seconds and rejects coercion', () => {
  for (const durationSeconds of [0, 1.25, 31_536_000]) assert.equal(validateAgentVideoCard(card({ durationSeconds })).durationSeconds, durationSeconds)
  for (const durationSeconds of [-1, NaN, Infinity, -Infinity, 31_536_000.01, '60', null, {}, undefined]) assert.throws(() => validateAgentVideoCard(card({ durationSeconds })))
})
test('title and author bounds count Unicode code points and reject unpaired UTF16 surrogates', () => {
  const valid = card({ title: '😀'.repeat(300), author: '😀'.repeat(120) })
  assert.deepEqual(validateAgentVideoCard(valid), valid)
  for (const override of [{ title: '😀'.repeat(301) }, { author: '😀'.repeat(121) }, { title: '' }, { title: '   ' },
    { title: '\ud800' }, { title: '\udc00' }, { title: '\ud800x' }, { title: 'x\udc00' }, { author: '\ud800' }, { author: '\udc00' }]) assert.throws(() => validateAgentVideoCard(card(override)))
  assert.equal(validateAgentVideoCard(card({ author: '' })).author, '')
})
test('display fields reject controls and content changed by the final reply policy', () => {
  for (const text of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
    ' padded', 'padded ', '[CQ:at,qq=123456]', '<tool_call>private</tool_call>', '{"query":"private","id":"123"}']) {
    assert.throws(() => validateAgentVideoCard(card({ title: text })))
    assert.throws(() => validateAgentVideoCard(card({ author: text })))
  }
})
test('safe callback sees the complete metadata projection and can reject cross-field sensitive text', () => {
  let calls = 0, projection
  const input = card()
  assert.deepEqual(validateAgentVideoCard(input, text => { calls++; projection = text; return true }), input)
  assert.equal(calls, 1); assert.equal(projection, [input.id, input.title, input.author, input.pageUrl].join('\n'))
  assert.throws(() => validateAgentVideoCard(input, text => !text.includes(input.author)))
  assert.throws(() => validateAgentVideoCard(input, () => { throw Error('policy unavailable') }))
  calls = 0; assert.throws(() => validateAgentVideoCard(card({ pageUrl: 'https://private.invalid' }), () => { calls++; return true })); assert.equal(calls, 0)
})
