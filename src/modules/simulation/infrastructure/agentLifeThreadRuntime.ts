import { randomUUID } from 'node:crypto'
import type { AgentLifeThreadContext, AgentLifeThreadProvider } from '../../../contracts/agentLifeThread.js'
import { agentBindingToken, conversationAddressKey } from '../../runtime/domain/agentBindings.js'
import { mergeThreadSync, normalizeLifeThreads, type LifeThread } from '../domain/lifeThread.js'

export interface AgentLifeThreadStore {
  loadLifeThreads(): Promise<unknown[]>
  saveLifeThreads(threads: unknown[]): Promise<void>
}

const isDue = (thread: LifeThread, at: number, intervalMs: number) => thread.status === 'active' && at - thread.lastSyncAt >= intervalMs

/** Serialize the complete read/resolve/write operation in each actual character partition. */
export function createAgentLifeThreadRuntime(provider: AgentLifeThreadProvider, now: () => number = Date.now) {
  const pending = new Map<string, Promise<unknown>>()
  function run<T>(store: AgentLifeThreadStore, context: AgentLifeThreadContext, operation: (ensure: () => Promise<void>) => Promise<T>): Promise<T> {
    const captured = agentBindingToken(context.binding)
    const key = JSON.stringify([context.binding.agentId, conversationAddressKey(context.binding.target)])
    const current = () => !context.signal.aborted && context.isCurrent() && agentBindingToken(context.binding) === captured
    const ensure = async () => {
      if (!current()) throw new Error('生活线所属角色或权限已改变')
      await context.ensureCurrent()
      if (!current()) throw new Error('生活线所属角色或权限已改变')
    }
    const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await ensure()
      return operation(ensure)
    })
    pending.set(key, result)
    void result.finally(() => { if (pending.get(key) === result) pending.delete(key) }).catch(() => undefined)
    return result
  }
  const titleInput = (title: string) => typeof title === 'string' && title.trim().length > 0 && title.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(title)
  return {
    follow(title: string, store: AgentLifeThreadStore, context: AgentLifeThreadContext) {
      return run(store, context, async ensure => {
        if (!titleInput(title)) return { ok: false as const, error: '请提供不超过四十字的作品名' }
        title = title.trim()
        const threads = normalizeLifeThreads(await store.loadLifeThreads()); await ensure()
        const existing = threads.find(thread => thread.title.includes(title) || title.includes(thread.title))
        if (existing?.status === 'active') return { ok: false as const, error: '这部作品已经在追了' }
        if (threads.filter(thread => thread.status === 'active').length >= 3) return { ok: false as const, error: '最多同时追三部作品，请先弃掉一部' }
        const resolved = await provider.resolve({ title }, context); await ensure()
        if (!resolved.ok) return resolved
        if (!titleInput(resolved.title) || !/^[1-9][0-9]{0,15}$/u.test(resolved.sourceId) ||
            resolved.episode !== undefined && (!Number.isSafeInteger(resolved.episode) || resolved.episode < 1)) return { ok: false as const, error: '作品资料未通过核验' }
        const next = { id: existing?.id ?? `lt-${randomUUID()}`, kind: 'anime' as const, title: resolved.title, sourceId: resolved.sourceId,
          status: 'active' as const, addedAt: now(), lastSyncAt: 0, notes: [], ...(resolved.episode === undefined ? {} : { lastEpisode: resolved.episode }) }
        await ensure()
        const retained = threads.filter(thread => thread !== existing)
        await store.saveLifeThreads(normalizeLifeThreads([...retained.filter(thread => thread.status === 'active'), next,
          ...retained.filter(thread => thread.status === 'dropped').sort((a, b) => b.addedAt - a.addedAt)])); await ensure()
        return { ok: true as const, title: resolved.title }
      })
    },
    list(store: AgentLifeThreadStore, context: AgentLifeThreadContext) {
      return run(store, context, async ensure => {
        const threads = normalizeLifeThreads(await store.loadLifeThreads()); await ensure()
        return threads.map(thread => ({ title: thread.title, status: thread.status, notes: thread.notes,
          ...(thread.lastEpisode === undefined ? {} : { lastEpisode: thread.lastEpisode }) }))
      })
    },
    drop(title: string, store: AgentLifeThreadStore, context: AgentLifeThreadContext) {
      return run(store, context, async ensure => {
        if (!titleInput(title)) return { ok: false as const, error: '请提供不超过四十字的作品名' }
        const threads = normalizeLifeThreads(await store.loadLifeThreads()); await ensure()
        const selected = threads.find(thread => thread.title.includes(title.trim()) || title.trim().includes(thread.title))
        if (!selected) return { ok: false as const, error: '没有找到这部作品' }
        selected.status = 'dropped'
        await ensure(); await store.saveLifeThreads(threads); await ensure()
        return { ok: true as const }
      })
    },
    async hasDueSync(intervalMs: number, store: AgentLifeThreadStore): Promise<boolean> {
      const threads = normalizeLifeThreads(await store.loadLifeThreads()), at = now()
      return threads.some(thread => isDue(thread, at, intervalMs))
    },
    sync(intervalMs: number, store: AgentLifeThreadStore, context: AgentLifeThreadContext) {
      return run(store, context, async ensure => {
        const threads = normalizeLifeThreads(await store.loadLifeThreads()); await ensure()
        const at = now(); let dirty = false
        for (const thread of threads) {
          if (!isDue(thread, at, intervalMs)) continue
          await ensure()
          const result = await provider.sync({ sourceId: thread.sourceId, title: thread.title,
            ...(thread.lastEpisode === undefined ? {} : { lastEpisode: thread.lastEpisode }) }, context)
          await ensure()
          if ('error' in result || !Array.isArray(result.newNotes) || result.newNotes.length > 12 ||
              result.newNotes.some(note => typeof note !== 'string' || note.length > 120) ||
              result.episode !== undefined && (!Number.isSafeInteger(result.episode) || result.episode < (thread.lastEpisode ?? 1))) continue
          Object.assign(thread, mergeThreadSync(thread, result, at)); dirty = true
        }
        await ensure()
        if (dirty) { await store.saveLifeThreads(threads); await ensure() }
      })
    },
  }
}
