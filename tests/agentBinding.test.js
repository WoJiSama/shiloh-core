import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { resolveConversationContext } from '../dist/backend/adapters/conversationContext.js'
import { resolveQqAgentBinding } from '../dist/backend/adapters/qqAgentBinding.js'
import { isAgentBindingCurrent } from '../dist/backend/contracts/agentBinding.js'
import { createStrictConversation } from '../dist/backend/modules/conversation/infrastructure/strictConversation.js'
import { loadTurnContinuity, recordTurnContinuity } from '../dist/backend/modules/conversation/application/turnContinuity.js'
import { createPersonaLibrary } from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import { createChatPlugin } from '../dist/backend/modules/host/infrastructure/chatPlugin.js'
import { BananaTool } from '../dist/backend/modules/toolSupport/infrastructure/BananaTool.js'
import { createGoogleImageEditTool } from '../dist/backend/modules/toolSupport/infrastructure/GoogleImageEditTool.js'
import { createReminderRuntime } from '../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
import { createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { createAdminCommands } from '../dist/backend/modules/platform/infrastructure/admin/adminCommands.js'
import {
  buildChatTurnKey,
  rebuildChatTurnEvent,
  serializeChatTurnEnvelope,
} from '../utils/chatTurnDurability.js'

function config() {
  return {
    version: 1,
    agents: [{id:'daily', personaId:'shared'}, {id:'work', personaId:'shared'}],
    connections: [
      {id:'qq-main', platform:'qq', namespace:'global', accountId:'99'},
      {id:'qq-secondary', platform:'qq', namespace:'global', accountId:'303'},
      {id:'lark-main', platform:'feishu', namespace:'tenant-a', accountId:'99'},
      {id:'lark-other', platform:'feishu', namespace:'tenant-b', accountId:'99'},
    ],
    bindings: [
      {connectionId:'qq-main', kind:'group', conversationId:'42', agentId:'daily'},
      {connectionId:'qq-main', kind:'group', conversationId:'43', agentId:'work'},
      {connectionId:'qq-secondary', kind:'private', conversationId:'202', agentId:'daily'},
      {connectionId:'lark-main', kind:'group', conversationId:'42', agentId:'work'},
      {connectionId:'lark-other', kind:'group', conversationId:'42', agentId:'daily'},
      {connectionId:'lark-main', kind:'channel', conversationId:'oc_open_channel', agentId:'daily'},
    ],
  }
}

function fixture(t, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-binding-'))
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}))
  const file = path.join(dir, 'agent-bindings.yaml')
  const calls = []
  const warnings = []
  const sent = []
  const { ExamplePlugin } = createChatPlugin({
    Plugin: class {},
    shared: {},
    getSmartRuntimeState: key => key,
    logger: {warn: message => warnings.push(message)},
    getBot: () => undefined,
    anchorEventConversation() {},
    handleRandomReply: async (_host, event) => { calls.push({event}); return true },
    handleToolInnerFn: async (_host, event) => {
      const snapshot = event._pendingPersonaSnapshot
      event._personaSnapshot = snapshot
      calls.push({event, snapshot, context:resolveConversationContext(event)})
      return run ? run(event) : true
    },
  })
  const host = Object.create(ExamplePlugin.prototype)
  host.config = {persona:{name:'默认人设'}}
  host.handleForbiddenWordHit = () => false
  host.handleMemorySelfCorrection = () => {}
  const library = createPersonaLibrary({
    libraryPath:path.join(dir, 'persona-library.yaml'),
    getBasePersona: () => host.config.persona,
  })
  host.personaLibrary = library
  library.upsert({name:'共享人设'}, {preferId:'shared'})
  library.upsert({name:'旧群人设'}, {preferId:'legacy-group'})
  library.upsert({name:'旧账号人设'}, {preferId:'legacy-account'})
  library.upsert({name:'旧私聊人设'}, {preferId:'legacy-private'})
  const group = {
    getMemberMap: async () => new Map(),
    pickMember: () => ({info:{}}),
    sendMsg: async value => { sent.push(value); return {message_id:'sent'} },
  }
  const bot = {uin:99, pickGroup:() => group}
  const event = overrides => ({
    message_type:'group', group_id:42, user_id:202, self_id:99,
    message_id:55, msg:'你好', bot, group,
    reply:payload => group.sendMsg(payload),
    ...overrides,
  })
  const write = value => {
    fs.writeFileSync(file + '.tmp', YAML.stringify(value))
    fs.renameSync(file + '.tmp', file)
  }
  return {host, library, event, write, file, calls, warnings, sent, bot}
}

