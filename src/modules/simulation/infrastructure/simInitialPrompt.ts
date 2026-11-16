import { randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import { agentBindingIdentity, agentBindingToken } from '../../runtime/domain/agentBindings.js'
import { simulationAddressKey } from './simulationAddress.js'
import type { SimRedisLike } from './simSessionStore.js'

export const simulationInitialPromptKey = (groupId: string) => `shiloh:sim:g:${groupId}:init`
export const simulationInitialPromptApplicationKey = (groupId: string) => `${simulationInitialPromptKey(groupId)}-application`
export const SIM_INITIAL_PROMPT_MAX_CHARS = 2000

interface InitialPromptApplication {
  bindingIdentity: string
  bindingToken: string
  applicationId: string
  pending: boolean
}

export const encodeInitialPromptApplication = (binding: AgentBindingSnapshot, pending: boolean): string =>
  JSON.stringify({ bindingIdentity: agentBindingIdentity(binding), bindingToken: agentBindingToken(binding), applicationId: randomUUID(), pending })

function decodeApplication(raw: string | null): InitialPromptApplication | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('bindingIdentity' in value) || !('bindingToken' in value) || !('applicationId' in value) ||
        !('pending' in value) || typeof value.bindingIdentity !== 'string' || typeof value.bindingToken !== 'string' || typeof value.applicationId !== 'string' ||
        !value.applicationId || typeof value.pending !== 'boolean') return undefined
    return { bindingIdentity: value.bindingIdentity, bindingToken: value.bindingToken, applicationId: value.applicationId, pending: value.pending }
  } catch { return undefined }
}

const compareApplication = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[2], ARGV[3])
return 1`

const editTemplate = `
if ARGV[1] == '' then
  redis.call('DEL', KEYS[1], KEYS[2])
else
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2])
end
return 1`

const resetWithPrompt = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[3], ARGV[3])
redis.call('SET', KEYS[2], ARGV[4])
return 1`

function promptKeys(groupId: string): [string, string] {
  return [simulationInitialPromptKey(groupId), simulationInitialPromptApplicationKey(groupId)]
}

export function createInitialPromptStore(redis: SimRedisLike) {
  async function read(groupId: string, binding: AgentBindingSnapshot) {
    if (binding.source !== 'configured' || simulationAddressKey(binding.target) !== groupId) return undefined
    const keys = promptKeys(groupId)
    const [promptKey, applicationKey] = keys
    const [rawPrompt, rawApplication] = await Promise.all([redis.get(promptKey), redis.get(applicationKey)])
    const application = decodeApplication(rawApplication)
    if (!rawPrompt || rawPrompt.length > SIM_INITIAL_PROMPT_MAX_CHARS ||
        rawApplication === null || application?.bindingIdentity !== agentBindingIdentity(binding)) return undefined
    return { prompt: rawPrompt, rawApplication, application, keys }
  }

  return {
    async edit(groupId: string, text: string, binding: AgentBindingSnapshot) {
      if (!redis.eval) throw new Error('独立仿真初始说明需要原子写入')
      if (binding.source !== 'configured' || simulationAddressKey(binding.target) !== groupId) throw new Error('初始提示词与会话绑定不一致')
      const value = text.trim().slice(0, SIM_INITIAL_PROMPT_MAX_CHARS)
      await redis.eval(editTemplate, { keys: promptKeys(groupId), arguments: [value, encodeInitialPromptApplication(binding, false)] })
    },
    async resetAndRearm(groupId: string, binding: AgentBindingSnapshot, session: { key: string; value: string }): Promise<boolean> {
      const snapshot = await read(groupId, binding)
      if (!snapshot || !redis.eval) return false
      const written = await redis.eval(resetWithPrompt, {
        keys: [...snapshot.keys, session.key],
        arguments: [snapshot.prompt, snapshot.rawApplication, session.value, encodeInitialPromptApplication(binding, true)],
      })
      if (Number(written) !== 1) throw new Error('初始提示词已变化，请重新重置会话')
      return true
    },
    async claim(groupId: string, binding: AgentBindingSnapshot) {
      const snapshot = await read(groupId, binding)
      if (!snapshot?.application.pending || snapshot.application.bindingToken !== agentBindingToken(binding) || !redis.eval) return undefined
      const evaluate = redis.eval.bind(redis)
      const compare = (from: string, to: string) => evaluate(compareApplication, {
        keys: snapshot.keys, arguments: [snapshot.prompt, from, to],
      })
      const consumed = JSON.stringify({ ...snapshot.application, pending: false })
      if (Number(await compare(snapshot.rawApplication, consumed)) !== 1) return undefined
      return {
        text: snapshot.prompt,
        async isCurrent() {
          const [promptKey, applicationKey] = snapshot.keys
          const [prompt, application] = await Promise.all([redis.get(promptKey), redis.get(applicationKey)])
          return prompt === snapshot.prompt && application === consumed
        },
        restore: () => compare(consumed, snapshot.rawApplication),
      }
    },
  }
}
