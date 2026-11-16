import type { AgentMusicExtractionConfig } from '../../../contracts/agentMusicExtraction.js'
import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import { isPlatformAccount, platformAccountKey } from '../../runtime/domain/agentBindings.js'

/** Authority is supplied by the host, never inferred from group administration or message text. */
export function validateMusicExtractionConfig(input: unknown): AgentMusicExtractionConfig {
  if (input === undefined) return Object.freeze({ enabled: false, operators: Object.freeze([]) })
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['enabled', 'operators'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw new Error('musicExtraction 仅支持 enabled 和 operators')
  const row = input as Record<string, unknown>
  if (typeof row.enabled !== 'boolean' || row.operators !== undefined && (!Array.isArray(row.operators) || row.operators.length > 100)) throw new Error('音乐提取需要布尔开关及最多100个操作员身份')
  const operators = (row.operators as unknown[] | undefined ?? []).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['platform', 'namespace', 'id'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) || !isPlatformAccount(value as PlatformUserRef)) throw new Error('音乐提取操作员需要完整平台身份')
    const user = value as PlatformUserRef
    return Object.freeze({ platform: user.platform, namespace: user.namespace, id: user.id })
  })
  if (new Set(operators.map(platformAccountKey)).size !== operators.length) throw new Error('音乐提取操作员身份不能重复')
  return Object.freeze({ enabled: row.enabled, operators: Object.freeze(operators) })
}
