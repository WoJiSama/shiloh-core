// Pure BTIH syntax shared by Core admission and legacy download consumers.
export class TorrentDownloadError extends Error {code?:string}
const MAGNET_URI_PATTERN = /magnet:\?[^\s<>'"，。；;]+/i

function decodeBase32Hash(value = "") {
  const normalized = String(value || "").replace(/=+$/g, "").toUpperCase()
  if (!/^[A-Z2-7]{32}$/.test(normalized)) return ""
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let buffer = 0
  const bytes = []
  for (const char of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes).toString("hex").toUpperCase()
}

export function parseMagnetUri(value = "") {
  const source = String(value || "").trim()
  if (!/^magnet:\?/i.test(source)) throw new TorrentDownloadError("只支持 magnet:?xt=urn:btih:... 格式的磁链")

  let url
  try {
    url = new URL(source)
  } catch {
    throw new TorrentDownloadError("磁链格式不正确")
  }
  if (url.protocol !== "magnet:") throw new TorrentDownloadError("只支持 magnet 磁链")

  const xt = url.searchParams.getAll("xt").find(item => /^urn:btih:/i.test(item)) || ""
  const rawHash = xt.replace(/^urn:btih:/i, "").trim()
  const infoHash = /^[a-f\d]{40}$/i.test(rawHash)
    ? rawHash.toUpperCase()
    : decodeBase32Hash(rawHash)
  if (!infoHash || !/^[A-F\d]{40}$/.test(infoHash)) {
    throw new TorrentDownloadError("磁链缺少有效的 BTIH 信息哈希")
  }

  return {
    magnet: source,
    infoHash,
    displayName: String(url.searchParams.get("dn") || "").trim().slice(0, 160),
    trackerCount: url.searchParams.getAll("tr").filter(Boolean).length
  }
}

export function extractValidBtihMagnetUri(value = "") {
  const magnet = String(value || "").match(MAGNET_URI_PATTERN)?.[0] || ""
  if (!magnet) return ""
  try {
    parseMagnetUri(magnet)
    return magnet
  } catch {
    return ""
  }
}

