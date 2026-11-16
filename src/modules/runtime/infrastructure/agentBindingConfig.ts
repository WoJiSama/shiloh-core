import { createHash } from 'node:crypto'
import fs from 'node:fs'
import YAML from 'yaml'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import { createAgentBindingDirectory } from '../domain/agentBindings.js'

/** The file is optional. Its metadata distinguishes successive saves, even of identical content. */
export function createAgentBindingConfig(file: string, validateAddress?: (target: ConversationAddress) => void) {
  let cache: { stamp: string; directory: ReturnType<typeof createAgentBindingDirectory> | Error } | undefined

  return function read() {
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false })
    if (!stat) {
      cache = undefined
      return undefined
    }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    if (cache?.stamp !== stamp) {
      let directory: ReturnType<typeof createAgentBindingDirectory> | Error
      try {
        if (!stat.isFile()) throw new Error('角色绑定配置须为普通文件')
        const source = fs.readFileSync(file, 'utf8')
        const document = YAML.parseDocument(source)
        if (document.errors.length) throw new Error('agent-bindings.yaml 无法解析，请检查 YAML')
        const revision = createHash('sha256').update(stamp).update('\0').update(source).digest('hex')
        directory = createAgentBindingDirectory(document.toJS(), revision, validateAddress)
      } catch (error) {
        directory = error instanceof Error ? error : new Error('角色绑定配置无法读取')
      }
      cache = { stamp, directory }
    }
    if (cache.directory instanceof Error) throw cache.directory
    return cache.directory
  }
}
