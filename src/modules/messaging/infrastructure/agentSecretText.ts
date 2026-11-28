/** Fixed host credentials, including common escaped encodings, cannot become outgoing text or file bodies. */
export function createAgentSecretTextCheck(secrets: readonly string[]): (text: string) => boolean {
  const variants = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]))]
  if (!variants.length) return () => true
  const length = variants.reduce((sum, value) => sum + value.length, 0)
  // Pattern operands here are fixed strings. Large credential sets keep the literal fallback.
  const pattern = variants.length > 1 && length <= 32_768
    ? new RegExp(variants.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')) : undefined
  const containsSecret = pattern ? (value: string) => pattern.test(value) : (value: string) => variants.some(secret => value.includes(secret))
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value.replace(/%([\da-f]{2})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16))) } }
  return text => {
    if (containsSecret(text)) return false
    // JSON serialization can add another escape layer to model-supplied Unicode escapes.
    const unicode = text.includes('\\') ? text.replace(/\\+u([\da-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16))) : text
    if (unicode !== text && containsSecret(unicode)) return false
    const decoded = text.includes('%') ? decode(text) : text
    if (decoded !== text && decoded !== unicode && containsSecret(decoded)) return false
    if (unicode === text || !unicode.includes('%')) return true
    const decodedUnicode = decode(unicode)
    return decodedUnicode === text || decodedUnicode === unicode || decodedUnicode === decoded || !containsSecret(decodedUnicode)
  }
}
