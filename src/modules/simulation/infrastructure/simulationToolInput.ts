import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { compileToolInputSchema, isAgentToolInput, type ToolParameterIssue } from '../../tools/infrastructure/agentToolSchema.js'

// Includes JSON escaping for a full workspace draft and its source references.
export const SIMULATION_TOOL_INPUT_MAX_CHARS = 128_000
const validators = new Map<string, ReturnType<typeof compileToolInputSchema>>()
const schemaError = '工具参数不符合声明的 JSON Schema，未执行'

/** Only in-tree tools use their model-facing schema as the runtime contract. */
export function prepareSimulationToolInput(tool: AbstractTool, input: Record<string, unknown>, event?: unknown,
  onInvalid?: (issue: ToolParameterIssue) => void, parameters = tool.parameters): Record<string, unknown> | string {
  if (!isAgentToolInput(input)) { onInvalid?.({ rule: 'type' }); return schemaError }
  let phase = 'normalization'
  try {
    const normalized = typeof tool.normalizeParameters === 'function' ? tool.normalizeParameters(input, { event }) : input
    if (!isAgentToolInput(normalized)) { onInvalid?.({ rule: 'normalization' }); return schemaError }
    phase = 'schema_unavailable'
    // Scene tools are recreated per turn. Reuse compiled validators for identical definitions.
    const schema = JSON.stringify(parameters)
    let validate = validators.get(schema)
    if (!validate) {
      validate = compileToolInputSchema(parameters, SIMULATION_TOOL_INPUT_MAX_CHARS)
      if (validators.size < 128) validators.set(schema, validate)
    }
    if (!validate(normalized, onInvalid)) return schemaError
    phase = 'business_rule'
    let described = false
    const validation = tool.validateParameters?.(normalized, onInvalid && (issue => { described = true; onInvalid(issue) })) ?? true
    if (validation !== true && !described) onInvalid?.({ rule: phase })
    return validation === true ? normalized : validation
  } catch { onInvalid?.({ rule: phase }); return schemaError }
}
