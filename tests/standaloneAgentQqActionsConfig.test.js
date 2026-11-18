import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneQqActionsConfig, readStandaloneQqActionsConnection } = await importBilibiliHost('bootstrap/standaloneQqActions.js')
const denied = { qzone: { enabled: false }, gift: { enabled: false }, redPackets: {
  enabled: false, allowExplicit: false, allowRecentSearch: false, allowReferenceFallback: false, allowPasswordSend: false, recentLimit: 100,
  automatic: { enabled: false, toolConfigured: false, allowPasswordSend: false },
} }
const packetGrants = ['allowExplicit', 'allowRecentSearch', 'allowReferenceFallback', 'allowPasswordSend']
function assertFrozen(config) {
  for (const item of [config, config.qzone, config.gift, config.redPackets, config.redPackets.automatic]) assert.ok(Object.isFrozen(item))
}

test('standalone QQ action configuration defaults to denial for every independent capability', () => {
  for (const input of [undefined, {}, { qzone: { enabled: false }, gift: { enabled: false }, redPackets: { enabled: false } }]) {
    const config = readStandaloneQqActionsConfig(input); assert.deepEqual(config, denied); assertFrozen(config)
  }
  assert.equal(readStandaloneQqActionsConnection(undefined), undefined)
  assert.deepEqual(readStandaloneQqActionsConnection({ driver: 'napcat' }), { driver: 'napcat', giftDisplay: false, redPackets: false, qzone: false })
})

test('qzone and gift require independent explicit enablement and cannot enable red packets', () => {
  for (const key of ['qzone', 'gift']) {
    const input = { [key]: { enabled: true } }, config = readStandaloneQqActionsConfig(input)
    assert.deepEqual(config, { ...denied, [key]: { enabled: true } }); assertFrozen(config)
    assert.equal(Object.isFrozen(input[key]), false, 'parsing must not mutate caller objects')
    input[key].enabled = false; assert.equal(config[key].enabled, true)
  }
})

test('red-packet grants remain separate from the feature flag and from automatic password permission', () => {
  for (const grant of packetGrants) {
    const config = readStandaloneQqActionsConfig({ redPackets: { enabled: true, [grant]: true } })
    assert.deepEqual(config, { ...denied, redPackets: { ...denied.redPackets, enabled: true, [grant]: true } }); assertFrozen(config)
  }
  const input = { qzone: { enabled: true }, gift: { enabled: true }, redPackets: { enabled: true,
    ...Object.fromEntries(packetGrants.map(key => [key, true])), recentLimit: 1,
    automatic: { enabled: true, toolConfigured: true, allowPasswordSend: true } } }
  const config = readStandaloneQqActionsConfig(input); assert.deepEqual(config, input); assertFrozen(config)
  input.redPackets.automatic.allowPasswordSend = false; assert.equal(config.redPackets.automatic.allowPasswordSend, true)
  assert.deepEqual(readStandaloneQqActionsConfig({ redPackets: { enabled: true, automatic: { enabled: true, toolConfigured: false } } }).redPackets.automatic,
    { enabled: true, toolConfigured: false, allowPasswordSend: false })
  const disabled = readStandaloneQqActionsConfig({ redPackets: { enabled: false, allowExplicit: true, automatic: { enabled: false, toolConfigured: true } } })
  assert.equal(disabled.redPackets.enabled, false); assert.equal(disabled.redPackets.allowExplicit, true)
  assert.equal(disabled.redPackets.automatic.enabled, false); assert.equal(disabled.redPackets.automatic.toolConfigured, true)
})

test('red-packet recentLimit is a bounded integer with the runtime default of 100', () => {
  for (const recentLimit of [1, 1000]) assert.equal(readStandaloneQqActionsConfig({ redPackets: { enabled: false, recentLimit } }).redPackets.recentLimit, recentLimit)
  for (const recentLimit of [undefined, null, true, '100', 0, 1001, 1.5, NaN, Infinity]) {
    assert.throws(() => readStandaloneQqActionsConfig({ redPackets: { enabled: false, recentLimit } }), /recentLimit/u)
  }
})

