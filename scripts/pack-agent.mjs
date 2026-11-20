import fs from 'node:fs/promises'
import path from 'node:path'
import { isBuiltin } from 'node:module'
import ts from 'typescript'
import { root, digestFiles, filesUnder, run, verifyBackend } from './lib/build-support.mjs'

const backend = path.join(root, 'dist/backend')
const runtimeEntries = ['bootstrap/standaloneAgent.js', 'modules/platform/infrastructure/admin/backendArtifactGuard.js', 'modules/content/infrastructure/agentExcelWorker.js', 'modules/content/infrastructure/agentFileTextChild.js', 'modules/memory/infrastructure/agentSemanticEvaluation.js']
const exports = {
  '.': 'core/index.js',
  './qq': 'adapters/oneBotConnection.js',
  './redis': 'modules/runtime/infrastructure/agentRedis.js',
  './logging': 'modules/runtime/infrastructure/agentOperationJournal.js',
  './web': 'modules/tools/infrastructure/agentWebTools.js',
  './memory': 'modules/memory/infrastructure/agentMemoryModels.js',
  './simulation-models': 'modules/simulation/infrastructure/agentSimulationModels.js',
  './interactions': 'modules/tools/infrastructure/agentInteractions.js',
  './images': 'modules/tools/infrastructure/agentImageTools.js',
  './image-search': 'modules/content/infrastructure/agentImageSearchTools.js',
  './delta-force': 'modules/games/infrastructure/agentDeltaForceTools.js',
  './turtle-soup': 'modules/games/infrastructure/agentTurtleSoup.js',
  './uma-race': 'modules/games/infrastructure/agentUmaRace.js',
  './local-emoji': 'modules/emoji/infrastructure/agentLocalEmojiRuntime.js',
  './life-threads': 'modules/simulation/infrastructure/agentLifeThreadProvider.js',
  './mcp': 'modules/tools/infrastructure/agentMcpTools.js',
  './semantic': 'modules/memory/infrastructure/agentSemanticBackend.js',
  './repositories': 'modules/tools/infrastructure/agentRepositoryTools.js',
  './modrinth': 'modules/tools/infrastructure/agentModrinthTools.js',
  './modrinth-cards': 'modules/media/infrastructure/agentModrinthCardRenderer.js',
  './excel': 'modules/content/infrastructure/agentExcelTool.js',
  './files': 'modules/content/infrastructure/agentFileTextTool.js',
  './voice': 'modules/media/infrastructure/agentVoiceTool.js',
  './music': 'modules/media/infrastructure/agentMusicTool.js',
  './music-extraction': 'modules/media/infrastructure/agentMusicExtractionProvider.js',
  './media-relay': 'modules/media/infrastructure/agentMediaRelay.js',
  './pixiv': 'modules/media/infrastructure/agentPixiv.js',
  './video-search': 'modules/media/infrastructure/agentVideoSearch.js',
  './bilibili-quality': 'modules/media/infrastructure/agentBilibiliQuality.js',
  './console': 'bootstrap/standaloneAgentConsole.js',
  './console-auth': 'bootstrap/standaloneAgentConsoleAuth.js',
  './console-services': 'bootstrap/standaloneAgentConsoleServices.js',
  './console-runtime': 'bootstrap/standaloneAgentConsoleRuntime.js',
  './console-management': 'bootstrap/standaloneAgentConsoleManagement.js',
  './console-workspace': 'bootstrap/standaloneAgentWorkspace.js',
  './video-analysis': 'modules/media/infrastructure/agentVideoAnalysis.js',
  './group-logs': 'modules/dice/infrastructure/agentGroupLog.js',
  './torrent': 'modules/media/infrastructure/agentTorrent.js',
  './rendering': 'modules/tools/infrastructure/agentRenderingTools.js',
  './text-images': 'modules/media/infrastructure/agentTextImageRenderer.js',
  './mindmaps': 'modules/media/infrastructure/agentMindMapRenderer.js',
}
const runtimeFiles = new Set([...runtimeEntries, ...Object.values(exports)])
const declarations = new Set(Object.values(exports).map(name => name.replace(/\.js$/, '.d.ts')))
const dependencies = new Set()

