import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
const { groupTextInteractionToolNames, groupTextScopedToolNames } = await importBilibiliHost('modules/conversation/infrastructure/groupTextTools.js')
const { RESTRICTED_SIM_TOOLS, normalizeSimToolPolicy, resolveSimToolSurface } = await importBilibiliHost('modules/simulation/domain/toolPolicy.js')
const { AUTONOMOUS_EXTRA_TOOLS, AUTONOMOUS_CREATIVE_TOOLS } = await importBilibiliHost('modules/simulation/domain/executionActor.js')

test('recall joins the text interaction surface while retaining restricted simulation and no autonomous extra-tool grant', () => {
  assert.deepEqual(groupTextInteractionToolNames, ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool'])
  assert.equal(groupTextScopedToolNames.includes('recallTool'), true)
  assert.equal(RESTRICTED_SIM_TOOLS.includes('recallTool'), true)
  assert.equal(AUTONOMOUS_EXTRA_TOOLS.includes('recallTool'), false)
  assert.equal(AUTONOMOUS_CREATIVE_TOOLS.includes('recallTool'), false)
  const input = { builtInNames: [...groupTextInteractionToolNames], extraTools: [], groupId: 'room' }
  assert.equal(resolveSimToolSurface({ ...input, policy: normalizeSimToolPolicy({}) }).includes('recallTool'), false)
  assert.equal(resolveSimToolSurface({ ...input, policy: normalizeSimToolPolicy({ allowTools: ['recallTool'] }) }).includes('recallTool'), true)
})

test('group management joins group text tools but remains restricted and human-only in simulation', () => {
  const input = { builtInNames: [...groupTextInteractionToolNames], extraTools: [], groupId: 'room' }
  for (const name of ['jinyanTool', 'changeCardTool']) {
    assert.equal(groupTextScopedToolNames.includes(name), true)
    assert.equal(RESTRICTED_SIM_TOOLS.includes(name), true)
    assert.equal(AUTONOMOUS_EXTRA_TOOLS.includes(name), false)
    assert.equal(AUTONOMOUS_CREATIVE_TOOLS.includes(name), false)
    assert.equal(resolveSimToolSurface({ ...input, policy: normalizeSimToolPolicy({}) }).includes(name), false)
    assert.equal(resolveSimToolSurface({ ...input, policy: normalizeSimToolPolicy({ allowTools: [name] }) }).includes(name), true)
    assert.equal(resolveSimToolSurface({ ...input, policy: normalizeSimToolPolicy({ allowTools: [name], denyTools: [name] }) }).includes(name), false)
  }
})
