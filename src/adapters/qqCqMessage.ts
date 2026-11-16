const cqEscapes = new Map([['&amp;', '&'], ['&#91;', '['], ['&#93;', ']'], ['&#44;', ',']])

function decodeCqEscapes(text: string, parameter = false): string {
  const entities = parameter ? /&(?:amp|#91|#93|#44);/g : /&(?:amp|#91|#93);/g
  return text.replace(entities, entity => cqEscapes.get(entity) ?? entity)
}

/** The event reader and later source proofs must decode exactly the same neutral text. */
export function parseQqCqMessage(text: string): { type: string; data: Record<string, string> }[] {
  const message: { type: string; data: Record<string, string> }[] = []
  let offset = 0
  // Split the encoded input before decoding escapes. Decoded brackets in text stay text.
  for (const match of text.matchAll(/\[CQ:([A-Za-z0-9_-]+)((?:,[A-Za-z0-9_-]+=[^[\],]*)*)\]/g)) {
    const [, type, parameters = ''] = match
    if (!type) continue
    if (match.index > offset) {
      message.push({ type: 'text', data: { text: decodeCqEscapes(text.slice(offset, match.index)) } })
    }
    const data = Object.fromEntries(parameters.slice(1).split(',').filter(Boolean).map(parameter => {
      const equals = parameter.indexOf('=')
      return [parameter.slice(0, equals), decodeCqEscapes(parameter.slice(equals + 1), true)]
    }))
    message.push({ type, data })
    offset = match.index + match[0].length
  }
  if (offset < text.length) message.push({ type: 'text', data: { text: decodeCqEscapes(text.slice(offset)) } })
  return message
}
