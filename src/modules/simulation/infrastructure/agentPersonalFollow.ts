import type { CharacterFeedItem } from '../../../contracts/characterActivities.js'
import { fetchPublicFeed, normalizePublicFeedUrl, type PublicFeedDependencies } from './characterSubscriptions.js'

export function personalFollowSource(input: unknown) {
  if (typeof input !== 'string' || input.length > 256) throw new Error('兴趣跟进需要公开项目地址')
  const github = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})(?:\/releases)?\/?$/iu.exec(input)
  if (github && github[2] !== '.' && github[2] !== '..') {
    const url = `https://github.com/${github[1]!.toLowerCase()}/${github[2]!.toLowerCase()}`
    return { kind: 'github' as const, url, feed: normalizePublicFeedUrl(url, 'github') }
  }
  const steam = /^https:\/\/store\.steampowered\.com\/app\/([1-9]\d{0,9})(?:\/[a-z0-9_-]+)?\/?$/iu.exec(input)
  if (steam && Number(steam[1]) <= 0xffffffff) {
    return { kind: 'rss' as const, url: `https://store.steampowered.com/app/${steam[1]}/`,
      feed: `https://store.steampowered.com/feeds/news/app/${steam[1]}/` }
  }
  throw new Error('兴趣跟进仅支持 GitHub 仓库或 Steam 游戏主页')
}

export function personalFollowItemUrl(source: ReturnType<typeof personalFollowSource>, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 600) return false
  if (URL.parse(value)?.href !== value) return false
  if (source.kind === 'github') {
    const prefix = `${source.url}/releases/tag/`
    return value.slice(0, prefix.length).toLowerCase() === prefix && /^[\w.%+~!$&'(),;=@/-]+$/u.test(value.slice(prefix.length))
  }
  const prefix = source.url.replace('/app/', '/news/app/') + 'view/'
  return value.startsWith(prefix) && /^\d{1,24}\/?$/u.test(value.slice(prefix.length))
}

export async function readPersonalFollowFeed(url: string, current: () => boolean, dependencies: PublicFeedDependencies = {}): Promise<CharacterFeedItem[]> {
  const source = personalFollowSource(url)
  const items = await fetchPublicFeed(source.feed, source.kind, {
    ...dependencies,
    allowRequest: request => request.href === source.feed,
    async guard() {
      await dependencies.guard?.()
      if (!current()) throw new Error('兴趣跟进已停止')
    },
  })
  if (!current()) throw new Error('兴趣跟进已停止')
  return items.filter(item => personalFollowItemUrl(source, item.url))
}
