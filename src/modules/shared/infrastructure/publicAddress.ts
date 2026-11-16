import { isIP } from 'node:net'

/** Accept only globally routable addresses for public media and feed requests. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const bytes = address.split('.').map(Number)
    const a = bytes[0]!, b = bytes[1]!, c = bytes[2]!
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    const [first, second] = lower.split(':').map(part => Number.parseInt(part || '0', 16))
    // IPv4-mapped, NAT64, ULA, link-local, multicast and transition ranges are excluded.
    return first !== undefined && first >= 0x2000 && first < 0x4000 && !lower.includes('%') &&
      !(first === 0x2001 && (second! < 0x200 || second === 0xdb8)) &&
      first !== 0x2002 && first !== 0x3fff
  }
  return false
}
