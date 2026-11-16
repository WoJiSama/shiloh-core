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
      expire(keys[0])
      if (data.get(keys[0]) !== args[0]) return 0
      if (script.includes('commitment-state-v2')) {
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
