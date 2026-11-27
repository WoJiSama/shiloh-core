import { createHash } from 'node:crypto'
import YAML, { isMap, isSeq, type Document } from 'yaml'
import { DEFAULT_TEMPLATES } from '../modules/dice/domain/diceReplyCatalog.js'
import { validateDiceRulePack } from '../modules/dice/infrastructure/DiceRuleSchema.js'
import { AgentConsoleError } from '../contracts/agentConsole.js'

const templates = ['dice', 'engine', 'builtin', 'templates']
const decks = ['dice', 'engine', 'builtin', 'decks']
const packages = ['dice', 'engine', 'rulePackages']
const help = ['commandHelp', 'markdown']
const builtInHelp = [
  '# 希洛指令', '',
  '## 骰子与跑团', '',
  '- `.r 1d100` 掷骰',
  '- `.ra 侦查` 检定',
  '- `.pc` 查看人物卡操作',
  '- `.draw` 查看牌堆，`.draw 牌堆名` 抽牌',
  '- `.log on` 开始团录，`.log end` 结束并导出',
].join('\n')
const field = (field: string, label: string, value: string) => ({ field, label, value, component: 'InputTextArea', secret: false })
const json = (value: unknown) => JSON.stringify(value, null, 2)
const fail = (): never => { throw new AgentConsoleError('invalid_request') }
type InstalledRule = { kind: string; source: string; trustedPackage?: { id: string } }

function installedRules(host: Document): InstalledRule[] {
  const node = host.getIn(packages, true)
  return isSeq(node) ? node.toJSON() as InstalledRule[] : []
}

function readMap<T>(host: Document, keys: string[]): Record<string, T> {
  const node = host.getIn(keys, true)
  return isMap(node) ? node.toJSON() : {}
}

export function standaloneDiceConsoleView(host: Document, kind: string) {
  if (kind === 'commands') return { title: '命令目录', fields: [field('commandHelp.markdown', '命令说明（Markdown）',
    host.getIn(help) as string ?? builtInHelp)] }
  if (kind !== 'diceAssets') return undefined
  const installed = installedRules(host)
  const native = installed.filter(row => row.kind !== 'yaml')
  const current = readMap<string>(host, templates)
  const fields = Object.entries(DEFAULT_TEMPLATES).map(([name, fallback]) => field('template.' + name, name, current[name] ?? fallback))
  return { title: '骰子回复与资产', fields: [
    field('decks', '牌堆（JSON，名称对应文字卡牌列表）', json(readMap(host, decks))),
    field('yamlRules', 'YAML 规则包（YAML 文本组成的 JSON 数组）', json(installed
      .filter(row => row.kind === 'yaml').map(row => row.source))),
    ...fields,
  ], packages: native.map(row => ({ id: row.trustedPackage?.id ?? 'unknown', kind: row.kind })) }
}

export function updateStandaloneDiceConsole(host: Document, kind: string, values: Readonly<Record<string, unknown>>): number | undefined {
  const view = standaloneDiceConsoleView(host, kind)
  if (!view) return undefined
  let changed = 0
  for (const [name, value] of Object.entries(values)) {
    const entry = view.fields.find(item => item.field === name)
    if (!entry || typeof value !== 'string' || value.length > (name === 'yamlRules' ? 192000 : name === 'decks' ? 128000 : 8000) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return fail()
    if (entry.value === value) continue
    if (kind === 'commands') host.setIn(help, value)
    else {
      if (!host.hasIn(['dice', 'engine'])) return fail()
      if (name === 'decks') {
        let data: unknown
        try { data = JSON.parse(value) } catch { return fail() }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return fail()
        host.setIn(decks, data)
      } else if (name === 'yamlRules') {
        let data: unknown
        try { data = JSON.parse(value) } catch { return fail() }
        if (!Array.isArray(data) || data.length > 16 || data.some(source => typeof source !== 'string' || !source.trim())) return fail()
        const existing = installedRules(host).filter(row => row.kind !== 'yaml')
        const loaded = data.map((source: string) => {
          let result: ReturnType<typeof validateDiceRulePack>
          try { result = validateDiceRulePack(YAML.parse(source, { maxAliasCount: 50 })) } catch { return fail() }
          if (!result.ok) return fail()
          const sourceHash = createHash('sha256').update(source).digest('hex')
          return { kind: 'yaml', source, sourceHash, revision: sourceHash.slice(0, 16) }
        })
        host.setIn(packages, [...existing, ...loaded])
      } else host.setIn([...templates, name.slice('template.'.length)], value)
    }
    changed++
  }
  return changed
}
