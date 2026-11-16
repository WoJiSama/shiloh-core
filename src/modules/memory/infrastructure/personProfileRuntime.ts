import type {PersonMemoryStore,PersonMemoryIdentity} from '../../../contracts/personMemory.js'
import type {PersonProfile} from '../../simulation/domain/personProfile.js'
import {filterPersonMemoryHistory} from './personMemoryContext.js'

export async function readScopedPersonProfile(store:PersonMemoryStore,userId:unknown,{groupId,viewer}:{groupId:unknown;viewer?:PersonMemoryIdentity}):Promise<PersonProfile|null> {
  const id = String(userId || '')
  if (!id || !viewer?.botId || !viewer.personaId) return null
  const result = await store.query({identity:viewer,subjectId:id,viewerUserId:id,scene:groupId ? {kind:'group',id:String(groupId)} : {kind:'private',id},portableOnly:Boolean(groupId),limit:12})
  const profile:PersonProfile = {interests:[],taboos:[],facts:[]}
  for (const entry of result.items) {
    if (entry.category === 'name') profile.name ??= entry.text
    else if (entry.category === 'interest') profile.interests!.push(entry.text)
    else if (entry.category === 'preference') profile.taboos!.push(entry.text)
    else profile.facts!.push(entry.text)
  }
  return result.items.length ? profile : null
}

export async function filterScopedProfileMessages<T extends {message_id?:unknown;content?:string;raw_message?:string;at?:unknown;time?:unknown;sender?:{user_id?:unknown}}>(
  store:PersonMemoryStore,groupId:unknown,messages:T[],viewer?:PersonMemoryIdentity
):Promise<T[]> {
  if (!viewer || !groupId) return []
  return filterPersonMemoryHistory(store,viewer,{kind:'group',id:String(groupId)},messages.map(message => ({...message,content:message.content || message.raw_message || '',sender:message.sender || {}})))
}
