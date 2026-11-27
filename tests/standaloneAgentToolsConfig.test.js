import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const defaultTools = {
  localEmoji: { enabled: false, config: {} },
  qqActions: {
    qzone: { enabled: false }, gift: { enabled: false },
    redPackets: { enabled: false, allowExplicit: false, allowRecentSearch: false, allowReferenceFallback: false,
      allowPasswordSend: false, recentLimit: 100, automatic: { enabled: false, toolConfigured: false, allowPasswordSend: false } },
  },
  deferredActions: { enabled: false, rules: [], migrationApprovals: [] },
}

const { createStandaloneAgentCandidateValidator, readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_MODEL_KEY: 'main-key', TEST_SEARCH_KEY: 'search-key' }
  const search = { baseUrl: 'https://search.example/v1', name: 'search-model', apiKeyEnv: 'TEST_SEARCH_KEY' }
  function hostSource(tools) {
    return JSON.stringify({
      version: 1, instance: 'tools-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(tools === undefined ? {} : { tools }),
    })
  }
  function read(tools, options, credentials = env) {
    fs.writeFileSync(file, hostSource(tools))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  const validate = createStandaloneAgentCandidateValidator(file, env)
  return { read, search, env, validateTools: tools => validate({ host: hostSource(tools), personas: undefined,
    bindings: fs.readFileSync(path.join(directory, 'agent-bindings.yaml'), 'utf8') }) }
}

test('standalone tools default off and use an explicit search backend with no main model fallback', t => {
  const { read, search } = fixture(t)
  assert.deepEqual(read().tools, defaultTools)
  assert.deepEqual(read({ web: { enabled: false } }).tools, defaultTools)
  assert.deepEqual(read({ web: { enabled: true } }).tools, { ...defaultTools, web: { enabled: true } })
  for (const webSearch of [undefined, 'auto', 'on', 'off']) {
    assert.deepEqual(read({ search: { ...search, ...(webSearch ? { webSearch } : {}) } }).tools, { ...defaultTools,
      search: { baseUrl: 'https://search.example/v1', name: 'search-model', apiKey: 'search-key', ...(webSearch ? { webSearch } : {}) },
    })
  }
  assert.throws(() => read({ search: {} }), /tools.search.baseUrl/u)
  assert.throws(() => read({ search: { ...search, apiKeyEnv: 'MISSING_SEARCH_KEY' } }), /MISSING_SEARCH_KEY/u)
  assert.equal(read({ search }, { requireCredentials: false }, {}).tools.search.apiKey, '')
})

test('standalone tool configuration rejects ambiguous switches, raw credentials and credential endpoints', t => {
  const { read, search } = fixture(t)
  for (const tools of [null, false, [], { unknown: true }, { search: false }, { web: true }, { web: {} },
    { web: { enabled: 'true' } }, { web: { enabled: false, url: 'http://example.test' } },
    { search: { ...search, apiKey: 'raw-key' } }, { search: { ...search, webSearch: true } },
    { search: { ...search, webSearch: 'yes' } }, { search: { ...search, name: '' } },
    { search: { ...search, apiKeyEnv: 'bad-name' } },
  ]) assert.throws(() => read(tools))
  for (const baseUrl of ['file:///tmp/key', 'https://user:password@search.example/v1',
    'https://search.example/v1?api_key=value', 'https://search.example/v1#fragment', 'not-a-url']) {
    assert.throws(() => read({ search: { ...search, baseUrl } }))
  }
})

test('public webpage evidence retention is opt-in and can be restricted to selected QQ groups', t => {
  const { validateTools } = fixture(t)
  assert.doesNotThrow(() => validateTools({ web: { enabled: true, reuse: {} } }))
  const groups = ['90001']
  assert.doesNotThrow(() => validateTools({ web: { enabled: true, reuse: { groups } } }))
  for (const reuse of [true, null, [], { unknown: true }, { groups: [] }, { groups: [90001] }, { groups: ['90001', '90001'] }]) {
    assert.throws(() => validateTools({ web: { enabled: true, reuse } }))
  }
  assert.throws(() => validateTools({ web: { enabled: false, reuse: {} } }), /tools.web.reuse/u)
})

