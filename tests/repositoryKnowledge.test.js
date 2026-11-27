import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRepositoryGit } from '../dist/backend/bootstrap/repositoryGit.js'
import { decodeRepositoryCatalog } from '../dist/backend/modules/knowledge/infrastructure/repositoryCatalog.js'
import { openRepositoryKnowledge } from '../dist/backend/modules/knowledge/infrastructure/repositoryKnowledge.js'

const target = (platform, id) => ({ account: { platform, namespace: platform === 'qq' ? 'global' : 'ding-example', id: platform + '-bot' }, kind: 'group', id })
const qq = target('qq', 'web-group')
const ding = target('dingtalk', 'work-group')
const partial = target('qq', 'front-only')
const prompt = '研发自测开关默认开启吗'

function reply(value) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] }
}

const catalog = () => decodeRepositoryCatalog({
  repositories: [
    { id: 'backend', remote: 'git@codeup.aliyun.com:company/dept/backend.git', branch: 'master', paths: ['src'] },
    { id: 'frontend', remote: 'https://codeup.aliyun.com/company/dept/frontend.git', branch: 'master', paths: ['src'] },
  ],
  projects: [{ id: 'demo', name: '示例项目', repositories: ['backend', 'frontend'] }],
  grants: [qq, ding, partial].map(target => ({ target, projectId: 'demo', repositories: target === partial ? ['frontend'] : ['backend', 'frontend'] })),
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function fixture(root, id, file, text) {
  const cwd = path.join(root, id)
  await mkdir(path.join(cwd, 'src'), { recursive: true })
  git(cwd, 'init', '-q', '-b', 'master')
  git(cwd, 'config', 'user.name', 'Fixture')
  git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  async function commit(content) {
    await writeFile(path.join(cwd, 'src', file), content)
    git(cwd, 'add', 'src')
    git(cwd, 'commit', '-qm', 'fixture change')
    return git(cwd, 'rev-parse', 'HEAD')
  }
  return { cwd, initial: await commit(text), commit }
}

async function until(check) {
  for (let tries = 0; tries < 240; tries++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail('repository work timed out')
}

function incoming(conversation, text = prompt) {
  return { version: 1, conversation, sender: { ...conversation.account, id: 'member' }, messageId: 'question',
    occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true }
}

test('versioned Git evidence is reused across channels and cannot outlive revocation or a new commit', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiloh-project-knowledge-'))
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }) })
  const [backend, frontend] = await Promise.all([
    fixture(root, 'backend', 'Policy.java', 'class Policy {\n // 研发自测\n static boolean selfTest = false;\n}\n'),
    fixture(root, 'frontend', 'Creation.ts', 'export const label = "研发自测"\nexport const readSelfTest = true\n'),
  ])
  git(backend.cwd, 'tag', 'pilot-1')
  git(frontend.cwd, 'tag', 'pilot-1')
  const directory = path.join(root, 'core')
  const searches = [], tool = createRepositoryGit({ directory, testRemote: source => ({ backend, frontend })[source.id].cwd })
  const frames = []
  const serviceOptions = { directory, seed: catalog(), syncIntervalMs: 60_000, modelAllowed: true, signal: controller.signal,
    isCurrent: () => !controller.signal.aborted, allowsText: () => true,
    git: { ...tool, search(...args) { searches.push(args[0].id); return tool.search(...args) } },
    async model(request, guard) {
      await guard.ensureCurrent()
      const system = request.messages[0].content
      const data = JSON.parse(request.messages[1].content)
      if (system.startsWith('判断用户')) return reply({ kind: 'project', project: 'demo', terms: ['研发自测', 'selfTest'],
        ...(data.question.includes('pilot-1') ? { tag: 'pilot-1' } : {}) })
      if (system.startsWith('依据编号')) return reply({ topic: '研发自测开关', fact: '研发自测由前后端读取和处理开关值。',
        terms: ['研发自测', 'selfTest'], refs: data.sources.map(row => row.ref) })
      frames.push(data)
      const enabled = data.sources.find(row => row.repoId === 'backend')?.text?.includes('selfTest = true')
      return reply({ answer: enabled ? '源码默认开启。' : '请按所列实现核对。', topic: '研发自测开关',
        refs: data.sources.filter((row, index) => index === data.sources.findIndex(item => item.repoId === row.repoId)).map(row => row.ref) })
    },
  }
  let service = await openRepositoryKnowledge(serviceOptions)
  t.after(() => service.close())
  await until(() => service.status().every(row => row.state === 'ready'))
  assert.deepEqual(service.status().map(row => row.tracked), [backend.initial, frontend.initial])
  const guard = { signal: controller.signal, isCurrent: () => true, async ensureCurrent() {} }
  const first = await service.knowledge.answer(incoming(ding), {}, guard)
  assert.match(first.text, /backend@/)
  assert.match(first.text, /frontend@/)
  assert.match(first.text, new RegExp('/blob/' + backend.initial + '/src/Policy.java'))
  await first.delivered({ state: 'sent', messageId: 'confirmation' })
  await until(() => service.status()[0].memoryCount === 1)
  const saved = JSON.parse(await readFile(path.join(directory, 'backend', 'memory.json'), 'utf8'))
  assert.equal(saved.length, 1)
  assert.doesNotMatch(JSON.stringify(saved), /work-group|web-group|question/)
  await service.close()
  service = await openRepositoryKnowledge(serviceOptions)
  await until(() => service.status().every(row => row.state === 'ready'))
  const count = searches.length
  const reused = await service.knowledge.answer(incoming(qq), { name: '希洛' }, guard)
  assert.ok(reused)
  assert.equal(frames.at(-1).memory[0].id, saved[0].id)
  assert.equal(searches.length, count)
  await service.knowledge.answer(incoming(partial), {}, guard)
  assert.deepEqual(frames.at(-1).memory, [])
  assert.ok(frames.at(-1).sources.every(row => row.repoId === 'frontend'))

  const updated = await backend.commit('class Policy {\n // 研发自测\n static boolean selfTest = true;\n}\n')
  await service.refresh('backend', () => {})
  await until(() => service.status()[0].tracked === updated)
  const after = await service.knowledge.answer(incoming(qq), {}, guard)
  assert.match(after.text, /源码默认开启/)
  assert.ok(!frames.at(-1).memory.some(row => row.id === saved[0].id))
  const historical = await service.knowledge.answer(incoming(qq, prompt + ' pilot-1'), {}, guard)
  assert.match(historical.text, new RegExp('/blob/' + backend.initial))
  const next = { ...service.catalog.get(), grants: service.catalog.get().grants.filter(row => row.target.id !== qq.id) }
  assert.equal(await service.replace(service.catalog.revision(), next, () => {}), true)
  assert.equal(after.isCurrent(), false)
  assert.equal(service.knowledge.available(qq), false)
  assert.equal(service.knowledge.available(ding), true)
})

test('repository catalog requires an authorized path and canonicalizes the Codeup repository identity', () => {
  const current = catalog()
  assert.throws(() => decodeRepositoryCatalog({ ...current, repositories: [...current.repositories, {
    id: 'duplicate', remote: 'https://codeup.aliyun.com/company/dept/backend.git', branch: 'master', paths: ['src'],
  }] }), /重复/)
  assert.throws(() => decodeRepositoryCatalog({ ...current, repositories: [{ ...current.repositories[0], paths: ['../private'] }] }), /路径/)
  assert.throws(() => decodeRepositoryCatalog({ ...current, repositories: [{ ...current.repositories[0], remote: 'https://example.com/company/dept/backend.git' }] }), /云效/)
})
