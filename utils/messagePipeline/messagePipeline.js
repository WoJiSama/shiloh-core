import { enrichBilibiliMessageSegments, extractBilibiliShareFromSegment, extractBilibiliShareFromText } from "../bilibiliMessage.js"
import { enrichDouyinMessageSegments, extractDouyinShareFromText } from "../douyinMessage.js"
import { enrichYoutubeMessageSegments, extractYoutubeShareFromText } from "../youtubeMessage.js"
import { enrichPixivMessageSegments, extractPixivShareFromText } from "../pixivMessage.js"
import { extractXiaohongshuShareFromText } from "../xiaohongshuMessage.js"
import { createEventEnvelope, envelopeToRuntimeEvent, isEnvelopeFromBot } from "./eventEnvelope.js"
import { isResponsibleBot, isFederationSibling, markBotOnline, onlineBotList } from "../botFederation.js"
import { pluginBridge } from '../pluginBridge.js'
import { createPersonMemoryStore } from '../../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { revokePersonMemoryNotice } from '../../dist/backend/modules/memory/infrastructure/personMemoryLifecycle.js'

import { createMessagePipelineClass } from '../../dist/backend/modules/messaging/infrastructure/messagePipeline.js'
const TypedMessagePipeline = createMessagePipelineClass({
  enrichBilibili: enrichBilibiliMessageSegments, enrichDouyin: enrichDouyinMessageSegments,
  enrichYoutube: enrichYoutubeMessageSegments, enrichPixiv: enrichPixivMessageSegments,
  extractBilibiliShareFromSegment, extractBilibiliShareFromText, extractDouyinShareFromText,
  extractYoutubeShareFromText, extractPixivShareFromText, extractXiaohongshuShareFromText, createEventEnvelope,
  isResponsibleBot, isFederationSibling, markBotOnline, onlineBotList,
  onRecall: event => revokePersonMemoryNotice(createPersonMemoryStore({redis:globalThis.redis}), event,
    target => pluginBridge.instance?.getPersonaSnapshotFor?.({ message_type: target.kind, self_id: target.account.id,
      ...(target.kind === 'group' ? {group_id: target.id} : {user_id: target.id}) }))
})
export class MessagePipeline extends TypedMessagePipeline {
  constructor(options = {}) { super({ logger: globalThis.logger, ...options }) }
}
