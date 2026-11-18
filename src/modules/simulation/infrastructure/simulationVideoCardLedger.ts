import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import { agentBindingIdentity, conversationAddressKey } from '../../runtime/domain/agentBindings.js'
import type { SimRedisLike } from './simSessionStore.js'

const COOLDOWN = 20 * 60_000, ATTEMPT_TTL = 7 * 86_400_000
const failure = () => new Error('视频卡片发送账本不可用，未再次发送')
const claimScript = `-- simulation-video-card-claim-v1
local function record(value, timeField)
  if type(value) ~= 'table' or value.version ~= 1 or type(value.owner) ~= 'string'
    or #value.owner ~= 36 or not string.match(value.owner, '^[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+$') then return false end
  local time = value[timeField]
  if type(time) ~= 'number' or not (time >= 0 and time <= 9007199254740991) or time % 1 ~= 0 then return false end
  local count = 0
  for key, _ in pairs(value) do
    if key ~= 'version' and key ~= 'owner' and key ~= 'state' and key ~= timeField then return false end
    count = count + 1
  end
  return count == 4
end
local attempt = redis.call('GET', KEYS[1])
if attempt then
  local ok, value = pcall(cjson.decode, attempt)
  if not ok or not record(value, 'at') then return -1 end
  if value.state == 'pending' or value.state == 'unknown' then return 4 end
  if value.state == 'sent' or value.state == 'failed' then return 2 end
  return -1
end
local previous = redis.call('GET', KEYS[2])
if previous then
  local ok, value = pcall(cjson.decode, previous)
  if not ok or not record(value, 'untilAt') or (value.state ~= 'pending' and value.state ~= 'unknown' and value.state ~= 'sent') then return -1 end
  if value.untilAt > tonumber(ARGV[3]) then return 3 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[5])
return 1`
const finishScript = `-- simulation-video-card-finish-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[5])
if ARGV[4] == '' then redis.call('DEL', KEYS[2])
else redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[6]) end
return 1`

/** A pending transport attempt survives process death; it is never resumed. */
export function createSimulationVideoCardLedger(storage: SimRedisLike, now: () => number = Date.now) {
  return {
    async claim(binding: AgentBindingSnapshot, turnIdentity: string): Promise<
      | { readonly state: 'duplicate' | 'cooldown' | 'unconfirmed' }
      | { readonly state: 'claimed'; finish(receipt: DeliveryReceipt): Promise<void> }
    > {
      if (typeof storage.eval !== 'function' || typeof turnIdentity !== 'string' || !turnIdentity || turnIdentity.length > 16_384) throw failure()
      const at = now()
      if (!Number.isSafeInteger(at) || at < 0) throw failure()
      const scope = createHash('sha256').update(JSON.stringify([conversationAddressKey(binding.target), agentBindingIdentity(binding)])).digest('hex')
      const turn = createHash('sha256').update(turnIdentity).digest('hex')
      const attemptKey = `shiloh:sim:video-card:v1:${scope}:attempt:${turn}`, cooldownKey = `shiloh:sim:video-card:v1:${scope}:cooldown`
      const owner = randomUUID(), untilAt = at + COOLDOWN
      const pending = JSON.stringify({ version: 1, owner, state: 'pending', at })
      const cooldown = JSON.stringify({ version: 1, owner, state: 'pending', untilAt })
      let result: number
      try { result = Number(await storage.eval(claimScript, { keys: [attemptKey, cooldownKey], arguments: [pending, cooldown, String(at), String(ATTEMPT_TTL), String(COOLDOWN)] })) }
      catch { throw failure() }
      if (result === 2) return { state: 'duplicate' }
      if (result === 3) return { state: 'cooldown' }
      if (result === 4) return { state: 'unconfirmed' }
      if (result !== 1) throw failure()
      let finished = false
      return {
        state: 'claimed',
        async finish(receipt: DeliveryReceipt) {
          if (finished) throw failure()
          finished = true
          const state = receipt.state === 'failed' ? 'failed' : receipt.state === 'sent' ? 'sent' : 'unknown'
          const final = JSON.stringify({ version: 1, owner, state, at })
          const remaining = Math.max(1, untilAt - now())
          const nextCooldown = state === 'failed' ? '' : JSON.stringify({ version: 1, owner, state, untilAt })
          try {
            if (!Number.isSafeInteger(remaining) || Number(await storage.eval!(finishScript, { keys: [attemptKey, cooldownKey], arguments: [pending, cooldown, final, nextCooldown, String(ATTEMPT_TTL), String(remaining)] })) !== 1) throw failure()
          } catch { throw failure() }
        },
      }
    },
  }
}
