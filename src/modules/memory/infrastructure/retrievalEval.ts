import type { SemanticRuntime } from './semanticRuntime.js'

export const RETRIEVAL_EVAL_COMMAND = 'node scripts/semantic-memory-eval.mjs --dataset tests/fixtures/semantic-retrieval-benchmark.v2.json --output /tmp/core-retrieval-v2.json'
export const LEGACY_RETRIEVAL_EVAL_WARNING = '插件旧评估 legacy-v1：向量对照和延迟口径无效，历史值不可与 Core v2 比较。'

/** Kept for old importers. Never sample a live corpus, call a model or mutate recall strength. */
export async function runRetrievalEval(_runtime?: SemanticRuntime, _options: { sampleCount?: number; sampleMinChars?: number } = {}) {
  return {
    status: 'retired' as const,
    method: 'legacy-v1' as const,
    runtime: 'plugin' as const,
    message: '旧在线自出题评估已停用。请在项目根目录运行 Core v2 隔离评估；默认固定合成后端仅验证评估流程，真实模型质量需显式配置后端。',
    command: RETRIEVAL_EVAL_COMMAND,
  }
}