test('QQ action grant objects are closed and validate disabled configurations too', () => {
  for (const input of [null, [], 1, true, 'napcat', { enabled: false }, { driver: 'napcat' },
    { qzone: null }, { gift: [] }, { redPackets: false }, { qzone: {} }, { gift: {} }, { redPackets: {} },
    { qzone: { enabled: false, images: true } }, { gift: { enabled: false, amount: 1 } },
    { redPackets: { enabled: false, walletKeyEnv: 'QQ_WALLET' } },
    { redPackets: { enabled: false, automatic: {} } },
    { redPackets: { enabled: false, automatic: { enabled: false } } },
    { redPackets: { enabled: false, automatic: { enabled: false, toolConfigured: false, probability: 1 } } },
  ]) assert.throws(() => readStandaloneQqActionsConfig(input))
  for (const value of [undefined, null, 'true', 1, 0, {}, []]) {
    for (const section of ['qzone', 'gift']) assert.throws(() => readStandaloneQqActionsConfig({ [section]: { enabled: value } }))
    for (const key of ['enabled', ...packetGrants]) assert.throws(() => readStandaloneQqActionsConfig({ redPackets: { enabled: false, [key]: value } }))
    for (const key of ['enabled', 'toolConfigured', 'allowPasswordSend']) assert.throws(() => readStandaloneQqActionsConfig({ redPackets: { enabled: false,
      automatic: { enabled: false, toolConfigured: false, [key]: value } } }))
  }
})

test('NapCat extension declarations enable only explicit per-connection booleans', () => {
  const keys = ['giftDisplay', 'redPackets', 'qzone']
  for (const key of keys) {
    const config = readStandaloneQqActionsConnection({ driver: 'napcat', [key]: true })
    assert.deepEqual(config, { driver: 'napcat', giftDisplay: false, redPackets: false, qzone: false, [key]: true }); assert.ok(Object.isFrozen(config))
  }
  const input = { driver: 'napcat', giftDisplay: true, redPackets: true, qzone: true }, config = readStandaloneQqActionsConnection(input)
  assert.deepEqual(config, input); assert.ok(Object.isFrozen(config)); input.qzone = false; assert.equal(config.qzone, true)
  assert.deepEqual(readStandaloneQqActionsConfig(), denied, 'connection declarations do not grant business authorization')
})

test('connection extensions reject LLBot and unknown drivers, booleans and fields without probing a server', () => {
  for (const input of [null, [], true, 'napcat', {}, { driver: 'llbot' }, { driver: 'LLBot' }, { driver: 'unknown' }, { driver: 'NapCat' },
    { driver: 'napcat', gift: true }, { driver: 'napcat', supportsRedPacket: true }, { driver: 'napcat', endpoint: 'http://localhost/native' },
    { driver: 'napcat', credentials: 'private' }]) assert.throws(() => readStandaloneQqActionsConnection(input))
  for (const key of ['giftDisplay', 'redPackets', 'qzone']) for (const value of [undefined, null, 'true', 1, 0, {}, []]) {
    assert.throws(() => readStandaloneQqActionsConnection({ driver: 'napcat', [key]: value }), new RegExp(key, 'u'))
  }
})

test('configuration parsing rejects accessors, proxies and inherited grants without executing them', () => {
  let touched = 0
  const traps = { get() { touched++; throw Error('proxy get') }, ownKeys() { touched++; throw Error('proxy ownKeys') }, getPrototypeOf() { touched++; throw Error('proxy prototype') } }
  const accessor = Object.defineProperty({}, 'qzone', { get() { touched++; return { enabled: true } } })
  const symbol = { [Symbol('qzone')]: { enabled: true } }
  for (const input of [accessor, symbol, new Proxy({}, traps), Object.create({ qzone: { enabled: true } }), new Date(), new Map()]) assert.throws(() => readStandaloneQqActionsConfig(input))
  for (const input of [new Proxy({}, traps), Object.create({ driver: 'napcat', giftDisplay: true }),
    Object.defineProperty({ driver: 'napcat' }, 'qzone', { get() { touched++; return true } }), { driver: 'napcat', [Symbol('giftDisplay')]: true }]) {
    assert.throws(() => readStandaloneQqActionsConnection(input))
  }
  assert.equal(touched, 0)
})
