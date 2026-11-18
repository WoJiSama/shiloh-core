import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createAgentManagementBindings, captureAgentBindingDirectoryCheck }, { readStandaloneAgentConfig }] = await Promise.all([
  load('modules/runtime/infrastructure/agentManagementBindings.js'), load('bootstrap/standaloneAgentConfig.js'),
])

function binding(accountId = '23000101') {
  return { source: 'configured', id: `binding-${accountId}`, revision: 'v1', agentId: 'daily', personaId: 'guide', connectionId: `qq-${accountId}`,
    target: { account: { platform: 'qq', namespace: 'global', id: accountId }, kind: 'group', id: '310901' } }
}

test('every public lookup and captured comparison performs one complete fresh read', () => {
  let live = [binding(), binding('23000102')], reads = 0
  const port = createAgentManagementBindings(() => { reads++; return live })
  assert.equal(Object.isFrozen(port), true)
  const expected = port.list(); assert.equal(reads, 1)
  const check = captureAgentBindingDirectoryCheck(port, expected)
  assert.equal(typeof check, 'function'); assert.equal(reads, 1, 'capture does not observe the live source')
  assert.equal(port.resolve(expected[0].target).id, expected[0].id); assert.equal(reads, 2)
  assert.equal(check(), true); assert.equal(reads, 3)
  live = [live[1], live[0]]
  assert.equal(check(), true); assert.equal(reads, 4, 'directory order does not change membership')
  live = live.slice(1)
  assert.equal(port.resolve(expected[1].target), undefined); assert.equal(reads, 5)
  assert.equal(check(), false); assert.equal(reads, 6)
  live = structuredClone(expected)
  assert.equal(check(), true); assert.equal(reads, 7, 'failed observations are not memoized')
})

test('returned snapshots and captured expectations are independent deep immutable copies', () => {
  const live = [binding()], expected = structuredClone(live), port = createAgentManagementBindings(() => live)
  const check = captureAgentBindingDirectoryCheck(port, expected), first = port.list(), resolved = port.resolve(live[0].target)
  assert.notEqual(first[0], live[0]); assert.notEqual(first[0].target.account, live[0].target.account)
  assert.notEqual(resolved, first[0]); assert.notEqual(resolved.target, first[0].target)
  for (const value of [first, first[0], first[0].target, first[0].target.account, resolved, resolved.target, resolved.target.account]) {
    assert.equal(Object.isFrozen(value), true)
  }
  assert.throws(() => { first[0].revision = 'changed' }, TypeError)
  assert.throws(() => { resolved.target.account.id = 'changed' }, TypeError)
  expected[0].target.account.id = 'changed-expectation'; expected.push(binding('23000102'))
  assert.equal(check(), true, 'mutating the caller expectation cannot update the captured directory')
  live[0].target.account.id = '23000103'; live[0].revision = 'v2'
  assert.equal(first[0].target.account.id, '23000101'); assert.equal(resolved.revision, 'v1')
  assert.equal(check(), false)
})

test('long configured binding IDs survive while raw serializer extensions are ignored', () => {
  const raw = [binding()]
  raw[0].id = 'binding-' + 'x'.repeat(300)
  let callbacks = 0
  for (const value of [raw, raw[0], raw[0].target, raw[0].target.account]) {
    Object.defineProperty(value, 'toJSON', { get() { callbacks++; throw new Error('opaque serializer must not run') } })
  }
  const port = createAgentManagementBindings(() => raw), check = captureAgentBindingDirectoryCheck(port, raw)
  const listed = port.list()
  assert.equal(listed[0].id, raw[0].id); assert.ok(listed[0].id.length > 128 && listed[0].id.length < 4096)
  assert.equal(check(), true); assert.equal(callbacks, 0)
  for (const value of [listed, listed[0], listed[0].target, listed[0].target.account]) assert.equal(Object.hasOwn(value, 'toJSON'), false)
})