function isRuntimeImport(expression, requireAliases) {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true
  if (ts.isIdentifier(expression)) return requireAliases.has(expression.text)
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'createRequire'
}

function collectImports(file, text, isDeclaration, add) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const requireAliases = new Set(['require'])
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const {name, initializer} of statement.declarationList.declarations) {
      if (ts.isIdentifier(name) && initializer && ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) && initializer.expression.text === 'createRequire') requireAliases.add(name.text)
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier.text)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text)
    } else if (!isDeclaration && ts.isCallExpression(node) && (isRuntimeImport(node.expression, requireAliases) ||
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' && isRuntimeImport(node.expression.expression, requireAliases))) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Unsupported runtime import in ${file}`)
      add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const manifest = await verifyBackend(backend, { source: true })
if (!/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error('Agent release requires a backend build from a Git checkout')
for (const [files, isDeclaration] of [[runtimeFiles, false], [declarations, true]]) {
  for (const file of files) {
    if (!Object.hasOwn(manifest.files, file)) throw new Error(`Missing Agent dependency ${file}`)
    collectImports(file, await fs.readFile(path.join(backend, file), 'utf8'), isDeclaration, specifier => {
      if (specifier.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
        files.add(isDeclaration ? target.replace(/\.js$/, '.d.ts') : target)
      } else if (!isBuiltin(specifier)) {
        dependencies.add(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))
      }
    })
  }
}

const [project, projectLock] = await Promise.all(['package.json', 'package-lock.json']
  .map(async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))))
const packageJson = {
  name: 'bl-chat-agent', version: project.version, private: true, type: 'module', license: project.license, engines: project.engines,
  scripts: { start: 'node scripts/start-agent.mjs', 'eval:memory': 'node scripts/semantic-memory-eval.mjs' },
  files: ['dist/backend', 'console/frontend/dist', 'console/README.md', 'docs', 'scripts/start-agent.mjs', 'scripts/bl-chat-agent.service', 'scripts/start-sandboxed-chromium.mjs', 'scripts/migrate-agent-emoji.mjs', 'scripts/import-cognition.mjs', 'scripts/import-legacy-console-resources.py', 'scripts/import-legacy-token-usage.py', 'scripts/semantic-memory-eval.mjs', 'scripts/examples/semantic-evaluation-backend.mjs', 'tests/fixtures/semantic-retrieval-benchmark.v2.json', 'utils/backendArtifactGuard.js', 'release-manifest.json', 'npm-shrinkwrap.json'],
  exports: Object.fromEntries(Object.entries(exports).map(([key, name]) => [key, {
    types: `./dist/backend/${name.replace(/\.js$/, '.d.ts')}`, import: `./dist/backend/${name}`,
  }])),
  dependencies: Object.fromEntries([...dependencies].sort().map(name => {
    const locked = projectLock.packages[`node_modules/${name}`]
    if (!Object.hasOwn(project.dependencies, name) || !locked?.version || !locked.integrity) {
      throw new Error(`Agent dependency ${name} must be a locked production dependency`)
    }
    return [name, locked.version]
  })),
}

