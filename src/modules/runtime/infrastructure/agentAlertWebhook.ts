import { createAgentFailureAlerts } from './agentFailureAlerts.js'

export function parseAgentAlertWebhookUrl(value: string): URL {
  const invalid = () => new Error('BL_AGENT_ALERT_WEBHOOK_URL 无效：需要 HTTPS 或本机回环 HTTP 地址')
  let url: URL
  try { url = new URL(value) } catch { throw invalid() }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.hash) throw invalid()
  return url
}

export function createAgentAlertWebhook(options: {
  url: URL
  fetchImpl?: typeof fetch
  allowsLabel?: (label: string) => boolean
  logger?: Pick<Console, 'error'> & Partial<Pick<Console, 'info'>>
}) {
  const endpoint = parseAgentAlertWebhookUrl(options.url.href).href
  const fetcher = options.fetchImpl ?? fetch
  return createAgentFailureAlerts({ ...options, channel: 'webhook', async deliver(batch, signal) {
    const response = await fetcher(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'idempotency-key': batch.id },
      body: JSON.stringify(batch),
    })
    void response.body?.cancel().catch(() => {})
    return response.ok ? { state: 'confirmed' } : { state: 'failed', code: `http=${response.status}` }
  } })
}
