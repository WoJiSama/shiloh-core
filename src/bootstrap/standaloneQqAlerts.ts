import type { PlatformConnection, PlatformUserRef } from '../contracts/agentBinding.js'
import type { AlertBatch } from '../modules/runtime/infrastructure/agentFailureAlerts.js'
import { qqId } from '../adapters/qqIdentity.js'

export function resolveStandaloneQqAlertOwner(connectionId: string, connections: readonly PlatformConnection[], masters: readonly PlatformUserRef[]): PlatformUserRef {
  const connection = connections.find(candidate => candidate.id === connectionId)
  const owner = masters[0]
  if (!connection || connection.account.platform !== 'qq' || connection.account.namespace !== 'global' || masters.length !== 1 ||
      owner?.platform !== 'qq' || owner.namespace !== 'global' || qqId(owner.id) !== owner.id ||
      connections.some(candidate => candidate.account.platform === 'qq' && candidate.account.namespace === 'global' && candidate.account.id === owner.id)) {
    throw new Error('QQ 主人告警需要一个有效 QQ 连接和唯一的 bilibiliQuality.masters 主人')
  }
  return owner
}

export function formatQqOwnerAlerts(batch: AlertBatch): string {
  const lines = batch.alerts.map(alert => {
    const outcome = alert.outcome === 'unknown' ? '结果未知' : '失败'
    const details = [alert.code, alert.httpStatus === undefined ? undefined : `HTTP ${alert.httpStatus}`, alert.errorKind]
    return [`${alert.stage}/${alert.operation} ${outcome} · ${alert.count} 次`,
      details.filter(Boolean).join(' · '), alert.traceId && `trace ${alert.traceId}`].filter(Boolean).join('\n')
  })
  return ['【Agent 运行告警】', ...lines].join('\n\n')
}