test('the binding directory keeps platform, tenant, conversation kind and opaque IDs distinct', () => {
  const directory = createAgentBindingDirectory(config(), 'test-revision')
  const address = (platform, namespace, kind = 'group', id = '42') => ({
    account:{platform, namespace, id:'99'}, kind, id,
  })
  assert.equal(directory.resolve(address('qq', 'global')).agentId, 'daily')
  assert.equal(directory.resolve(address('feishu', 'tenant-a')).agentId, 'work')
  assert.equal(directory.resolve(address('feishu', 'tenant-b')).agentId, 'daily')
  assert.equal(directory.resolve(address('feishu', 'tenant-a', 'channel', 'oc_open_channel')).agentId, 'daily')
  assert.equal(directory.resolve(address('qq', 'global', 'private')), undefined)

  const ambiguous = config()
  ambiguous.bindings.push({...ambiguous.bindings[0], agentId:'work'})
  assert.throws(() => createAgentBindingDirectory(ambiguous, 'test'), /会话已绑定/)
  const dangling = config()
  dangling.bindings[0].agentId = 'missing'
  assert.throws(() => createAgentBindingDirectory(dangling, 'test'), /角色或连接不存在/)
})

test('the QQ tool entry preserves legacy persona rules and storage identities', async t => {
  const {host, library, calls, event} = fixture(t)
  library.setGroupBinding(42, 'legacy-group')
  library.setAccountBinding('9900', 'legacy-account')
  library.setPrivateBinding('legacy-private')

  await host.handleTool(event())
  await host.handleTool(event({group_id:43, self_id:9900, bot:{uin:9900,pickGroup(){}}}))
  await host.handleTool(event({message_type:'private', group_id:undefined, group:undefined}))
  assert.deepEqual(calls.map(call => call.snapshot.personaId), ['legacy-group', 'legacy-account', 'legacy-private'])
  assert.deepEqual(calls.map(call => call.context.binding.source), ['legacy', 'legacy', 'legacy'])
  assert.equal(calls[0].context.conversationId, '["qq","99","group","42"]')
  assert.equal(calls[2].context.binding.target.id, '202')
  assert.deepEqual(calls[0].context.sender, {platform:'qq', namespace:'global', id:'202'})
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].context)), calls[0].context)
})

test('the QQ entry selects explicit agents for two accounts and separates roles that share a persona', async t => {
  const {host, library, calls, event, write} = fixture(t)
  library.setGroupBinding(42, 'legacy-group')
  write(config())

  await host.handleTool(event())
  await host.handleTool(event({group_id:43}))
  await host.handleTool(event({
    message_type:'private', group_id:undefined, group:undefined,
    self_id:303, bot:{uin:303,pickGroup(){}},
  }))

  assert.deepEqual(calls.map(call => call.context.binding.agentId), ['daily', 'work', 'daily'])
  assert.deepEqual(calls.map(call => call.context.binding.connectionId), ['qq-main', 'qq-main', 'qq-secondary'])
  assert.deepEqual(calls.map(call => call.snapshot.persona.name), ['共享人设', '共享人设', '共享人设'])
  assert.deepEqual(calls.map(call => call.snapshot.personaId), ['agent:daily', 'agent:work', 'agent:daily'])
  assert.ok(calls.every(call => call.context.binding.personaId === 'shared'))
  assert.equal(resolveQqAgentBinding(library, event()).binding.agentId, calls[0].context.binding.agentId)
})

test('the QQ chat entries attach a serializable message with the resolved binding, mentions, quote and media', async t => {
  const {host, event, write, calls} = fixture(t)
  write(config())
  const fields = {
    msg:' 这张图', raw_message:'[CQ:reply,id=-901][CQ:at,qq=303] 这张图', time:1770000000,
    sender:{card:'阿明'},
    message:[
      {type:'reply', data:{id:-901}},
      {type:'at', data:{qq:99}},
      {type:'image', data:{url:'https://example.test/image.png'}},
      {type:'text', data:{text:' 这张图'}},
    ],
    source:{user_id:303, nickname:'波波', message:[{type:'text', text:'图在这里'}]},
  }
  await host.handleTool(event(fields))
  await host.handleRandomReply(event(fields))
  const [tool, chat] = calls.map(call => call.event._incomingMessage)
  assert.deepEqual(chat, tool)
  assert.deepEqual(tool, JSON.parse(JSON.stringify(tool)))
  assert.equal(tool.binding.agentId, 'daily')
  assert.equal(tool.occurredAt, 1770000000000)
  assert.equal(tool.senderName, '阿明')
  assert.equal(tool.directedToAccount, true)
  assert.deepEqual(tool.mentions.map(user => user.id), ['99', '303'])
  assert.equal(tool.quote.messageId, '-901')
  assert.equal(tool.quote.author.id, '303')
  assert.equal(tool.quote.text, '图在这里')
  assert.deepEqual(tool.parts.find(part => part.kind === 'image').resource, {kind:'url', value:'https://example.test/image.png'})
})

