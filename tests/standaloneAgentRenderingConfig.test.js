import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rendering-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const mindMap = { baseUrl: 'https://map.example/v1', name: 'map-model', apiKeyEnv: 'TEST_MAP_KEY' }
  const read = (rendering, env = { TEST_MAIN_KEY: 'main-key', TEST_MAP_KEY: 'map-key' }, options) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'rendering-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(rendering === undefined ? {} : { tools: { rendering } }) }))
    return readStandaloneAgentConfig(file, env, options)
  }
  return { read, mindMap }
}
test('rendering defaults off, local text needs no model and mind map resolves its own explicit key', t => {
  const { read, mindMap } = fixture(t)
  assert.deepEqual(read().tools, {})
  assert.deepEqual(read({}).tools, {})
  assert.deepEqual(read({ textImage: { enabled: false } }).tools, {})
  assert.deepEqual(read({ textImage: { enabled: true } }, { TEST_MAIN_KEY: 'main-key' }).tools.rendering, { textImage: { enabled: true } })
  assert.deepEqual(read({ mindMap }).tools.rendering, { mindMap: { baseUrl: mindMap.baseUrl, name: mindMap.name, apiKey: 'map-key' } })
  assert.throws(() => read({ mindMap }, { TEST_MAIN_KEY: 'main-key' }), /TEST_MAP_KEY/u)
  assert.equal(read({ mindMap }, {}, { requireCredentials: false }).tools.rendering.mindMap.apiKey, '')
})
test('rendering rejects raw credentials, unknown fields, implicit models and invalid endpoints', t => {
  const { read, mindMap } = fixture(t)
  for (const input of [null, false, [], { enabled: true }, { textImage: true }, { textImage: {} }, { textImage: { enabled: 1 } }, { textImage: { enabled: false, template: 'document' } },
    { mindMap: true }, { mindMap: {} }, { mindMap: { ...mindMap, apiKey: 'raw-private-key' } }, { mindMap: { ...mindMap, enabled: true } },
    { mindMap: { ...mindMap, apiKeyEnv: 'bad-name' } }, { mindMap: { ...mindMap, name: 'x'.repeat(201) } },
    ...['file:///tmp/model', 'https://user:pass@map.example/v1', 'https://map.example/v1?key=secret', 'https://map.example/v1#fragment', ' https://map.example/v1'].map(baseUrl => ({ mindMap: { ...mindMap, baseUrl } })),
  ]) assert.throws(() => read(input), error => !error.message.includes('raw-private-key'))
})