test('all identity and address fields, membership and duplicate addresses affect the full directory', () => {
  const baseline = [binding(), binding('23000102')]
  let live = structuredClone(baseline)
  const port = createAgentManagementBindings(() => live), check = captureAgentBindingDirectoryCheck(port, baseline)
  const changes = [
    ['source', 'legacy'], ['id', 'replacement'], ['revision', 'v2'], ['agentId', 'other'], ['personaId', 'other'], ['connectionId', 'other'],
    ['target.account.platform', 'matrix'], ['target.account.namespace', 'other'], ['target.account.id', '23000103'],
    ['target.kind', 'private'], ['target.id', '310902'],
  ]
  for (const [field, value] of changes) {
    live = structuredClone(baseline)
    const keys = field.split('.'), leaf = keys.pop()
    keys.reduce((row, key) => row[key], live[0])[leaf] = value
    assert.equal(check(), false, field)
  }
  live = structuredClone(baseline); live[1].revision = 'v2'
  assert.equal(check(), false, 'changes to a later member are observed too')
  live = baseline.slice(1); assert.equal(check(), false, 'removed member')
  live = [...baseline, binding('23000103')]; assert.equal(check(), false, 'added member')
  live = [binding(), { ...binding(), id: 'different-id', agentId: 'different-agent' }]
  assert.throws(check, 'two agents cannot own one conversation address')
  live = [{ ...binding(), source: 'unknown' }]
  assert.throws(check, 'unrecognized source kinds cannot enter a coherent directory')
})

test('only an exact factory port is captured before either foreign methods or expectations are inspected', () => {
  let reads = 0, callbacks = 0
  const port = createAgentManagementBindings(() => { reads++; return [binding()] })
  const tripwire = () => { callbacks++; throw new Error('must not inspect foreign input') }
  const expected = new Proxy([], { get: tripwire, getOwnPropertyDescriptor: tripwire, getPrototypeOf: tripwire })
  const accessor = Object.defineProperties({}, { list: { get: tripwire }, resolve: { get: tripwire } })
  const foreign = { list: tripwire, resolve: tripwire }
  const proxy = new Proxy(port, { get: tripwire, getOwnPropertyDescriptor: tripwire, getPrototypeOf: tripwire })
  for (const candidate of [foreign, { ...port }, Object.create(port), accessor, proxy]) {
    assert.equal(captureAgentBindingDirectoryCheck(candidate, expected), undefined)
  }
  assert.equal(callbacks, 0); assert.equal(reads, 0)
  assert.equal(typeof captureAgentBindingDirectoryCheck(port, [binding()]), 'function')
  assert.equal(reads, 0)
})

test('an optional holder must expose the exact port as its own data property before expectations are inspected', () => {
  let reads = 0, callbacks = 0
  const port = createAgentManagementBindings(() => { reads++; return [binding()] })
  const tripwire = () => { callbacks++; throw new Error('must not inspect an unowned holder or expectation') }
  const expected = new Proxy([], { get: tripwire, getOwnPropertyDescriptor: tripwire, getPrototypeOf: tripwire })
  const getter = Object.defineProperty({}, 'bindings', { get: tripwire })
  const inherited = Object.create({ bindings: port })
  const proxy = new Proxy({ bindings: port }, { get: tripwire, getOwnPropertyDescriptor: tripwire, getPrototypeOf: tripwire })
  const other = createAgentManagementBindings(tripwire)
  for (const holder of [getter, inherited, proxy, { bindings: other }, { bindings: { ...port } }]) {
    assert.equal(captureAgentBindingDirectoryCheck(port, expected, holder), undefined)
  }
  assert.equal(callbacks, 0); assert.equal(reads, 0)
  const check = captureAgentBindingDirectoryCheck(port, [binding()], Object.freeze({ bindings: port }))
  assert.equal(typeof check, 'function'); assert.equal(reads, 0)
  assert.equal(check(), true); assert.equal(reads, 1)
})

test('a captured holder rejects replacement by another factory or foreign port before reading either directory', () => {
  let reads = 0, replacementReads = 0
  const port = createAgentManagementBindings(() => { reads++; return [binding()] })
  const replacement = createAgentManagementBindings(() => { replacementReads++; return [binding()] })
  const holder = { bindings: port }, check = captureAgentBindingDirectoryCheck(port, [binding()], holder)
  assert.equal(check(), true); assert.equal(reads, 1)
  holder.bindings = replacement
  assert.equal(check(), false, 'another factory with identical rows still replaces the captured owner')
  assert.equal(reads, 1); assert.equal(replacementReads, 0)
  holder.bindings = { list() { replacementReads++; return [binding()] }, resolve() { replacementReads++; return binding() } }
  assert.equal(check(), false); assert.equal(reads, 1); assert.equal(replacementReads, 0)
})

