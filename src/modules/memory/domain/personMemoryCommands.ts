import type { IncomingMessage } from '../../../contracts/platformMessage.js'

export const personMemoryCommandText = {
  forget: '#清空我的记忆',
  disable: '#禁用我的记忆',
  enable: '#启用我的记忆',
} as const

export type PersonMemoryCommand = keyof typeof personMemoryCommandText

export function matchPersonMemoryCommand(text: string): PersonMemoryCommand | undefined {
  return (Object.keys(personMemoryCommandText) as PersonMemoryCommand[]).find(key => personMemoryCommandText[key] === text.trim())
}

export function personMemoryCommand(input: IncomingMessage): { command: PersonMemoryCommand; standalone: boolean } | undefined {
  const text = input.text.trim()
  const command = matchPersonMemoryCommand(text)
  if (!command) return undefined
  const standalone = !input.quote && !input.mentions.length && input.parts.length > 0 &&
    input.parts.every(part => part?.kind === 'text' && typeof part.text === 'string') &&
    input.parts.map(part => part.kind === 'text' ? part.text : '').join('').trim() === text
  return { command, standalone }
}
