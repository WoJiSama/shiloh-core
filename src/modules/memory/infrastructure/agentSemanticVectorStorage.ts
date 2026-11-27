import { createHash } from 'node:crypto'
import type { AgentSemanticMemoryRow } from './agentSemanticMemoryStore.js'

const fingerprint = /^[a-f0-9]{64}$/u
const maximumDimensions = 4096
const doubleBytes = Float64Array.BYTES_PER_ELEMENT
const maximumEncodedLength = 4 * Math.ceil(maximumDimensions * doubleBytes / 3)

export interface StoredSemanticVector {
  readonly providerId: string
  readonly sourceDigest: string
  readonly vector: number[]
}

export function semanticVectorSourceDigest(row: AgentSemanticMemoryRow): string {
  return createHash('sha256').update(JSON.stringify([row.messageId, row.authorId, row.name, row.text, row.at, row.peerId ?? null])).digest('hex')
}

/** Keep the original double precision while avoiding decimal JSON for each coefficient. */
export function packSemanticVector(row: AgentSemanticMemoryRow & { vector: number[]; providerId: string }): string {
  const bytes = Buffer.allocUnsafe(row.vector.length * doubleBytes)
  row.vector.forEach((value, index) => bytes.writeDoubleLE(value, index * doubleBytes))
  return `${row.providerId}:${semanticVectorSourceDigest(row)}:${bytes.toString('base64')}`
}

export function unpackSemanticVector(value: string): StoredSemanticVector | undefined {
  if (value.length > 130 + maximumEncodedLength) return undefined
  const [providerId, sourceDigest, encoded, extra] = value.split(':')
  if (!providerId || !sourceDigest || !encoded || extra !== undefined || !fingerprint.test(providerId) || !fingerprint.test(sourceDigest)) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  const dimensions = bytes.length / doubleBytes
  if (!Number.isInteger(dimensions) || dimensions < 2 || dimensions > maximumDimensions || bytes.toString('base64') !== encoded) return undefined
  const vector: number[] = []
  let nonzero = false
  for (let offset = 0; offset < bytes.length; offset += doubleBytes) {
    const component = bytes.readDoubleLE(offset)
    if (!Number.isFinite(component)) return undefined
    nonzero ||= component !== 0
    vector.push(component)
  }
  if (!nonzero) return undefined
  return { providerId, sourceDigest, vector }
}
