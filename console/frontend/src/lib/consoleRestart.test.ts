import { describe, expect, it } from 'vitest'
import {
  createConsoleRestartGate,
  isConfigurationRead,
  isConfigurationWrite,
  parseConfigProcessState
} from './consoleRestart'

const status = (processEpoch: string, extra = {}) => ({
  processEpoch,
  loadedRevision: 'r2',
  storedRevision: 'r2',
  requiresRestart: false,
  phase: 'active',
  ...extra
})
const saved = (requiresRestart = true) => ({
  changed: requiresRestart ? 1 : 0,
  requiresRestart,
  committedRevision: 'r2',
  processEpoch: 'p1',
  view: { revision: 'r2' }
})
function initial() {
  const gate = createConsoleRestartGate()
  gate.observe({ mode: 'standalone', processEpoch: 'p1' }, 0)
  return gate
}
describe('standalone configuration epoch gate', () => {
  it('freezes all mutations during save and allows only status/auth to reconcile configuration', () => {
    const gate = initial()
    const ticket = gate.begin()
    expect(() => gate.assertAllowed('/api/person-profiles/delete', 'POST')).toThrow()
    expect(() => gate.assertAllowed('/api/config/dice')).toThrow()
    expect(() => gate.assertAllowed('/api/config-state')).not.toThrow()
    expect(() => gate.assertAllowed('/api/auth/logout', 'POST')).not.toThrow()
    gate.complete(ticket, saved())
    expect(gate.state.phase).toBe('restart-required')
  })
  it('requires a real new process with matching loaded and stored revisions before unlocking', () => {
    const gate = initial()
    gate.complete(gate.begin(), saved())
    gate.process(status('p1'))
    expect(gate.blocked.value).toBe(true)
    expect(() => gate.process(status('p2', { loadedRevision: 'r1' }))).toThrow()
    expect(gate.blocked.value).toBe(true)
    gate.process(status('p2', { phase: 'uncertain' }))
    expect(gate.blocked.value).toBe(true)
    gate.process(status('p2'))
    expect(gate.blocked.value).toBe(true)
    gate.process(status('p3'))
    expect(gate.blocked.value).toBe(false)
    expect(gate.state.reloadGeneration).toBe(1)
    expect(gate.state.processEpoch).toBe('p3')
  })
  it('discards a read started before saving and does not freeze a no-change result', () => {
    const gate = initial(),
      generation = gate.state.generation
    gate.complete(gate.begin(), saved(false))
    expect(gate.blocked.value).toBe(false)
    expect(() => gate.observe({ mode: 'standalone', processEpoch: 'p1' }, generation)).toThrow()
    gate.invalidate()
    gate.process(status('p2', { loadedRevision: 'r3', storedRevision: 'r3' }))
    expect(gate.blocked.value).toBe(false)
  })
  it('verifies that the replacement host loaded the committed revision', () => {
    const gate = initial()
    gate.complete(gate.begin(), saved())
    gate.process(status('p2', { loadedRevision: 'r3', storedRevision: 'r3' }))
    expect(gate.blocked.value).toBe(true)
    gate.process(status('p3'))
    expect(gate.blocked.value).toBe(false)
  })
  it('keeps network, conflict and postcommit failures uncertain without automatic retry', () => {
    for (const error of [new Error('network'), { status: 409 }, { status: 500 }]) {
      const gate = initial()
      gate.failed(gate.begin(), error)
      expect(gate.state.phase).toBe('uncertain')
      gate.process(status('p1'))
      expect(gate.blocked.value).toBe(true)
    }
    const rejected = initial()
    rejected.failed(rejected.begin(), { status: 400 })
    expect(rejected.blocked.value).toBe(false)
  })
  it('detects pending restart on page reload and rejects malformed save acknowledgements', () => {
    const gate = createConsoleRestartGate()
    gate.process(status('p1', { requiresRestart: true, phase: 'restart-required' }))
    expect(gate.blocked.value).toBe(true)
    const pending = initial()
    expect(() =>
      pending.complete(pending.begin(), { requiresRestart: false, processEpoch: 'other' })
    ).toThrow()
    expect(pending.state.phase).toBe('uncertain')
  })

  it('treats commit as a write, preview as a non-write, and catalog as a configuration read', () => {
    expect(isConfigurationWrite('/api/configuration/commit', 'POST')).toBe(true)
    expect(isConfigurationWrite('/api/configuration/commit', 'GET')).toBe(false)
    expect(isConfigurationWrite('/api/configuration/preview', 'POST')).toBe(false)
    expect(isConfigurationRead('/api/configuration/catalog')).toBe(true)
    const gate = initial()
    gate.begin('/api/configuration/commit')
    expect(() => gate.assertAllowed('/api/configuration/catalog')).toThrow()
    expect(() => gate.assertAllowed('/api/configuration/preview', 'POST')).toThrow()
    expect(() => gate.assertAllowed('/api/configuration/commit', 'POST')).toThrow()
  })

  it('unlocks only a new commit explicitly rejected as candidate_stale', () => {
    const gate = initial()
    const path = '/api/configuration/commit'
    gate.failed(gate.begin(path), { status: 409, details: { error: 'candidate_stale' } }, path)
    expect(gate.state.phase).toBe('active')
    expect(gate.blocked.value).toBe(false)

    for (const [writePath, error, failurePath] of [
      [path, { status: 409, details: { error: 'conflict' } }, path],
      [path, { status: 409 }, path],
      [
        '/api/config/dice',
        { status: 409, details: { error: 'candidate_stale' } },
        '/api/config/dice'
      ],
      [path, { status: 409, details: { error: 'candidate_stale' } }, '/api/config/dice']
    ] as const) {
      const uncertain = initial()
      uncertain.failed(uncertain.begin(writePath), error, failurePath)
      expect(uncertain.state.phase).toBe('uncertain')
      expect(uncertain.blocked.value).toBe(true)
    }
  })

  it('keeps recovery locked across same-epoch clean observations', () => {
    const gate = initial()
    gate.failed(gate.begin('/api/configuration/commit'), {
      status: 503,
      details: { error: 'configuration_recovery_required' }
    })
    expect(gate.state.recoveryRequired).toBe(true)
    expect(gate.state.transaction.phase).toBe('recovery-required')
    gate.process(status('p1', { recoveryRequired: false, transaction: { phase: 'clean' } }))
    expect(gate.state.recoveryRequired).toBe(true)
    expect(gate.blocked.value).toBe(true)
    gate.process(status('p2', { recoveryRequired: false, transaction: { phase: 'clean' } }))
    expect(gate.state.recoveryRequired).toBe(false)
    expect(gate.state.transaction.phase).toBe('clean')
    expect(gate.blocked.value).toBe(false)
    expect(gate.state.reloadGeneration).toBe(1)
  })

  it('retains offline recovery metadata discovered on reload and never unlocks that same epoch', () => {
    const gate = createConsoleRestartGate()
    const transaction = {
      phase: 'blocked',
      txId: 'tx-1',
      direction: 'undo',
      reason: 'source_changed'
    }
    gate.process(
      status('p1', {
        phase: 'uncertain',
        requiresRestart: true,
        recoveryRequired: true,
        transaction
      })
    )
    expect(gate.state.transaction).toEqual(transaction)
    expect(gate.state.recoveryRequired).toBe(true)
    gate.process(status('p1'))
    expect(gate.blocked.value).toBe(true)
    expect(gate.state.recoveryRequired).toBe(true)
    expect(gate.state.transaction).toEqual(transaction)
    gate.process(status('p2', { recoveryRequired: false, transaction: { phase: 'clean' } }))
    expect(gate.blocked.value).toBe(false)
  })

  it('does not let a stale save receipt or failure change an accepted newer epoch', () => {
    const gate = initial()
    const ticket = gate.begin('/api/configuration/commit')
    gate.process(status('p2', { recoveryRequired: false, transaction: { phase: 'clean' } }))
    expect(() => gate.complete(ticket, saved())).toThrow(/配置有效期已改变/)
    gate.failed(ticket, { status: 503, details: { error: 'configuration_recovery_required' } })
    expect(gate.state.processEpoch).toBe('p2')
    expect(gate.state.phase).toBe('active')
    expect(gate.state.recoveryRequired).toBe(false)
    expect(gate.blocked.value).toBe(false)
  })

  it('locks a recovery response even outside a saving ticket', () => {
    const gate = initial()
    gate.failed(undefined, { status: 503, details: { error: 'configuration_recovery_required' } })
    expect(gate.state.recoveryRequired).toBe(true)
    expect(gate.state.phase).toBe('uncertain')
    expect(gate.blocked.value).toBe(true)
  })
})

