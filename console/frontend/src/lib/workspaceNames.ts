import { computed } from 'vue'
import { workspace } from './workspace'
import type { WorkspaceAccount, WorkspaceConversation, WorkspaceTarget } from './workspaceModel'

const accountKey = (account: WorkspaceAccount) =>
  JSON.stringify([account.platform, account.namespace, account.id])
const addressKey = ({ account, kind, id }: WorkspaceTarget) =>
  JSON.stringify([account.platform, account.namespace, account.id, kind, id])
const simulationKey = (address: string) =>
  'v2.' +
  btoa(String.fromCharCode(...new TextEncoder().encode(address)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const kinds: Record<string, string> = {
  group: '群聊',
  private: '私聊',
  channel: '频道',
  thread: '话题'
}

const names = computed(() => {
  const accounts = new Map<string, string>()
  const conversations = new Map<string, string>()
  const scopes = new Map<string, WorkspaceConversation>()
  const qqGroups = new Map<string, string | undefined>()
  for (const connection of workspace.data.value?.connections ?? []) {
    if (connection.name) accounts.set(accountKey(connection.account), connection.name)
  }
  for (const agent of workspace.data.value?.agents ?? []) {
    for (const row of agent.conversations) {
      const { target } = row.binding
      const address = addressKey(target)
      scopes.set(row.scopeKey, row)
      scopes.set(address, row)
      if (target.kind !== 'private') scopes.set(simulationKey(address), row)
      if (row.name) conversations.set(address, row.name)
      if (
        target.kind === 'group' &&
        target.account.platform === 'qq' &&
        target.account.namespace === 'global'
      ) {
        const previous = qqGroups.get(target.id)
        qqGroups.set(
          target.id,
          !qqGroups.has(target.id) || previous === row.name ? row.name : undefined
        )
      }
    }
  }
  return { accounts, conversations, scopes, qqGroups }
})

export function namedId(id: string, name?: string): string {
  const label = typeof name === 'string' ? name.trim() : ''
  return label && label !== id ? `${label}（${id}）` : id
}
export const accountReference = (account: WorkspaceAccount) =>
  `${account.platform} / ${account.namespace} / ${account.id}`
export function accountLabel(account: WorkspaceAccount) {
  return namedId(accountReference(account), names.value.accounts.get(accountKey(account)))
}
export function conversationAddressLabel(target: WorkspaceTarget, fallback?: string) {
  return namedId(
    `${kinds[target.kind] || target.kind} ${target.id}`,
    names.value.conversations.get(addressKey(target)) ?? fallback
  )
}
export function conversationLabel(row: WorkspaceConversation) {
  return conversationAddressLabel(row.binding.target, row.name)
}
export function conversationSourceLabel(row: WorkspaceConversation) {
  return `连接 ${row.binding.connectionId} · 账号 ${accountLabel(row.binding.target.account)} · ${conversationLabel(row)}`
}
export function scopedConversationLabel(
  scopeKey: string,
  includeAccount = false
): string | undefined {
  const row = names.value.scopes.get(scopeKey)
  if (!row) return undefined
  const label = conversationLabel(row)
  return includeAccount ? `${label} · ${accountLabel(row.binding.target.account)}` : label
}
export function qqGroupName(id: string): string | undefined {
  return names.value.qqGroups.get(id)
}
export function qqAccountName(id: string): string | undefined {
  return names.value.accounts.get(accountKey({ platform: 'qq', namespace: 'global', id }))
}
export function workspaceRobotLabel(id: string): string {
  return namedId(id, workspace.data.value?.agents.find((row) => row.id === id)?.name)
}
