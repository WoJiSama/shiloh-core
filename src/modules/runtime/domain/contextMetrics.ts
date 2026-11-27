import type { AgentDiagnosticEvent } from '../../../contracts/agentDiagnostics.js'

type Sample = { trace: string; phase: 'first' | 'followup'; input?: number; cache?: number; estimate?: number; ms?: number; cost?: number;
  saved: number; repeated: number; requestBytes: number; systemBytes: number; schemaBytes: number; overflow: boolean }

function percentiles(values: number[]) {
  if (!values.length) return null
  values.sort((a, b) => a - b)
  return { p50: values[Math.ceil(values.length / 2) - 1]!, p95: values[Math.ceil(values.length * 0.95) - 1]! }
}

export function aggregateContextMetrics(events: readonly AgentDiagnosticEvent[]) {
  const groups = new Map<string, { platform: string; scene: string; purpose: string; model: string; route: string; samples: Sample[] }>()
  for (const event of events) {
    const details = event.details
    if (event.operation !== 'provider_context' || !details?.contextPurpose || !details.contextModel || !details.contextRoute || details.requestBytes === undefined) continue
    const target = event.scope.kind === 'conversation' ? event.scope.binding.target : undefined
    const platform = target?.account.platform ?? (event.scope.kind === 'account' ? event.scope.account.platform : 'host')
    const scene = target?.kind ?? event.scope.kind
    const key = JSON.stringify([platform, scene, details.contextPurpose, details.contextModel, details.contextRoute])
    let group = groups.get(key)
    if (!group) {
      group = { platform, scene, purpose: details.contextPurpose, model: details.contextModel, route: details.contextRoute, samples: [] }
      groups.set(key, group)
    }
    group.samples.push({ trace: JSON.stringify([event.scope, event.traceId]), phase: (details.contextRound ?? 1) <= 1 ? 'first' : 'followup',
      ...(details.inputTokens === undefined ? {} : { input: details.inputTokens }), ...(details.cachedInputTokens === undefined ? {} : { cache: details.cachedInputTokens }),
      ...(details.estimatedInputTokens === undefined ? {} : { estimate: details.estimatedInputTokens }), ...(event.durationMs === undefined ? {} : { ms: event.durationMs }),
      ...(details.pricedCostMicroCny === undefined ? {} : { cost: details.pricedCostMicroCny }),
      saved: (details.savedContextBytes ?? 0) + (details.savedToolResultBytes ?? 0), repeated: details.repeatedContextReads ?? 0,
      requestBytes: details.requestBytes, systemBytes: details.systemBytes ?? 0, schemaBytes: details.toolSchemaBytes ?? 0,
      overflow: ['context_length_exceeded', 'request_body_too_large', 'model_context_budget_exceeded', 'model_request_body_budget_exceeded'].includes(event.code ?? '') })
  }
  return [...groups.values()].sort((a, b) => b.samples.length - a.samples.length).slice(0, 32).map(({ samples, ...group }) => {
    const values = (list: Sample[], field: 'ms' | 'input' | 'estimate' | 'requestBytes' | 'systemBytes' | 'schemaBytes') =>
      list.flatMap(row => row[field] === undefined ? [] : [row[field]!])
    const summarize = (list: Sample[]) => ({ requests: list.length, inputTokens: percentiles(values(list, 'input')),
      estimatedInputTokens: percentiles(values(list, 'estimate')), latencyMs: percentiles(values(list, 'ms')),
      requestBytes: percentiles(values(list, 'requestBytes')), systemBytes: percentiles(values(list, 'systemBytes')),
      toolSchemaBytes: percentiles(values(list, 'schemaBytes')) })
    const traces = new Map<string, { input: number; estimated: number; ms: number; repeated: number; measured: boolean }>()
    let savedBytes = 0, overflow = 0, cacheTokens = 0, cacheDenominator = 0
    let priced = 0, pricedCostMicroCny = 0
    for (const sample of samples) {
      savedBytes += sample.saved
      if (sample.overflow) overflow++
      if (sample.cache !== undefined && sample.input !== undefined) { cacheTokens += sample.cache; cacheDenominator += sample.input }
      if (sample.cost !== undefined) { priced++; pricedCostMicroCny += sample.cost }
      const trace = traces.get(sample.trace) ?? { input: 0, estimated: 0, ms: 0, repeated: 0, measured: true }
      trace.input += sample.input ?? 0
      trace.estimated += sample.estimate ?? 0
      trace.ms += sample.ms ?? 0
      trace.repeated = Math.max(trace.repeated, sample.repeated)
      trace.measured &&= sample.input !== undefined
      traces.set(sample.trace, trace)
    }
    const totals = [...traces.values()]
    return { ...group, first: summarize(samples.filter(row => row.phase === 'first')), followup: summarize(samples.filter(row => row.phase === 'followup')),
      turns: { count: totals.length, inputTokens: percentiles(totals.filter(row => row.measured).map(row => row.input)),
        estimatedInputTokens: percentiles(totals.map(row => row.estimated)), latencyMs: percentiles(totals.map(row => row.ms)) },
      savedBytes, overflow, repeatedReads: totals.reduce((total, row) => total + row.repeated, 0),
      cachePercent: cacheDenominator ? Math.round(100 * cacheTokens / cacheDenominator) : null,
      pricedCostMicroCny: priced ? pricedCostMicroCny : null, priced }
  })
}
