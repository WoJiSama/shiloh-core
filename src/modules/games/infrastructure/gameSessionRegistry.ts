import path from 'node:path'
// 跨模块的"游戏占用群"注册表:小游戏组合根发布进行中的局,主聊天prefilter查询。
// 用进程级Symbol解耦——conversation与games两个组合根互不import,同进程内共享一份状态。
type ActiveGroupsReader = () => ReadonlySet<string>
const REGISTRY_KEY = Symbol.for('shiloh-plugin.games.activeGameGroups')

export function publishActiveGameGroups(reader:ActiveGroupsReader) {
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = reader
}

export function readActiveGameGroups():ReadonlySet<string> {
  const reader = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY]
  if (typeof reader !== 'function') return new Set()
  try {
    const value = (reader as ActiveGroupsReader)()
    return value instanceof Set ? value : new Set()
  } catch {
    return new Set()
  }
}

// One atomic claim covers all game entry paths, before their first await.
// Namespace by runtime root so isolated fixtures and separate deployments do not compete.
type GameClaim = { game: 'turtleSoup' | 'uma'; owner: object }
const CLAIMS_KEY = Symbol.for('shiloh-plugin.games.groupClaims')
function claims():Map<string,GameClaim> {
  const host = globalThis as Record<symbol, unknown>
  if (!(host[CLAIMS_KEY] instanceof Map)) host[CLAIMS_KEY] = new Map<string,GameClaim>()
  return host[CLAIMS_KEY] as Map<string,GameClaim>
}
function claimKey(groupId:string, namespace:string) { return JSON.stringify([path.resolve(namespace), String(groupId)]) }
export function ownsGameGroup(groupId:string, owner:object, namespace = process.cwd()):boolean {
  return claims().get(claimKey(groupId, namespace))?.owner === owner
}
// Validate every restored group before publishing any claim, so a conflict is all-or-nothing.
export function claimGameGroups(groupIds:readonly string[], game:GameClaim['game'], owner:object, namespace = process.cwd()):string|null {
  const registry = claims()
  const entries = groupIds.map(groupId => ({groupId, key: claimKey(groupId, namespace)}))
  for (const {groupId, key} of entries) {
    const current = registry.get(key)
    if (current && current.owner !== owner) return groupId
  }
  for (const {key} of entries) registry.set(key, {game, owner})
  return null
}
export function claimGameGroup(groupId:string, game:GameClaim['game'], owner:object, namespace = process.cwd()):boolean {
  return claimGameGroups([groupId], game, owner, namespace) === null
}
export function releaseGameGroup(groupId:string, owner:object, namespace = process.cwd()):void {
  const key = claimKey(groupId, namespace)
  if (claims().get(key)?.owner === owner) claims().delete(key)
}
