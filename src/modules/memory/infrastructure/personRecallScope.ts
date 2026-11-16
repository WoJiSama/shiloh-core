import type { ChatTurnEvent,ChatTurnHost } from '../../../contracts/chatTurn.js'
import type { PersonaSnapshot } from '../../../contracts/persona.js'

/** Bounds are supplied by runtime identities, never by model-selected group IDs. */
export async function resolvePersonRecallGroups(host:Pick<ChatTurnHost,'memoryManager'|'getPersonaSnapshotFor'>,event:ChatTurnEvent,viewer:PersonaSnapshot) {
  const subjectId = String(event.user_id || '')
  const remembered = await host.memoryManager?.personMemory?.scenes({identity:viewer,subjectId,viewerUserId:subjectId,scene:{kind:'private',id:subjectId}}) || []
  const allowed = new Set(remembered.filter(scene => scene.kind === 'group').map(scene => scene.id))
  const legacy = new Set<string>()
  if (String(event.bot.uin || event.self_id || '') === viewer.botId && host.getPersonaSnapshotFor) {
    for (const groupId of event.bot.gl?.keys() || []) {
      const source = host.getPersonaSnapshotFor({...event,message_type:'group',group_id:groupId})
      if (source.botId !== viewer.botId || source.personaId !== viewer.personaId) continue
      allowed.add(String(groupId))
      legacy.add(String(groupId))
    }
  }
  return {allowedGroupIds:[...allowed],legacyGroupIds:[...legacy]}
}
