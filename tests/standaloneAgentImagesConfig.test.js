import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-images-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const generation = { baseUrl: 'https://generation.example/v1', name: 'generation-model', apiKeyEnv: 'TEST_GENERATION_KEY' }
  const edit = { baseUrl: 'https://edit.example/v1', name: 'edit-model', apiKeyEnv: 'TEST_EDIT_KEY' }
  const env = { TEST_MAIN_KEY: 'main-private-key', TEST_GENERATION_KEY: 'generation-private-key', TEST_EDIT_KEY: 'edit-private-key' }
  const read = (images, options, credentials = env, sections = {}) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'images-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(images === undefined ? {} : { tools: { images } }), ...sections,
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read, generation, edit, env }
}

test('standalone image tools default off and never borrow the main or vision model', t => {
  const { read } = fixture(t)
  assert.deepEqual(read().tools, {})
  assert.deepEqual(read(undefined, undefined, undefined, {
    vision: { baseUrl: 'https://vision.example/v1', name: 'vision-model', apiKeyEnv: 'TEST_MAIN_KEY' },
  }).tools, {})
  const empty = read({}).tools.images
  assert.ok(empty === undefined || Object.keys(empty).length === 0)
})

test('generation and editing each require their own explicit backend and resolved environment key', t => {
  const { read, generation, edit } = fixture(t)
  const generated = read({ generation }).tools.images
  assert.equal(generated.generation.baseUrl, generation.baseUrl)
  assert.equal(generated.generation.name, 'generation-model')
  assert.equal(generated.generation.apiKey, 'generation-private-key')
  assert.equal(generated.generation.protocol ?? 'images', 'images')
  assert.equal(generated.edit, undefined)
  const edited = read({ edit }).tools.images
  assert.equal(edited.edit.name, 'edit-model')
  assert.equal(edited.edit.apiKey, 'edit-private-key')
  assert.equal(edited.generation, undefined)
  const both = read({ generation, edit }).tools.images
  assert.equal(both.generation.apiKey, 'generation-private-key')
  assert.equal(both.edit.apiKey, 'edit-private-key')
  assert.equal(Object.hasOwn(both.generation, 'apiKeyEnv'), false)
})

test('image backends preserve explicit images or chat protocols and fixed optional size and quality', t => {
  const { read, generation, edit } = fixture(t)
  for (const protocol of ['images', 'chat']) {
    const configured = read({ generation: { ...generation, protocol, size: '1536x1024', quality: 'high' },
      edit: { ...edit, protocol, size: '1024x1024', quality: 'medium' } }).tools.images
    assert.equal(configured.generation.protocol, protocol)
    assert.equal(configured.generation.size, '1536x1024')
    assert.equal(configured.generation.quality, 'high')
    assert.equal(configured.edit.protocol, protocol)
    assert.equal(configured.edit.size, '1024x1024')
    assert.equal(configured.edit.quality, 'medium')
  }
})

test('declared image backends require their own credentials while preview can read without keys', t => {
  const { read, generation, edit } = fixture(t)
  const mainOnly = { TEST_MAIN_KEY: 'main-private-key' }
  assert.throws(() => read({ generation }, undefined, mainOnly), /TEST_GENERATION_KEY/u)
  assert.throws(() => read({ edit }, undefined, mainOnly), /TEST_EDIT_KEY/u)
  const preview = read({ generation, edit }, { requireCredentials: false }, {})
  assert.equal(preview.tools.images.generation.apiKey, '')
  assert.equal(preview.tools.images.edit.apiKey, '')
  assert.equal(preview.execution.chatAiConfig.chatApiKey, '')
  assert.equal(preview.tools.images.generation.name, generation.name)
  assert.equal(preview.tools.images.edit.name, edit.name)
})

test('image tool configuration rejects switches, unknown fields, raw credentials and ambiguous backend values', t => {
  const { read, generation } = fixture(t)
  for (const images of [null, false, true, [], 'enabled', 1, { enabled: true }, { unknown: generation },
    { generation: null }, { generation: false }, { generation: [] }, { generation: 'main-model' },
    { generation: {} }, { edit: {} },
    ...['apiKey', 'headers', 'timeoutMs', 'response_format', 'n', 'fallback', 'enabled'].map(key => ({ generation: { ...generation, [key]: 'raw-image-private-secret' } })),
    ...['image', 'auto', '', null, false, 1, {}].map(protocol => ({ generation: { ...generation, protocol } })),
    ...['', ' ', null, false, 1024, []].map(size => ({ generation: { ...generation, size } })),
    ...['', ' ', null, false, 1, {}].map(quality => ({ edit: { ...generation, quality } })),
  ]) assert.throws(() => read(images), error => !error.message.includes('raw-image-private-secret'))
})

test('image tool configuration rejects unsafe endpoints and invalid names or environment references without exposing their values', t => {
  const { read, generation } = fixture(t)
  for (const baseUrl of ['file:///tmp/image-private-key', 'not-a-url', 'https://user:image-private-key@generation.example/v1',
    'https://generation.example/v1?api_key=image-private-key', 'https://generation.example/v1#image-private-key']) {
    assert.throws(() => read({ generation: { ...generation, baseUrl } }), error => !error.message.includes('image-private-key'))
  }
  for (const name of ['', ' ', null, false, 1]) assert.throws(() => read({ generation: { ...generation, name } }))
  for (const apiKeyEnv of ['', 'bad-name', null, false, 1]) assert.throws(() => read({ generation: { ...generation, apiKeyEnv } }))
})
