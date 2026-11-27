type Operation =
  | { kind: 'added' | 'unique' | 'sort' | 'count' }
  | { kind: 'include' | 'exclude'; text: string }

export interface PersonalToolDefinition {
  name: string
  description: string
  steps: Operation[]
}

export function boundedPersonalToolText(value: unknown, limit = 4000): string {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('分析输入无效')
  }
  return value
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('文字工具定义无效')
  }
  return value as Record<string, unknown>
}

function label(value: unknown, limit: number): string {
  const text = boundedPersonalToolText(value, limit)
  if (!text.trim() || /[\r\n\t]/u.test(text)) throw new Error('文字工具名称或说明无效')
  return text.trim()
}

export function decodePersonalTool(value: unknown): PersonalToolDefinition {
  const row = object(value, ['name', 'description', 'steps'])
  if (!Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 8) throw new Error('文字工具步骤无效')
  const steps = row.steps.map((value: unknown, index: number): Operation => {
    const step = object(value, ['kind', 'text'])
    const kind = step.kind
    if (kind === 'include' || kind === 'exclude') return { kind, text: label(step.text, 120) }
    if (step.text !== undefined || kind !== 'added' && kind !== 'unique' && kind !== 'sort' && kind !== 'count' ||
        kind === 'count' && index !== (row.steps as unknown[]).length - 1) throw new Error('文字工具步骤无效')
    return { kind }
  })
  return { name: label(row.name, 64), description: label(row.description, 160), steps }
}

function lines(value: string): string[] {
  return boundedPersonalToolText(value).split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
}

export function executePersonalTool(tool: PersonalToolDefinition, before: string, after: string): string {
  const previous = new Set(lines(before))
  let output = lines(after)
  for (const step of tool.steps) {
    switch (step.kind) {
      case 'added': output = output.filter(line => !previous.has(line)); break
      case 'include': output = output.filter(line => line.includes(step.text)); break
      case 'exclude': output = output.filter(line => !line.includes(step.text)); break
      case 'unique': output = [...new Set(output)]; break
      case 'sort': output = output.slice().sort(); break
      case 'count': return String(output.length)
    }
  }
  return output.slice(0, 20).join('\n')
}

export function verifyPersonalToolPublication(value: unknown): PersonalToolDefinition {
  const row = object(value, ['definition', 'examples'])
  const definition = decodePersonalTool(row.definition)
  if (!Array.isArray(row.examples) || row.examples.length < 1 || row.examples.length > 4) throw new Error('文字工具缺少样例')
  for (const example of row.examples) {
    const input = object(example, ['before', 'after', 'expected'])
    const result = executePersonalTool(definition, boundedPersonalToolText(input.before), boundedPersonalToolText(input.after))
    if (result !== boundedPersonalToolText(input.expected)) throw new Error('文字工具样例检查失败')
  }
  return definition
}
