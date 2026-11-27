import { verifyPersonalToolPublication } from '../modules/simulation/domain/agentPersonalTools.js'

// This fixed program receives only a declaration and fixtures from the author.
// It has no access to the model, Redis, QQ, or the publisher's environment.
try {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 96 * 1024) throw new Error('文字工具候选过大')
    chunks.push(chunk)
  }
  const definition = verifyPersonalToolPublication(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify(definition))
} catch {
  process.exitCode = 1
}
