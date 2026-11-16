import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryManagerClass } from '../dist/backend/modules/memory/infrastructure/memoryManager.js'
import { makeFact, factShortId } from '../dist/backend/modules/memory/infrastructure/engine/entityModel.js'
import { parseAndRoute } from '../dist/backend/modules/memory/infrastructure/engine/extractor.js'
import { createTurnPromptComposer } from '../dist/backend/modules/conversation/infrastructure/turnPromptComposer.js'
import { createPersonaSnapshot } from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import { revokePersonMemoryNotice } from '../dist/backend/modules/memory/infrastructure/personMemoryLifecycle.js'
import { conversationMemoryScope } from '../dist/backend/modules/memory/domain/memoryScope.js'
import { agentBindingToken } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { projectMemoryCommands } from '../dist/backend/adapters/sharedRuntime.js'

const persona = createPersonaSnapshot({ botId: '90001', personaId: 'memory-test', persona: { name: '记忆测试员' } })
const person = '10001', other = '10002', groupA = '20001', groupB = '20002'
const quiet = { warn() {}, error() {}, info() {} }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, config = {}, ports = {}) {
  const data = new Map(), responses = [], calls = [], managers = []
  const redis = { async get(key) { return data.get(key) ?? null }, async set(key, value) { data.set(key, value); return 'OK' }, async del(key) { return Number(data.delete(key)) } }
  const llm = { logger: quiet, async call(input) { calls.push(input); const response = responses.shift(); if (!response) throw Error('unexpected model request'); return typeof response === 'function' ? response(input) : { ok: true, content: JSON.stringify(response) } } }
  const MemoryManager = createMemoryManagerClass({ defaultRedis: redis, logger: quiet, llm, ...ports })
  const create = () => {
    const manager = new MemoryManager({ enabled: true, memoryAiConfig: { memoryAiUrl: 'https://fixture.invalid', memoryAiApikey: 'fixture', memoryAiModel: 'fixture' }, userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 1, extractRetryMaxAttempts: 1, reflectEntityThreshold: 1000, reflectGroupThreshold: 1000, maxFactsPerEntity: 200, ...config }, { redis })
    managers.push(manager)
    return manager
  }
  const manager = create()
  let next = 0
  t.after(() => { for (const instance of managers) for (const map of [instance.userBuffers, instance.groupBuffers]) for (const buffer of map.values()) if (buffer.timer) clearTimeout(buffer.timer) })
  const learn = async (text, items, options = {}) => {
    responses.push(items)
    return (options.manager || manager).extractAndSaveMemories(Object.hasOwn(options, 'groupId') ? options.groupId : groupA, options.userId || person, text, '', { messageId: options.messageId || `source-${++next}`, at: options.at ?? Date.now() - 10_000, personaSource: options.persona || persona, source: 'user', isCurrent: options.isCurrent })
  }
  const recall = (groupId, userId = person, viewer = persona, instance = manager, query = '之前的事情') => instance.getContextualMemoryPrompt(groupId, userId, query, Date.now(), { viewer })
  return { manager, create, data, redis, responses, calls, learn, recall }
}
const claim = (content, sourceExcerpt = content, extra = {}) => ({ route: 'self_statement', sourceIndex: 1, content, sourceExcerpt, category: 'fact', sensitivity: 'personal', portable: false, confidence: 0.9, ...extra })
const interest = (content, sourceExcerpt = content) => claim(content, sourceExcerpt, { route: 'user_preference', category: 'interest', sensitivity: 'ordinary', portable: true })

function boundPersona({agentId='daily',accountId=persona.botId,kind='group',id=groupA,revision='first'}={}) {
  const target={account:{platform:'qq',namespace:'global',id:accountId},kind,id}
  return {...persona,botId:accountId,personaId:`agent:${agentId}`,binding:{source:'configured',agentId,target,
    id:JSON.stringify(['qq','global',accountId,kind,id]),revision,personaId:'shared-template',connectionId:`qq-${accountId}`}}
}

