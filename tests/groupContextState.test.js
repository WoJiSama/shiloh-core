import test from "node:test"
import assert from "node:assert/strict"
import { createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { configuredConversationKey } from '../dist/backend/modules/conversation/domain/conversationIdentity.js'
import { createSmartConversation } from '../dist/backend/modules/conversation/application/smartConversation.js'
import { createTimingGate } from '../dist/backend/modules/conversation/infrastructure/timingGate.js'
import {
  updateGroupTopic, getGroupTopicPrompt, detectAttentionHook,
  updateGroupSocial, getGroupSocialPrompt,
  resetGroupContextStateForTests, sweepGroupContextState
} from "../utils/groupContextState.js"

test("话题关键词滚动更新并过期淘汰", () => {
  resetGroupContextStateForTests()
  for (let i = 0; i < 5; i++) updateGroupTopic({ groupId: "g1", text: "今晚吃什么 火锅还是烧烤" })
  updateGroupTopic({ groupId: "g1", text: "明天要交报告了" })
  const prompt = getGroupTopicPrompt("g1")
  assert.ok(prompt.includes("【群话题】"), "有话题前缀")
  assert.ok(prompt.includes("火锅") || prompt.includes("烧烤"), "高频词进入话题")
  assert.ok(!getGroupTopicPrompt("g-other"), "别的群没有状态")
})

test("互动状态识别对话对与话题中心", () => {
  resetGroupContextStateForTests()
  for (let i = 0; i < 3; i++) {
    updateGroupSocial({ groupId: "g2", fromUserId: "1001", atTargetIds: ["2002"] })
    updateGroupSocial({ groupId: "g2", fromUserId: "2002", atTargetIds: ["1001"] })
  }
  const prompt = getGroupSocialPrompt("g2")
  assert.ok(prompt.includes("【群互动】"), "有互动前缀")
  assert.ok(prompt.includes("话题中心"), "@得最多的人是话题中心")
})

test("reset 清空全部状态", () => {
  resetGroupContextStateForTests()
  updateGroupTopic({ groupId: "g3", text: "测试" })
  resetGroupContextStateForTests()
  assert.equal(getGroupTopicPrompt("g3"), "")
})

test('the smart QQ ingress and TimingGate isolate topic and social context across accounts, roles and revisions', async () => {
  resetGroupContextStateForTests()
  const config = { version: 1, agents: ['daily', 'work'].map(id => ({ id, personaId: 'default' })),
    connections: ['99', '303'].map(accountId => ({ id: `qq-${accountId}`, platform: 'qq', namespace: 'global', accountId })),
    bindings: ['99', '303'].map(accountId => ({ connectionId: `qq-${accountId}`, kind: 'group', conversationId: '42', agentId: 'daily' })),
  }
  const directory = createAgentBindingDirectory(config, 'first')
  const target = accountId => ({ account: { platform: 'qq', namespace: 'global', id: accountId }, kind: 'group', id: '42' })
  const first = directory.resolve(target('99'))
  const second = directory.resolve(target('303'))
  const legacy = { ...first, source: 'legacy', revision: 'legacy-v1' }
  const logger = { info() {}, warn() {}, error() {} }
  const gateRequests = []
  const gate = createTimingGate({ logger, bot: () => ({}), resolvePersonaName: () => 'bot',
    computeAddresseeSignal: () => ({ groupAddressed: false, targetKind: 'other', pronounWithoutBotAnchor: false }),
    buildPersonaTonePrompt: () => '', getGroupTopicPrompt, getGroupSocialPrompt, detectAttentionHook,
    sideLLMCall: async request => {
      gateRequests.push(request.messages.at(-1).content)
      return { ok: true, content: '{"decision":"no_action","reason":"测试"}' }
    },
  })
  const gateHost = { config: { trackAiConfig: { trackAiUrl: 'https://model.invalid/v1', trackAiModel: 'fixture', trackAiApikey: 'fixture' } },
    getPersonaFor: () => ({}), computeGroupMsgRate5min: () => 0,
    messageManager: { formatMessageHistory: async () => '' },
  }
  const state = () => ({ inFlight: true, pendingCount: 0 })
  const smartHost = { config: { enabled: true }, isUserBlacklisted: () => false, handleForbiddenWordHit: () => false,
    handleMemorySelfCorrection() {}, getSmartState: state, checkTriggers: () => false,
  }
  const smart = createSmartConversation({ logger, bot: () => ({}), anchorEventConversation() {},
    updateGroupTopic, updateGroupSocial, detectAttentionHook, resolveLongTaskFeedbackPolicy: () => null,
  })
  const incoming = (binding, msg, user, mention) => ({ _agentBinding: binding, group_id: 42, self_id: binding.target.account.id,
    user_id: user, msg, message: [{ type: 'at', qq: mention }],
  })
  await smart.handleRandomReplySmart(smartHost, incoming(first, '红色火锅', '1001', '1010'))
  await smart.handleRandomReplySmart(smartHost, incoming(first, '火锅真香', '1002', '1010'))
  await smart.handleRandomReplySmart(smartHost, incoming(second, '绿色西瓜', '2001', '2020'))
  await smart.handleRandomReplySmart(smartHost, incoming(second, '西瓜甜甜', '2002', '2020'))
  await smart.handleRandomReplySmart(smartHost, incoming(legacy, '橙味汽水', '3001', '3030'))

  const runGate = async binding => {
    await gate.runTimingGate(gateHost, incoming(binding, '今天的话题', '5001', '5050'), state())
    return gateRequests.at(-1)
  }
  const firstPrompt = await runGate(first)
  assert.match(firstPrompt, /火锅/u)
  assert.match(firstPrompt, /用户1010/u)
  assert.doesNotMatch(firstPrompt, /西瓜|汽水|用户2020|用户3030/u)
  assert.ok(detectAttentionHook({ groupId: configuredConversationKey(first) }))
  const secondPrompt = await runGate(second)
  assert.match(secondPrompt, /西瓜/u)
  assert.match(secondPrompt, /用户2020/u)
  assert.doesNotMatch(secondPrompt, /火锅|汽水|用户1010|用户3030/u)

  config.bindings[0].agentId = 'work'
  const newBinding = createAgentBindingDirectory(config, 'next').resolve(target('99'))
  const newPrompt = await runGate(newBinding)
  assert.doesNotMatch(newPrompt, /火锅|西瓜|汽水|用户1010|用户2020|用户3030/u)
  const legacyPrompt = await runGate(legacy)
  assert.match(legacyPrompt, /汽水/u)
  assert.match(legacyPrompt, /用户3030/u)
  assert.doesNotMatch(legacyPrompt, /火锅|西瓜|用户1010|用户2020/u)
  assert.equal(sweepGroupContextState(Date.now() + 31 * 60_000), 6)
  assert.equal(getGroupTopicPrompt(configuredConversationKey(first)), '')
  assert.equal(getGroupSocialPrompt(configuredConversationKey(second)), '')
})