test('a holder replaced during its complete read cannot return a current directory', () => {
  let holder, reads = 0, replacementReads = 0
  const replacement = createAgentManagementBindings(() => { replacementReads++; return [binding()] })
  const port = createAgentManagementBindings(() => { reads++; holder.bindings = replacement; return [binding()] })
  holder = { bindings: port }
  const check = captureAgentBindingDirectoryCheck(port, [binding()], holder)
  assert.equal(check(), false, 'the owner must still expose the captured port after reading')
  assert.equal(reads, 1); assert.equal(replacementReads, 0)
  assert.equal(check(), false); assert.equal(reads, 1); assert.equal(replacementReads, 0)
})

test('changing a holder data property to a getter during a read is rejected without invoking that getter', () => {
  let holder, reads = 0, getters = 0
  const port = createAgentManagementBindings(() => {
    reads++
    Object.defineProperty(holder, 'bindings', { get() { getters++; return port } })
    return [binding()]
  })
  holder = { bindings: port }
  const check = captureAgentBindingDirectoryCheck(port, [binding()], holder)
  assert.equal(check(), false)
  assert.equal(reads, 1); assert.equal(getters, 0)
  assert.equal(check(), false); assert.equal(reads, 1); assert.equal(getters, 0)
})

test('sparse, accessor and Proxy directories are rejected without running opaque property code', () => {
  let callbacks = 0
  const tripwire = () => { callbacks++; throw new Error('must not invoke a getter or Proxy trap') }
  const indexed = Object.defineProperty([], '0', { get: tripwire })
  const thenGetter = Object.defineProperty([binding()], 'then', { get: tripwire })
  const inheritedThenGetter = Object.setPrototypeOf([binding()], Object.defineProperty({}, 'then', { get: tripwire }))
  const row = Object.defineProperty(binding(), 'revision', { get: tripwire })
  const target = binding(); target.target = Object.defineProperty(target.target, 'id', { get: tripwire })
  const account = binding(); account.target.account = new Proxy(account.target.account, { get: tripwire, getOwnPropertyDescriptor: tripwire })
  const inputs = [Array(1), indexed, thenGetter, inheritedThenGetter, [row], [target], [account],
    new Proxy([binding()], { get: tripwire, getOwnPropertyDescriptor: tripwire }),
    [new Proxy(binding(), { get: tripwire, getOwnPropertyDescriptor: tripwire })]]
  for (const input of inputs) {
    const port = createAgentManagementBindings(() => input)
    assert.throws(() => port.list())
    assert.throws(() => captureAgentBindingDirectoryCheck(port, input))
  }
  assert.equal(callbacks, 0)
})

test('thenable directory readers are rejected synchronously without invoking their callbacks', () => {
  let callbacks = 0
  const then = () => { callbacks++; throw new Error('must not invoke then') }
  const inheritedThen = Object.setPrototypeOf([binding()], { then })
  for (const input of [{ then }, Object.assign(() => {}, { then }), Object.assign([binding()], { then }), inheritedThen]) {
    const port = createAgentManagementBindings(() => input)
    assert.throws(() => port.list())
    assert.throws(() => captureAgentBindingDirectoryCheck(port, input))
  }
  assert.equal(callbacks, 0)
})

test('a rejected native Promise reader fails synchronously without an unhandled rejection or overridden then call', async () => {
  let callbacks = 0
  const input = Promise.reject(new Error('asynchronous directory reader'))
  input.then = () => { callbacks++; throw new Error('overridden then must not run') }
  const port = createAgentManagementBindings(() => input)
  assert.throws(() => port.list())
  assert.throws(() => captureAgentBindingDirectoryCheck(port, input))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(callbacks, 0)
})

test('finite busy observers perform complete reentrant checks and do not reuse a nested result', () => {
  const baseline = [binding()], observations = []
  let live = structuredClone(baseline), check, busy = false, withdraw = false, reads = 0
  const port = createAgentManagementBindings(() => {
    reads++
    if (check && !busy) {
      busy = true
      try { observations.push(check()) } finally { busy = false }
      if (withdraw) live[0].revision = 'withdrawn-after-observation'
    }
    return live
  })
  check = captureAgentBindingDirectoryCheck(port, baseline)
  assert.equal(check(), true); assert.equal(reads, 2); assert.deepEqual(observations, [true])
  withdraw = true
  assert.equal(check(), false); assert.equal(reads, 4); assert.deepEqual(observations, [true, true])
  assert.equal(check(), false); assert.equal(reads, 6); assert.deepEqual(observations, [true, true, false])
})

function configFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'management-binding-sources-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = { host: path.join(root, 'agent-host.yaml'), personas: path.join(root, 'persona-library.yaml'), bindings: path.join(root, 'agent-bindings.yaml') }
  const sources = {
    host: 'version: 1\ninstance: management-bindings\nmodel:\n  baseUrl: https://api.example/v1\n  name: test-model\n  apiKeyEnv: TEST_MANAGEMENT_API_KEY\nconnections:\n  - id: main\n    url: ws://127.0.0.1:3001\n',
    personas: 'personas:\n  - id: guide\n    name: Guide\n',
    bindings: 'version: 1\nagents:\n  - id: daily\n    personaId: guide\nconnections:\n  - id: main\n    platform: qq\n    namespace: global\n    accountId: "23000101"\nbindings:\n  - connectionId: main\n    kind: group\n    conversationId: "310901"\n    agentId: daily\n',
  }
  for (const key of Object.keys(files)) fs.writeFileSync(files[key], sources[key], { mode: 0o600 })
  const read = () => readStandaloneAgentConfig(files.host, {}, { requireCredentials: false })
  return { root, files, sources, read }
}

test('an actual standalone reader compares one complete source observation and withdraws on each YAML dependency change', t => {
  const f = configFixture(t)
  for (const changed of ['host', 'personas', 'bindings']) {
    const config = f.read(), port = createAgentManagementBindings(() => config.listBindings()), expected = port.list()
    const check = captureAgentBindingDirectoryCheck(port, expected), opens = new Map(Object.values(f.files).map(file => [file, 0]))
    const open = fs.openSync
    fs.openSync = function(file, ...args) {
      if (opens.has(file)) opens.set(file, opens.get(file) + 1)
      return open.call(this, file, ...args)
    }
    try { assert.equal(check(), true) } finally { fs.openSync = open }
    assert.deepEqual([...opens.values()], [2, 2, 2], 'one observation performs the existing full three-file double read')
    fs.appendFileSync(f.files[changed], `# ${changed} changed\n`)
    assert.equal(check(), false, changed)
    if (changed === 'bindings') {
      const current = port.resolve(expected[0].target)
      assert.equal(current.id, expected[0].id); assert.notEqual(current.revision, expected[0].revision)
    } else assert.deepEqual(port.list(), [], changed)
  }
})

test('same-byte binding inode replacement revokes a captured directory revision', t => {
  const f = configFixture(t), config = f.read(), port = createAgentManagementBindings(() => config.listBindings())
  const expected = port.list(), check = captureAgentBindingDirectoryCheck(port, expected), before = fs.statSync(f.files.bindings)
  const replacement = path.join(f.root, 'replacement.yaml')
  fs.writeFileSync(replacement, f.sources.bindings, { mode: 0o600 }); fs.renameSync(replacement, f.files.bindings)
  assert.equal(fs.readFileSync(f.files.bindings, 'utf8'), f.sources.bindings)
  assert.notEqual(fs.statSync(f.files.bindings).ino, before.ino)
  assert.equal(check(), false)
  assert.notEqual(port.list()[0].revision, expected[0].revision)
})

test('a terminal fence retires the original reader while a fresh reader may observe the same binding directory', t => {
  const f = configFixture(t), config = f.read(), port = createAgentManagementBindings(() => config.listBindings())
  const expected = port.list(), check = captureAgentBindingDirectoryCheck(port, expected)
  const head = path.join(f.root, '.agent-config.head'), token = '11111111-1111-4111-8111-111111111111'
  fs.mkdirSync(head, { mode: 0o700 })
  fs.writeFileSync(path.join(head, `${token}.json`), JSON.stringify({ schema: 1, txId: token, direction: 'undo', token }), { mode: 0o600 })
  assert.equal(check(), false); assert.deepEqual(port.list(), [])
  const fresh = f.read()
  assert.deepEqual(fresh.sourceSnapshot.versions, config.sourceSnapshot.versions)
  assert.notEqual(fresh.sourceSnapshot.fence, config.sourceSnapshot.fence)
  const freshPort = createAgentManagementBindings(() => fresh.listBindings())
  assert.equal(captureAgentBindingDirectoryCheck(freshPort, expected)(), true)
})
