import assert from 'node:assert/strict'
import test from 'node:test'
import { createQqMessageActionPort } from '../dist/backend/adapters/qqMessageDelivery.js'
import { queuedDeliveryAllowed } from '../dist/backend/modules/messaging/infrastructure/deliveryScope.js'
import { validateMessageBundle } from '../dist/backend/modules/messaging/infrastructure/messageBundle.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const binding = { id: 'bundle-binding', source: 'configured', revision: 'v1', personaId: 'default', agentId: 'agent',
  connectionId: 'local', target }
const png = { kind: 'image', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
const item = text => ({ parts: [{ kind: 'text', text }] })
const action = (items = [item('一个结果')], conversation = target) => ({ version: 1, kind: 'message.bundle.send', target: conversation, items })
const paddedPng = length => {
  const bytes = Buffer.alloc(length)
  Buffer.from(png.base64, 'base64').copy(bytes)
  return { ...png, base64: bytes.toString('base64') }
}

test('message bundles preserve text and inline bytes in a detached, immutable snapshot', () => {
  const items = [{ parts: [{ kind: 'text', text: '  项目标题\n链接  ' }, { ...png }] }]
  const snapshot = validateMessageBundle(items)
  assert.deepEqual(snapshot, items)
  assert.notEqual(snapshot, items)
  assert.notEqual(snapshot[0], items[0])
  assert.notEqual(snapshot[0].parts, items[0].parts)
  assert.notEqual(snapshot[0].parts[0], items[0].parts[0])
  assert.notEqual(snapshot[0].parts[1], items[0].parts[1])
  items[0].parts[0].text = '后来修改的标题'
  items[0].parts[1].base64 = 'https://example.test/remote.png'
  items[0].parts.push({ kind: 'text', text: '后来新增的内容' })
  items.push(item('后来新增的节点'))
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].parts.length, 2)
  assert.equal(snapshot[0].parts[0].text, '  项目标题\n链接  ')
  assert.equal(snapshot[0].parts[1].base64, png.base64)
  for (const value of [snapshot, snapshot[0], snapshot[0].parts, ...snapshot[0].parts]) assert.equal(Object.isFrozen(value), true)
})

test('message bundles close item and part structures and enforce text/node limits', () => {
  const customIterator = [item('不能借迭代器越过节点上限')]
  customIterator[Symbol.iterator] = function* () { yield* Array.from({ length: 13 }, () => item('x')) }
  const accessor = [item('unused')]
  Object.defineProperty(accessor, '0', { get() { assert.fail('array accessors must not execute') } })
  const invalid = [null, {}, [], Array.from({ length: 13 }, () => item('x')), [{ parts: [] }],
    [{ parts: Array.from({ length: 5 }, () => ({ kind: 'text', text: 'x' })) }], [item('')], [item(' \n\t')],
    [item('x'.repeat(4_001))], Array.from({ length: 9 }, () => item('x'.repeat(4_000))),
    [{ ...item('x'), sender: '99999' }], [{ ...item('x'), target: 'another-group' }],
    [{ parts: [{ kind: 'text', text: 'x', mime: 'image/png' }] }],
    [{ parts: [{ kind: 'mention', user: 'everyone' }] }], [{ parts: [{ kind: 'forward', id: 'forward-id' }] }],
    [{ parts: [{ kind: 'image', mime: png.mime, base64: png.base64, sender: '99999' }] }],
    [Object.create({ parts: [{ kind: 'text', text: 'inherited' }] })],
    [{ get parts() { assert.fail('untrusted accessors must not execute') } }],
    [{ parts: [{ kind: 'text', get text() { assert.fail('untrusted accessors must not execute') } }] }],
    customIterator, accessor, [item('x'), ,],
  ]
  for (const [index, items] of invalid.entries()) assert.throws(() => validateMessageBundle(items), `invalid bundle case ${index}`)
  assert.equal(validateMessageBundle(Array.from({ length: 12 }, () => item('x'))).length, 12)
  assert.equal(validateMessageBundle([{ parts: Array.from({ length: 4 }, () => ({ kind: 'text', text: 'x' })) }])[0].parts.length, 4)
  assert.doesNotThrow(() => validateMessageBundle(Array.from({ length: 8 }, () => item('x'.repeat(4_000)))))
})

test('bundle images require validated inline bytes and cap each image and the whole payload', () => {
  const badCanvas = Buffer.from(png.base64, 'base64')
  badCanvas.writeUInt32BE(16_385, 16)
  for (const image of [
    { ...png, base64: 'https://example.test/image.png' }, { ...png, base64: '/tmp/image.png' },
    { ...png, base64: `base64://${png.base64}` }, { ...png, base64: `data:image/png;base64,${png.base64}` },
    { ...png, base64: png.base64 + '\n' }, { ...png, base64: 'AB==' }, { ...png, mime: 'image/jpeg' },
    { ...png, base64: badCanvas.toString('base64') }, { ...png, resource: { kind: 'url', value: 'https://example.test/image.png' } },
    paddedPng(2 * 1024 * 1024 + 1),
  ]) assert.throws(() => validateMessageBundle([{ parts: [image] }]))
  const image = paddedPng(2 * 1024 * 1024)
  assert.doesNotThrow(() => validateMessageBundle(Array.from({ length: 6 }, () => ({ parts: [image] }))))
  assert.throws(() => validateMessageBundle([...Array.from({ length: 6 }, () => ({ parts: [image] })), { parts: [png] }]))
})