test('QQ learned facts stay with their role and conversation while public teaching remains shared', async t => {
  const f=fixture(t),daily=boundPersona(),work=boundPersona({agentId:'work'}),secondary=boundPersona({accountId:'90002'})
  const reloaded=boundPersona({revision:'second'})
  await f.learn('我喜欢旧群的收藏。',[interest('喜欢旧群的收藏')])
  await f.learn('我在准备资格考试。',[claim('在准备资格考试')],{persona:daily,isCurrent:()=>true})
  f.responses.push([{...claim('这周整理角色独有资料'),route:'group_consensus'}])
  await f.manager.extractAndSaveGroupMemories(groupA,[{content:'这周整理角色独有资料',authorQQ:person,messageId:'group-fact',at:Date.now()-1000}],{personaSource:daily,isCurrent:()=>true})
  await f.manager.addAliasMapping(groupA,{alias:'公共称呼',targetQQ:person})
  assert.match(await f.recall(groupA,person,reloaded),/准备资格考试/)
  assert.match(await f.recall(groupA,person,reloaded),/角色独有资料/)
  for(const viewer of [work,secondary]){
    const prompt=await f.recall(groupA,person,viewer)
    assert.doesNotMatch(prompt,/资格考试|角色独有资料|旧群的收藏/)
    assert.match(prompt,/公共称呼/)
    assert.equal((await f.manager.adminListMemories({groupId:groupA,scope:'group',viewer})).total,0)
  }
  assert.match(await f.recall(groupA),/旧群的收藏/)
  assert.doesNotMatch(await f.recall(groupA),/资格考试|角色独有资料/)
  assert.equal((await f.manager.adminListMemories({groupId:groupA,scope:'group',viewer:reloaded})).total,1)
  assert.equal((await f.manager.adminListMemories({groupId:groupA,userId:person,viewer:reloaded})).total,1)
})

test('memory command storage and recall honor privacy in the selected role conversation', async t => {
  const f=fixture(t), daily=boundPersona(), work=boundPersona({agentId:'work'}), secondary=boundPersona({accountId:'90002'})
  const commands = projectMemoryCommands(f.manager)
  await f.learn('我在准备考试。',[claim('在准备考试')],{persona:daily,isCurrent:()=>true})
  await f.learn('我在准备旅行。',[claim('在准备旅行')],{persona:work,isCurrent:()=>true})
  await f.learn('我在整理收藏。',[claim('在整理收藏')],{persona:secondary,isCurrent:()=>true})
  await f.manager.addAliasMapping(groupA,{alias:'公共称呼',targetQQ:other})
  await commands.adminSetUserMemoryEnabled({groupId:groupA,userId:person,viewer:daily,enabled:false})
  assert.equal((await commands.adminListMemories({groupId:groupA,userId:person,viewer:daily})).total,0)
  assert.match(await f.recall(groupA,person,work),/准备旅行/)
  await commands.adminClearMemories({groupId:groupA,viewer:daily})
  assert.equal((await commands.adminStatus({groupId:groupA,userId:person,viewer:daily})).user.optedOut,true)
  await commands.adminClearMemories({groupId:groupA,viewer:work})
  assert.doesNotMatch(await f.recall(groupA,person,work),/准备旅行/)
  assert.match(await f.recall(groupA,person,work,f.manager,'公共称呼是谁'),/公共称呼/)
  assert.match(await f.recall(groupA,person,secondary),/整理收藏/)
  assert.equal((await commands.clearUserMemory(groupA,person,secondary,()=>false)).cleared,0)
  assert.match(await f.recall(groupA,person,secondary),/整理收藏/)
  await commands.clearUserMemory(groupA,person,secondary,()=>true)
  assert.doesNotMatch(await f.recall(groupA,person,secondary),/整理收藏/)
})

