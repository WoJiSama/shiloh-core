import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { qqId } from './qqIdentity.js'

const lists = [
  { kind: 'group', action: 'get_group_list', id: 'group_id', name: 'group_name' },
  { kind: 'private', action: 'get_friend_list', id: 'user_id', name: 'nickname' },
] as const

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function createQqConversationNames(account: PlatformAccountRef, targets: readonly ConversationAddress[]) {
  const owner = platformAccountKey(account)
  const kinds = lists.map(list => ({ ...list, ids: new Set(targets.filter(target =>
    target.kind === list.kind && platformAccountKey(target.account) === owner && qqId(target.id) === target.id).map(target => target.id)),
    names: new Map<string, string | undefined>() }))
  const selected = kinds.filter(list => list.ids.size)

  return {
    enabled: selected.length > 0,
    read(target: ConversationAddress) {
      if (platformAccountKey(target.account) !== owner) return undefined
      return selected.find(list => list.kind === target.kind)?.names.get(target.id)
    },
    async refresh(read: (action: (typeof lists)[number]['action']) => Promise<unknown>, isCurrent: () => boolean) {
      await Promise.all(selected.map(async list => {
        const response = record(await read(list.action))
        if (!isCurrent() || response.status !== 'ok' || response.retcode !== 0 ||
            response.self_id !== undefined && qqId(response.self_id) !== account.id ||
            !Array.isArray(response.data) || response.data.length > 10_000) return
        const names = new Map<string, string | undefined>()
        for (const input of response.data) {
          const row = record(input), id = qqId(row[list.id])
          if (!id || id !== String(row[list.id]) || !list.ids.has(id) ||
              row.self_id !== undefined && qqId(row.self_id) !== account.id) continue
          const raw = row[list.name]
          const name = typeof raw === 'string' ? raw.trim() : ''
          if (!name || name === id || name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) continue
          names.set(id, names.has(id) && names.get(id) !== name ? undefined : name)
        }
        list.names = names
      }))
    },
  }
}