test('the existing QQ tool entry uses the captured binding for forbidden-word interruption', async t => {
  const {host, event, write, calls} = fixture(t)
  const setup = config()
  setup.bindings.push({ connectionId: 'qq-secondary', kind: 'group', conversationId: '42', agentId: 'daily' })
  write(setup)
  const observed = []
  host.handleForbiddenWordHit = e => { observed.push(e._agentBinding); return true }
  assert.equal(await host.handleTool(event()), false)
  const secondary = {uin:303,pickGroup:() => event().group}
  assert.equal(await host.handleTool(event({bot:secondary,self_id:303})), false)
  assert.deepEqual(observed.map(binding => [binding.target.account.id, binding.target.id, binding.agentId]), [
    ['99', '42', 'daily'], ['303', '42', 'daily'],
  ])
  assert.equal(calls.length, 0)
})

test('the QQ entry rejects mismatched accounts, missing templates and invalid config before any turn', async t => {
  const {host, calls, event, write, file, warnings} = fixture(t)
  write(config())
  assert.equal(await host.handleTool(event({self_id:303})), false)

  const missing = config()
  missing.agents[0].personaId = 'missing'
  write(missing)
  assert.equal(await host.handleTool(event()), false)
  assert.match(warnings.at(-1), /引用的人设不存在/)

  fs.writeFileSync(file, 'bindings: [')
  assert.equal(await host.handleTool(event()), false)
  assert.match(warnings.at(-1), /无法解析/)
  assert.equal(calls.length, 0)
})

test('both QQ hosts reject collisions with the configured role state identity', async t => {
  const {host, library, event, write, file, warnings} = fixture(t)
  write(config())
  const standaloneFile = path.join(path.dirname(file), 'agent-host.yaml')
  fs.writeFileSync(standaloneFile, YAML.stringify({
    version: 1, instance: 'local-qq', persona: {name:'独立群聊角色'},
    model: {baseUrl:'http://127.0.0.1:9900/v1', name:'local-model', apiKeyEnv:'MODEL_KEY'},
    connections: [{id:'qq-main', url:'ws://127.0.0.1:6700/'}],
  }))
  const standalone = readStandaloneAgentConfig(standaloneFile, {MODEL_KEY:'test-model-key'})
  const target = { account:{platform:'qq', namespace:'global', id:'99'}, kind:'group', id:'42' }
  const selected = standalone.resolvePersona(target)
  assert.equal(selected.personaId, 'agent:daily')
  assert.equal(selected.persona.name, '共享人设')
  assert.equal(selected.binding.personaId, 'shared')

  library.upsert({name:'冲突的历史人设'}, {preferId:'agent:daily'})
  assert.throws(() => standalone.resolvePersona(target), /角色状态标识与现有人设 ID 冲突/)
  assert.equal(await host.handleTool(event()), false)
  assert.match(warnings.at(-1), /角色状态标识与现有人设 ID 冲突/)
})

test('a delayed turn inherits the binding captured by the normal QQ message entry', async t => {
  const {host, event, write, calls} = fixture(t)
  write(config())
  const incoming = event()
  assert.equal(await host.handleRandomReply(incoming), true)
  assert.ok(calls[0].event._agentBindingToken)
  const changed = config()
  changed.bindings[0].agentId = 'work'
  write(changed)
  assert.equal(await host.handleTool(Object.create(calls[0].event)), false)
  assert.equal(calls.length, 1)
  assert.equal(await host.handleTool(event()), true)
  assert.equal(calls[1].snapshot.binding.agentId, 'work')
})

