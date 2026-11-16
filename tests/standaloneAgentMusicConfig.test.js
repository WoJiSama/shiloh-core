import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

test('music is default off, supports explicit anonymous search, and reads only enabled host cookie references', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-music-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = (music, env = {}, requireCredentials = true) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'music-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(music === undefined ? {} : { tools: { music } }) }))
    return readStandaloneAgentConfig(file, Object.defineProperties({ MAIN_KEY: 'main-key' }, Object.getOwnPropertyDescriptors(env)), { requireCredentials })
  }
  assert.deepEqual(read().tools, {})
  const disabledEnv = Object.defineProperty({}, 'QQ_COOKIE', { get() { throw new Error('disabled cookie read') } })
  assert.deepEqual(read({ enabled: false, cookieEnv: 'QQ_COOKIE' }, disabledEnv).tools, {})
  assert.deepEqual(read({ enabled: true }).tools.music, { enabled: true })
  assert.deepEqual(read({ enabled: true, cookieEnv: 'QQ_COOKIE' }, { QQ_COOKIE: 'uin=123;qm_keyst=key==' }).tools.music, { enabled: true, cookie: 'uin=123;qm_keyst=key==' })
  assert.throws(() => read({ enabled: true, cookieEnv: 'QQ_COOKIE' }), /QQ_COOKIE/)
  assert.deepEqual(read({ enabled: true, cookieEnv: 'QQ_COOKIE' }, {}, false).tools.music, { enabled: true })
  for (const music of [null, [], false, {}, { enabled: 'yes' }, { enabled: false, cookieEnv: 'bad-name' }, { enabled: true, cookie: 'inline' },
    { enabled: true, endpoint: 'http://other' }, { enabled: true, accountId: 'other' }, { enabled: true, groupId: '90001' }, { enabled: true, refreshCommand: 'curl' }]) assert.throws(() => read(music))
  assert.throws(() => read({ enabled: true, cookieEnv: 'QQ_COOKIE' }, { QQ_COOKIE: 'uin=1\r\nHeader: injected' }), /Cookie/)
  assert.throws(() => read({ enabled: true, cookieEnv: 'QQ_COOKIE' }, { QQ_COOKIE: 'x'.repeat(32769) }), /Cookie/)
})