test('QQ encodes one group/private forward API with the original account as every node author', async () => {
  const dispatched = []
  const port = createQqMessageActionPort({ sendApi: async (api, params) => {
    dispatched.push({ api, params })
    return { status: 'ok', retcode: 0, data: { message_id: `bundle-${dispatched.length}` } }
  } })
  const items = [{ parts: [{ kind: 'text', text: '项目标题' }, png] }, item('https://modrinth.com/mod/fixture')]
  for (const [kind, api, key] of [['group', 'send_group_forward_msg', 'group_id'], ['private', 'send_private_forward_msg', 'user_id']]) {
    assert.deepEqual(await port.sendBundle(action(items, { ...target, kind })), { state: 'sent', messageId: `bundle-${dispatched.length}` })
    const request = dispatched.at(-1)
    assert.equal(request.api, api)
    assert.deepEqual(request.params, { [key]: Number(target.id), messages: [
      { type: 'node', data: { name: 'Agent', uin: account.id, content: [
        { type: 'text', data: { text: '项目标题' } }, { type: 'image', data: { file: `base64://${png.base64}` } },
      ] } },
      { type: 'node', data: { name: 'Agent', uin: account.id, content: [{ type: 'text', data: { text: 'https://modrinth.com/mod/fixture' } }] } },
    ] })
  }
  assert.equal(dispatched.length, 2)
})

test('QQ rejects invalid bundles, crossed bindings and revoked sends before API dispatch', async () => {
  let dispatched = 0
  const port = createQqMessageActionPort({ sendApi: async () => { dispatched++; return { message_id: 1 } } })
  const invalidActions = [
    { ...action(), version: 2 }, { ...action(), kind: 'message.send' },
    action(undefined, { ...target, account: { ...account, namespace: 'another' } }),
    action(undefined, { ...target, account: { ...account, id: `0${account.id}` } }),
    action(undefined, { ...target, kind: 'channel' }),
    { ...action(), binding: { ...binding, target: { ...target, id: '99999' } } },
    action([{ ...item('x'), user_id: '99999' }]),
  ]
  for (const invalid of invalidActions) assert.equal((await port.sendBundle(invalid)).state, 'failed')
  assert.deepEqual(await port.sendBundle(action(), { isCurrent: () => false }), { state: 'failed', code: 'binding_changed' })
  assert.equal((await port.sendBundle(action(), { isCurrent: () => { throw new Error('revoked') } })).state, 'failed')
  const replyOnly = createQqMessageActionPort({ reply: { target: { ...target, id: '99999' }, send: async () => { dispatched++ } } })
  assert.equal((await replyOnly.sendBundle(action())).state, 'failed')
  assert.equal(dispatched, 0)
})

test('QQ bundle payload snapshots survive caller mutation while queued and carry the captured guard', async () => {
  let current = true, release, reached
  const queued = new Promise(resolve => { reached = resolve })
  const paused = new Promise(resolve => { release = resolve })
  let dispatched = 0
  const items = [item('发送前的内容')]
  const port = createQqMessageActionPort({ sendApi: async (_api, params) => {
    reached()
    await paused
    assert.equal(params.messages[0].data.content[0].data.text, '发送前的内容')
    if (!queuedDeliveryAllowed()) return { state: 'failed', code: 'binding_changed' }
    dispatched++
    return { message_id: 1 }
  } })
  const sent = port.sendBundle(action(items), { isCurrent: () => current })
  await queued
  items[0].parts[0].text = '不得进入等待中的发送'
  items.push(item('不得追加的节点'))
  current = false
  release()
  assert.deepEqual(await sent, { state: 'failed', code: 'binding_changed' })
  assert.equal(dispatched, 0)
})

test('native QQ bundle delivery resolves only the explicit account and fails unsupported capabilities', async () => {
  let defaultSends = 0, exactSends = 0
  const other = { uin: '99999', async sendApi() { defaultSends++; return { message_id: 'wrong' } } }
  const exact = { uin: account.id, async sendApi(api, params) {
    assert.equal(this, exact)
    assert.equal(api, 'send_group_forward_msg')
    assert.equal(params.messages[0].data.uin, account.id)
    exactSends++
    return { message_id: 'exact-account' }
  } }
  assert.equal((await createQqMessageActionPort({ getBotRoot: () => other }).sendBundle(action())).state, 'failed')
  assert.equal((await createQqMessageActionPort({ getBotRoot: () => ({ uin: account.id }) }).sendBundle(action())).state, 'failed')
  const port = createQqMessageActionPort({ getBotRoot: () => ({ ...other, bots: { [account.id]: exact } }) })
  assert.deepEqual(await port.sendBundle(action()), { state: 'sent', messageId: 'exact-account' })
  assert.equal(defaultSends, 0)
  assert.equal(exactSends, 1)
})

test('QQ bundle receipts require a real message_id and never split or retry an uncertain result', async () => {
  for (const [raw, expected] of [
    [{ status: 'failed', retcode: 1, data: { message_id: 'not-success' } }, { state: 'unknown' }],
    [{ status: 'ok', retcode: 0, data: { res_id: 'resource-only' } }, { state: 'unknown' }],
    [{ status: 'ok', retcode: 0, data: { message_id: 0 } }, { state: 'unknown' }],
    [{ status: 'ok', retcode: 0, data: { message_id: 17 } }, { state: 'sent', messageId: '17' }],
    [new Error('transport disconnected after write'), { state: 'unknown' }],
  ]) {
    let dispatched = 0
    const port = createQqMessageActionPort({ sendApi: async () => { dispatched++; if (raw instanceof Error) throw raw; return raw } })
    assert.deepEqual(await port.sendBundle(action([item('first'), item('second')])), expected)
    assert.equal(dispatched, 1)
  }
})
