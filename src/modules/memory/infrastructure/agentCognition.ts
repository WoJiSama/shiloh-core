import { createHash } from 'node:crypto'
import type { AgentCognition, CognitionConsolidator, CognitionGuard, CognitionNode, CognitionRedis, CognitionSource, CognitionState, CognitionTurnProjection } from '../../../contracts/agentCognition.js'
import { conversationAddressKey } from '../../runtime/domain/agentBindings.js'
import { cognitionLinkIsDependency, cognitionSourceId, invalidateCognitionState, recordCognitionSources } from '../domain/cognitionState.js'
import { applyCognitionProposals } from '../domain/cognitionSelf.js'
import { buildCognitionRecall } from '../domain/cognitionRecall.js'
import { createCognitionStore } from './cognitionStore.js'
import { createCognitionConsolidation } from './cognitionConsolidation.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const current = (guard: CognitionGuard) => !guard.signal?.aborted && guard.isCurrent()
async function check(guard: CognitionGuard) {
  if (!current(guard)) throw new Error('认知资料权限已改变')
  await guard.ensureCurrent?.()
  if (!current(guard)) throw new Error('认知资料权限已改变')
}

/** Walk only evidence edges, never a related/person association into a private scene. */
function evidence(state: CognitionState, ids: readonly string[]) {
  const sources = new Map(state.sources.map(source => [source.id, source]))
  const nodes = new Map(state.nodes.map(node => [node.id, node]))
  const visited = new Set<string>(), queue = [...ids], result: CognitionSource[] = []
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    if (visited.has(id)) continue
    visited.add(id)
    if (visited.size > 256) throw new Error('认知证据展开超过上限')
    const source = sources.get(id), node = nodes.get(id)
    if (source) {
      if (source.status !== 'active') throw new Error('认知来源已撤销')
      result.push(source)
    } else if (node) {
      if (node.status === 'invalid') throw new Error('认知节点已改变')
      queue.push(...node.sourceIds)
    } else throw new Error('认知证据缺失')
    for (const link of state.links) if (link.to === id && cognitionLinkIsDependency(link, nodes)) queue.push(link.from, ...link.sourceIds)
  }
  return { sources: result, nodes: state.nodes.filter(node => visited.has(node.id)), ids: visited }
}
export function cognitionCharacterReference(node: CognitionNode): { kind: 'memory' | 'goal' | 'receipt'; id: string } | undefined {
  const parts = /^character:[a-f0-9]{24}:(memory|goal|receipt):(.+):[a-f0-9]{16}$/u.exec(node.id)
  return parts ? { kind: parts[1] as 'memory' | 'goal' | 'receipt', id: parts[2]! } : undefined
}
function fingerprint(state: CognitionState, ids: Set<string>): string {
  const nodes = new Map(state.nodes.map(node => [node.id, node]))
  return hash({ sources: state.sources.filter(item => ids.has(item.id)), nodes: state.nodes.filter(item => ids.has(item.id)),
    links: state.links.filter(link => ids.has(link.to) && cognitionLinkIsDependency(link, nodes)) })
}