test('QQ chat state and tracking follow the captured binding even when the same role is restored', async t => {
  const {host, event, write} = fixture(t)
  const strict = createStrictConversation({ bot: () => ({ uin: 99 }) })
  const runtimeKey = input => host.getSmartState(input.group_id, input)
  const legacy = event()
  assert.equal(await host.handleRandomReply(legacy), true)
  assert.equal(runtimeKey(legacy), 'bot:99:group:42')
  const initial = config()
  initial.bindings.push({connectionId:'qq-secondary', kind:'group', conversationId:'42', agentId:'daily'})
  write(initial)
  const first = event()
  const same = event()
  const secondAccount = event({self_id:303, bot:{...first.bot, uin:303}})
  for (const input of [first, same, secondAccount]) assert.equal(await host.handleRandomReply(input), true)
  assert.equal(runtimeKey(first), runtimeKey(same))
  assert.notEqual(runtimeKey(first), runtimeKey(legacy))
  assert.notEqual(runtimeKey(first), runtimeKey(secondAccount))
  assert.notEqual(strict.trackingConversationKey(first), strict.trackingConversationKey(secondAccount))

  const changed = config()
  changed.bindings[0].agentId = 'work'
  write(changed)
  const next = event()
  assert.equal(await host.handleRandomReply(next), true)
  assert.notEqual(runtimeKey(first), runtimeKey(next))
  assert.notEqual(strict.trackingConversationKey(first), strict.trackingConversationKey(next))

  write(initial)
  const restored = event()
  assert.equal(await host.handleRandomReply(restored), true)
  assert.equal(restored._agentBinding.agentId, first._agentBinding.agentId)
  assert.notEqual(runtimeKey(first), runtimeKey(restored))
  assert.notEqual(strict.trackingConversationKey(first), strict.trackingConversationKey(restored))
})

test('QQ turn continuity uses the exact binding and keeps the legacy data readable', async t => {
  const {host, event, write} = fixture(t)
  const scope = input => {
    const persona = host.getPersonaSnapshotFor(input)
    return { groupId: input.group_id, userId: input.user_id, botId: persona.botId, persona, binding: persona.binding }
  }
  const legacyScope = scope(event())
  await recordTurnContinuity({...legacyScope, lastReply: '历史兼容回合'})
  const initial = config()
  initial.bindings.push({connectionId:'qq-secondary', kind:'group', conversationId:'42', agentId:'daily'})
  write(initial)
  const firstScope = scope(event())
  await recordTurnContinuity({...firstScope, lastReply: '原绑定的回合'})
  assert.equal((await loadTurnContinuity(scope(event())))?.lastReply, '原绑定的回合')
  assert.equal(await loadTurnContinuity(scope(event({self_id:303, bot:{uin:303}}))), null)

  write(initial)
  const restoredScope = scope(event())
  assert.equal(restoredScope.persona.personaVersion, firstScope.persona.personaVersion)
  assert.notEqual(restoredScope.binding.revision, firstScope.binding.revision)
  assert.equal(await loadTurnContinuity(restoredScope), null)
  assert.equal((await loadTurnContinuity(legacyScope))?.lastReply, '历史兼容回合')
})

test('QQ persona commands show and respect the effective explicit binding', async t => {
  const {library, event, write} = fixture(t)
  write(config())
  library.setGroupBinding(42, 'legacy-group')
  const notices = []
  const commands = createAdminCommands({logger:{mark(){},error(){}}})
  const host = {
    personaLibrary:library,
    config:{},
    sendObservedReply:async (_event, text) => notices.push(text),
    formatPersonaDetail:detail => detail.persona.name,
    isChatManager:() => true,
    resolvePersonaTargetGroup:() => ({groupId:'42'}),
  }
  await commands.handlePersonaCurrent(host, event())
  assert.match(notices[0], /共享人设[\s\S]*运行角色 daily/)
  await commands.handlePersonaSwitch(host, event({msg:'#切换人设 旧账号人设'}))
  assert.match(notices[1], /由 agent-bindings\.yaml 管理/)
  await commands.handlePersonaReset(host, event({msg:'#人设重置'}))
  assert.match(notices[2], /由 agent-bindings\.yaml 管理/)
  assert.equal(library.bindings().groups['42'], 'legacy-group')
})

