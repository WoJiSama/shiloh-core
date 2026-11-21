import type { MessageActionOptions } from '../../../contracts/platformMessage.js'
import { KeyedSerialQueue } from '../../messaging/infrastructure/keyedSerialQueue.js'

export function createAgentActionExecutor(isRunning: () => boolean) {
  const sends = new KeyedSerialQueue()

  async function run<T>(options: MessageActionOptions, operation: (guard: Pick<Required<MessageActionOptions>, 'isCurrent' | 'ensureCurrent'>) => Promise<T>): Promise<T> {
    const isCurrent = () => !options.signal?.aborted && isRunning() && options.isCurrent?.() !== false
    const ensureCurrent = async () => {
      if (!isCurrent()) throw new Error('动作授权已失效')
      await options.ensureCurrent?.()
      if (!isCurrent()) throw new Error('动作授权已失效')
    }
    await ensureCurrent()
    return operation({ isCurrent, ensureCurrent })
  }

  return {
    run,
    send<T>(targetKey: string, operation: () => Promise<T>) {
      return sends.run(targetKey, operation)
    },
  }
}
