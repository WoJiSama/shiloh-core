import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

const definition = (name, execute) => ({ name, description: 'Dynamic host fixture',
  parameters: { type: 'object', properties: {}, required: [] }, execute })
const success = content => ({ status: 'succeeded', content })
function fixture() {
  let custom = []
  const parent = new AbortController()
  const registry = { get custom() { return custom } }
  const account = { platform: 'qq', namespace: 'fixture', id: '1' }
  const tools = createAgentTools(registry, { signal: parent.signal,
    context: () => ({
      binding: { target: { account, kind: 'group', id: '2' } },
      actor: { kind: 'user', user: { ...account, id: '3' } },
      request: { messageId: 'request-1', text: 'run the fixture tool', mentions: [] },
      isCurrent: () => true,
    }),
  })
  return { tools, set(definitions) { custom = definitions } }
}

test('live custom registry getters publish added tools, revoke old wrappers and preserve explicit custom origin', async () => {
  const f = fixture()
  assert.deepEqual(f.tools.listRegistryToolNames(), { builtIn: [], all: [] })
  let calls = 0
  f.set([definition('mcp_fixture_probe', async () => { calls++; return success('original') })])
  const [old] = f.tools.getExtraTools(['mcp_fixture_probe'])
  assert.equal(f.tools.isExtraToolAutonomous(old.name), false)
  assert.equal((await old.execute({}, {})).content, 'original')
  f.set([definition('mcp_fixture_probe', async () => success('replacement'))])
  assert.equal((await old.execute({}, {})).status, 'error')
  const [replacement] = f.tools.getExtraTools(['mcp_fixture_probe'])
  assert.notEqual(old, replacement)
  assert.equal((await replacement.execute({}, {})).content, 'replacement')
  f.set([])
  assert.deepEqual(f.tools.getExtraTools(['mcp_fixture_probe']), [])
  assert.equal((await replacement.execute({}, {})).status, 'error')
  assert.equal(calls, 1)
})

test('removing a dynamic definition aborts its running wrapper and discards a late result', async () => {
  const f = fixture()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let callSignal
  f.set([definition('mcp_fixture_pending', async (_input, context) => {
    callSignal = context.signal
    entered.resolve()
    return release.promise
  })])
  const [tool] = f.tools.getExtraTools(['mcp_fixture_pending'])
  const pending = tool.execute({}, {})
  await Promise.race([entered.promise, pending.then(() => assert.fail('tool exited before entering the provider'))])
  f.set([])
  const result = await pending
  assert.equal(result.status, 'unknown')
  assert.equal(callSignal.aborted, true)
  release.resolve(success('late private result'))
  await delay(10)
  assert.ok(!JSON.stringify(result).includes('late private result'))
})