test('an in-flight reply keeps its original account and cannot send after the binding is replaced', async t => {
  let resume
  const gate = new Promise(resolve => { resume = resolve })
  const {host, calls, event, write, sent} = fixture(t, async e => {
    await gate
    return await e.reply('迟到的回复')
  })
  const first = config()
  write(first)
  const inFlight = host.handleTool(event())
  assert.equal(calls.length, 1)
  assert.equal(isAgentBindingCurrent(calls[0].event), true)

  const next = config()
  next.bindings[0].agentId = 'work'
  write(next)
  resume()
  assert.equal((await inFlight).status, 'failed')
  assert.deepEqual(sent, [])
  write(first)
  assert.equal(isAgentBindingCurrent(calls[0].event), false)
})

test('restart recovery honors the original binding and never substitutes another QQ account', async t => {
  const {host, calls, event, write, bot} = fixture(t)
  write(config())
  const input = event()
  await host.handleTool(input)
  const envelope = JSON.parse(JSON.stringify(serializeChatTurnEnvelope(input)))
  assert.ok(envelope.agentBindingToken)
  assert.notEqual(buildChatTurnKey(input), buildChatTurnKey({...input, self_id:303}))

  const previousBot = globalThis.Bot
  t.after(() => { if (previousBot === undefined) delete globalThis.Bot; else globalThis.Bot = previousBot })
  globalThis.Bot = {uin:303,pickGroup(){ throw new Error('a different account must not recover the turn') }}
  assert.equal(rebuildChatTurnEvent(envelope), null)
  globalThis.Bot = {uin:[99,303],bots:{99:bot}}
  assert.equal(await host.handleToolInner(rebuildChatTurnEvent(envelope)), true)
  assert.equal(calls.length, 2)

  const changed = config()
  changed.bindings[0].agentId = 'work'
  write(changed)
  assert.equal(await host.handleToolInner(rebuildChatTurnEvent(envelope)), false)
  assert.equal(calls.length, 2)
})

test('QQ image recovery reuses the original turn and retires jobs from a superseded binding', async t => {
  const {host, event, write, bot, sent} = fixture(t)
  write(config())
  const input = event()
  await host.handleTool(input)
  const rows = new Map()
  const redis = {
    get: async key => rows.get(key) ?? null,
    set: async (key, value) => rows.set(key, value),
    del: async key => rows.delete(key),
    keys: async prefix => [...rows.keys()].filter(key => key.startsWith(prefix.slice(0, -1))),
  }
  const bridge = {restoreDeferredAgentBinding: host.restoreDeferredAgentBinding.bind(host)}
  let account = bot
  const recovered = []
  class RecoveringDraw extends BananaTool {
    async runDrawJob(job) {
      recovered.push(job.e._agentBinding)
      await this.removeDurableDrawJob(job)
    }
  }
  const ports = {getRedis: () => redis, getBot: () => account, getBridge: () => bridge, logger:{info(){},warn(){},error(){}}}
  const EditTool=createGoogleImageEditTool(ports)
  const writer = new BananaTool({}, ports)
  const restart = new RecoveringDraw({}, ports)
  const editWriter=new EditTool(), editRestart=new EditTool()
  const edits=[]
  editRestart.performImageEdit=async (_options,e)=>edits.push(e._agentBinding)
  const storeEdit=async ()=>{
    const job=editWriter.createDurableJob({images:['base'],prompt:'验收图片编辑'},input)
    await editWriter.persistDurableJob(job)
    return `ytbot:image_edit_job:${job.id}`
  }
  const store = async id => await writer.persistDrawJob({id,opts:{prompt:'验收图片'},e:input,scopeKey:writer.getDrawScopeKey(input),requesterId:'202',messageId:'55'})
  await store('same-binding')
  const editKey=await storeEdit()
  assert.equal(JSON.parse(rows.get(writer.getDurableJobKey('same-binding'))).bindingToken, input._agentBindingToken)
  assert.equal(JSON.parse(rows.get(editKey)).bindingToken,input._agentBindingToken)
  account = {uin:303,pickGroup(){throw Error('wrong account')}}
  await restart.recoverDurableJobs()
  await editRestart.recoverDurableJobs()
  assert.equal(recovered.length, 0)
  assert.equal(edits.length,0)
  assert.ok(rows.has(editKey))
  assert.ok(rows.has(writer.getDurableJobKey('same-binding')))
  account = bot
  await restart.recoverDurableJobs()
  await editRestart.recoverDurableJobs()
  assert.deepEqual(recovered, [input._agentBinding])
  assert.deepEqual(edits,[input._agentBinding])
  assert.equal(sent.length, 2)

  await store('no-blind-replay')
  const attemptedKey=writer.getDurableJobKey('no-blind-replay')
  rows.set(attemptedKey, JSON.stringify({...JSON.parse(rows.get(attemptedKey)),deliveryAttempted:true}))
  await store('superseded')
  const staleEdit=await storeEdit()
  const next=config()
  next.bindings[0].agentId='work'
  write(next)
  await restart.recoverDurableJobs()
  await editRestart.recoverDurableJobs()
  assert.equal(recovered.length, 1)
  assert.equal(edits.length,1)
  assert.equal(sent.length, 2)
  assert.equal(rows.has(staleEdit),false)
  assert.equal(rows.has(writer.getDurableJobKey('superseded')), false)
  assert.equal(rows.has(writer.getDurableQueueKey(writer.getDrawScopeKey(input))), false)
})

