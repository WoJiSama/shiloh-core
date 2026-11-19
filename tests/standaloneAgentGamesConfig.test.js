import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneGamesConfig } = await importBilibiliHost('bootstrap/standaloneGamesConfig.js')
const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const { resolveTurtleSoupConfig } = await importBilibiliHost('modules/games/infrastructure/turtleSoup/TurtleSoupStore.js')
const { DEFAULT_CONFIG, RACE_SIZE } = await importBilibiliHost('modules/games/infrastructure/uma/umaConstants.js')
const root = '/tmp/agent-games-config-owned'
const read = value => readStandaloneGamesConfig(value, { dataDir: root })

test('both legacy default-on games remain absent unless explicitly enabled in the standalone host', () => {
  assert.deepEqual(read(undefined), { operatorIds: [] })
  assert.deepEqual(read({}), { operatorIds: [] })
  assert.deepEqual(read({ turtleSoup: { enabled: false }, umaRace: { enabled: false } }), { operatorIds: [] })
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.equal(resolveTurtleSoupConfig({}).enabled, true)
  assert.equal(Object.isFrozen(read({}).operatorIds), true)
})

test('Turtle effective behavior is normalized by the existing resolver with a host-owned path only', () => {
  const selected = { enabled: true, minPlayers: 3, joinWindowMinutes: 7, idleTimeoutMinutes: 10, guessCooldownSeconds: 0,
    similarityHitThreshold: 0.95, similarityMissThreshold: 0.2, freshPoolTarget: 8, freshEasy: 2, freshNormal: 3, freshHard: 3,
    generationModel: 'game-model', reviewModel: 'review-model', contentPolicy: '保留旧题材要求', generationCustomPrompt: '旧自定义生成要求',
    ratingWindowMinutes: 15, maxHints: 4, recapEveryQuestions: 0, chooseWindowSeconds: 30, hintCooldownSeconds: 0,
    generationCallBudget: 20, maxPending: 30 }
  const expected = resolveTurtleSoupConfig({ miniGames: { enabled: true, turtleSoup: { ...selected, baseDir: path.join(root, 'games', 'turtle-soup') } } })
  assert.deepEqual(read({ turtleSoup: selected }).turtleSoup, expected)
  assert.equal(Object.isFrozen(read({ turtleSoup: selected }).turtleSoup), true)
  for (const value of [{ ...selected, baseDir: '/private/source' }, { ...selected, sourcePath: '../../state' }, { ...selected, modelApiKey: 'secret' }]) assert.throws(() => read({ turtleSoup: value }))
})

test('Uma preserves current eight-runner rules and effective awards without granting operator powers', () => {
  const value = read({ umaRace: { enabled: true, minPlayers: 8, maxPlayers: 8, winPoints: 5, secondPoints: 3, thirdPoints: 2, participationPoints: 1 } })
  assert.equal(RACE_SIZE, 8)
  assert.deepEqual(value.umaRace, { ...DEFAULT_CONFIG, minPlayers: 8, maxPlayers: 8, winPoints: 5, secondPoints: 3,
    thirdPoints: 2, participationPoints: 1, baseDir: path.join(root, 'games', 'uma-race') })
  assert.deepEqual(value.operatorIds, [])
  for (const raw of [{ enabled: true, minPlayers: 2 }, { enabled: true, maxPlayers: 12 }, { enabled: true, baseDir: '/private/state' },
    { enabled: true, isMaster: true }, { enabled: true, allowGroupAdminPoints: true }]) assert.throws(() => read({ umaRace: raw }))
})

