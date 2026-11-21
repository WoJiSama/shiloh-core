import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentPersonalRuntime } from '../dist/backend/modules/simulation/infrastructure/agentPersonalRuntime.js'

test('a bad self-profile review has a specific code and retries without replacing the profile', async t => {
  const values = new Map(), failures = []
  let at = 10_000, reviews = 0
  const runtime = createAgentPersonalRuntime({
    redis: {
      async get(key) { return values.get(key) ?? null },
      async set(key, value) { values.set(key, value); return 'OK' },
      async del(key) { return Number(values.delete(key)) },
    },
    now: () => at,
    seeds: [{ id: 'fixture', name: '示例', identity: '初始设定' }],
    isCurrent: () => true,
    async model(request) {
      let content = '{"action":"rest"}'
      if (request.messages[0].content.includes('自主档案修订')) {
        reviews++
        content = reviews === 1 ? 'bad json' : '{"action":"update","introduction":"新介绍","reason":"补充介绍"}'
      }
      return { choices: [{ message: { content } }] }
    },
    async targets() { return [] },
    async contact() { throw new Error('unexpected contact') },
    allowsText: () => true,
    failed(stage, _error, code) { failures.push([stage, code]) },
  })
  t.after(() => runtime.stop())
  await runtime.load()
  const initial = runtime.profile('fixture')
  at += 10 * 60_000
  await runtime.tick()
  assert.deepEqual(runtime.profile('fixture'), initial)
  assert.deepEqual(failures, [['self_profile', 'self_profile_response_invalid']])
  at += 15 * 60_000 - 1
  await runtime.tick()
  assert.equal(reviews, 1)
  at++
  await runtime.tick()
  const updated = runtime.profile('fixture')
  assert.equal(updated.revision, initial.revision + 1)
  assert.equal(updated.introduction, '新介绍')
  assert.equal(updated.identity, initial.identity)
  assert.equal(reviews, 2)
  at += 15 * 60_000
  await runtime.tick()
  assert.equal(reviews, 2)
})
