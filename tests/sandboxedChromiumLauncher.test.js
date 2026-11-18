import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// These tests execute the real identity switch and execve in an isolated /tmp
// tree. They require Linux root and never access QQ, Redis or deployed config.
const launcher = fileURLToPath(new URL('../scripts/start-sandboxed-chromium.mjs', import.meta.url))
const skip = process.platform !== 'linux' ? 'requires Linux identity and execve semantics'
  : process.getuid?.() !== 0 ? 'requires root to test the real privilege drop'
  : typeof process.execve !== 'function' ? 'requires Node.js with process.execve' : false
const uid = 65534, gid = 65534
const refusal = '[Agent] Sandboxed Chromium launch refused; check the dedicated browser user, private home and temporary profile.\n'
const secret = 'sandbox-launcher-isolated-secret-123'
const metadata = async file => {
  const stat = await lstat(file, { bigint: true })
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode,
    size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

async function fixture(t) {
  const temporary = await realpath(tmpdir())
  const directory = await realpath(await mkdtemp(path.join(temporary, 'sandbox-launcher-test-')))
  const profile = await mkdtemp(path.join(temporary, 'puppeteer_dev_chrome_profile-'))
  t.after(async () => { await rm(profile, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }) })
  await chmod(directory, 0o755); await chmod(profile, 0o700)
  const home = path.join(directory, 'home'), executable = path.join(directory, 'fake-chromium')
  await mkdir(home, { mode: 0o700 }); await chown(home, uid, gid)
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'
import path from 'node:path'
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
const stat = fs.lstatSync(profile)
const report = { pid: process.pid, uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups(),
  cwd: process.cwd(), env: process.env, args: process.argv.slice(2), profile: { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, entries: fs.readdirSync(profile) } }
fs.writeFileSync(path.join(process.env.HOME, 'fake-chromium-ran.json'), JSON.stringify(report), { mode: 0o600 })
process.stdout.write(JSON.stringify(report) + '\\n')
if (process.argv.includes('--hold-for-test')) setInterval(() => {}, 1000)
`, { mode: 0o755 })
  await chmod(executable, 0o755); await chown(executable, 0, 0)
  const env = { PATH: '/usr/bin:/bin', TMPDIR: temporary, HOME: '/root', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Shanghai',
    BL_AGENT_CHROMIUM_UID: String(uid), BL_AGENT_CHROMIUM_GID: String(gid), BL_AGENT_CHROMIUM_HOME: home, BL_AGENT_CHROMIUM_EXECUTABLE: executable,
    BL_AGENT_MODEL_KEY: secret, QQ_TOKEN: secret, NODE_OPTIONS: '--stack-trace-limit=7', LD_LIBRARY_PATH: path.join(directory, 'unused-libraries'),
    HTTP_PROXY: 'http://fixture.invalid:9999', PUPPETEER_EXECUTABLE_PATH: launcher }
  const args = ['--headless=new', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`]
  const run = (options = {}) => {
    const child = spawn(process.execPath, [launcher, ...(options.args ?? args)], { cwd: directory, env: { ...env, ...options.env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }))
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    const result = finished.finally(() => clearTimeout(timer))
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await result })
    return { child, result }
  }
  return { temporary, directory, profile, home, executable, env, args, run }
}

test('Linux root launcher execve preserves PID, drops every identity and strips private environment', { skip, timeout: 10000 }, async t => {
  const f = await fixture(t), before = await metadata(f.profile)
  const { child, result } = f.run(), outcome = await result
  assert.equal(outcome.code, 0, outcome.stderr); assert.equal(outcome.signal, null)
  const report = JSON.parse(outcome.stdout)
  assert.equal(report.pid, child.pid, 'execve must keep the PID observed by Puppeteer')
  assert.deepEqual([report.uid, report.euid, report.gid, report.egid], [uid, uid, gid, gid])
  assert.ok(report.groups.every(group => group === gid)); assert.equal(report.groups.includes(0), false)
  assert.equal(report.cwd, f.home)
  assert.deepEqual(report.env, { PATH: '/usr/bin:/bin', HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, 'config'),
    XDG_CACHE_HOME: path.join(f.home, 'cache'), XDG_RUNTIME_DIR: path.join(f.home, 'runtime'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Shanghai' })
  assert.equal(outcome.stdout.includes(secret), false); assert.equal(outcome.stderr.includes(secret), false)
  assert.deepEqual(report.args, f.args)
  assert.deepEqual(report.profile, { uid, gid, mode: 0o700, entries: [] })
  const after = await metadata(f.profile)
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mode, before.mode)
  assert.equal(after.uid, BigInt(uid)); assert.equal(after.gid, BigInt(gid))
  const runtime = await metadata(path.join(f.home, 'runtime'))
  assert.equal(runtime.uid, BigInt(uid)); assert.equal(runtime.mode & 0o7777n, 0o700n)
  await rm(f.profile, { recursive: true })
  await assert.rejects(lstat(f.profile), { code: 'ENOENT' }, 'the root Puppeteer parent can clean the transferred profile')
  t.diagnostic(`launcher sha256=${createHash('sha256').update(await readFile(launcher)).digest('hex')}`)
})

test('Linux root launcher keeps the browser directly killable under the original child PID', { skip, timeout: 10000 }, async t => {
  const f = await fixture(t), { child, result } = f.run({ args: [...f.args, '--hold-for-test'] })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('fake browser exited before kill check'))); child.once('error', reject)
  })
  assert.equal(child.kill('SIGTERM'), true)
  const outcome = await result
  assert.equal(JSON.parse(outcome.stdout).pid, child.pid); assert.equal(outcome.signal, 'SIGTERM')
})

