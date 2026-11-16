import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { validateMusicExtractionConfig } from '../dist/backend/modules/media/domain/musicExtractionConfig.js'

test('music extraction is independently default off and operators require exact complete identities', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-music-extraction-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = musicExtraction => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'extraction-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(musicExtraction === undefined ? {} : { musicExtraction }) }))
    return readStandaloneAgentConfig(file, { MAIN_KEY: 'private-key' })
  }
  assert.deepEqual(read().musicExtraction, { enabled: false, operators: [] })
  assert.deepEqual(read({ enabled: true }).musicExtraction, { enabled: true, operators: [] })
  const operator = { platform: 'qq', namespace: 'global', id: '123456789' }, input = { enabled: true, operators: [operator] }
  const owned = validateMusicExtractionConfig(input)
  operator.id = 'another-user'; input.operators.push({ ...operator })
  assert.equal(owned.operators[0].id, '123456789'); assert.equal(owned.operators.length, 1)
  assert.ok(Object.isFrozen(owned)); assert.ok(Object.isFrozen(owned.operators)); assert.ok(Object.isFrozen(owned.operators[0]))
  assert.deepEqual(read({ enabled: true, operators: [{ platform: 'qq', namespace: 'global', id: '123456789' }] }).musicExtraction, owned)
  for (const value of [null, [], {}, { enabled: 1 }, { enabled: false, endpoint: 'https://example.com' }, { enabled: true, operators: ['123456789'] },
    { enabled: true, operators: [{ id: '123456789' }] }, { enabled: true, operators: [{ platform: 'qq', namespace: 'global', id: '123456789', role: 'master' }] },
    { enabled: true, operators: Array.from({ length: 101 }, (_, id) => ({ platform: 'qq', namespace: 'global', id: String(id) })) },
    { enabled: true, operators: [{ platform: 'qq', namespace: 'global', id: '123456789' }, { platform: 'qq', namespace: 'global', id: '123456789' }] }]) assert.throws(() => read(value))
  let getter = 0
  assert.throws(() => validateMusicExtractionConfig({ enabled: true, operators: [{ get id() { getter++; return '123456789' }, platform: 'qq', namespace: 'global' }] }))
  assert.equal(getter, 0)
})
