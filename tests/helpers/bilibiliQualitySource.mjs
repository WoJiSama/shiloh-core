import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
if (sourceTest) {
  const ts = (await import('typescript')).default, sourceRoot = path.join(repo, 'src') + path.sep
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(sourceRoot).href) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(url.href, context)
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
      return next(url, context)
    },
  })
}
export function agentHostModuleUrl(relative) {
  return pathToFileURL(path.join(sourceTest ? repo : release, sourceTest ? 'src' : 'dist/backend',
    sourceTest ? relative.replace(/\.js$/u, '.ts') : relative))
}
export function importBilibiliHost(relative) {
  return import(agentHostModuleUrl(relative).href)
}