const releaseRoot = path.join(root, '.release')
await fs.mkdir(releaseRoot, { recursive: true })
const output = await fs.mkdtemp(path.join(releaseRoot, 'agent-'))
async function copy(source, relative) {
  const target = path.join(output, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}
const writeJson = (relative, data) => fs.writeFile(path.join(output, relative), JSON.stringify(data, null, 2) + '\n')

try {
  const frontend = path.join(root, 'console/frontend'), frontendOutput = path.join(frontend, 'dist')
  const frontendManifest = JSON.parse(await fs.readFile(path.join(frontendOutput, 'build-manifest.json'), 'utf8'))
  const frontendSources = await digestFiles(frontend, [
    ...await filesUnder(path.join(frontend, 'src')),
    ...['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'].map(name => path.join(frontend, name)),
  ])
  const frontendFiles = await filesUnder(frontendOutput)
  const frontendHashes = await digestFiles(frontendOutput, frontendFiles.filter(file => path.basename(file) !== 'build-manifest.json'))
  if (frontendManifest.schema !== 1 || JSON.stringify(frontendManifest.sources) !== JSON.stringify(frontendSources) ||
      JSON.stringify(frontendManifest.files) !== JSON.stringify(frontendHashes) || !frontendHashes['index.html']) {
    throw new Error('Console output differs from sources or manifest; run npm run console:build')
  }
  for (const name of frontendFiles) await copy(name, path.posix.join('console/frontend/dist', path.relative(frontendOutput, name)))
  const files = Object.fromEntries([...new Set([...runtimeFiles, ...declarations])].sort().map(file => [file, manifest.files[file]]))
  for (const name of Object.keys(files)) await copy(path.join(backend, name), `dist/backend/${name}`)
  for (const name of ['scripts/start-agent.mjs', 'scripts/bl-chat-agent.service', 'scripts/start-sandboxed-chromium.mjs', 'scripts/migrate-agent-emoji.mjs', 'scripts/import-cognition.mjs', 'scripts/import-legacy-console-resources.py', 'scripts/import-legacy-token-usage.py', 'scripts/semantic-memory-eval.mjs', 'scripts/examples/semantic-evaluation-backend.mjs', 'tests/fixtures/semantic-retrieval-benchmark.v2.json', 'utils/backendArtifactGuard.js', 'LICENSE']) await copy(path.join(root, name), name)
  // Linux must execute this shebang even when the package is built from a Windows checkout.
  const chromiumLauncher = path.join(output, 'scripts/start-sandboxed-chromium.mjs')
  const launcherSource = await fs.readFile(chromiumLauncher, 'utf8')
  await fs.writeFile(chromiumLauncher, launcherSource.replaceAll('\r\n', '\n'))
  await fs.chmod(chromiumLauncher, 0o755)
  for (const name of ['docs/project-status.md', 'docs/architecture/agent-bindings.md', 'docs/architecture/agent-bindings-history.md',
    'docs/architecture/message-pipeline.md', 'docs/architecture/ai-brain-construction-2026-11-17.md', 'docs/evals/semantic-retrieval.md', 'console/README.md']) await copy(path.join(root, name), name)
  const agentReadme = await fs.readFile(path.join(root, 'docs/architecture/agent-bindings.md'), 'utf8')
  await fs.writeFile(path.join(output, 'README.md'), agentReadme
    .replaceAll('](../project-status.md', '](docs/project-status.md')
    .replaceAll('](agent-bindings-history.md', '](docs/architecture/agent-bindings-history.md')
    .replaceAll('](../evals/semantic-retrieval.md', '](docs/evals/semantic-retrieval.md')
    .replaceAll('](../../console/README.md', '](console/README.md'))
  await writeJson('package.json', packageJson)
  await copy(path.join(root, 'package-lock.json'), 'package-lock.json')
  run('npm', ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--silent'], { cwd: output })
  run('npm', ['shrinkwrap', '--ignore-scripts', '--silent'], { cwd: output })
  await writeJson('dist/backend/manifest.json', { ...manifest, files })
  await verifyBackend(path.join(output, 'dist/backend'))
  await writeJson('release-manifest.json', {
    schema: 1, commit: manifest.commit, node: manifest.node, compiler: manifest.compiler, files: await digestFiles(output, await filesUnder(output)),
  })
  // Verify the staged files before installing their production dependencies.
  run(process.execPath, ['--input-type=module', '-e', `
    import { ensureBackendArtifacts } from './utils/backendArtifactGuard.js'
    await ensureBackendArtifacts()
  `], { cwd: output })
  console.log(output)
} catch (error) {
  await fs.rm(output, { recursive: true, force: true })
  throw error
}
