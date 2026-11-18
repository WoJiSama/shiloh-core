import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

// Checkout-only legacy parity and source architecture checks. These assertions
// are deliberately separate from installed-package suites: the agent archive
// does not publish DiceManager, the plugin config repository, or TypeScript sources.
const [{ createAgentDiceBuiltin }, { DiceManager }, { createStandaloneAgentConsoleServices },
  { AgentConsoleError }, { agentConversationKey, agentBindingToken }, { createConfigRepository, ConfigConflictError }] = await Promise.all([
  load('modules/dice/infrastructure/agentDiceBuiltin.js'), load('modules/dice/infrastructure/DiceManager.js'),
  load('bootstrap/standaloneAgentConsoleServices.js'), load('contracts/agentConsole.js'),
  load('modules/runtime/domain/agentBindings.js'), load('modules/config/infrastructure/configRepository.js'),
])

const source={messageId:'native-human-message',authorId:'alice',at:1_800_000_000_000}
const context=(extra={})=>({source,actor:{id:'alice',name:'Alice'},members:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'carol',name:'Carol'}],mentions:[],groupId:'room',botUserId:'bot',allows:permission=>permission==='player',...extra})
const publicText=result=>result.effects.filter(effect=>effect.kind==='public').map(effect=>effect.text).join('\n')
const card=(state,id='alice')=>state.users[id].cards[state.users[id].activeCard]
const randomForD100=value=>{const digits=value===100?[0,0]:[value%10,Math.floor(value/10)];let index=0;return()=>digits[index++%2]/10+0.001}
const inputState=()=>({version:1,users:{alice:{activeCard:'default',cards:{default:{name:'Investigator',attrs:{STR:50,CON:50,SIZ:60,DEX:70,POW:60,EDU:70,SAN:60},skills:{侦查:60,斗殴:50,克苏鲁神话:10}}}},bob:{activeCard:'default',cards:{default:{name:'Other',attrs:{SAN:70,DEX:40},skills:{侦查:80,斗殴:50}}}}},scene:{}})
async function run(command,{state=inputState(),ctx=context(),random=()=>0.501,config={}}={}){return createAgentDiceBuiltin(config).evaluate({state,command,context:ctx,random})}

test('COC ranks preserve all rule 0-5 and nofumble boundary semantics against the legacy pure rank function',async()=>{
 const pure=Object.create(DiceManager.prototype)
 const names={4:'大成功',3:'极难成功',2:'困难成功',1:'成功',[-1]:'失败',[-2]:'大失败'}
 for(const rule of ['0','1','2','3','4','5','nofumble'])for(const target of [1,49,50,80,100])for(const value of [1,2,3,4,5,9,10,20,40,49,50,79,80,95,96,97,98,99,100]){
  const expected=pure.computeCocRank(value,target,rule==='nofumble'?'0':rule).rank
  const result=await run(`.ra 侦查 ${target}`,{random:randomForD100(value),config:{defaultRule:rule,templates:{check:'{level}'}}})
  assert.equal(publicText(result),names[rule==='nofumble'&&expected===-2?-1:expected],`${rule}/${target}/${value}`)
 }
 const hard=await run('.ra 困难侦查 60',{random:randomForD100(40)});assert.match(publicText(hard),/困难检定失败/u)
 const extreme=await run('.ra 极难侦查 60',{random:randomForD100(10)});assert.match(publicText(extreme),/极难检定成功/u)
})

function binding(id = '23000101') {
  return { source: 'configured', id: `binding-${id}`, revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: `qq-${id}`,
    target: { account: { platform: 'qq', namespace: 'global', id }, kind: 'group', id: '310901' } }
}
function fixture(extra = {}) {
  const bindings = [binding(), binding('23000102')], decisions = new Map(), controller = new AbortController()
  let active = true
  const principal = { id: 'operator', username: 'admin', via: 'session' }
  const context = selected => {
    const captured = selected && structuredClone(selected), isCurrent = () => active && !controller.signal.aborted && (!captured || bindings.some(current => agentConversationKey(current) === agentConversationKey(captured) && agentBindingToken(current) === agentBindingToken(captured)))
    return { principal, ...(captured ? { binding: captured } : {}), signal: controller.signal, isCurrent, ensureCurrent() { if (!isCurrent()) throw new AgentConsoleError('conflict') } }
  }
  const ports = { bindings: { list: () => bindings, resolve: target => bindings.find(item => agentConversationKey(item) === agentConversationKey({ agentId: item.agentId, target })) },
    auth: { async authorize(_principal, operation, selected, guard) { guard.ensureCurrent(); return decisions.get(`${operation}:${selected?.target.account.id}`) ?? 'allowed' } }, ...extra }
  const services = createStandaloneAgentConsoleServices(ports)
  const call = async (operation, { body = {}, query = {}, params = {}, selected } = {}) => {
    const service = services.find(item => item.operation === operation)
    assert.ok(service?.handle, `${operation} installed`)
    return (await service.handle({ method: service.method, pathname: service.path, body, query, params }, context(selected))).value
  }
  return { ports, bindings, decisions, controller, context, services, call, revoke: () => { active = false } }
}

test('config services require revisions and reuse a real CAS repository without discarding credentials or unrelated YAML', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'console-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'agent.yaml')
  await writeFile(file, '# keep-comment\nagent:\n  persona:\n    name: before\n  apiKey: fixture-private-key\n  unrelated: keep\n')
  const repository = createConfigRepository({ file, settingsKey: 'agent' })
  let writes = 0
  const f = fixture({ config: {
    read(kind, context) { context.ensureCurrent(); const view = repository.read(); return { key: kind, revision: view.revision, value: view.settings.persona } },
    async write(kind, payload, context) {
      context.ensureCurrent()
      try { await repository.update(document => { context.ensureCurrent(); writes++; document.setIn(['agent', 'persona', 'name'], payload.values['persona.name']) }, { expectedRevision: payload.revision }) }
      catch (error) { if (error instanceof ConfigConflictError) throw new AgentConsoleError('conflict'); throw error }
      context.ensureCurrent(); return { ok: true, kind, revision: repository.read().revision }
    },
  } })
  const view = await f.call('config.read', { params: { kind: 'persona' } })
  assert.equal(JSON.stringify(view).includes('fixture-private-key'), false)
  await assert.rejects(f.call('config.write', { params: { kind: 'persona' }, body: { values: { 'persona.name': 'after' } } }), { code: 'invalid_request' })
  assert.equal(writes, 0)
  const result = await f.call('config.write', { params: { kind: 'persona' }, body: { revision: view.revision, values: { 'persona.name': 'after' } } })
  assert.equal(result.ok, true); assert.notEqual(result.revision, view.revision)
  const after = await readFile(file, 'utf8'); assert.match(after, /# keep-comment/u); assert.match(after, /fixture-private-key/u); assert.match(after, /unrelated: keep/u); assert.match(after, /name: after/u)
  await assert.rejects(f.call('config.write', { params: { kind: 'persona' }, body: { revision: view.revision, values: { 'persona.name': 'stale' } } }), { code: 'conflict' })
  assert.equal(writes, 1); assert.equal(await readFile(file, 'utf8'), after)
  await assert.rejects(f.call('config.read', { params: { kind: '../secrets' } }), { code: 'not_found' })
})

test('the neutral console source imports no plugin runtime, globals or service implementation', async () => {
  const source = await readFile(new URL('../src/bootstrap/standaloneAgentConsole.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /globalThis\.|process\.env|YUNZAI|CONSOLE_PLUGIN_ROOT|message\.yaml|connectAgentRedis|consoleServer\.js/u)
})
