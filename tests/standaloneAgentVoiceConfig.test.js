import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const defaultTools = {
  qqActions: {
    qzone: { enabled: false }, gift: { enabled: false },
    redPackets: { enabled: false, allowExplicit: false, allowRecentSearch: false, allowReferenceFallback: false,
      allowPasswordSend: false, recentLimit: 100, automatic: { enabled: false, toolConfigured: false, allowPasswordSend: false } },
  },
  deferredActions: { enabled: false, rules: [], migrationApprovals: [] },
}

const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-voice-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = { account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001' }
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: target.account.id }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  return { target, read(voice, { env = {}, requireCredentials = true, extra = {} } = {}) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'voice-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(voice === undefined ? {} : { tools: { voice } }), ...extra }))
    return readStandaloneAgentConfig(file, Object.defineProperties({ MAIN_KEY: 'main-key' }, Object.getOwnPropertyDescriptors(env)), { requireCredentials })
  } }
}
const declared = { enabled: true, appId: 'app-fixture', accessTokenEnv: 'VOICE_KEY', resourceId: 'resource-fixture', voiceType: 'voice-fixture' }

test('voice is default off and disabled declarations validate without reading credentials', t => {
  const f = fixture(t)
  assert.deepEqual(f.read().tools, defaultTools)
  const env = Object.defineProperty({}, 'VOICE_KEY', { enumerable: true, get() { throw new Error('disabled credentials were read') } })
  assert.deepEqual(f.read({ ...declared, enabled: false }, { env }).tools, defaultTools)
  assert.deepEqual(f.read({ enabled: false }).tools, defaultTools)
  assert.throws(() => f.read({ ...declared, enabled: false, endpoint: 'https://host.invalid/?secret=value' }), /endpoint/)
  assert.throws(() => f.read({ ...declared, enabled: false, styles: { normal: { speedRatio: 20 } } }), /speedRatio/)
})

test('voice resolves only host credential references and preserves bounded style configuration', t => {
  const f = fixture(t)
  const input = { ...declared, endpoint: 'http://127.0.0.1:8000/tts', authorizationEnv: 'VOICE_AUTH', format: 'wav', maxTextLength: 80, sampleRate: 24000,
    speedRatio: 1, pitchRatio: 1, volumeRatio: 1, uid: 'fixture-user', stylePrompt: '轻柔', styles: { normal: {}, sleepy: { speedRatio: 0.9, prompt: '睡前', resourceId: 'style-resource' } } }
  const decoded = f.read(input, { env: { VOICE_KEY: 'voice-private', VOICE_AUTH: 'voice-auth-private' } }).tools.voice
  assert.equal(decoded.enabled, true); assert.equal(decoded.provider, 'volcengine'); assert.equal(decoded.accessToken, 'voice-private'); assert.equal(decoded.authorization, 'voice-auth-private')
  assert.deepEqual(decoded.styles, input.styles); assert.equal(decoded.format, 'wav'); assert.equal(decoded.uid, 'fixture-user'); assert.equal(decoded.stylePrompt, '轻柔')
  assert.deepEqual(f.read({ ...declared, styles: { shy: { emotion: '', prompt: '' } }, stylePrompt: '' }, { env: { VOICE_KEY: 'private' } }).tools.voice.styles, { shy: { emotion: '', prompt: '' } })
  assert.equal('accessTokenEnv' in decoded, false)
  assert.throws(() => f.read(declared), /VOICE_KEY/)
  assert.equal(f.read(declared, { requireCredentials: false }).tools.voice.accessToken, '')
  assert.throws(() => f.read({ ...declared, authorizationEnv: 'VOICE_AUTH' }, { env: { VOICE_KEY: 'fixture' } }), /VOICE_AUTH/)
})

test('voice rejects open configuration, invalid formats, endpoints, styles and credential data', t => {
  const f = fixture(t)
  for (const input of [null, [], {}, { enabled: 1 }, { ...declared, provider: 'other' }, { ...declared, appId: '' },
    { ...declared, accessToken: 'inline-key' }, { ...declared, accessTokenEnv: 'bad-name' }, { ...declared, url: 'https://other' },
    { ...declared, endpoint: 'file:///private/audio' }, { ...declared, endpoint: 'https://user:pass@provider/tts' },
    { ...declared, endpoint: 'https://provider/tts#fragment' }, { ...declared, endpoint: 'https://provider\\@other/tts' },
    { ...declared, maxTextLength: 7 }, { ...declared, maxTextLength: 301 }, { ...declared, format: 'pcm' },
    { ...declared, sampleRate: 1 }, { ...declared, sampleRate: 24000.5 }, { ...declared, pitchRatio: 2.1 }, { ...declared, volumeRatio: 0 },
    { ...declared, styles: { normal: { endpoint: 'https://other' } } }, { ...declared, styles: [] }, { ...declared, styles: { ['a'.repeat(41)]: {} } }]) {
    assert.throws(() => f.read(input, { env: { VOICE_KEY: 'private' } }), JSON.stringify(input))
  }
  assert.throws(() => f.read(declared, { env: { VOICE_KEY: 'key\nheader' } }), /凭据/)
})

test('persona guard is explicitly validated and travels with the resolved current role', t => {
  const f = fixture(t), guard = { enabled: false, stripCustomerTone: false, badPatterns: ['坏习惯'], maxPromptItems: 3 }
  assert.deepEqual(f.read(undefined, { extra: { personaGuard: guard } }).resolvePersona(f.target).personaGuard, guard)
  assert.equal(f.read().resolvePersona(f.target).personaGuard, undefined)
  for (const personaGuard of [null, [], { enabled: 1 }, { strips: true }, { badPatterns: ['ok', 1] }, { badPatterns: 'unsafe' }, { maxPromptItems: 9 }]) assert.throws(() => f.read(undefined, { extra: { personaGuard } }))
})
