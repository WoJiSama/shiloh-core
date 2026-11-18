import { types } from 'node:util'
import type { AgentRedPacketPolicy } from '../contracts/agentQqRedPacket.js'

export interface StandaloneQqActionsConfig {
  readonly qzone: Readonly<{ enabled: boolean }>
  readonly gift: Readonly<{ enabled: boolean }>
  readonly redPackets: Readonly<Omit<Required<AgentRedPacketPolicy>, 'automatic'> & {
    readonly automatic: Readonly<Required<NonNullable<AgentRedPacketPolicy['automatic']>>>
  }>
}

/** Operator-declared NapCat extensions; these flags are not live capability proof. */
export interface StandaloneQqActionsConnection {
  readonly driver: 'napcat'
  readonly giftDisplay: boolean
  readonly redPackets: boolean
  readonly qzone: boolean
}

function object(input: unknown, section: string, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(`${section} 必须是配置对象`)
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !allowed.includes(key) || !field || !Object.hasOwn(field, 'value')) {
      throw new Error(`${section} 包含不支持的字段`)
    }
    result[key] = field.value
  }
  return result
}

function boolean(input: Record<string, unknown>, key: string, section: string, required = false): boolean {
  if (!Object.hasOwn(input, key) && !required) return false
  if (typeof input[key] !== 'boolean') throw new Error(`${section}.${key} 必须是布尔值`)
  return input[key]
}

function enabled(input: unknown, section: string): Readonly<{ enabled: boolean }> {
  if (input === undefined) return Object.freeze({ enabled: false })
  const value = object(input, section, ['enabled'])
  return Object.freeze({ enabled: boolean(value, 'enabled', section, true) })
}

/** Parse grants only. Reading configuration never accesses a QQ account or credentials. */
export function readStandaloneQqActionsConfig(input: unknown): Readonly<StandaloneQqActionsConfig> {
  const root = 'tools.qqActions'
  const value = input === undefined ? {} : object(input, root, ['qzone', 'gift', 'redPackets'])
  const section = `${root}.redPackets`
  const packets = value.redPackets === undefined ? {} : object(value.redPackets, section,
    ['enabled', 'allowExplicit', 'allowRecentSearch', 'allowReferenceFallback', 'allowPasswordSend', 'recentLimit', 'automatic'])
  const recentLimit = packets.recentLimit === undefined && !Object.hasOwn(packets, 'recentLimit') ? 100 : packets.recentLimit
  if (typeof recentLimit !== 'number' || !Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > 1000) {
    throw new Error(`${section}.recentLimit 必须是 1–1000 的整数`)
  }
  const automaticSection = `${section}.automatic`
  const automatic = packets.automatic === undefined ? {} : object(packets.automatic, automaticSection, ['enabled', 'toolConfigured', 'allowPasswordSend'])
  const explicitAutomatic = packets.automatic !== undefined
  return Object.freeze({
    qzone: enabled(value.qzone, `${root}.qzone`),
    gift: enabled(value.gift, `${root}.gift`),
    redPackets: Object.freeze({
      enabled: boolean(packets, 'enabled', section, value.redPackets !== undefined),
      allowExplicit: boolean(packets, 'allowExplicit', section),
      allowRecentSearch: boolean(packets, 'allowRecentSearch', section),
      allowReferenceFallback: boolean(packets, 'allowReferenceFallback', section),
      allowPasswordSend: boolean(packets, 'allowPasswordSend', section),
      recentLimit,
      automatic: Object.freeze({
        enabled: boolean(automatic, 'enabled', automaticSection, explicitAutomatic),
        toolConfigured: boolean(automatic, 'toolConfigured', automaticSection, explicitAutomatic),
        allowPasswordSend: boolean(automatic, 'allowPasswordSend', automaticSection),
      }),
    }),
  })
}

/** Missing declarations expose no extension. Only the declared NapCat protocol is accepted. */
export function readStandaloneQqActionsConnection(input: unknown): Readonly<StandaloneQqActionsConnection> | undefined {
  if (input === undefined) return undefined
  const section = 'connections.qqActions', value = object(input, section, ['driver', 'giftDisplay', 'redPackets', 'qzone'])
  if (value.driver !== 'napcat') throw new Error(`${section}.driver 仅支持 napcat`)
  return Object.freeze({ driver: 'napcat',
    giftDisplay: boolean(value, 'giftDisplay', section),
    redPackets: boolean(value, 'redPackets', section),
    qzone: boolean(value, 'qzone', section),
  })
}
