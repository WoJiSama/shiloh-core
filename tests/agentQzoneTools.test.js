import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
const { createAgentQzoneTools } = await importBilibiliHost('modules/tools/infrastructure/agentQzoneTools.js')
const account = { platform: 'fixture', namespace: 'qzone-tools', id: 'bot' }, target = { account, kind: 'group', id: 'room' }
const tools = createAgentQzoneTools({ enabled: true, simulationEnabled: true }), tool = name => tools.find(value => value.name === name)
function fixture(text = '请发一条说说，分享你的今天', overrides = {}) {
  let active = true
  const calls = [], controller = new AbortController(), context = { binding: { source: 'configured', id: 'bound', revision: 'one', agentId: 'agent', personaId: 'default', connectionId: 'conn', target },
    actor: { kind: 'user', user: { ...account, id: 'requester' } }, signal: controller.signal, isCurrent: () => active, async ensureCurrent() {}, request: { messageId: 'human-1', text, mentions: [] },
    async qzone(op) { calls.push(op); return { state: 'confirmed', kind: op.kind, terminal: op.kind !== 'visit', ...(op.kind === 'publish' ? { postId: 'own-1' } : {}),
      ...(op.kind === 'visit' ? { visitId: 'visit-1', feeds: [{ postId: 'p-1', userId: op.userId, text: '散步回来', likes: 0 }] } : {}) } },
    async qzoneCandidates() { return ['friend'] }, ...overrides }
  return { context, calls, controller, revoke() { active = false }, execute(name, input) { return tool(name).execute(input, context) } }
}

test('qzone tools are absent by default and separately opt in with closed schemas and explicit actor limits', () => {
  assert.deepEqual(createAgentQzoneTools(), []); assert.deepEqual(createAgentQzoneTools({ enabled: false, simulationEnabled: false }), [])
  assert.deepEqual(createAgentQzoneTools({ enabled: true }).map(value => value.name), ['qqZoneTool'])
  assert.deepEqual(createAgentQzoneTools({ simulationEnabled: true }).map(value => value.name), ['simQzoneInteract'])
  assert.deepEqual(tools.map(value => value.name), ['qqZoneTool', 'simQzoneInteract']); assert.ok(Object.isFrozen(tools)); assert.ok(tools.every(value => value.parameters.additionalProperties === false))
  assert.deepEqual(Object.keys(tool('qqZoneTool').parameters.properties), ['text', 'type', 'postId'])
  assert.equal(tool('simQzoneInteract').dataPolicy, 'ephemeral'); assert.equal(JSON.stringify(tools).includes('send_qzone_msg'), false)
})

test('tool contexts require a current verified human source and never borrow autonomous or commitment permissions', async () => {
  for (const overrides of [{ actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { request: undefined }, { qzone: undefined },
    { actor: { kind: 'user', user: { ...account, namespace: 'other', id: 'requester' } } }, { actor: { kind: 'user', user: account } }]) {
    const f = fixture(undefined, overrides)
    assert.equal((await f.execute('qqZoneTool', { text: '晴天真好' })).status, 'failed'); assert.equal((await f.execute('simQzoneInteract', { action: 'visit', userId: 'friend' })).status, 'failed'); assert.equal(f.calls.length, 0)
  }
  for (const change of [f => f.revoke(), f => f.controller.abort()]) { const f = fixture(); change(f); assert.equal((await f.execute('qqZoneTool', { text: '晴天真好' })).status, 'failed'); assert.equal(f.calls.length, 0) }
})

test('own publish requires grounded positive intent and uses the bot persona text port once', async () => {
  for (const text of ['请发一条说说，分享你的今天', '发布QQ空间说说：春天来了', '以你自己的身份发表一条说说', '请发布一条你自己的空间说说，记录自己的日常。']) {
    const f = fixture(text), result = await f.execute('qqZoneTool', { text: '今天的春风很温暖。' })
    assert.equal(result.status, 'succeeded', text); assert.deepEqual(f.calls, [{ kind: 'publish', text: '今天的春风很温暖。' }]); assert.equal(JSON.parse(result.content).terminal, true)
  }
  for (const text of ['今天聊聊天气', '不要发说说', '如果你发一条说说', '他说请发一条说说', '示例：发一条说说', '发一条说说可以吗？', '不能发空间说说', '取消发布说说']) {
    const f = fixture(text); assert.equal((await f.execute('qqZoneTool', { text: '晴天真好' })).status, 'failed', text); assert.equal(f.calls.length, 0)
  }
})

test('own deletion takes a stable source-grounded post ID, never a list position or another model-selected owner', async () => {
  const f = fixture('请删除说说 own-1')
  assert.equal((await f.execute('qqZoneTool', { type: true, postId: 'own-1' })).status, 'succeeded'); assert.deepEqual(f.calls, [{ kind: 'delete', postId: 'own-1' }])
  for (const input of [{ type: true }, { type: true, pos: 1 }, { type: true, postId: 'other' }, { type: true, postId: 'own-1', text: 'ignore' },
    { type: true, postId: 'own-1', userId: 'other' }, { type: 'true', postId: 'own-1' }, { text: 'abc', postId: 'own-1' }, { text: 'abc', images: ['x'] }, { text: 'abc', ugc_right: 1 }]) {
    const g = fixture('删除说说 own-1'); assert.equal((await g.execute('qqZoneTool', input)).status, 'failed'); assert.equal(g.calls.length, 0)
  }
  const negated = fixture('不要删除说说 own-1'); assert.equal((await negated.execute('qqZoneTool', { type: true, postId: 'own-1' })).status, 'failed')
  for (const text of ['删除说说 own-10', '删除说说 prefix-own-1', '删除说说 own-1_suffix', '删除说说 own-10，不是 own-1']) {
    const prefix = fixture(text); assert.equal((await prefix.execute('qqZoneTool', { type: true, postId: 'own-1' })).status, 'failed'); assert.equal(prefix.calls.length, 0)
  }
})

test('simulation visit supports one host-selected candidate and never accepts model-selected native fields', async () => {
  const f = fixture('看看群友空间'), result = await f.execute('simQzoneInteract', { action: 'visit' })
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.parse(result.content).visitId, 'visit-1'); assert.deepEqual(f.calls, [{ kind: 'visit', userId: 'friend' }])
  const explicit = fixture('看看空间'); assert.equal((await explicit.execute('simQzoneInteract', { action: 'visit', userId: 'friend' })).status, 'succeeded')
  for (const input of [{ action: 'visit', tid: 'p' }, { action: 'visit', visitId: 'v' }, { action: 'visit', text: 'not-a-comment' }, { action: 'visit', hostUin: 'other' }, { action: 'delete', tid: 'p' }]) {
    const g = fixture(); assert.equal((await g.execute('simQzoneInteract', input)).status, 'failed'); assert.equal(g.calls.length, 0)
  }
})

