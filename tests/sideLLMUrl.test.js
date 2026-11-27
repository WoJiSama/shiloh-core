import test from 'node:test'
import assert from 'node:assert/strict'
import { sideLLMCall } from '../dist/backend/adapters/sideLLM.js'

const okResponse = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })

test('sideLLMCall 给渠道基址补全 /chat/completions，完整地址保持不变', async () => {
  const endpoints = []
  const fetchImpl = async url => { endpoints.push(url); return okResponse() }
  await sideLLMCall({ url: 'https://open.bigmodel.cn/api/coding/paas/v4', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://open.bigmodel.cn/api/coding/paas/v4/', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://api.deepseek.com/chat/completions', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://x.test/v1', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  assert.equal(endpoints[0], 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
  assert.equal(endpoints[1], 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
  assert.equal(endpoints[2], 'https://api.deepseek.com/chat/completions')
  assert.equal(endpoints[3], 'https://x.test/v1/chat/completions')
})

test('vision can disable GLM thinking and retain metered usage for a truncated response', async () => {
  const bodies = [], usage = { prompt_tokens: 50, completion_tokens: 250, completion_tokens_details: { reasoning_tokens: 250 } }
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage }) }
  }
  const options = { apikey: 'fixture', model: 'glm-5.3-flash', maxTokens: 250, messages: [{ role: 'user', content: '描述合成图' }], fetchImpl }
  const url = 'https://open.bigmodel.cn/api/paas/v4'
  const result = await sideLLMCall({ ...options, url, disableThinking: true })
  assert.equal(result.code, 'model_response_truncated'); assert.equal(result.limit, 250); assert.deepEqual(result.usage, usage)
  await sideLLMCall({ ...options, url })
  await sideLLMCall({ ...options, url: 'https://provider.example/v1', disableThinking: true })
  assert.deepEqual(bodies.map(body => body.thinking), [{ type: 'disabled' }, undefined, undefined])
  assert.deepEqual(bodies.map(body => body.max_tokens), [250, 250, 250])
})
