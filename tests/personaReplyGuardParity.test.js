import assert from 'node:assert/strict'
import test from 'node:test'
import { createPersonaReplyGuard } from '../dist/backend/modules/conversation/domain/personaReplyGuard.js'
import { createPersonaFeedbackModule } from '../dist/backend/modules/memory/infrastructure/personaFeedbackManager.js'
import { isToneCorrectionMessage } from '../dist/backend/modules/conversation/application/chatFailureReply.js'

test('shared domain guard and legacy manager retain the same transforms and six-response rotation', () => {
  const domain = createPersonaReplyGuard({ isToneCorrectionMessage })
  const { PersonaFeedbackManager } = createPersonaFeedbackModule({ isToneCorrectionMessage })
  const old = new PersonaFeedbackManager()
  const examples = [
    ['我不能帮你付款。', {}, {}], ['作为AI，很抱歉，我是不是太啰嗦了。你好', {}, {}],
    ['宝贝，你先休息。', {}, {}], ['原话是“宝贝，你先休息。”', {}, {}],
    ['嘿嘿，别气嘛😋', {}, { userText: '不要阴阳怪气' }],
    ['欸，别突然这么叫呀，有点不好意思啦。', {}, { botNames: ['甲'] }],
  ]
  for (const [text, config, context] of examples) assert.equal(domain.guardReply(text, config, context), old.guardReply(text, config, context))
  const context = { userText: '甲是不是机器人', botNames: ['甲'] }
  const sequence = []
  for (let index = 0; index < 7; index++) {
    const result = domain.guardReply('我才不是机器人！', {}, context)
    assert.equal(result, old.guardReply('我才不是机器人！', {}, context)); sequence.push(result)
  }
  assert.equal(new Set(sequence.slice(0, 6)).size, 6)
  assert.equal(sequence[0], sequence[6])
})