test('closed bounded fields reject coercion, non-finite values, unknown nesting and invalid disabled sections', () => {
  for (const raw of [null, [], 'games', { enabled: true }, { turtleSoup: true }, { turtleSoup: {} }, { umaRace: {} },
    { turtleSoup: { enabled: 'true' } }, { turtleSoup: { enabled: true, minPlayers: '3' } },
    { turtleSoup: { enabled: true, freshPoolTarget: 151 } }, { turtleSoup: { enabled: true, ratingWindowMinutes: 0 } },
    { turtleSoup: { enabled: true, recapEveryQuestions: 101 } }, { turtleSoup: { enabled: true, similarityHitThreshold: NaN } },
    { turtleSoup: { enabled: true, minPlayers: 1.5 } }, { turtleSoup: { enabled: true, generationModel: 1 } },
    { turtleSoup: { enabled: true, contentPolicy: 'bad\0text' } }, { turtleSoup: { enabled: true, generationCustomPrompt: 'x'.repeat(16001) } },
    { umaRace: { enabled: false, rankLimit: '10' } }, { umaRace: { enabled: true, winPoints: Infinity } },
    { umaRace: { enabled: true, lobbySeconds: 9 } }, { umaRace: { enabled: true, cooldownSeconds: -1 } }]) assert.throws(() => read(raw), JSON.stringify(raw))
})

test('operator IDs require an explicit, dense, unique canonical QQ string list and no getters execute', () => {
  assert.deepEqual(read({ operatorIds: ['12345678', '87654321'] }).operatorIds, ['12345678', '87654321'])
  let observed = false
  const accessor = []; Object.defineProperty(accessor, '0', { enumerable: true, get() { observed = true; return '12345678' } })
  for (const ids of [true, '12345678', [12345678], ['012345'], [' 12345 '], ['0'], ['12345', '12345'], new Array(1), accessor,
    Array.from({ length: 129 }, (_, index) => String(index + 1))]) assert.throws(() => read({ operatorIds: ids }))
  const poisoned = {}; Object.defineProperty(poisoned, 'turtleSoup', { enumerable: true, get() { observed = true; return { enabled: true } } })
  assert.throws(() => read(poisoned)); assert.equal(observed, false)
  assert.throws(() => read({ masters: ['12345'] }))
  assert.throws(() => read({ operatorIds: [{ id: '12345', role: 'owner' }] }))
})

test('configuration capture performs no directory creation and rejects relative host roots', t => {
  const missing = path.join(os.tmpdir(), `game-config-no-write-${process.pid}-${Date.now()}`)
  assert.equal(fs.existsSync(missing), false)
  const value = readStandaloneGamesConfig({ turtleSoup: { enabled: true }, umaRace: { enabled: true } }, { dataDir: missing })
  assert.equal(fs.existsSync(missing), false)
  assert.equal(path.dirname(path.dirname(value.turtleSoup.baseDir)), missing)
  assert.throws(() => readStandaloneGamesConfig({}, { dataDir: '../games' }))
})

test('top-level agent host captures games in its loaded snapshot and rejects nested unknown fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-games-host-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), host = { version: 1, instance: 'games-config', dataDir: 'state',
    model: { baseUrl: 'https://model.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  fs.writeFileSync(file, JSON.stringify(host)); assert.deepEqual(readStandaloneAgentConfig(file, { MAIN_KEY: 'main-key' }).games, { operatorIds: [] })
  fs.writeFileSync(file, JSON.stringify({ ...host, games: { turtleSoup: { enabled: true }, umaRace: { enabled: true }, operatorIds: ['12345678'] } }))
  const value = readStandaloneAgentConfig(file, { MAIN_KEY: 'main-key' })
  assert.equal(value.games.turtleSoup.enabled, true); assert.equal(value.games.umaRace.enabled, true)
  assert.equal(value.games.umaRace.baseDir, path.join(directory, 'state', 'games', 'uma-race')); assert.deepEqual(value.games.operatorIds, ['12345678'])
  fs.writeFileSync(file, JSON.stringify({ ...host, games: { umaRace: { enabled: true, arbitraryStatePath: '/other' } } }))
  assert.throws(() => readStandaloneAgentConfig(file, { MAIN_KEY: 'main-key' }))
})
