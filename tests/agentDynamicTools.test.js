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
  const tools = createAgentTools(registry, { signal: parent.signal,
    context: () => ({ actor: { kind: 'user' }, isCurrent: () => true }),
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
  assert.equal((await old.func({}, {})).content, 'original')
  f.set([definition('mcp_fixture_probe', async () => success('replacement'))])
  assert.equal((await old.func({}, {})).status, 'error')
  const [replacement] = f.tools.getExtraTools(['mcp_fixture_probe'])
  assert.notEqual(old, replacement)
  assert.equal((await replacement.func({}, {})).content, 'replacement')
  f.set([])
  assert.deepEqual(f.tools.getExtraTools(['mcp_fixture_probe']), [])
  assert.equal((await replacement.func({}, {})).status, 'error')
  assert.equal(calls, 1)
})

test('removing a dynamic definition aborts its running wrapper and discards a late result', async () => {
  const f = fixture()
  let release, callSignal
  f.set([definition('mcp_fixture_pending', async (_input, context) => {
    callSignal = context.signal
    return await new Promise(resolve => { release = resolve })
  })])
  const [tool] = f.tools.getExtraTools(['mcp_fixture_pending'])
  const pending = tool.func({}, {})
  while (!release) await delay(5)
  f.set([])
  const result = await pending
  assert.equal(result.status, 'unknown')
  assert.equal(callSignal.aborted, true)
  release(success('late private result'))
  await delay(10)
  assert.ok(!JSON.stringify(result).includes('late private result'))
})
