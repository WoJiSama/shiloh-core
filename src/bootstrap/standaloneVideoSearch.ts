import { types } from 'node:util'

export interface StandaloneVideoSearchConfig { readonly enabled: boolean; readonly attachments?: boolean }

/** Anonymous public metadata and opt-in bounded attachments; no credential authority. */
export function readStandaloneVideoSearchConfig(input: unknown): Readonly<StandaloneVideoSearchConfig> {
  const fail = () => new Error('tools.videoSearch 配置无效')
  if (input === undefined) return Object.freeze({ enabled: false })
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => !['enabled', 'attachments'].includes(String(key)) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw fail()
  const enabled = Object.getOwnPropertyDescriptor(input, 'enabled')?.value
  const attachments = Object.getOwnPropertyDescriptor(input, 'attachments')?.value
  if (typeof enabled !== 'boolean' || attachments !== undefined && typeof attachments !== 'boolean') throw fail()
  return Object.freeze({ enabled, ...(attachments === undefined ? {} : { attachments }) })
}
