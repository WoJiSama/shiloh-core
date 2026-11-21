import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { qqId } from './qqIdentity.js'

const lists = [
  { kind: 'group', action: 'get_group_list', id: 'group_id', name: 'group_name' },
  { kind: 'private', action: 'get_friend_list', id: 'user_id', name: 'nickname' },
] as const

type NameLookup = (action: (typeof lists)[number]['action'] | 'get_group_info', params: Record<string, unknown>) => Promise<unknown>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function displayName(raw: unknown, id: string): string | undefined {
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name && name !== id && name.length <= 128 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)
    ? name : undefined
}

export function createQqConversationNames(account: PlatformAccountRef, targets: readonly ConversationAddress[]) {
  const owner = platformAccountKey(account)
  const kinds = lists.map(list => ({ ...list, ids: new Set(targets.filter(target =>
    target.kind === list.kind && platformAccountKey(target.account) === owner && qqId(target.id) === target.id).map(target => target.id)),
    names: new Map<string, string>() }))
  const selected = kinds.filter(list => list.ids.size)
  const fromAccount = (row: Record<string, unknown>) => row.self_id === undefined || qqId(row.self_id) === account.id
  function result(value: unknown): unknown {
    const response = record(value)
    return response.status === 'ok' && response.retcode === 0 && fromAccount(response) ? response.data : undefined
  }

  return {
    enabled: selected.length > 0,
    read(target: ConversationAddress) {
      if (platformAccountKey(target.account) !== owner) return undefined
      return selected.find(list => list.kind === target.kind)?.names.get(target.id)
    },
    async refresh(read: NameLookup, isCurrent: () => boolean) {
      await Promise.all(selected.map(async list => {
        const data = result(await read(list.action, list.kind === 'group' ? { no_cache: true } : {}))
        if (!isCurrent()) return
        const fromList = new Map<string, string | undefined>()
        if (Array.isArray(data) && data.length <= 10_000) {
          for (const input of data) {
            const row = record(input), id = qqId(row[list.id])
            if (!id || id !== String(row[list.id]) || !list.ids.has(id) || !fromAccount(row)) continue
            const name = displayName(row[list.name], id)
            if (name) fromList.set(id, fromList.has(id) && fromList.get(id) !== name ? undefined : name)
          }
          for (const [id, name] of fromList) if (name) list.names.set(id, name)
        }
        if (list.kind !== 'group') return
        for (const id of list.ids) {
          if (fromList.get(id)) continue
          const row = record(result(await read('get_group_info', { group_id: id })))
          if (!isCurrent()) return
          if (!fromAccount(row) || qqId(row.group_id) !== id || String(row.group_id) !== id) continue
          const name = displayName(row.group_name, id)
          if (name) list.names.set(id, name)
        }
      }))
    },
  }
}
