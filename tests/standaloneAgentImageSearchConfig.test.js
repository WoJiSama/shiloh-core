import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig, createStandaloneAgentCandidateValidator } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-image-search-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml'), env = { TEST_MODEL_KEY: 'config-fixture-private-key' }
  const host = tools => ({ version: 1, instance: 'image-search-config',
    model: { baseUrl: 'https://model.example.test/v1', name: 'fixture-model', apiKeyEnv: 'TEST_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(tools ? { tools } : {}),
  })
  function read(imageSearch, options) {
    fs.writeFileSync(file, JSON.stringify(host(imageSearch === undefined ? undefined : { imageSearch })))
    return readStandaloneAgentConfig(file, env, options)
  }
  return { file, env, host, read }
}

test('image search stays off until each public provider is explicitly enabled', t => {
  const { read } = fixture(t)
  for (const value of [undefined, {}, { emoji: { enabled: false } }, { bing: { enabled: false } },
    { emoji: { enabled: false }, bing: { enabled: false } }]) assert.equal(read(value).tools.imageSearch, undefined)
  assert.deepEqual(read({ emoji: { enabled: true } }).tools.imageSearch, { emoji: { enabled: true } })
  assert.deepEqual(read({ bing: { enabled: true }, emoji: { enabled: false } }).tools.imageSearch, { bing: { enabled: true } })
  assert.deepEqual(read({ emoji: { enabled: true }, bing: { enabled: true } }).tools.imageSearch,
    { emoji: { enabled: true }, bing: { enabled: true } })
})

test('image search cannot configure a target, credentials, arbitrary endpoints or unsupported provider switches', t => {
  const { read } = fixture(t)
  const secret = 'must-not-appear-in-config-errors'
  for (const value of [null, false, true, [], 'enabled', 1, { enabled: true }, { unknown: {} },
    { emoji: null }, { bing: [] }, { emoji: true }, { emoji: {} }, { bing: { enabled: 'true' } },
    { emoji: { enabled: true, baseUrl: 'http://127.0.0.1/private' } },
    { bing: { enabled: false, apiKey: secret } }, { bing: { enabled: true, target: 'other-chat' } },
    { emoji: { enabled: true, timeoutMs: 600000 } }, { emoji: { enabled: true, count: 1000 } }]) {
    assert.throws(() => read(value), error => !error.message.includes(secret))
  }
})

test('configuration preview validates image search without provider requests or a separate model credential', t => {
  const { env, host, read } = fixture(t), loaded = read()
  const validate = createStandaloneAgentCandidateValidator(loaded.sourceSnapshot.hostFile, env, { sourceSnapshot: loaded.sourceSnapshot })
  const candidate = { ...loaded.sourceSnapshot.sources,
    host: JSON.stringify(host({ imageSearch: { emoji: { enabled: true }, bing: { enabled: true } } })),
  }
  assert.doesNotThrow(() => validate(candidate))
  assert.throws(() => validate({ ...candidate,
    host: JSON.stringify(host({ imageSearch: { bing: { enabled: true, endpoint: 'https://other.example.test' } } })),
  }))
  assert.equal(read({ bing: { enabled: true } }, { requireCredentials: false }).tools.imageSearch.bing.enabled, true)
})