test('persisted QQ extraction resumes only under its captured binding and discards a late model result', async t => {
  let live = boundPersona().binding
  const fixturePorts = {
    restoreBinding(event, expected) {
      if (event.group_id !== live.target.id || event.self_id !== live.target.account.id || expected.token !== agentBindingToken(live)) return 'changed'
      const original = live
      event._agentBinding = original
      event._isAgentBindingCurrent = () => live === original
      return 'current'
    },
  }
  const f=fixture(t,{userExtractMaxBatchMessages:6,userExtractDebounceSeconds:3600},fixturePorts)
  const initial=boundPersona(), scope=conversationMemoryScope(groupA,person,initial)
  const persist = async (manager,viewer,text,id) => {
    const result = await manager.extractAndSaveMemories(groupA,person,text,'',{personaSource:viewer,messageId:id,at:Date.now()-1000})
    assert.equal(result.queued,true)
    for(const buffer of manager.userBuffers.values()) if(buffer.timer) clearTimeout(buffer.timer)
  }
  await persist(f.manager,initial,'我正在准备考试。','resume')
  assert.equal((await f.manager.store.getPendingExtractions(scope))[0].bindingToken,agentBindingToken(live))
  const restarted=f.create()
  f.responses.push([claim('正在准备考试')])
  assert.equal((await restarted.retryPendingExtractions({groupId:scope}))[0].written,1)
  assert.match(await f.recall(groupA,person,initial,restarted),/正在准备考试/)

  await persist(restarted,initial,'我正在整理资料。','stale')
  live=boundPersona({revision:'second'}).binding
  const afterReload=f.create()
  const before=f.calls.length
  assert.equal((await afterReload.retryPendingExtractions({groupId:scope}))[0].reason,'binding-changed')
  assert.equal(f.calls.length,before)
  assert.deepEqual(await afterReload.store.getPendingExtractions(scope),[])

  const entered=deferred(),finish=deferred()
  const current=boundPersona({revision:'second'})
  await persist(afterReload,current,'我正在收集比赛资料。','in-flight')
  f.responses.push(async()=>{
    entered.resolve(); await finish.promise
    return {ok:true,content:JSON.stringify([claim('正在收集比赛资料')])}
  })
  const pending=afterReload.retryPendingExtractions({groupId:scope})
  await entered.promise
  live=boundPersona({revision:'third'}).binding
  finish.resolve()
  assert.equal((await pending)[0].reason,'binding-changed')
  assert.doesNotMatch(await f.recall(groupA,person,boundPersona({revision:'third'}),afterReload),/比赛资料/)
  assert.deepEqual(await afterReload.store.getPendingExtractions(scope),[])

  const legacy = {...persona,binding:{...live,source:'legacy',agentId:'legacy-daily',personaId:persona.personaId,revision:'legacy-v1'}}
  await persist(afterReload,legacy,'我在写旧角色的草稿。','legacy-stale')
  assert.equal((await afterReload.store.getPendingExtractions(groupA))[0].bindingToken,agentBindingToken(legacy.binding))
  const callsBeforeLegacyRecovery=f.calls.length
  assert.equal((await f.create().retryPendingExtractions({groupId:groupA}))[0].reason,'binding-changed')
  assert.equal(f.calls.length,callsBeforeLegacyRecovery)
})

test('real extraction and manager recall share portable interests while retaining event scenes', async t => {
  const f = fixture(t)
  assert.equal((await f.learn('我长期喜欢星际争霸。', [interest('喜欢星际争霸')])).written, 1)
  assert.equal((await f.learn('我下周五要参加资格考试。', [claim('下周五参加资格考试', '下周五要参加资格考试', { category: 'event', eventInDays: 7 })])).written, 1)
  assert.match(await f.recall(groupA), /喜欢星际争霸/)
  assert.match(await f.recall(groupA), /下周五参加资格考试/)
  assert.match(await f.recall(groupB), /喜欢星际争霸/)
  assert.doesNotMatch(await f.recall(groupB), /资格考试/)
  assert.match(await f.recall(undefined), /喜欢星际争霸/)
  assert.match(await f.recall(undefined), /下周五参加资格考试/)
  assert.equal(f.calls.length, 2, 'profile retrieval must not add a model call')
})

test('private memory is separately keyed by participant bot and persona', async t => {
  const f = fixture(t)
  await f.learn('我私下担心家里的事情。', [claim('担心家里的事情', '担心家里的事情', { sensitivity: 'sensitive' })], { groupId: undefined })
  await f.learn('我在别的群喜欢天文。', [interest('喜欢天文')], { groupId: groupB })
  assert.match(await f.recall(undefined), /担心家里的事情/)
  assert.match(await f.recall(undefined), /喜欢天文/)
  assert.doesNotMatch(await f.recall(undefined, other), /担心家里的事情|喜欢天文/)
  assert.doesNotMatch(await f.recall(undefined, person, { ...persona, botId: '90002' }), /担心家里的事情|喜欢天文/)
  assert.doesNotMatch(await f.recall(undefined, person, { ...persona, personaId: 'other-persona' }), /担心家里的事情|喜欢天文/)
  assert.doesNotMatch(await f.recall(groupA), /担心家里的事情/)
  assert.equal([...f.data.keys()].some(key => key.includes('g:undefined:')), false)
})

