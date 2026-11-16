import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

test('Excel is explicitly enabled with a closed boolean boundary and no additional model credentials', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-excel-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = excel => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'excel-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(excel === undefined ? {} : { tools: { excel } }) }))
    return readStandaloneAgentConfig(file, { TEST_MAIN_KEY: 'main-key' })
  }
  assert.deepEqual(read().tools, {})
  assert.deepEqual(read({ enabled: false }).tools, {})
  assert.deepEqual(read({ enabled: true }).tools.excel, { enabled: true })
  for (const input of [null, false, [], {}, { enabled: 1 }, { enabled: true, url: 'https://arbitrary.example' }, { enabled: true, path: '/private' }]) assert.throws(() => read(input))
})
