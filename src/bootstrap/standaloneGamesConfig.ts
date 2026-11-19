import path from 'node:path'
import type { TurtleSoupConfig } from '../contracts/turtleSoup.js'
import type { UmaConfig } from '../contracts/uma.js'
import { resolveTurtleSoupConfig } from '../modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import { DEFAULT_CONFIG, RACE_SIZE } from '../modules/games/infrastructure/uma/umaConstants.js'

export interface StandaloneGamesConfig {
  readonly turtleSoup?: TurtleSoupConfig
  readonly umaRace?: UmaConfig
  /** Explicit trusted host operators; group membership/admin never adds an ID here. */
  readonly operatorIds: readonly string[]
}
const invalid = () => new Error('games 只接受有界的 turtleSoup、umaRace 与显式 QQ operatorIds 配置')
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw invalid()
  return value as Record<string, unknown>
}
type Range = readonly [minimum: number, maximum: number]
function numbers(raw: Record<string, unknown>, ranges: Readonly<Record<string, Range>>, fractional: readonly string[] = []): void {
  for (const [key, [min, max]] of Object.entries(ranges)) if (raw[key] !== undefined &&
      (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || !fractional.includes(key) && !Number.isSafeInteger(raw[key]) ||
        Number(raw[key]) < min || Number(raw[key]) > max)) throw invalid()
}
const TURTLE_NUMBERS = {
  minPlayers: [1, 50], joinWindowMinutes: [1, 60], idleTimeoutMinutes: [1, 240], guessCooldownSeconds: [0, 3600],
  similarityHitThreshold: [0.5, 1], similarityMissThreshold: [0, 0.9], freshPoolTarget: [1, 150],
  freshEasy: [0, 50], freshNormal: [0, 50], freshHard: [0, 50], ratingWindowMinutes: [1, 120],
  maxHints: [0, 10], recapEveryQuestions: [0, 100], chooseWindowSeconds: [10, 300], hintCooldownSeconds: [0, 300],
  generationCallBudget: [4, 100], maxPending: [1, 100],
} satisfies Record<string, Range>
const TURTLE_TEXT = { generationModel: 200, reviewModel: 200, contentPolicy: 4000, generationCustomPrompt: 16_000 }
const UMA_NUMBERS = {
  minPlayers: [RACE_SIZE, RACE_SIZE], maxPlayers: [RACE_SIZE, RACE_SIZE], lobbySeconds: [10, 300],
  raceStageSeconds: [10, 180], cooldownSeconds: [0, 3600], winPoints: [0, 100_000], secondPoints: [0, 100_000],
  thirdPoints: [0, 100_000], participationPoints: [0, 100_000], rankLimit: [3, 50],
} satisfies Record<string, Range>

/** Pure explicit capture. State roots are derived from the already selected host dataDir. */
export function readStandaloneGamesConfig(value: unknown, options: { readonly dataDir: string }): StandaloneGamesConfig {
  if (!options || typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir) || options.dataDir.includes('\0')) throw invalid()
  const raw = value === undefined ? {} : object(value, ['turtleSoup', 'umaRace', 'operatorIds'])
  const ids = raw.operatorIds ?? []
  if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || ids.length > 128 ||
      Reflect.ownKeys(ids).length !== ids.length + 1 || Array.from({ length: ids.length }, (_, index) => Object.getOwnPropertyDescriptor(ids, String(index))).some(item => !item || !Object.hasOwn(item, 'value')) ||
      ids.some(id => typeof id !== 'string' || !/^[1-9]\d{0,19}$/u.test(id)) ||
      new Set(ids).size !== ids.length) throw invalid()
  const operatorIds: readonly string[] = Object.freeze([...ids])
  let turtleSoup: TurtleSoupConfig | undefined, umaRace: UmaConfig | undefined
  if (raw.turtleSoup !== undefined) {
    const turtle = object(raw.turtleSoup, ['enabled', ...Object.keys(TURTLE_NUMBERS), ...Object.keys(TURTLE_TEXT)])
    if (typeof turtle.enabled !== 'boolean') throw invalid()
    numbers(turtle, TURTLE_NUMBERS, ['similarityHitThreshold', 'similarityMissThreshold'])
    for (const [key, maximum] of Object.entries(TURTLE_TEXT)) if (turtle[key] !== undefined &&
        (typeof turtle[key] !== 'string' || turtle[key].length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(turtle[key]))) throw invalid()
    if (turtle.enabled) turtleSoup = Object.freeze(resolveTurtleSoupConfig({ miniGames: { enabled: true, turtleSoup: {
      ...turtle, baseDir: path.join(options.dataDir, 'games', 'turtle-soup'),
    } } }))
  }
  if (raw.umaRace !== undefined) {
    const uma = object(raw.umaRace, ['enabled', ...Object.keys(UMA_NUMBERS)])
    if (typeof uma.enabled !== 'boolean') throw invalid()
    numbers(uma, UMA_NUMBERS)
    if (uma.enabled) umaRace = Object.freeze({ ...DEFAULT_CONFIG, ...uma, enabled: true, minPlayers: RACE_SIZE, maxPlayers: RACE_SIZE,
      baseDir: path.join(options.dataDir, 'games', 'uma-race'),
    } as UmaConfig)
  }
  return Object.freeze({ ...(turtleSoup ? { turtleSoup } : {}), ...(umaRace ? { umaRace } : {}), operatorIds })
}