test('QQ reminders stay with the registering owner across restart and stop on a role change', async t => {
  const {host, event, write, file, bot} = fixture(t)
  const first = config()
  write(first)
  const input = event()
  await host.handleTool(input)
  const rows = new Map(), sends = []
  const redis = {
    get: async key => rows.get(key) ?? null,
    set: async (key, value, options) => {
      if (options?.NX && rows.has(key)) return null
      rows.set(key, value)
      return 'OK'
    },
    del: async key => rows.delete(key),
    eval: async (_script, {keys:[key],arguments:[token]}) => { if (rows.get(key) === token) rows.delete(key) },
  }
  bot.sendApi=async (action, params)=>{sends.push({action, params});return {message_id:'reminder-receipt'}}
  const ports={redis,getBot:id=>String(id)==='99'?bot:undefined,restoreBinding:host.restoreDeferredAgentBinding.bind(host),
    logger:{info(){},warn(){},error(){},debug(){}},mcpManager:{isMCPTool:()=>false}}
  const writer=createReminderRuntime(ports)
  const tool=new writer.ReminderTool()
  const schedule=async (e,content)=>{
    const reply=await tool.func({action:'create',reminder_time:new Date(Date.now()+60_000).toISOString(),content},Object.create(e))
    assert.match(reply,/提醒已创建/)
    return reply.match(/提醒ID: (.+)$/)[1]
  }
  const pendingKey='bl-chat:reminder:pending:list'
  const detailKey=id=>`bl-chat:reminder:detail:${id}`
  const makeDue=id=>{
    const pending=JSON.parse(rows.get(pendingKey))
    pending.find(entry=>entry.id===id).trigger_time=1
    rows.set(pendingKey,JSON.stringify(pending))
    rows.set(detailKey(id),JSON.stringify({...JSON.parse(rows.get(detailKey(id))),trigger_time:1}))
  }
  const id=await schedule(input,'同一归属仍可执行')
  assert.ok(JSON.parse(rows.get(detailKey(id))).bindingIdentity)
  write(first)
  const refreshed=event()
  await host.handleTool(refreshed)
  assert.equal((await tool.getActionFacts(refreshed)).tasks[0].followUp.state,'registered')
  const restart=createReminderRuntime(ports)
  makeDue(id)
  fs.writeFileSync(file,'invalid: [')
  await restart.checkPendingReminders({})
  const waiting=JSON.parse(rows.get(detailKey(id)))
  assert.equal(waiting.status,'pending')
  assert.equal(waiting.retry_count,0)
  assert.equal(waiting.waitingForBinding,true)
  assert.equal(sends.length,0)
  write(first)
  const restored=event()
  await host.handleTool(restored)
  assert.equal((await tool.getActionFacts(restored)).tasks[0].followUp.state,'none')
  makeDue(id)
  await restart.checkPendingReminders({})
  assert.equal(sends.length,1)
  assert.equal(sends[0].params.group_id,42)
  assert.equal((await tool.getActionFacts(restored)).tasks[0].delivery.messageId,'reminder-receipt')

  const old=await schedule(restored,'换绑前的提醒')
  const next=config()
  next.bindings[0].agentId='work'
  write(next)
  const replacement=event()
  await host.handleTool(replacement)
  assert.deepEqual((await tool.getActionFacts(replacement)).tasks,[])
  assert.match(await tool.cancelReminder(replacement,old),/不属于当前角色和会话/)
  makeDue(old)
  await restart.checkPendingReminders({})
  assert.equal(sends.length,1)
  assert.equal(JSON.parse(rows.get(detailKey(old))).status,'cancelled')
})
