import { ensureBackendArtifacts } from '../utils/backendArtifactGuard.js'

try {
  await ensureBackendArtifacts()
  const { main } = await import('../dist/backend/bootstrap/standaloneAgent.js')
  await main(process.argv.slice(2))
} catch (error) {
  console.error('[Agent]', error instanceof Error ? error.message : '启动失败')
  process.exitCode = 1
}
