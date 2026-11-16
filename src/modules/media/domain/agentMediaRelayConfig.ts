import type { AgentMediaRelayConfig } from '../../../contracts/agentMediaRelayWorkflow.js'

export function validateAgentMediaRelayConfig(value: unknown): Readonly<AgentMediaRelayConfig> {
  if (value === undefined) return Object.freeze({ enabled: false })
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error()
    for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !['enabled', 'providers'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) throw Error()
    const enabled = (value as Record<string, unknown>).enabled
    if (typeof enabled !== 'boolean') throw Error()
    const providers = (value as Record<string, unknown>).providers
    if (providers === undefined) return Object.freeze({ enabled })
    if (!Array.isArray(providers) || Object.getPrototypeOf(providers) !== Array.prototype || providers.length < 1 || providers.length > 5 ||
        Reflect.ownKeys(providers).length !== providers.length + 1) throw Error()
    const normalized: NonNullable<AgentMediaRelayConfig['providers']>[number][] = []
    for (let index = 0; index < providers.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(providers, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv'].includes(descriptor.value) || normalized.includes(descriptor.value)) throw Error()
      normalized.push(descriptor.value)
    }
    return Object.freeze({ enabled, providers: Object.freeze(normalized) })
  } catch { throw new Error('媒体搬运配置仅接受enabled布尔值与受支持的providers列表') }
}
