/** Fixed host credentials, including common escaped encodings, cannot become outgoing text or file bodies. */
export function createAgentSecretTextCheck(secrets: readonly string[]): (text: string) => boolean {
  const variants = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]))]
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value.replace(/%([\da-f]{2})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16))) } }
  return text => {
    // JSON serialization can add another escape layer to model-supplied Unicode escapes.
    const unicode = text.replace(/\\+u([\da-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    return ![text, unicode, decode(text), decode(unicode)].some(value => variants.some(secret => value.includes(secret)))
  }
}