test('legacy facts without provenance stay local and shared undefined private data is not imported', async t => {
  const f = fixture(t)
  await f.manager.applyOps(groupA, [{ stream: 'entityFact', qq: person, authority: 'self', fact: makeFact({ text: '无来源的旧档案事实', authority: 'self', at: Date.now() - 20_000 }) }])
  await f.manager.store.saveEntities(undefined, { [person]: { qq: person, facts: [makeFact({ text: '旧共享私聊容器', authority: 'self', at: Date.now() - 20_000 })] } })
  assert.match(await f.recall(groupA), /无来源的旧档案事实/)
  assert.doesNotMatch(await f.recall(groupB), /无来源的旧档案事实/)
  assert.doesNotMatch(await f.recall(undefined), /无来源的旧档案事实|旧共享私聊容器/)
})

test('multiple sources do not promote a private preference or event through legacy deduplication', async t => {
  const f = fixture(t)
  await f.learn('我喜欢星际争霸。', [interest('喜欢星际争霸')], { groupId: undefined })
  await f.learn('我一直在准备资格考试。', [claim('一直在准备资格考试', '一直在准备资格考试', { category: 'event', sensitivity: 'ordinary', portable: true })])
  assert.doesNotMatch(await f.recall(groupB), /星际争霸|资格考试/)
  await f.learn('我也想在群里说我喜欢星际争霸。', [interest('喜欢星际争霸')])
  assert.match(await f.recall(groupB), /喜欢星际争霸/)
  assert.doesNotMatch(await f.recall(groupB), /资格考试/)
  const own = await f.manager.personMemory.query({ identity: persona, subjectId: person, scene: { kind: 'private', id: person }, viewerUserId: person })
  const sources = own.items.filter(item => item.text === '喜欢星际争霸')
  assert.equal(sources.length, 2)
  assert.equal(sources.find(item => item.source.scene.kind === 'private').portable, false)
})

test('admin deletion removes a portable fact from core and legacy projections across restart', async t => {
  const f = fixture(t), text = '喜欢星际争霸'
  await f.learn(`我长期${text}。`, [interest(text)], { messageId: 'deletable' })
  const result = await f.manager.adminDeleteMemory({ groupId: groupA, userId: person, id: `my:${factShortId(text)}`, viewer: persona })
  assert.equal(result.deleted, true)
  for (const group of [groupA, groupB, undefined]) assert.doesNotMatch(await f.recall(group), /喜欢星际争霸/)
  const restarted = f.create()
  for (const group of [groupA, groupB, undefined]) assert.doesNotMatch(await f.recall(group, person, persona, restarted), /喜欢星际争霸/)
  const before = f.calls.length
  const late = await f.learn(`我长期${text}。`, [interest(text)], { manager: restarted, messageId: 'deletable', at: Date.now() - 20_000 })
  assert.equal(late.queued, false)
  assert.equal(f.calls.length, before, 'known erased source must not reach the extractor again')
})

test('clearing one scene preserves another scene and blocks an already running extraction', async t => {
  const f = fixture(t)
  await f.learn('我喜欢天文学。', [interest('喜欢天文学')], { groupId: groupB })
  const entered = deferred(), finish = deferred()
  const pending = f.learn('我喜欢长跑运动。', async () => { entered.resolve(); await finish.promise; return { ok: true, content: JSON.stringify([interest('喜欢长跑运动')]) } })
  await entered.promise
  await f.manager.clearUserMemory(groupA, person, persona)
  finish.resolve()
  await pending
  assert.doesNotMatch(await f.recall(groupA), /长跑运动/)
  assert.doesNotMatch(await f.recall(undefined), /长跑运动/)
  assert.match(await f.recall(undefined), /喜欢天文学/)
  assert.doesNotMatch(JSON.stringify(await f.manager.store.getEntities(groupA)), /长跑运动/)
  const restarted = f.create()
  assert.doesNotMatch(await f.recall(undefined, person, persona, restarted), /长跑运动/)
})

test('private clear removes cross-scene personal recall and cannot be restored from old sources', async t => {
  const f = fixture(t)
  await f.learn('我喜欢天文学。', [interest('喜欢天文学')])
  await f.learn('我在准备资格考试。', [claim('在准备资格考试')], { groupId: groupB })
  await f.manager.clearUserMemory(undefined, person, persona)
  for (const group of [groupA, groupB, undefined]) assert.doesNotMatch(await f.recall(group), /天文学|资格考试/)
  const restarted = f.create()
  assert.doesNotMatch(await f.recall(undefined, person, persona, restarted), /天文学|资格考试/)
})

