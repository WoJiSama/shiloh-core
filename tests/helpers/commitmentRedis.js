// Implements the store's atomic script contract, with deterministic expiration.
export function commitmentRedis(data = new Map(), now = () => Date.now()) {
  const expiry = new Map()
  const expire = key => { if ((expiry.get(key) ?? Infinity) <= now()) { data.delete(key); expiry.delete(key) } }
  return {
    async get(key) { expire(key); return data.get(key) ?? null },
    async set(key, value, options) {
      expire(key)
      if (options?.NX && data.has(key)) return null
      data.set(key, value)
      expiry.delete(key)
      if (options?.PX || options?.EX) expiry.set(key, now() + (options.PX || options.EX * 1000))
      return 'OK'
    },
    async del(key) { expiry.delete(key); return data.delete(key) },
    async eval(script, {keys, arguments: args}) {
      for (const key of keys) expire(key)
      const value = key => data.get(key) ?? null
      const expected = (flag, raw) => flag === '1' ? raw : null
      if (script.includes('commitment-cleanup-read-v1')) return keys.map(value)
      if (script.startsWith("local current=redis.call('GET',KEYS[1])") && args.length === 3) {
        if (value(keys[0]) !== expected(args[0], args[1])) return 0
        data.set(keys[0], args[2]); return 1
      }
      if (script.includes('commitment-cleanup-purge-v1')) {
        if (value(keys[0]) !== args[0]) return -1
        for (let index = 1; index <= 4; index++) if (value(keys[index]) !== expected(args[2 * index - 1], args[2 * index])) return 0
        data.set(keys[5], '1'); data.delete(keys[1]); expiry.delete(keys[1]); data.set(keys[2], args[9])
        if (args[10] === '1') data.set(keys[3], args[11])
        return 1
      }
      if (script.includes('commitment-failures-cas-v1')) {
        if (value(keys[0]) !== args[0]) return -1
        if ((value(keys[1]) ?? '') !== args[1]) return 0
        if (keys.length > 2 && value(keys[2]) !== expected(args[3], args[4])) return 0
        if (keys.length > 3 && value(keys[3]) !== null) return -2
        data.set(keys[1], args[2]); return 1
      }
      expire(keys[0])
      if (data.get(keys[0]) !== args[0]) return 0
      if (script.includes('commitment-state-v2')) {
        if (keys.length > 3) {
          if (value(keys[3]) !== expected(args[4], args[5]) || value(keys[1]) !== expected(args[6], args[7])) return 0
          if (value(keys[4]) !== null) return -1
        }
        data.set(keys[1], args[1]); data.set(keys[2], args[2])
        expiry.delete(keys[1]); if (Number(args[3])) expiry.set(keys[1], now() + Number(args[3]) * 1000)
        return 1
      }
      data.delete(keys[0]); expiry.delete(keys[0]); return 1
    },
    async *scanIterator({MATCH}) {
      const prefix = MATCH.replace(/\*$/, '')
      yield [...data.keys()].filter(key => key.startsWith(prefix))
    },
  }
}
