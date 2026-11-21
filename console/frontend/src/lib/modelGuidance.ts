export interface ModelSelectionGuidance {
  purpose: string
  tier: string
  criteria: string
}

export const modelGuidance: Readonly<Record<string, ModelSelectionGuidance | undefined>> = {
  model: {
    purpose: '生成群聊和私聊回复，在开放工具的会话中决定何时调用工具。',
    tier: '强模型',
    criteria: '优先选中文表达自然、擅长理解多轮上下文、能稳定调用工具的型号。'
  },
  developmentModel: {
    purpose: '用于编程工作器修改代码、排查问题，以及生成自建文字工具。',
    tier: '擅长编程的强模型',
    criteria: '优先选能理解多个文件、准确输出代码修改和结构化结果的型号。'
  },
  vision: {
    purpose: '识别聊天图片里的画面和文字，把描述交给对话模型参考。',
    tier: '轻量或中档视觉模型',
    criteria: '需支持图片输入。经常处理截图时，优先选能准确识别中文和小字的型号。'
  },
  personMemoryExtraction: {
    purpose: '提取人物称呼、偏好等记忆。仿真的梗提取也用此模型，启用唤醒预判时默认沿用此配置。',
    tier: '中档文本模型',
    criteria: '优先选能分清发言人、忠实提取原话并稳定输出 JSON 的型号。'
  },
  midtermSummary: {
    purpose: '把近期多轮消息压缩成摘要，供后续回复接续上下文。',
    tier: '轻量模型（弱模型）',
    criteria: '优先选擅长中文摘要、能保留人物、时间和未完事项的低成本型号。'
  },
  groupMemoryExtraction: {
    purpose: '从群聊中提取群内共识，也处理群友明确要求长期记住的约定。',
    tier: '中档文本模型',
    criteria: '优先选能区分长期共识与临时闲聊、按来源原话输出结构化结果的型号。'
  },
  textTriggerModel: {
    purpose: '在群文字模式中判断该发言、等一等，还是继续旁听，也判断用户是否在跟机器人接着聊。',
    tier: '低延迟的轻量模型（弱模型）',
    criteria: '优先选能快速读懂群聊指向、稳定输出简短 JSON 判断的型号。'
  },
  trackAiConfig: {
    purpose: '根据近期消息判断用户是否在继续和机器人对话。',
    tier: '低延迟的轻量模型（弱模型）',
    criteria: '优先选能快速分清对话对象、稳定给出简短判断的型号。'
  },
  intentAiConfig: {
    purpose: '在生成回复前识别消息意图和可能需要的工具类型。',
    tier: '低延迟的轻量模型（弱模型）',
    criteria: '优先选能快速完成分类、稳定输出 JSON 的型号。'
  },
  toolsAiConfig: {
    purpose: '选择工具并填写调用参数，也用于表情包替换等决策。',
    tier: '中档模型',
    criteria: '优先选支持工具调用、能按参数要求稳定返回结果的型号。'
  },
  chatAiConfig: {
    purpose: '生成聊天回复，处理多轮对话和复杂问题。',
    tier: '强模型',
    criteria: '优先选中文表达自然、能保留多轮上下文并处理复杂推理的型号。'
  },
  imageEditAiConfig: {
    purpose: '根据文字要求修改现有图片。',
    tier: '专用图像编辑模型',
    criteria: '确认支持参考图输入和图片输出，优先选能保留原图关键细节的型号。'
  },
  imageGenerationAiConfig: {
    purpose: '根据文字描述生成图片。',
    tier: '专用生图模型',
    criteria: '按所需画质、出图速度和尺寸选择，确认渠道支持对应的图片生成接口。'
  },
  analysisAiConfig: {
    purpose: '理解图片内容，用于识图、表情包打标和内容审核。',
    tier: '中档视觉模型',
    criteria: '确认支持图片输入，优先选中文识字和分类表现稳定的型号。'
  },
  searchAiConfig: {
    purpose: '按问题查询网上资料并整理结果。',
    tier: '支持联网搜索的模型',
    criteria: '优先选结果中能提供可核对来源的型号。'
  },
  memoryAiConfig: {
    purpose: '提取长期记忆，学习不同场景里的表达偏好。',
    tier: '轻量文本模型',
    criteria: '优先选能从原话提取关键信息、稳定遵循输出格式的型号。'
  },
  embeddingAiConfig: {
    purpose: '把内容转成向量，用于知识库和表情包的语义召回。',
    tier: '文本向量模型（Embedding）',
    criteria: '优先选中文检索表现好的型号，查询和索引使用同一模型及向量维度。'
  }
}
