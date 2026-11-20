// Explicit offline provider; the evaluator never reads the bot's live configuration.
import { createAgentSemanticBackend } from '../../dist/backend/modules/memory/infrastructure/agentSemanticBackend.js'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing offline evaluation variable: ${name}`)
  return value
}
function model(prefix) {
  return { baseUrl: required(`${prefix}_URL`), name: required(`${prefix}_MODEL`), apiKey: required(`${prefix}_KEY`) }
}
function identity(value) {
  const url = new URL(value.baseUrl)
  return { model: value.name, endpoint: `${url.origin}${url.pathname}` }
}

const embedding = model('BL_EVAL_EMBEDDING')
const hasRerank = ['URL', 'MODEL', 'KEY'].some(key => process.env[`BL_EVAL_RERANK_${key}`])
const rerank = hasRerank ? model('BL_EVAL_RERANK') : undefined

export const metadata = {
  kind: 'real-model',
  embedding: identity(embedding),
  rerank: rerank ? identity(rerank) : null,
  revision: process.env.BL_EVAL_MODEL_REVISION?.trim() || 'unspecified',
}

export function createBackend() {
  return createAgentSemanticBackend({ embedding, ...(rerank ? { rerank } : {}) })
}
