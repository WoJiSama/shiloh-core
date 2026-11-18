import { ensureBackendArtifacts } from '../utils/backendArtifactGuard.js'

let startupStage = 'artifacts'
try {
  await ensureBackendArtifacts()
  startupStage = 'host'
  const { main } = await import('../dist/backend/bootstrap/standaloneAgent.js')
  await main(process.argv.slice(2))
} catch (error) {
  // Match known diagnostic classes, but never echo arbitrary exception content.
  const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined
  const safeFailures = [
    ['--check 与 --migrate-qq-state 须分别运行', '--check 与 --migrate-qq-state 须分别运行'],
    ['独立宿主无法连接 Redis', '独立宿主无法连接 Redis'],
    ['人设不存在', '人设不存在，请核对角色配置'],
    ['未能验证 QQ 账号', 'OneBot 连接未能验证 QQ 账号'],
    ['检查期间角色绑定文件已改变', '检查期间角色绑定文件已改变，请重试'],
    ['配置事务检查、离线恢复及其它命令须分别运行', '配置事务检查、离线恢复及其它命令须分别运行'],
  ]
  const known = typeof value === 'string' ? safeFailures.find(([needle]) => value.includes(needle))?.[1] : undefined
  console.error(startupStage === 'artifacts'
    ? '[Agent] Backend output differs or artifacts are unavailable. Run npm run backend:build or install a verified release.'
    : `[Agent] ${known ?? '独立宿主启动或检查失败，请核对配置、Redis 与 QQ 连接；运行期诊断见 dataDir/operations。'}`)
  process.exitCode = 1
}
