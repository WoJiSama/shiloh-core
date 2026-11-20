import { createRequire } from 'node:module'
import type { AgentTool } from '../../../contracts/agentTool.js'

const require = createRequire(import.meta.url)
const maxArgumentLength = 16_000

export function isAgentToolInput(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const prototype: unknown = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

export function parseAgentToolArguments(raw: unknown, maxChars = maxArgumentLength): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.length > maxChars) return undefined
  try {
    const input: unknown = JSON.parse(raw)
    return isAgentToolInput(input) ? input : undefined
  } catch { return undefined }
}

type JsonSchemaValidator = ((input: unknown) => boolean) & { readonly $async?: boolean }

export function compileToolInputSchema(schema: unknown, maxChars = Number.POSITIVE_INFINITY): (input: unknown) => boolean {
  // Use the AJV distribution and formats shipped with the MCP SDK. Resolve within the SDK for nested installs.
  const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/validation/ajv'))
  const dialect = isAgentToolInput(schema) && typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/u, '') : undefined
  const entry = dialect === 'https://json-schema.org/draft/2020-12/schema' ? 'ajv/dist/2020' :
    dialect === 'https://json-schema.org/draft/2019-09/schema' ? 'ajv/dist/2019' : 'ajv'
  const Ajv = sdkRequire(entry) as new (options: Record<string, unknown>) => { compile(schema: unknown): JsonSchemaValidator }
  const addFormats = sdkRequire('ajv-formats') as (instance: InstanceType<typeof Ajv>) => void
  // Compile independently so different definitions can use the same $id.
  const instance = new Ajv({ strict: false, ownProperties: true, validateFormats: true })
  addFormats(instance)
  const validate = instance.compile(schema)
  if (validate.$async) throw new Error('工具参数 Schema 必须支持同步校验')
  return input => {
    try {
      const serialized = JSON.stringify(input, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('参数不是有限数字')
        return value
      })
      return serialized !== undefined && serialized.length <= maxChars && validate(JSON.parse(serialized)) === true
    } catch { return false }
  }
}

type ToolSchema = Pick<AgentTool, 'parameters' | 'inputSchema'>
const validators = new WeakMap<ToolSchema, (input: unknown) => boolean>()

export function agentToolInputValidator(tool: ToolSchema): (input: unknown) => boolean {
  const cached = validators.get(tool)
  if (cached) return cached
  const serialized = JSON.stringify(tool.inputSchema ?? tool.parameters)
  if (!serialized || serialized.length > maxArgumentLength) throw new Error('Agent 工具需要有界的参数定义')
  const schema: unknown = JSON.parse(serialized)
  if (!isAgentToolInput(schema) || schema.type !== 'object') throw new Error('Agent 工具需要对象参数定义')
  const validate = compileToolInputSchema(schema, maxArgumentLength)
  const validator = (input: unknown) => isAgentToolInput(input) && validate(input)
  validators.set(tool, validator)
  return validator
}

export function validateAgentToolInput(tool: ToolSchema, input: unknown): input is Record<string, unknown> {
  try { return agentToolInputValidator(tool)(input) } catch { return false }
}
