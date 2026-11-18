import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import { conversationAddressKey, isConversationAddress } from '../domain/agentBindings.js'

export interface AgentConversationActivityCapture {
  readonly signal: AbortSignal
  isCurrent(): boolean
  release(): void
}

/** A permission change revokes existing work permanently, including after a quick reopen. */
export function createAgentConversationActivity() {
  const states = new Map<string, { allowed: boolean; epoch: number; captures: Set<AbortController> }>()
  let defaultAllowed = true, closed = false
  const keyFor = (target: ConversationAddress) => {
    if (!isConversationAddress(target)) throw new TypeError('会话活动权限需要完整会话地址')
    return conversationAddressKey(target)
  }
  const stateFor = (key: string) => {
    let state = states.get(key)
    if (!state) { state = { allowed: defaultAllowed, epoch: 0, captures: new Set() }; states.set(key, state) }
    return state
  }
  const revoke = (state: ReturnType<typeof stateFor>) => {
    state.epoch++
    const captures = [...state.captures]
    state.captures.clear()
    for (const controller of captures) controller.abort()
  }
  return {
    allows(target: ConversationAddress): boolean {
      const key = keyFor(target)
      return !closed && (states.get(key)?.allowed ?? defaultAllowed)
    },
    capture(target: ConversationAddress): AgentConversationActivityCapture {
      const state = stateFor(keyFor(target)), epoch = state.epoch, controller = new AbortController()
      let released = false
      if (closed || !state.allowed) controller.abort()
      else state.captures.add(controller)
      return {
        signal: controller.signal,
        isCurrent: () => !released && !closed && !controller.signal.aborted && state.allowed && state.epoch === epoch,
        release() { if (released) return; released = true; state.captures.delete(controller); controller.abort() },
      }
    },
    set(target: ConversationAddress, allowed: boolean): void {
      const state = stateFor(keyFor(target))
      if (closed || state.allowed === allowed) return
      state.allowed = allowed
      revoke(state)
    },
    blockAll(): void {
      if (closed) return
      defaultAllowed = false
      for (const state of states.values()) { state.allowed = false; revoke(state) }
    },
    close(): void {
      if (closed) return
      closed = true; defaultAllowed = false
      for (const state of states.values()) { state.allowed = false; revoke(state) }
    },
  }
}
