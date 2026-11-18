import { importBilibiliHost } from './bilibiliQualitySource.mjs'
const { createModelExecutor } = await importBilibiliHost('modules/models/application/modelExecution.js')
import { removeToolPromptsFromMessages } from '../../utils/textUtils.js'
import { resolveChatCompletionUrl } from '../../utils/chatCompletionUrl.js'
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from '../../utils/agentIntelligence.js'
export function modelExecutor(fetcher = fetch, logger = { info() {}, warn() {}, error() {} }) {
  return createModelExecutor({ fetch: fetcher, logger, removeToolPromptsFromMessages,
    resolveChatCompletionUrl, resolveAgentBackend,
    shouldAcceptPlannerTextResponse, summarizeToolResultForAgent })
}