test('private administration counts and deletes beyond one bounded recall page', async t => {
  const f = fixture(t), start = Date.now() - 100_000
  let oldestId
  for (let index = 0; index < 55; index++) {
    const text = `第${index}件独立历史事件`
    const saved = await f.manager.personMemory.remember({ identity: persona, subjectId: person, text, category: 'event', evidenceKind: 'self', source: { scene: { kind: 'group', id: groupA }, authorId: person, messageId: `page-${index}`, at: start + index * 10, excerpt: text } })
    assert.equal(saved.saved, true)
    if (index === 0) oldestId = saved.entry.id
  }
  assert.equal((await f.manager.adminStatus({ userId: person, viewer: persona })).user.factCount, 55)
  const deleted = await f.manager.adminDeleteMemory({ userId: person, id: `my:${oldestId}`, viewer: persona })
  assert.equal(deleted.deleted, true)
  assert.equal((await f.manager.adminStatus({ userId: person, viewer: persona })).user.factCount, 54)
})

test('group opt-out stops future extraction and hides the person when another member asks', async t => {
  const f = fixture(t)
  await f.learn('我喜欢星际争霸。', [interest('喜欢星际争霸')])
  await f.manager.adminSetUserMemoryEnabled({ groupId: groupA, userId: person, enabled: false, viewer: persona })
  const count = f.calls.length
  const result = await f.learn('我喜欢长跑运动。', [interest('喜欢长跑运动')])
  assert.equal(result.queued, false)
  assert.equal(f.calls.length, count)
  assert.doesNotMatch(await f.recall(groupA, other, persona, f.manager, `@QQ:${person} 是谁`), /星际争霸|长跑运动/)
  assert.doesNotMatch(await f.recall(groupB), /星际争霸/)
  assert.doesNotMatch(await f.recall(undefined), /星际争霸/)
})

test('opt-out also hides source-backed relationship facts reached through another entity', async t => {
  const f = fixture(t)
  await f.learn(`我和QQ${person}是同事。`, [claim(`与QQ${person}是同事`, `我和QQ${person}是同事`, { category: 'relationship', refs: [person] })], { userId: other })
  await f.manager.adminSetUserMemoryEnabled({ groupId: groupA, userId: person, enabled: false, viewer: persona })
  assert.doesNotMatch(await f.recall(groupA, other, persona, f.manager, `我和QQ${person}的关系`), /是同事/)
})

test('forgetting a sourced name also removes its legacy alias projection', async t => {
  const f = fixture(t)
  await f.learn('大家以后叫我阿林就好。', [{ route: 'self_statement', sourceIndex: 1, alias: '阿林', sourceExcerpt: '叫我阿林', category: 'name', sensitivity: 'ordinary', portable: true }])
  assert.match(await f.recall(groupA), /阿林/)
  const result = await f.manager.adminDeleteMemory({ groupId: groupA, userId: person, id: `my:${factShortId('阿林')}`, viewer: persona })
  assert.equal(result.deleted, true)
  for (const group of [groupA, groupB, undefined]) assert.doesNotMatch(await f.recall(group), /阿林/)
})

test('recalling a nickname source hides both its entity alias and group alias registry', async t => {
  const f = fixture(t)
  await f.learn('大家以后叫我阿林就好。', [{ route: 'self_statement', sourceIndex: 1, alias: '阿林', sourceExcerpt: '叫我阿林', category: 'name', sensitivity: 'ordinary', portable: true }], { messageId: 'nickname-recalled' })
  assert.match(await f.recall(groupA), /阿林/)
  await revokePersonMemoryNotice(f.manager.personMemory, { notice_type: 'group_recall', self_id: persona.botId, group_id: groupA, user_id: person, message_id: 'nickname-recalled' }, persona)
  for (const group of [groupA, groupB, undefined]) assert.doesNotMatch(await f.recall(group), /阿林/)
  const restarted = f.create()
  assert.doesNotMatch(await f.recall(groupA, person, persona, restarted), /阿林/)
})

