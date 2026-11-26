import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')

test('file extraction has an explicit closed boundary and native parsers require named host authorization', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = files => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'files-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(files === undefined ? {} : { tools: { files } }) }))
    return readStandaloneAgentConfig(file, { TEST_MAIN_KEY: 'main-key' })
  }
  assert.equal(read().tools.files, undefined)
  assert.equal(read({ enabled: false }).tools.files, undefined)
  assert.deepEqual(read({ enabled: true }).tools.files, { enabled: true, nativeFormats: [] })
  assert.deepEqual(read({ enabled: true, nativeFormats: ['rtf', 'doc'] }).tools.files, { enabled: true, nativeFormats: ['rtf', 'doc'] })
  for (const input of [null, false, [], {}, { enabled: 1 }, { enabled: true, nativeFormats: 'doc' },
    { enabled: true, nativeFormats: ['doc', 'doc'] }, { enabled: false, nativeFormats: ['shell'] },
    { enabled: true, command: 'curl' }, { enabled: true, path: '/private' }, { enabled: true, nativeFormats: ['/bin/sh'] }]) assert.throws(() => read(input))
})
