import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { compileToolInputSchema, isAgentToolInput } from '../../tools/infrastructure/agentToolSchema.js'

// Includes JSON escaping for a full workspace draft and its source references.
export const SIMULATION_TOOL_INPUT_MAX_CHARS = 128_000
const validators = new Map<string, (input: unknown) => boolean>()
const schemaError = '工具参数不符合声明的 JSON Schema，未执行'

/** Only in-tree tools use their model-facing schema as the runtime contract. */
export function prepareSimulationToolInput(tool: AbstractTool, input: Record<string, unknown>, event?: unknown): Record<string, unknown> | string {
  if (!isAgentToolInput(input)) return schemaError
  try {
    const normalized = typeof tool.normalizeParameters === 'function' ? tool.normalizeParameters(input, { event }) : input
    if (!isAgentToolInput(normalized)) return schemaError
    // Scene tools are recreated per turn. Reuse compiled validators for identical definitions.
    const schema = JSON.stringify(tool.parameters)
    let validate = validators.get(schema)
    if (!validate) {
      validate = compileToolInputSchema(tool.parameters, SIMULATION_TOOL_INPUT_MAX_CHARS)
      if (validators.size < 128) validators.set(schema, validate)
    }
    if (!validate(normalized)) return schemaError
    const validation = tool.validateParameters?.(normalized) ?? true
    return validation === true ? normalized : validation
  } catch { return schemaError }
}