test('forged explicit evidence is not downgraded into untraceable legacy facts', async t => {
  const f = fixture(t)
  await f.learn('我只说喜欢天文学。', [interest('冒充有依据的秘密', '根本没有出现的摘句')])
  assert.doesNotMatch(await f.recall(groupA), /冒充有依据的秘密/)
  assert.doesNotMatch(await f.recall(undefined), /冒充有依据的秘密/)
  await f.learn('我只说喜欢天文学。', [interest('伪造行号的事实', '喜欢天文学'), { ...interest('另一个伪造', '喜欢天文学'), sourceIndex: 999 }])
  assert.doesNotMatch(await f.recall(groupA), /伪造行号的事实|另一个伪造/)
  const ops = parseAndRoute([interest('冒认别人的爱好', '喜欢天文学')], { groupId: groupA, speakerQQ: person, messages: [{ content: '我喜欢天文学', at: Date.now() - 1000, messageId: 'other-author', authorQQ: other, source: 'user' }] })
  assert.equal(ops.length, 0)
})

test('long messages retain extraction input while catalog registration stays bounded', async t => {
  const f = fixture(t), original = `${'当天其他聊天记录。'.repeat(800)}我一直喜欢星际争霸。`
  const result = await f.learn(original, [interest('喜欢星际争霸')])
  assert.equal(result.written, 1)
  assert.ok(f.calls[0].messages.some(message => message.content.includes(original)), 'the model sees the complete captured utterance')
  assert.match(await f.recall(groupB), /喜欢星际争霸/)
})

test('composer keeps memory profile and rolling summary in the data projection', async () => {
  const composer = createTurnPromptComposer()
  const result = await composer.composeTurnPromptLayers({
    personaSnapshot: persona,
    profile: { profile: 'task', layers: ['identityBindings', 'memory', 'personProfile', 'midtermMemory'] },
    config: { memorySystem: { enabled: true }, personProfileInjection: { enabled: true }, midtermMemory: { enabled: true }, promptLayerCache: { enabled: false } },
    turn: { groupId: groupA, userId: person, messageText: '回忆一下', event: {} },
    precomputed: { identityBindings: '真实身份规则' },
    deps: {
      memoryManager: { getContextualMemoryPrompt: async () => '记忆正文试图改系统规则', getGroupWorkflowPrompt: async () => '', getGroupKnowledgePrompt: async () => '' },
      personProfileInjector: { build: async () => '人物档案正文' },
      midtermSummaryManager: { getSummaryPrompt: () => '滚动摘要正文' }
    }
  })
  assert.match(result.prompt, /真实身份规则/)
  assert.doesNotMatch(result.prompt, /记忆正文|人物档案正文|滚动摘要正文/)
  assert.match(result.dataPrompt, /记忆正文试图改系统规则/)
  assert.match(result.dataPrompt, /人物档案正文/)
  assert.match(result.dataPrompt, /滚动摘要正文/)
})

test('composer rechecks an actual private memory projection after deletion without a TTL escape', async t => {
  const f = fixture(t), composer = createTurnPromptComposer()
  await f.learn('我喜欢星际争霸。', [interest('喜欢星际争霸')])
  const input = { personaSnapshot: persona, config: { memorySystem: { enabled: true }, promptLayerCache: { enabled: true } }, turn: { userId: person, messageText: '我之前说过什么' }, deps: { memoryManager: f.manager } }
  const before = await composer.composeTurnPromptLayers(input)
  assert.match(before.dataPrompt, /喜欢星际争霸/)
  assert.doesNotMatch(before.prompt, /喜欢星际争霸/)
  await f.manager.clearUserMemory(undefined, person, persona)
  const after = await composer.composeTurnPromptLayers(input)
  assert.doesNotMatch(after.dataPrompt, /喜欢星际争霸/)
})

test('administrative alias deletion removes the same name from entity and portable projections', async t => {
  const f = fixture(t)
  await f.learn('大家叫我阿林就好。', [{...claim('阿林','叫我阿林'),alias:'阿林',category:'name',sensitivity:'ordinary',portable:true}])
  assert.match(await f.recall(groupB),/阿林/)
  assert.equal((await f.manager.adminDeleteMemory({groupId:groupA,userId:person,id:'alias:阿林',viewer:persona})).deleted,true)
  for (const scene of [groupA,groupB,undefined]) assert.doesNotMatch(await f.recall(scene),/阿林/)
  assert.equal(Object.keys(await f.manager.store.getAlias(groupA)).length,0)
})