/** One Core entry point. Persistence is shared; model scheduling stays with the existing runtime. */
export function createAgentCognition(ports: {
  redis: CognitionRedis
  canUseSource(source: CognitionSource, guard: CognitionGuard): Promise<boolean> | boolean
  canUseNode?(node: CognitionNode, guard: CognitionGuard): Promise<boolean> | boolean
  allowsText?(text: string): boolean
  model?: CognitionConsolidator
  now?(): number
}): AgentCognition & { projectTurn(input: CognitionTurnProjection, guard: CognitionGuard): Promise<void> } {
  const store = createCognitionStore(ports.redis), now = ports.now ?? Date.now
  const allowed = async (state: CognitionState, ids: readonly string[], guard: CognitionGuard) => {
    await check(guard)
    const proof = evidence(state, ids)
    for (const node of proof.nodes) if (ports.allowsText?.(node.content) === false || ports.canUseNode && !await ports.canUseNode(node, guard)) return false
    for (const source of proof.sources) {
      if (ports.allowsText?.(source.content) === false || !await ports.canUseSource(source, guard)) return false
      await check(guard)
    }
    return true
  }
  const service: AgentCognition = {
    async record(sources, guard) {
      await check(guard)
      if (!sources.length) return
      const agentId = sources[0]!.agentId
      for (const source of sources) if (source.agentId !== agentId || ports.allowsText?.(source.content) === false || !await ports.canUseSource(source, guard)) throw new Error('认知来源不可用')
      await store.update(agentId, state => recordCognitionSources(state, sources), guard)
    },
    async propose(agentId, conversation, proposals, guard) {
      const snapshot = await store.read(agentId), sourceIds = [...new Set(proposals.flatMap(proposal => [...proposal.sourceIds, ...(proposal.targetId ? [proposal.targetId] : [])]))]
      if (!await allowed(snapshot, sourceIds, guard) || proposals.some(proposal => ports.allowsText?.(proposal.content) === false)) throw new Error('认知提案来源不可用')
      const stamp = fingerprint(snapshot, evidence(snapshot, sourceIds).ids)
      const originalSources = evidence(snapshot, sourceIds).sources
      const admitted = { ...guard, ensureCurrent: async () => {
        await check(guard)
        const fresh = await store.read(agentId)
        if (fresh.privacyRevision !== snapshot.privacyRevision || originalSources.some(source => JSON.stringify(fresh.sources.find(item => item.id === source.id)) !== JSON.stringify(source)) || !await allowed(fresh, sourceIds, guard)) throw new Error('认知提案来源已改变')
      } }
      await store.update(agentId, state => {
        if (fingerprint(state, evidence(state, sourceIds).ids) !== stamp) throw new Error('认知提案快照已改变')
        return applyCognitionProposals(state, conversation, proposals, now())
      }, admitted)
    },
    async recall(query, guard) {
      await check(guard)
      const state = await store.read(query.agentId)
      const candidates = buildCognitionRecall(state, { ...query, limit: 30 }, state.sources.filter(source => source.status === 'active').map(source => source.id))
      const permitted = new Set<string>(), permittedNodes = new Set<string>()
      for (const node of candidates.nodes) {
        if (ports.allowsText?.(node.content) === false) continue
        try { if (await allowed(state, [node.id], guard)) { permittedNodes.add(node.id); for (const id of node.sourceIds) permitted.add(id) } } catch { await check(guard) }
      }
      const selected = buildCognitionRecall(state, query, [...permitted], [...permittedNodes])
      const proof = evidence(state, selected.nodes.map(node => node.id)), stamp = fingerprint(state, proof.ids)
      return { ...selected, revision: state.revision, async isCurrent() {
        try {
          await check(guard)
          const fresh = await store.read(query.agentId)
          if (fresh.privacyRevision !== state.privacyRevision || fingerprint(fresh, proof.ids) !== stamp) return false
          return await allowed(fresh, selected.nodes.map(node => node.id), guard)
        } catch { return false }
      } }
    },
    async invalidate(agentId, change, guard) {
      await store.update(agentId, state => invalidateCognitionState(state, change), guard)
    },
    async consolidate(agentId, conversation, guard, model = ports.model) {
      if (!model) return
      const proofState = await store.read(agentId)
      const usedNodes: CognitionNode[] = []
      const consolidationGuard: CognitionGuard = { ...guard, ensureCurrent: async () => {
        await check(guard)
        for (const node of usedNodes) if (!await allowed(proofState, [node.id], guard)) throw new Error('认知整理的当前条目已不可用')
      } }
      const consolidation = createCognitionConsolidation({ store,
        model: async (input, modelGuard) => {
          const currentNodes: CognitionNode[] = []
          for (const node of input.current) if (await allowed(proofState, [node.id], modelGuard)) currentNodes.push(node)
          usedNodes.push(...currentNodes)
          const proposals = await model({ sources: input.sources, current: currentNodes }, modelGuard)
          await check(modelGuard)
          if (proposals.some(proposal => ports.allowsText?.(proposal.content) === false)) throw new Error('认知整理内容不可用')
          for (const proposal of proposals) if (proposal.targetId && !currentNodes.some(node => node.id === proposal.targetId)) throw new Error('认知整理目标已不可用')
          return proposals
        },
        canUseSource: async (source, sourceGuard) => {
          if (!proofState.sources.some(saved => saved.id === source.id && saved.revision === source.revision && saved.status === 'active')) return false
          return allowed(proofState, [source.id], sourceGuard)
        }, now,
      })
      await consolidation.consolidate(agentId, conversation, consolidationGuard)
    },
  }

  async function projectTurn(input: CognitionTurnProjection, guard: CognitionGuard): Promise<void> {
    await check(guard)
    const { agentId, conversation, character } = input, scene = conversationAddressKey(conversation)
    const prefix = `character:${hash([agentId, scene]).slice(0, 24)}:`
    await store.update(agentId, before => {
      let state = before
      const sourceById = new Map(state.sources.map(source => [source.id, source]))
      const receipts = character.receipts.filter(receipt => receipt.status !== 'pending')
      const receiptSources = receipts.map(receipt => {
        const nativeId = `receipt:${receipt.id}`, id = cognitionSourceId(agentId, conversation, 'receipt', nativeId)
        const content = JSON.stringify({ toolName: receipt.toolName, status: receipt.status, summary: receipt.summary, goalId: receipt.goalId ?? null })
        const previous = sourceById.get(id)
        return { id, agentId, conversation, nativeId, kind: 'receipt' as const, authorId: conversation.account.id,
          occurredAt: previous?.occurredAt ?? receipt.at, content, revision: previous ? previous.revision + Number(previous.content !== content) : 1,
          participantIds: [], status: 'active' as const }
      }).filter(source => ports.allowsText?.(source.content) !== false)
      state = recordCognitionSources(state, receiptSources)
      const sources = new Map(state.sources.map(source => [source.id, source]))
      const messageIds = new Map(input.messageRefs.map(ref => [`message:${ref.seq}`, cognitionSourceId(agentId, conversation, 'message', ref.messageId)]))
      const receiptIds = new Map(receipts.map(receipt => [`receipt:${receipt.id}`, cognitionSourceId(agentId, conversation, 'receipt', `receipt:${receipt.id}`)]))
      const memories = new Map(character.memories.map(memory => [memory.id, memory]))
      const resolve = (refs: readonly string[], seen = new Set<string>()): string[] => {
        const result = new Set<string>()
        for (const ref of refs) {
          if (seen.has(ref)) return []
          seen.add(ref)
          const id = messageIds.get(ref) ?? receiptIds.get(ref)
          if (id && sources.get(id)?.status === 'active') result.add(id)
          else if (ref.startsWith('memory:')) {
            const memory = memories.get(ref.slice(7))
            const prior = state.nodes.find(node => node.id.startsWith(`${prefix}${ref}:`) && node.status === 'active' && node.content === memory?.content)
            const nested = prior?.sourceIds ?? (memory ? resolve(memory.evidenceRefs, new Set(seen)) : [])
            if (!nested.length || nested.some(sourceId => sources.get(sourceId)?.status !== 'active')) return []
            for (const sourceId of nested) result.add(sourceId)
          } else return []
        }
        return [...result]
      }
      const projected = new Set<string>(), projectedById = new Map<string, CognitionNode>()
      const addNode = (logicalId: string, kind: CognitionNode['kind'], content: string, topic: string, epistemic: CognitionNode['epistemic'], sourceIds: string[], createdAt: number, updatedAt: number) => {
        const prior = state.nodes.find(node => node.id.startsWith(`${prefix}${logicalId}:`) && node.content === content && node.updatedAt === updatedAt)
        if (prior) {
          if (prior.status !== 'active' || prior.sourceIds.some(id => sources.get(id)?.status !== 'active' || sources.get(id)?.revision !== prior.sourceVersions[id])) return
          sourceIds = [...prior.sourceIds]
        }
        if (!sourceIds.length || ports.allowsText?.(content) === false) return
        const sourceVersions = Object.fromEntries(sourceIds.map(id => [id, sources.get(id)!.revision]))
        const id = `${prefix}${logicalId}:${hash([content, sourceVersions, updatedAt]).slice(0, 16)}`
        projected.add(id)
        const saved = state.nodes.find(node => node.id === id)
        if (saved) { if (saved.status === 'active') projectedById.set(logicalId, saved); return }
        const node: CognitionNode = { id, kind, content, topic, epistemic, conversation, audience: 'scene', sourceIds, sourceVersions, status: 'active', createdAt, updatedAt }
        projectedById.set(logicalId, node)
        state.nodes.push(node)
        for (const sourceId of sourceIds) state.links.push({ id: `link:${hash([sourceId, id])}`, from: sourceId, to: id, kind: kind === 'receipt' ? 'result' : 'supports', sourceIds: [sourceId] })
      }
      for (const memory of character.memories) if (!character.memories.some(other => other.supersedes === memory.id)) addNode(`memory:${memory.id}`, memory.kind, memory.content, memory.kind, memory.epistemic, resolve(memory.evidenceRefs), memory.createdAt, memory.updatedAt)
      for (const goal of character.goals) addNode(`goal:${goal.id}`, 'goal', JSON.stringify({ title: goal.title, nextStep: goal.nextStep, status: goal.status, outcome: goal.lastOutcome ?? null }), goal.title, 'desired', resolve(goal.evidenceRefs), goal.createdAt, goal.updatedAt)
      for (const receipt of receipts) {
        const id = receiptIds.get(`receipt:${receipt.id}`)!
        if (sources.get(id)?.status === 'active') addNode(`receipt:${receipt.id}`, 'receipt', sources.get(id)!.content, receipt.toolName, 'reported', [id], receipt.at, receipt.at)
      }
      const connect = (from: CognitionNode | undefined, to: CognitionNode | undefined, kind: 'motivates' | 'result') => {
        if (!from || !to) return
        const id = `link:${hash([from.id, to.id, kind])}`
        if (!state.links.some(link => link.id === id)) state.links.push({ id, from: from.id, to: to.id, kind, sourceIds: [...new Set([...from.sourceIds, ...to.sourceIds])] })
      }
      for (const goal of character.goals) for (const ref of goal.evidenceRefs) if (ref.startsWith('memory:')) connect(projectedById.get(ref), projectedById.get(`goal:${goal.id}`), 'motivates')
      for (const receipt of receipts) if (receipt.goalId) connect(projectedById.get(`goal:${receipt.goalId}`), projectedById.get(`receipt:${receipt.id}`), 'result')
      // A committed record can evolve without withdrawing the independently
      // confirmed outcomes attached to it. Retain the old immutable snapshot,
      // but connect current records only to their current versions.
      const replaced = new Set<string>()
      if (!input.preserveCharacter) for (const node of state.nodes) {
        if (!node.id.startsWith(prefix) || node.status !== 'active' || projected.has(node.id)) continue
        const reference = cognitionCharacterReference(node)
        if (reference && projectedById.has(`${reference.kind}:${reference.id}`)) { node.status = 'superseded'; replaced.add(node.id) }
      }
      state.links = state.links.filter(link => !(replaced.has(link.from) || replaced.has(link.to)) || !['motivates', 'result'].includes(link.kind))
      const removed = new Set(state.nodes.filter(node => !input.preserveCharacter && node.id.startsWith(prefix) && node.status === 'active' && !projected.has(node.id)).map(node => node.id))
      if (removed.size) {
        const queue = [...removed], downstreamSources = new Set<string>()
        const nodes = new Map(state.nodes.map(node => [node.id, node]))
        for (let index = 0; index < queue.length; index++) for (const link of state.links) if (link.from === queue[index] && cognitionLinkIsDependency(link, nodes) && !removed.has(link.to)) {
          removed.add(link.to); queue.push(link.to)
          if (sources.has(link.to)) downstreamSources.add(link.to)
        }
        if (downstreamSources.size) state = invalidateCognitionState(state, { id: `projection:${hash([...removed].sort())}`, sourceIds: [...downstreamSources], before: Number.MAX_SAFE_INTEGER })
        for (const node of state.nodes) if (removed.has(node.id)) node.status = 'invalid'
        state.links = state.links.filter(link => !removed.has(link.from) && !removed.has(link.to))
      }
      const dependencies = [...new Set([...input.messageRefs.map(ref => messageIds.get(`message:${ref.seq}`)!).filter(id => sources.get(id)?.status === 'active'), ...[...projected, ...(input.contextNodeIds ?? [])].filter(id => state.nodes.some(node => node.id === id && node.status === 'active'))])]
      // Confirmed transport text only. The model still must opt into a narrow ordinary-self projection.
      for (const expression of input.expressions) {
        if (!dependencies.length || ports.allowsText?.(expression.content) === false) continue
        const id = cognitionSourceId(agentId, conversation, 'self-expression', expression.messageId)
        if (state.sources.some(source => source.id === id)) continue
        state = recordCognitionSources(state, [{ id, agentId, conversation, kind: 'self-expression', nativeId: expression.messageId,
          authorId: conversation.account.id, occurredAt: expression.at, content: expression.content, revision: 1, participantIds: expression.participantIds, status: 'active' }])
        for (const dependency of dependencies) {
          const proofIds = sources.has(dependency) ? [dependency] : state.nodes.find(node => node.id === dependency)?.sourceIds ?? []
          if (proofIds.length) state.links.push({ id: `link:${hash([dependency, id])}`, from: dependency, to: id, kind: 'supports', sourceIds: [...proofIds] })
        }
      }
      return state
    }, guard)
  }
  return { ...service, projectTurn }
}
