import fs from 'node:fs/promises'
import path from 'node:path'
import { root, run, filesUnder, digestFiles } from './lib/build-support.mjs'

const frontend = path.join(root, 'console/frontend')
async function sources() {
  return digestFiles(frontend, [
    ...await filesUnder(path.join(frontend, 'src')),
    ...['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json']
      .map(name => path.join(frontend, name)),
  ])
}

const before = await sources()
run('npm', ['run', 'build'], { cwd: frontend })
if (JSON.stringify(before) !== JSON.stringify(await sources())) throw new Error('Console sources changed during build; rebuild required')
const output = path.join(frontend, 'dist')
await fs.writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({
  schema: 1, sources: before, files: await digestFiles(output, await filesUnder(output)),
}, null, 2) + '\n')
