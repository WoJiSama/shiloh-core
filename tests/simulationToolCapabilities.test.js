import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createSimTools } from '../dist/backend/modules/simulation/infrastructure/simTools.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'

const optionalTools = {
  simShareVideoCard: { shareVideoCard: async () => ({ ok: true }) },
  simSendPoke: { pokeMember: async () => ({ ok: true }) },
  simGetGroupMembers: { getGroupMembers: async () => [] },
  simQzoneInteract: { qzoneInteract: async () => ({ ok: true }) },
  simCollectSticker: { collectSticker: async () => ({ ok: true }) },
  simGetForward: { getForward: async () => ({ lines: [] }) },
  simGetMessageImages: { getMessageImages: async seq => ({ seq, images: [] }) },
  simSetMood: { updateMood: async () => ({ error: 'unused fixture' }) },
  simSetRhythm: { setRhythm: async () => '' },
  simLifeThread: { lifeThreadFollow: async () => ({ ok: true }), lifeThreadList: async () => [], lifeThreadDrop: async () => ({ ok: true }) },
}
let incomingSequence = 0

test('simulation tool declarations follow implemented context methods independently of member ID syntax', () => {
  const base = createSimTools({}).map(tool => tool.name)
  for (const name of Object.keys(optionalTools)) assert.ok(!base.includes(name), `${name} has no implementation`)
  assert.ok(base.includes('simSendMessage'))
  assert.ok(base.includes('simRemember'))
  for (const [name, implementation] of Object.entries(optionalTools)) {
    for (const identity of [{}, { platformUserId: value => value.startsWith('member:') }]) {
      const names = createSimTools({ ...identity, ...implementation }).map(tool => tool.name)
      assert.ok(names.includes(name), `${name} must follow its implemented port`)
      for (const other of Object.keys(optionalTools).filter(other => other !== name)) assert.ok(!names.includes(other))
    }
  }
  assert.ok(!createSimTools({ lifeThreadFollow: async () => ({ ok: true }) }).some(tool => tool.name === 'simLifeThread'))
})

async function captureRuntimeTools(t, extraPorts = {}) {
  const bot = '3094088525', group = '10086', at = 1_790_000_000_000
  const state = createDefaultSimSession(at)
  state.bootstrapSent = true
  state.botId = bot
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  const storage = new Map([[`shiloh:sim:g:${group}`, JSON.stringify(state)]])
  const requests = []
  const errors = []
  const runtime = createSimulationRuntime({
    redis: {
      get: async key => storage.get(key) ?? null,
      set: async (key, value) => { storage.set(key, value); return 'OK' },
      del: async (...keys) => keys.reduce((count, key) => count + Number(storage.delete(key)), 0),
    },
    now: () => at, random: () => 0.99,
    logger: { info() {}, warn(...args) { errors.push(args.map(String).join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSelf: () => ({ id: bot, name: 'fixture' }),
    getPersona: () => ({ personaId: 'fixture', persona: { name: 'fixture' }, systemContent: '' }),
    getExecutionConfig: () => ({ useTools: true }),
    getSection: () => ({
      enabled: true, allGroups: false, groups: [group],
      wake: { probability: 0, batchWindowMs: 1000, proactiveProbability: 0 },
      reflection: { enabled: false }, mood: { enabled: false }, rhythm: { enabled: false },
      userStyle: { enabled: false }, wakeGate: { enabled: false },
      turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'legacy' },
    }),
    ...extraPorts,
    async YTapi(request) {
      requests.push(request)
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '能力检查结束', throughSeq: 1 }),
      } }] } }] }
    },
  })
  t.after(async () => { runtime.stop(); await runtime.drain() })
  await runtime.ingest(decodeQqIncomingMessage({
    group_id: group, self_id: bot, user_id: '40000', message_id: String(++incomingSequence), message_type: 'group',
    atBot: true, sender: { nickname: 'fixture' }, message: [{ type: 'at', data: { qq: bot } }, { type: 'text', data: { text: '检查当前宿主能力' } }],
  }, { now: at }))
  const deadline = Date.now() + 5_000
  while ((!requests.length || (await runtime.describeGroup(group)).running) && Date.now() < deadline) await delay(20)
  assert.ok(requests.length, `the production runtime must expose a real model request: ${errors.join(' | ')}`)
  return requests[0].tools.map(tool => tool.function.name)
}

test('QQ simulation omits absent host integrations while retaining Core state tools', async t => {
  const names = await captureRuntimeTools(t)
  for (const name of Object.keys(optionalTools).filter(name => name !== 'simSetRhythm')) {
    assert.ok(!names.includes(name), `${name} must not advertise an absent host integration`)
  }
  for (const name of ['simSetRhythm', 'simSendMessage', 'simCharacterMemory', 'simFinishTurn']) assert.ok(names.includes(name))
})

test('QQ simulation keeps the implemented Yunzai integrations available', async t => {
  const names = await captureRuntimeTools(t, {
    sendGroupMessage: async () => ({ ok: true, messageId: 'confirmed' }),
    resolveBilibiliCard: async () => ({ ok: true, title: 'fixture', cardJson: '{}' }),
    pokeMember: async () => ({ ok: true }),
    getGroupMembers: async () => [],
    qzoneInteract: async () => ({ ok: true }),
    collectStickerImage: async () => ({ ok: true }),
    getForwardContent: async () => ({ lines: [] }),
    fetchImageBase64: async () => ({ mime: 'image/png', base64: 'fixture' }),
    lifeThreadResolve: async () => ({ ok: true, title: 'fixture', sourceId: 'fixture' }),
  })
  for (const name of Object.keys(optionalTools).filter(name => name !== 'simSetMood')) assert.ok(names.includes(name), name)
})
