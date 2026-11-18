#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Existing root-owned Core installations can drop only the browser identity.
// execve preserves the browser PID, pipes and Puppeteer's process cleanup.
const fail = () => { throw new Error('chromium-launch-refused') }
function identity(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(value)) fail()
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) fail()
  return result
}
function directory(name, uid) {
  const stat = fs.lstatSync(name)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(name) !== name) fail()
  return stat
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino }

try {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || typeof process.execve !== 'function') fail()
  const uid = identity(process.env.BL_AGENT_CHROMIUM_UID), gid = identity(process.env.BL_AGENT_CHROMIUM_GID)
  const executable = process.env.BL_AGENT_CHROMIUM_EXECUTABLE, home = process.env.BL_AGENT_CHROMIUM_HOME
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.resolve(executable) !== executable ||
      typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(home) !== home || process.env.PUPPETEER_DANGEROUS_NO_SANDBOX === 'true') fail()
  const binary = fs.statSync(executable)
  if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0) fail()
  directory(home, uid)
  const runtime = path.join(home, 'runtime')
  try {
    fs.mkdirSync(runtime, { mode: 0o700 })
    const before = directory(runtime, 0)
    const fd = fs.openSync(runtime, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      if (!same(before, fs.fstatSync(fd))) fail()
      fs.fchownSync(fd, uid, gid)
    } finally { fs.closeSync(fd) }
  } catch (error) { if (error?.code !== 'EEXIST') throw error }
  directory(runtime, uid)
  const args = process.argv.slice(2)
  if (args.some(arg => /^--(?:no-sandbox|disable-(?:setuid|namespace|gpu|seccomp-filter)-sandbox|no-zygote-sandbox|single-process|remote-debugging-pipe)(?:=|$)/u.test(arg))) fail()
  const profiles = args.filter(arg => arg.startsWith('--user-data-dir='))
  if (profiles.length !== 1 || args.includes('--user-data-dir')) fail()
  const profile = profiles[0].slice('--user-data-dir='.length), temporary = fs.realpathSync(os.tmpdir())
  if (!path.isAbsolute(profile) || path.dirname(profile) !== temporary || !/^puppeteer_dev_chrome_profile-[A-Za-z0-9_-]+$/u.test(path.basename(profile))) fail()
  const before = directory(profile, 0)
  const fd = fs.openSync(profile, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    if (!same(before, fs.fstatSync(fd)) || fs.readdirSync(profile).length || !same(before, directory(profile, 0))) fail()
    fs.fchownSync(fd, uid, gid)
    if (!same(before, fs.fstatSync(fd)) || !same(before, directory(profile, uid))) fail()
  } finally { fs.closeSync(fd) }

  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_RUNTIME_DIR: path.join(home, 'runtime') }
  for (const key of ['LANG', 'LC_ALL', 'TZ']) {
    const value = process.env[key]
    if (typeof value === 'string' && /^[A-Za-z0-9_./+:-]{1,100}$/u.test(value)) env[key] = value
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  process.setgroups([])
  process.setgid(gid)
  process.setuid(uid)
  if (process.getuid() !== uid || process.getgid() !== gid || process.getgroups().some(group => group !== gid)) fail()
  process.chdir(home)
  directory(home, uid)
  directory(runtime, uid)
  process.execve(executable, [executable, ...args], env)
  fail()
} catch {
  process.stderr.write('[Agent] Sandboxed Chromium launch refused; check the dedicated browser user, private home and temporary profile.\n')
  process.exitCode = 1
}
