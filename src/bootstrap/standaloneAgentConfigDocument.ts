import YAML from 'yaml'
import type { ConfigSources } from './standaloneAgentConfigSources.js'

type Format = ConfigSources['format']

export function readStandaloneConfigDocument(source: string | undefined, format: Format): YAML.Document {
  return format === 'json' ? new YAML.Document(source === undefined ? {} : readConfigJson(source)) : YAML.parseDocument(source ?? '')
}

export function readConfigJson(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置源须为 JSON 对象')
  return value as Record<string, unknown>
}

export function encodeConfigJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item) ||
        Array.isArray(item) || item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) return item
    throw new Error('配置源包含无法转换为 JSON 的值')
  })
}

export function stringifyStandaloneConfigDocument(doc: YAML.Document, format: Format): string {
  return format === 'json' ? encodeConfigJson(doc.toJS({ maxAliasCount: 100 })) : doc.toString()
}