test('GitHub is explicit, defaults to anonymous public access and resolves only its declared token environment', t => {
  const { read, env } = fixture(t)
  assert.deepEqual(read({ github: { enabled: false } }).tools, defaultTools)
  assert.deepEqual(read({ github: { enabled: true } }, undefined, { ...env, GITHUB_TOKEN: 'ambient-github', GH_TOKEN: 'ambient-gh' }).tools,
    { ...defaultTools, github: { enabled: true } })
  assert.deepEqual(read({ github: { enabled: false, tokenEnv: 'MISSING_TOKEN' } }).tools, defaultTools)
  assert.deepEqual(read({ github: { enabled: true, tokenEnv: 'DECLARED_TOKEN' } }, undefined, { ...env, DECLARED_TOKEN: 'declared-github-key' }).tools,
    { ...defaultTools, github: { enabled: true, token: 'declared-github-key' } })
  assert.throws(() => read({ github: { enabled: true, tokenEnv: 'MISSING_TOKEN' } }), /MISSING_TOKEN/u)
  assert.deepEqual(read({ github: { enabled: true, tokenEnv: 'MISSING_TOKEN' } }, { requireCredentials: false }).tools,
    { ...defaultTools, github: { enabled: true } })
})

test('GitHub configuration closes credential and endpoint fields even while disabled', t => {
  const { read, env } = fixture(t)
  for (const github of [false, true, [], null, {}, { enabled: 'true' }, { enabled: true, token: 'raw-key' },
    { enabled: true, tokenEnv: 'bad-name' }, { enabled: true, tokenEnv: '' }, { enabled: true, tokenEnv: 7 },
    { enabled: true, baseUrl: 'https://evil.example' }, { enabled: false, token: 'raw-key' },
    { enabled: false, tokenEnv: 'bad-name' }, { enabled: false, url: 'https://evil.example' }]) {
    assert.throws(() => read({ github }))
  }
  for (const token of ['', ' ', 'key\r\nHeader: value', 'key\u0000suffix', 'x'.repeat(8193)]) {
    assert.throws(() => read({ github: { enabled: true, tokenEnv: 'DECLARED_TOKEN' } }, undefined, { ...env, DECLARED_TOKEN: token }))
  }
})

test('Modrinth requires its declared compact translation model and disabled declarations never resolve credentials', t => {
  const { read, env } = fixture(t)
  const translation = { baseUrl: 'https://translate.example/v1', name: 'compact-translation', apiKeyEnv: 'MODRINTH_KEY' }
  assert.deepEqual(read({ modrinth: { enabled: false } }).tools, defaultTools)
  const noReadEnv = new Proxy(env, { get(target, key) {
    if (key === 'MODRINTH_KEY') assert.fail('disabled Modrinth read its secret')
    return Reflect.get(target, key)
  } })
  assert.deepEqual(read({ modrinth: { enabled: false, translation } }, undefined, noReadEnv).tools, defaultTools)
  assert.throws(() => read({ modrinth: { enabled: true } }), /translation/u)
  assert.throws(() => read({ modrinth: { enabled: true, translation } }), /MODRINTH_KEY/u)
  assert.deepEqual(read({ modrinth: { enabled: true, translation } }, undefined, { ...env, MODRINTH_KEY: 'translate-key' }).tools.modrinth,
    { enabled: true, translation: { baseUrl: translation.baseUrl, name: translation.name, apiKey: 'translate-key' } })
  assert.equal(read({ modrinth: { enabled: true, translation } }, { requireCredentials: false }).tools.modrinth.translation.apiKey, '')
  for (const value of [true, null, [], {}, { enabled: 'true' }, { enabled: true, url: 'https://evil.example' },
    { enabled: false, translation: { ...translation, apiKey: 'raw-key' } },
    { enabled: false, translation: { ...translation, baseUrl: 'https://user:pass@evil.example/v1' } },
    { enabled: true, translation: { ...translation, apiKeyEnv: 'bad-name' } },
    { enabled: true, translation: { ...translation, name: 'x'.repeat(201) } },
  ]) assert.throws(() => read({ modrinth: value }))
})
