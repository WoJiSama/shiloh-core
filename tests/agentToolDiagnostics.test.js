import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { createAgentDiagnostics } from '../dist/backend/modules/runtime/infrastructure/agentDiagnostics.js'
const definition = execute => ({ name: 'diagnosticTool', description: 'Diagnostics fixture',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, execute })
function fixture(execute, overrides = {}) {
  const events = [], lines = []
  const diagnostics = createAgentDiagnostics({ sink: { async append(event) { events.push(event); return true } },
    logger: { info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) } })
  const tools = createAgentTools({ builtIn: [definition(execute)] }, { signal: new AbortController().signal,
    diagnostics, context: () => ({ actor: { kind: 'user' }, isCurrent: () => true }), ...overrides })
  return { tool: tools.getExtraTools(['diagnosticTool'])[0], events, lines, diagnostics }
}
test('HostTool emits start and safe terminal classifications for success, failed and unknown returned outcomes', async () => {
  for (const status of ['succeeded', 'failed', 'unknown']) {
    const f = fixture(async () => ({ status, content: 'private-result-with-key' }))
    const result = await f.tool.execute({ query: 'private-tool-params' }, {})
    await f.diagnostics.flush()
    assert.equal(result.status, status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'unknown')
    assert.ok(f.events.some(row => row.outcome === 'started'))
    assert.ok(f.events.some(row => row.outcome === status && row.code === (status === 'succeeded' ? 'completed' : `returned_${status}`)))
    assert.doesNotMatch(JSON.stringify([f.events, f.lines]), /private-tool-params|private-result-with-key/)
  }
})
test('HostTool swallowed exceptions and AbstractTool validation failures remain observable without exception text or parameters', async () => {
  const thrown = fixture(async () => { throw Error('https://private.invalid?token=secret') })
  assert.equal((await thrown.tool.execute({ query: 'private-params' }, {})).status, 'unknown'); await thrown.diagnostics.flush()
  assert.ok(thrown.events.some(row => row.code === 'tool_threw' && row.errorKind === 'Error'))
  assert.doesNotMatch(JSON.stringify([thrown.events, thrown.lines]), /private.invalid|secret|private-params/)
  let invoked = false
  const validation = fixture(async () => { invoked = true; return { status: 'succeeded', content: '' } })
  assert.match(await validation.tool.execute({}, {}), /^error:/); await validation.diagnostics.flush()
  assert.equal(invoked, false); assert.ok(validation.events.some(row => row.code === 'returned_failed'))
})
test('diagnostic observers cannot interrupt tool success or its existing outcome semantics', async () => {
  const f = fixture(async () => ({ status: 'succeeded', content: 'ok' }), { diagnostics: { emit() { throw Error('observer unavailable') }, traceId() { throw Error('observer unavailable') } } })
  assert.equal((await f.tool.execute({ query: 'query' }, {})).status, 'success')
})