describe('configuration process state parsing', () => {
  it('defaults old responses to a clean transaction and no recovery requirement', () => {
    expect(parseConfigProcessState(status('p1'))).toEqual({
      ...status('p1'),
      recoveryRequired: false,
      transaction: { phase: 'clean' }
    })
  })

  it('projects only validated transaction metadata', () => {
    const parsed = parseConfigProcessState(
      status('p1', {
        phase: 'uncertain',
        requiresRestart: true,
        recoveryRequired: true,
        transaction: {
          phase: 'recovery-required',
          txId: 'tx-1',
          direction: 'redo',
          reason: 'future_fixed_reason',
          privateSentinel: 'must-not-project'
        }
      })
    )
    expect(parsed.transaction).toEqual({
      phase: 'recovery-required',
      txId: 'tx-1',
      direction: 'redo',
      reason: 'future_fixed_reason'
    })
    expect(JSON.stringify(parsed)).not.toContain('must-not-project')
  })

  it.each([
    { recoveryRequired: 'true' },
    { recoveryRequired: undefined },
    { recoveryRequired: true },
    { transaction: undefined },
    { transaction: null },
    { transaction: { phase: 'unknown' } },
    { phase: ['active'] },
    { transaction: { phase: ['clean'] } },
    { transaction: { phase: 'clean', txId: '' } },
    { transaction: { phase: 'clean', direction: 'online' } },
    { transaction: { phase: 'clean', reason: 'raw error with secrets' } },
    { transaction: { phase: 'blocked' }, recoveryRequired: false },
    { transaction: { phase: 'clean' }, recoveryRequired: true },
    { loadedRevision: 'r1' },
    { requiresRestart: true }
  ])('rejects malformed or contradictory recovery state %#', (extra) => {
    expect(() => parseConfigProcessState(status('p1', extra))).toThrow(/无法核对配置状态/)
  })
})
