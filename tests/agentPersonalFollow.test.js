import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readPersonalFollowFeed } from '../dist/backend/modules/simulation/infrastructure/agentPersonalFollow.js'
import { createAgentPersonalRuntime } from '../dist/backend/modules/simulation/infrastructure/agentPersonalRuntime.js'

const hour = 3600_000
const seed = { id: 'shiloh', name: '希洛', identity: '我喜欢了解游戏更新。' }
const repo = 'https://github.com/example/game'
const steam = 'https://store.steampowered.com/app/1086940/'
const steamNews = 'https://store.steampowered.com/news/app/1086940/view/'
const response = value => ({ model: 'fixture', choices: [{ message: { content: JSON.stringify(value) } }] })
const release = (name, url = `${repo}/releases/tag/${name}`) => ({
  id: createHash('sha256').update(name).digest('hex'), url, title: name, summary: `版本说明 ${name}`, receivedAt: 1800000000000,
})

test('official Steam and GitHub feeds use only the locked project endpoint and same-project source links', async () => {
  const lookedUp = [], requests = []
  const lookup = async hostname => { lookedUp.push(hostname); return [{ address: '8.8.8.8', family: 4 }] }
  const dependencies = { lookup, async request(url) {
    requests.push(url.href)
    if (url.hostname === 'api.github.com') return { status: 200, body: JSON.stringify([
      { id: 1, name: '当前发布', html_url: `${repo}/releases/tag/v1` },
      { id: 2, name: '另一个仓库', html_url: 'https://github.com/example/other/releases/tag/v1' },
    ]) }
    return { status: 200, body: `<rss version="2.0"><channel><item><guid>1</guid><title>更新公告</title><link>${steamNews}192</link></item>` +
      `<item><guid>2</guid><title>另一个游戏</title><link>https://store.steampowered.com/news/app/999/view/193</link></item></channel></rss>` }
  } }
  assert.deepEqual((await readPersonalFollowFeed('https://github.com/Example/Game/releases', () => true, dependencies))
    .map(item => item.url), [`${repo}/releases/tag/v1`])
  assert.deepEqual((await readPersonalFollowFeed(steam + 'Baldurs_Gate_3/', () => true, dependencies))
    .map(item => item.url), [`${steamNews}192`])
  assert.deepEqual(requests, ['https://api.github.com/repos/example/game/releases?per_page=16',
    'https://store.steampowered.com/feeds/news/app/1086940/'])
  assert.deepEqual(lookedUp, ['api.github.com', 'store.steampowered.com'])
  for (const url of [repo + '?x=private', repo + '/issues', 'https://user@github.com/example/game',
    steam + '?source=chat', 'https://store.steampowered.com.evil.example/app/1086940/', 'https://example.org/feed.xml']) {
    await assert.rejects(readPersonalFollowFeed(url, () => true, dependencies), /仅支持/)
  }
  lookedUp.length = 0
  await assert.rejects(readPersonalFollowFeed(steam, () => true, { lookup, async request() {
    return { status: 302, body: '', location: 'https://example.org/feed.xml' }
  } }), /地址与公开来源不符/)
  assert.deepEqual(lookedUp, ['store.steampowered.com'])
  await assert.rejects(readPersonalFollowFeed(repo, () => false, dependencies), /已停止/)
  assert.deepEqual(lookedUp, ['store.steampowered.com'])
})

function harness({ model, followFeed, contact }) {
  const values = new Map(), failures = []
  const clock = { now: 1800000000000 }
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' } }
  function create(enabled = true) {
    return createAgentPersonalRuntime({
      redis, seeds: [seed], now: () => clock.now, isCurrent: () => true, allowsText: value => !value.includes('FIXTURE_SECRET'),
      targets: async () => [{ key: 'allowed-group', kind: 'group', label: '测试群' }],
      ...(enabled ? { followFeed } : {}), contact, verifyContact: async () => '870000042',
      failed(stage, _error, code) { failures.push([stage, code]) },
      async model(request) {
        assert.equal(request.tools, undefined)
        const data = JSON.parse(request.messages[1].content)
        return response(Object.hasOwn(data, 'revision') ? { action: 'keep' } : model(data))
      },
    })
  }
  return { clock, failures, create }
}

