// 承诺账本壳:dist 工厂 + Yunzai 全局注入。wakeSim/isSimulationGroup 走动态 import
// 拿仿真运行时单例(静态引用会与 localToolRegistry 形成装载环)。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {createCommitmentRuntime} from '../../dist/backend/modules/commitments/infrastructure/commitmentTool.js'
import {createPersonaLibrary} from '../../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import {resolveQqAgentBinding} from '../../dist/backend/adapters/qqAgentBinding.js'
import {findQqAccount} from '../../dist/backend/adapters/qqIdentity.js'
import {createQqMessageActionPort} from '../../dist/backend/adapters/qqMessageDelivery.js'

function readPluginSettings() {
  const root = process.cwd()
  const candidates = [
    path.join(root, 'plugins/shiloh-plugin/config/message.yaml'),
    path.join(root, 'config/message.yaml'),
    path.join(root, 'plugins/shiloh-plugin/config_default/message.yaml'),
    path.join(root, 'config_default/message.yaml')
  ]
  const configPath = candidates.find(file => fs.existsSync(file))
  if (!configPath) return {}
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'))
  return parsed && typeof parsed === 'object' ? parsed.pluginSettings || {} : {}
}

const library = createPersonaLibrary({
  libraryPath: fileURLToPath(new URL('../../config/persona-library.yaml', import.meta.url)),
  getBasePersona: () => readPluginSettings().persona || {},
})

const runtime = createCommitmentRuntime({
  redis: globalThis.redis,
  logger: globalThis.logger || {},
  getBot: id => id ? findQqAccount(globalThis.Bot, id) : globalThis.Bot,
  handlesTarget: target => !target || (target.account.platform === 'qq' && target.account.namespace === 'global'),
  resolveBinding: target => resolveQqAgentBinding(library, {
    group_id: target.id, self_id: target.account.id, message_type: target.kind,
  }).binding,
  messageActions: createQqMessageActionPort({getBotRoot: () => globalThis.Bot}),
  isSimulationGroup: async (gid, target) => {
    try {
      const { simulationRuntime } = await import('../../utils/simulationRuntime.js')
      return target ? await simulationRuntime.isConversationActive(target) : simulationRuntime.isGroupActive(gid)
    } catch { return false }
  },
  wakeSim: async (gid, card, options, target) => {
    const { simulationRuntime } = await import('../../utils/simulationRuntime.js')
    if (!simulationRuntime?.wakeForCommitment) throw new Error('仿真执行桥不可用')
    return await simulationRuntime.wakeForCommitment(gid, card, options, target)
  },
  loadConfig: () => readPluginSettings().commitments || {}
})

export const CommitmentTool = runtime.CommitmentTool
export const commitmentTick = runtime.commitmentTick
