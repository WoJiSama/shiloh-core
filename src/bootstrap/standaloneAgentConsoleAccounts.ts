import { execFile } from 'node:child_process'
import { statfs, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext } from '../contracts/agentConsole.js'
import type { StandaloneQqLoginConfig } from './standaloneAgentConsoleConfig.js'

const exec = promisify(execFile)
const tokenEnv = 'BL_AGENT_MANAGED_QQ_TOKEN'
const accountPattern = /^[1-9]\d{4,11}$/u
const imagePattern = /^mlikiowa\/napcat-docker@sha256:[a-f0-9]{64}$/u
const label = 'shiloh.qq.account'
type Action = 'start' | 'stop' | 'restart'
type Inspect = { Id: string; State: { Running: boolean }; HostConfig: { NetworkMode: string };
  Config: { Labels: Record<string, string> | null }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> } }

export function createStandaloneAgentConsoleAccounts(options: { dataDir: string; enabled: boolean
  image?: string; token?: string; configs: readonly StandaloneQqLoginConfig[] }) {
  const available = options.enabled && process.platform === 'linux'
  const provisionAvailable = available && !!options.image && imagePattern.test(options.image) &&
    !!options.token && /^[A-Za-z0-9_-]{24,128}$/u.test(options.token)
  const managed = new Map(options.configs.filter(row => row.container).map(row => [row.connectionId, row]))
  const pending = new Set<string>()
  const unavailable = (): never => { throw new AgentConsoleError('unavailable') }
  async function docker(args: string[], signal: AbortSignal, timeout = 8000) {
    return (await exec('/usr/bin/docker', args, { signal, timeout, maxBuffer: 512 * 1024,
      env: { PATH: '/usr/bin:/bin' } })).stdout
  }
  async function inspect(name: string, signal: AbortSignal): Promise<Inspect | undefined> {
    const output = await docker(['container', 'ls', '-aq', '--filter', 'name=^/' + name + '$'], signal)
    const id = output.trim()
    if (!id) return undefined
    if (!/^[a-f0-9]{12,64}$/u.test(id)) return unavailable()
    const result = JSON.parse(await docker(['container', 'inspect', id], signal)) as Inspect[]
    if (result.length !== 1 || !result[0]?.Id.startsWith(id)) return unavailable()
    return result[0]
  }
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (pending.has(key)) throw new AgentConsoleError('conflict')
    pending.add(key)
    try { return await action() }
    catch (error) { if (error instanceof AgentConsoleError) throw error; return unavailable() }
    finally { pending.delete(key) }
  }
  return {
    available,
    provisionAvailable,
    async list(context: AgentConsoleContext, visible: ReadonlySet<string>) {
      return Promise.all([...managed.values()].filter(row => visible.has(row.connectionId)).map(async row => {
        const state = await inspect(row.container!, context.signal).then(item => !item ? 'absent' : item.State.Running ? 'running' : 'stopped', () => 'unavailable')
        context.ensureCurrent()
        return { connectionId: row.connectionId, accountId: row.accountId, container: row.container!, state, busy: pending.has(row.accountId) }
      }))
    },
    async action(connectionId: string, accountId: string, action: Action, context: AgentConsoleContext) {
      const row = managed.get(connectionId)
      if (!available || !row || row.accountId !== accountId) throw new AgentConsoleError('not_found')
      return exclusive(accountId, async () => {
        const item = await inspect(row.container!, context.signal)
        if (!item) throw new AgentConsoleError('not_found')
        if (action !== 'stop' && row.companion) {
          const companion = await inspect(row.companion, context.signal)
          if (!companion || item.HostConfig.NetworkMode !== 'container:' + companion.Id) return unavailable()
          if (!companion.State.Running) {
            context.ensureCurrent()
            await docker(['start', companion.Id], context.signal, 30_000)
          }
        }
        context.ensureCurrent()
        if (action === 'restart' || item.State.Running !== (action === 'start')) {
          await docker([action, item.Id], context.signal, 30_000)
        }
        const after = await inspect(row.container!, context.signal)
        context.ensureCurrent()
        if (!after || after.Id !== item.Id || after.State.Running !== (action !== 'stop')) return unavailable()
        return { connectionId, accountId, state: after.State.Running ? 'running' : 'stopped' }
      })
    },
    async provision(accountId: string, context: AgentConsoleContext) {
      if (!accountPattern.test(accountId)) throw new AgentConsoleError('invalid_request')
      if (!provisionAvailable) return unavailable()
      return exclusive(accountId, async () => {
        const container = 'shiloh-qq-' + accountId, connectionId = 'qq-' + accountId
        const directory = path.join(options.dataDir, 'qq-accounts', accountId)
        const signal = context.signal
        let item = await inspect(container, signal)
        if (item && item.Config.Labels?.[label] !== accountId) throw new AgentConsoleError('conflict')
        if (!item) {
          const disk = await statfs(options.dataDir)
          if (disk.bavail * disk.bsize < 512 * 1024 * 1024) return unavailable()
          const configDir = path.join(directory, 'config'), qqDir = path.join(directory, 'qq')
          for (const folder of [path.dirname(directory), directory, configDir, qqDir]) {
            context.ensureCurrent()
            await mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
            const stat = await lstat(folder)
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return unavailable()
          }
          const web = { host: '0.0.0.0', port: 6099, token: options.token!, loginRate: 3, disableWebUI: false }
          const onebot = { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [],
            websocketServers: [{ name: 'core', host: '0.0.0.0', port: 3001, enable: true, reportSelfMessage: false,
              messagePostFormat: 'array', token: options.token!, debug: false, heartInterval: 30_000 }] }, musicSignUrl: '' }
          for (const [name, value] of [['webui.json', web], ['onebot11_' + accountId + '.json', onebot]] as const) {
            const file = path.join(configDir, name), bytes = JSON.stringify(value, null, 2) + '\n'
            context.ensureCurrent()
            try { await writeFile(file, bytes, { mode: 0o600, flag: 'wx' }) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              const stat = await lstat(file)
              if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
                  await readFile(file, 'utf8') !== bytes) throw new AgentConsoleError('conflict')
            }
          }
          context.ensureCurrent()
          await docker(['run', '-d', '--pull=never', '--name', container, '--label', label + '=' + accountId,
            '--restart', 'unless-stopped', '--env', 'ACCOUNT=' + accountId,
            '--publish', '127.0.0.1::6099', '--publish', '127.0.0.1::3001',
            '--volume', configDir + ':/app/napcat/config', '--volume', qqDir + ':/app/.config/QQ', options.image!], signal, 30_000)
          item = await inspect(container, signal)
        }
        if (!item?.State.Running || item.Config.Labels?.[label] !== accountId) return unavailable()
        function port(number: number) {
          const rows = item!.NetworkSettings.Ports[number + '/tcp']
          const row = rows?.[0]
          if (rows?.length !== 1 || row?.HostIp !== '127.0.0.1' || !/^\d{1,5}$/u.test(row.HostPort)) return unavailable()
          return Number(row.HostPort)
        }
        const login = { connectionId, accountId, port: port(6099), tokenEnv, container }
        context.ensureCurrent()
        return { login, url: 'ws://127.0.0.1:' + port(3001) + '/' }
      })
    },
  }
}
