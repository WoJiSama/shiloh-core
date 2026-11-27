export function createDelegatedMemoryRedis(data) {
  const read = key => data.get(key) ?? null
  return {
    async get(key) { return read(key) },
    async set(key, value) { data.set(key, value); return 'OK' },
    async del(key) { return data.delete(key) ? 1 : 0 },
    async eval(_script, { keys, arguments: args }) {
      const [key, fence] = keys
      if (keys.length === 1 && args.length === 2) {
        if ((read(key) ?? '') !== args[0]) return 0
        data.set(key, args[1])
        return 1
      }
      if (keys.length === 2 && args.length === 0) return keys.map(read)
      if (keys.length === 2 && args.length === 6) {
        const [hasCurrent, current, hasFence, expectedFence, hasNext, next] = args
        if (read(key) !== (hasCurrent === '1' ? current : null) ||
            read(fence) !== (hasFence === '1' ? expectedFence : null)) return 0
        if (hasNext === '1') data.set(key, next)
        else data.delete(key)
        return 1
      }
      throw new Error('Unexpected delegated memory Redis operation')
    },
  }
}
