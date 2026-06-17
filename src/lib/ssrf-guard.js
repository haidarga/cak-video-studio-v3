// SSRF defense — block server-side fetches to private/internal addresses.
//
// This is a literal-host layer: it rejects obvious internal hostnames and
// private/loopback/link-local IP literals (incl. cloud metadata 169.254.169.254).
// It does NOT resolve DNS, so a public hostname that resolves to a private IP
// can still slip through — acceptable as a first layer for an internal tool;
// pair with an egress allowlist for stronger guarantees.

const PRIVATE_V4 = [
  /^127\./,                                   // loopback
  /^10\./,                                    // RFC1918
  /^0\./,                                     // "this" network
  /^169\.254\./,                              // link-local + cloud metadata
  /^192\.168\./,                              // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,               // RFC1918 172.16–172.31
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
]

function hostIsPrivate(rawHost) {
  const h = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '') // strip ipv6 brackets
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true // ipv6 ULA + link-local
  return PRIVATE_V4.some((re) => re.test(h))
}

// Returns true only for a syntactically-valid public http(s) URL.
export function isPublicHttpUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (!u.hostname) return false
  return !hostIsPrivate(u.hostname)
}

// Throws if `raw` is not a public http(s) URL. Use at every boundary where a
// user-supplied URL is fetched or forwarded server-side.
export function assertPublicHttpUrl(raw, label = 'url') {
  if (!isPublicHttpUrl(raw)) {
    throw new Error(`${label} ditolak: harus URL http(s) publik (bukan alamat internal/private)`)
  }
  return raw
}