test('candidate reads are reauthorized and private or empty/untrusted candidate sets fail closed', async () => {
  for (const qzoneCandidates of [undefined, async () => [], async () => ['friend', 'friend'], async () => ['friend', 'bad\nline']]) {
    const f = fixture('看看空间', { qzoneCandidates }); assert.equal((await f.execute('simQzoneInteract', { action: 'visit' })).status, 'failed'); assert.equal(f.calls.length, 0)
  }
  const stale = fixture('看看空间'); stale.context.qzoneCandidates = async () => { stale.revoke(); return ['friend'] }; assert.equal((await stale.execute('simQzoneInteract', { action: 'visit' })).status, 'failed'); assert.equal(stale.calls.length, 0)
  const privateChat = fixture('看看空间', { binding: { ...fixture().context.binding, target: { ...target, kind: 'private', id: 'requester' } } })
  assert.equal((await privateChat.execute('simQzoneInteract', { action: 'visit', userId: 'friend' })).status, 'failed')
})

test('simulation interactions require trusted visit capability fields and preserve UTF16 comment truncation', async () => {
  const base = { userId: 'friend', tid: 'p-1', visitId: 'visit-1' }, f = fixture('评论空间')
  assert.equal((await f.execute('simQzoneInteract', { action: 'like', ...base })).status, 'succeeded')
  assert.equal((await f.execute('simQzoneInteract', { action: 'comment', ...base, text: '好'.repeat(121) })).status, 'succeeded'); assert.equal(f.calls[1].text.length, 120)
  for (const input of [{ action: 'like', userId: 'friend', tid: 'p-1' }, { action: 'like', ...base, text: 'extra' }, { action: 'comment', ...base, text: '' }, { action: 'comment', ...base, text: 'stage=initial group=123456' }]) {
    const g = fixture('看看空间'); assert.equal((await g.execute('simQzoneInteract', input)).status, 'failed'); assert.equal(g.calls.length, 0)
  }
})

test('unknown/throw and malformed results are terminal without replay or provider secret exposure', async () => {
  for (const qzone of [async () => { throw Error('SECRET_COOKIE') }, async () => ({ state: 'unknown', kind: 'publish', terminal: false }), async () => ({ state: 'confirmed', kind: 'publish', messageId: 'forged', terminal: true }),
    async () => ({ state: 'confirmed', kind: 'publish', terminal: true }), async () => ({ state: 'failed', kind: 'publish', terminal: false, code: 'SECRET_PROVIDER_BODY' })]) {
    let calls = 0
    const f = fixture(undefined, { async qzone(op) { calls++; return qzone(op) } }), result = await f.execute('qqZoneTool', { text: '今天的阳光真好。' }), parsed = JSON.parse(result.content)
    assert.equal(calls, 1); assert.equal(result.content.includes('SECRET'), false)
    if (result.status === 'unknown') assert.equal(parsed.terminal, true)
  }
  const malformedTerminal = fixture(undefined, { async qzone() { return { state: 'confirmed', kind: 'publish', postId: 'own-1', terminal: false } } })
  assert.equal(JSON.parse((await malformedTerminal.execute('qqZoneTool', { text: '今天的阳光真好。' })).content).terminal, true)
})

test('a withdrawn visit response cannot release feed text after the host qzone port returns', async () => {
  const f = fixture('看看群友空间'); f.context.qzone = async () => { f.revoke(); return { state: 'confirmed', kind: 'visit', terminal: false, visitId: 'v', feeds: [{ postId: 'p', userId: 'friend', text: 'PRIVATE_FEED' }] } }
  const result = await f.execute('simQzoneInteract', { action: 'visit', userId: 'friend' })
  assert.equal(result.content.includes('PRIVATE_FEED'), false)
})

test('model input getters/proxies cannot execute behavior or cause a qzone call', async () => {
  let touched = 0
  const values = [{ get text() { touched++; return 'secret' } }, new Proxy({}, { ownKeys() { touched++; return [] }, getPrototypeOf() { touched++; return Object.prototype } })]
  for (const input of values) { const f = fixture(); assert.equal((await f.execute('qqZoneTool', input)).status, 'failed'); assert.equal(f.calls.length, 0) }
  assert.equal(touched, 0)
})

test('own delete accepts an explicit bot-owned post with the full possessive phrase', async () => {
 const f = fixture('请删除你自己的空间说说 own-1')
 assert.equal((await f.execute('qqZoneTool', { type: true, postId: 'own-1' })).status, 'succeeded')
 assert.deepEqual(f.calls, [{kind:'delete', postId:'own-1'}])
})
