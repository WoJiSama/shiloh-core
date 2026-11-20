import type { ChatProviderConfig, ChatRequestData, ChatMessage, ChatTool, ToolChoice } from '../../../contracts/modelGateway.js'
export function resolveChatModel(config: ChatProviderConfig = {}) {
  return String(config.providers || '').toLowerCase() === 'oneapi' ? config.chatAiConfig?.chatApiModel : undefined
}
export function buildChatRequestData(config: ChatProviderConfig = {}, messages: ChatMessage[] = [], tools?: ChatTool[], toolChoice: ToolChoice = 'auto'): ChatRequestData {
  const data: ChatRequestData = { model: resolveChatModel(config), messages, temperature: 0.7, top_p: 0.9 }
  if (config.useTools && tools?.length && toolChoice !== 'none') { data.tools = tools; data.tool_choice = toolChoice }
  return data
}

export function glmFlashJsonOptions(endpoint: URL, model: string) {
  return endpoint.hostname === 'open.bigmodel.cn' && ['glm-4.5-flash', 'glm-5.3-flash'].includes(model.trim().toLowerCase())
    ? { thinking: { type: 'disabled' as const } } : {}
}