test('an autonomous follow starts silently, sends one chosen update after a restart, and can end itself', async () => {
  const old = release('v1'), next = release('v2'), sent = [], fetched = [], seenByModel = []
  let batch = [old], stop = false
  const h = harness({
    model(data) {
      if (data.updates) {
        seenByModel.push(data.updates.map(item => item.id))
        return { action: 'share', itemId: next.id, text: '这个游戏发布了 v2，修复了存档。' }
      }
      if (!data.follows.length) return { action: 'follow', url: repo, title: '跟进这个游戏', intervalHours: 1, key: 'allowed-group' }
      return stop ? { action: 'stop-follow', id: data.follows[0].id } : { action: 'rest' }
    },
    async followFeed(url, current) { assert.ok(current()); fetched.push(url); return batch },
    async contact(id, key, body) { sent.push({ id, key, body }); return { state: 'unknown' } },
  })
  let runtime = h.create()
  await runtime.load()
  h.clock.now += 10 * 60_000
  await runtime.tick()
  await runtime.tick()
  const read = () => runtime.workSummary(seed.id, () => true)
  assert.deepEqual(fetched, [repo])
  assert.equal(read().follows[0].lastCheckedAt, h.clock.now)
  assert.equal(read().follows[0].latest, undefined)
  assert.equal(seenByModel.length, 0)
  await runtime.stop()
  runtime = h.create()
  await runtime.load()
  batch = [next, old, release('foreign', 'https://github.com/other/repo/releases/tag/v1'),
    { ...release('secret'), summary: 'FIXTURE_SECRET' }]
  h.clock.now += hour
  await runtime.tick()
  assert.deepEqual(seenByModel, [[next.id]])
  assert.equal(read().follows[0].latest.url, next.url)
  assert.deepEqual(sent, [{ id: seed.id, key: 'allowed-group', body: `这个游戏发布了 v2，修复了存档。\n${next.url}` }])
  assert.equal(read().actions[0].state, 'unknown')
  assert.equal(runtime.workSummary(seed.id, () => false).actions.length, 0)
  await runtime.stop()
  runtime = h.create()
  await runtime.load()
  h.clock.now += hour
  await runtime.tick()
  assert.equal(read().actions[0].state, 'confirmed')
  assert.equal(read().actions[0].followId, read().follows[0].id)
  assert.equal(seenByModel.length, 1)
  const count = fetched.length
  stop = true
  h.clock.now += 4 * hour
  await runtime.tick()
  assert.equal(read().follows[0].state, 'stopped')
  h.clock.now += hour
  await runtime.tick()
  assert.equal(fetched.length, count)
  assert.equal(sent.length, 1)
  assert.deepEqual(h.failures, [])
  await runtime.stop()
})

test('checks back off, reject attempts to change recipients, and preserve a note without a recipient', async () => {
  const next = release('v2'), fetched = [], sent = []
  let forceError = true, forged = true, batch = []
  const h = harness({
    model(data) {
      if (data.updates) return { action: 'share', itemId: next.id, text: '记录 v2 的更新。', ...(forged ? { key: 'allowed-group' } : {}) }
      return data.follows?.length ? { action: 'rest' } : { action: 'follow', url: repo, title: '跟进发布', intervalHours: 1 }
    },
    async followFeed(url) { fetched.push(url); if (forceError) throw new Error('provider'); return batch },
    async contact(...args) { sent.push(args); return { state: 'sent', messageId: 'unexpected' } },
  })
  const runtime = h.create()
  await runtime.load()
  h.clock.now += 10 * 60_000
  await runtime.tick()
  await runtime.tick()
  const read = () => runtime.workSummary(seed.id, () => true).follows[0]
  assert.equal(read().failures, 1)
  assert.equal(read().nextAt, h.clock.now + hour)
  await runtime.tick()
  assert.equal(fetched.length, 1)
  forceError = false
  h.clock.now += hour
  await runtime.tick()
  assert.equal(read().failures, 0)
  batch = [next]
  h.clock.now += hour
  await runtime.tick()
  assert.equal(read().latest, undefined)
  assert.equal(read().failures, 1)
  forged = false
  h.clock.now += hour
  await runtime.tick()
  assert.equal(read().latest.text, '记录 v2 的更新。')
  assert.equal(sent.length, 0)
  assert.deepEqual(h.failures.map(([, code]) => code), ['personal_follow_source_failed', 'personal_follow_decision_failed'])
  await runtime.stop()
  const disabled = h.create(false), count = fetched.length
  await disabled.load()
  h.clock.now += hour
  await disabled.tick()
  assert.equal(fetched.length, count)
  assert.equal(disabled.workSummary(seed.id, () => true).followEnabled, false)
  assert.equal(disabled.workSummary(seed.id, () => true).follows[0].latest.url, next.url)
  await disabled.stop()
})