const rejected = [
  ['root browser UID', f => ({ env: { BL_AGENT_CHROMIUM_UID: '0' } })],
  ['root browser GID', f => ({ env: { BL_AGENT_CHROMIUM_GID: '0' } })],
  ['unsafe numeric identity', f => ({ env: { BL_AGENT_CHROMIUM_UID: '-1' } })],
  ['no sandbox', f => ({ args: [...f.args, '--no-sandbox'] })],
  ['no sandbox assignment', f => ({ args: [...f.args, '--no-sandbox=true'] })],
  ['setuid sandbox disabled', f => ({ args: [...f.args, '--disable-setuid-sandbox'] })],
  ['namespace sandbox disabled', f => ({ args: [...f.args, '--disable-namespace-sandbox'] })],
  ['GPU sandbox disabled', f => ({ args: [...f.args, '--disable-gpu-sandbox'] })],
  ['seccomp sandbox disabled', f => ({ args: [...f.args, '--disable-seccomp-filter-sandbox'] })],
  ['zygote sandbox disabled', f => ({ args: [...f.args, '--no-zygote-sandbox'] })],
  ['single process', f => ({ args: [...f.args, '--single-process'] })],
  ['debugging pipe', f => ({ args: [...f.args, '--remote-debugging-pipe'] })],
  ['dangerous Puppeteer environment', f => ({ env: { PUPPETEER_DANGEROUS_NO_SANDBOX: 'true' } })],
  ['duplicate profile', f => ({ args: [...f.args, `--user-data-dir=${f.profile}`] })],
  ['bare second profile', f => ({ args: [...f.args, '--user-data-dir', f.home] })],
  ['missing profile', f => ({ args: f.args.filter(arg => !arg.startsWith('--user-data-dir=')) })],
  ['non-temporary profile', f => ({ args: f.args.map(arg => arg.startsWith('--user-data-dir=') ? `--user-data-dir=${f.home}` : arg) })],
  ['occupied profile', async f => { await writeFile(path.join(f.profile, 'existing'), 'preserve existing profile'); return {} }],
  ['non-private profile', async f => { await chmod(f.profile, 0o755); return {} }],
  ['non-root profile', async f => { await chown(f.profile, uid, gid); return {} }],
  ['symbolic-link profile', async f => {
    const target = path.join(f.directory, 'profile-target'); await mkdir(target, { mode: 0o700 })
    await rm(f.profile, { recursive: true }); await symlink(target, f.profile)
    return { preserve: [target] }
  }],
  ['non-private home', async f => { await chmod(f.home, 0o755); return {} }],
  ['root-owned home', async f => { await chown(f.home, 0, 0); return {} }],
  ['symbolic-link home', async f => {
    const link = path.join(f.directory, 'home-link'); await symlink(f.home, link)
    return { env: { BL_AGENT_CHROMIUM_HOME: link } }
  }],
  ['non-private runtime', async f => { await mkdir(path.join(f.home, 'runtime'), { mode: 0o755 }); await chown(path.join(f.home, 'runtime'), uid, gid); return {} }],
  ['symbolic-link runtime', async f => {
    const target = path.join(f.directory, 'runtime-target'); await mkdir(target, { mode: 0o700 })
    await symlink(target, path.join(f.home, 'runtime')); return { preserve: [target] }
  }],
  ['writable executable', async f => { await chmod(f.executable, 0o777); return {} }],
  ['non-root executable', async f => { await chown(f.executable, uid, gid); return {} }],
]

for (const [name, prepare] of rejected) test(`Linux root launcher refuses ${name} before changing the profile or executing Chromium`, { skip, timeout: 10000 }, async t => {
  const f = await fixture(t), options = await prepare(f)
  const preserved = [f.profile, ...(options.preserve ?? [])]
  const before = await Promise.all(preserved.map(metadata))
  const outcome = await f.run(options).result
  assert.equal(outcome.code, 1); assert.equal(outcome.signal, null); assert.equal(outcome.stdout, '')
  assert.equal(outcome.stderr, refusal)
  await assert.rejects(lstat(path.join(f.home, 'fake-chromium-ran.json')), { code: 'ENOENT' })
  assert.deepEqual(await Promise.all(preserved.map(metadata)), before, 'refusal must preserve profile and symlink-target metadata')
})
