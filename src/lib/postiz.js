// SERVER-ONLY Postiz API client.
//
// All public functions now take explicit `creds = { url, key }` so the same
// workspace can talk to N Postiz instances (multi-account). Look up the right
// account in the DB before calling.
//
// Flow per Postiz public API:
// 1) POST /upload (multipart) — server-side upload media → returns { id, path }
// 2) POST /posts — create post with image: [{ id: <uploadId> }] + platform settings
//
// Postiz nolak external media URLs (e.g. Supabase Storage) — image[].URL harus
// di domain uploads.postiz.com, jadi kita HARUS upload-relay dulu.
//
// Channel-binding logic lives in ./postiz-match.js (pure, shared with the UI).

import { resolveChannelBinding } from './postiz-match.js'

export { resolveChannelBinding, findChannelByLabel, channelMatchesLabel, normalizeLabel } from './postiz-match.js'

function normCreds(creds) {
  if (!creds || !creds.url || !creds.key) {
    throw new Error('Postiz creds gak lengkap — pastikan workspace punya postiz_accounts row valid.')
  }
  return { url: String(creds.url).replace(/\/$/, ''), key: String(creds.key) }
}

// ── Transient-failure retry ─────────────────────────────────────────
// A self-hosted Postiz behind Cloudflare throws 502/504 regularly. Without a
// retry, one blip either (a) skipped channel validation entirely — which is how
// posts landed on the wrong persona — or (b) failed a perfectly good post.
const TRANSIENT_RE = /502|503|504|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|Bad Gateway|Service Unavailable|Cloudflare/i

export function isTransientPostizError(e) {
  if (e?.status && e.status >= 500) return true
  return TRANSIENT_RE.test(String(e?.message || e))
}

async function withRetry(fn, { tries = 3, baseMs = 700, label = 'call' } = {}) {
  let last
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (attempt === tries || !isTransientPostizError(e)) throw e
      const wait = baseMs * 2 ** (attempt - 1)
      console.warn(`[postiz] ${label}: transient fail ${attempt}/${tries}, retry in ${wait}ms — ${e.message}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw last
}

async function postizJson(creds, path, init = {}) {
  const { url, key } = normCreds(creds)
  const headers = {
    'Authorization': key,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  }
  const res = await fetch(`${url}${path}`, { ...init, headers, cache: 'no-store' })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) {
    let errMsg = json?.message || json?.error
    if (!errMsg && text) {
      if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('Cloudflare') || text.includes('502 Bad Gateway')) {
        errMsg = `502 Bad Gateway (Cloudflare/Proxy Error — Postiz instance unreachable or upload size limit exceeded)`
      } else {
        errMsg = text.slice(0, 400)
      }
    }
    if (!errMsg) errMsg = `HTTP ${res.status}`
    const err = new Error(`Postiz ${res.status} @ ${path}: ${errMsg}`)
    err.status = res.status
    err.path = path
    err.body = json
    throw err
  }
  return json
}

// Which API prefix this Postiz instance actually serves, per base URL.
// Self-hosted Postiz mounts its public API at different prefixes depending on
// version and reverse-proxy setup. Probing per endpoint independently meant
// `/integrations` could succeed on one prefix while `/upload` blindly retried
// the same doomed list and 404'd on all three — which is exactly the
// "Postiz upload 404 @ /api/v1/upload: not_found" report.
const prefixCache = new Map()

export function knownPostizPrefix(baseUrl) {
  return prefixCache.get(String(baseUrl || '').replace(/\/$/, '')) || null
}

// Order the candidates so the prefix we've already proven works is tried first.
function orderByKnownPrefix(url, paths) {
  const known = knownPostizPrefix(url)
  if (!known) return paths
  const preferred = paths.filter((p) => p.startsWith(known))
  const rest = paths.filter((p) => !p.startsWith(known))
  return [...preferred, ...rest]
}

// The prefix part of a path, e.g. '/api/public/v1/integrations' -> '/api/public/v1'
function prefixOf(path) {
  const m = String(path).match(/^(.*\/v1)\//)
  return m ? m[1] : null
}

async function postizJsonFallback(creds, paths, init) {
  const { url } = normCreds(creds)
  let lastErr
  const tried = []
  for (const p of orderByKnownPrefix(url, paths)) {
    tried.push(p)
    try {
      const out = await postizJson(creds, p, init)
      const pre = prefixOf(p)
      if (pre) prefixCache.set(url, pre)
      return out
    }
    catch (e) {
      lastErr = e
      if (e.status && e.status !== 404) throw e
    }
  }
  if (lastErr) lastErr.triedPaths = tried
  throw lastErr
}

// ── Channels / integrations ─────────────────────────────────────────
function pickPlatform(c) {
  const v =
    c?.identifier ||
    c?.providerIdentifier ||
    c?.platform ||
    c?.provider ||
    c?.platform_type ||
    c?.type ||
    c?.integration?.identifier ||
    c?.integration?.providerIdentifier ||
    c?.integration?.provider ||
    c?.profile?.platform ||
    c?.profile?.providerIdentifier ||
    ''
  return String(v).toLowerCase()
}
function pickUsername(c) {
  return (
    c?.username ||
    c?.profile?.username ||
    c?.internalId ||
    c?.profile?.internalId ||
    c?.handle ||
    c?.profile?.handle ||
    c?.account ||
    ''
  )
}

// Fetch a single post by id — check actual state (QUEUE/PUBLISHED/ERROR)
// and grab releaseURL once platform finishes processing.
export async function getPostizPost(creds, postId) {
  return postizJsonFallback(
    creds,
    [`/public/v1/posts/${postId}`, `/api/public/v1/posts/${postId}`, `/api/v1/posts/${postId}`],
    { method: 'GET' }
  )
}

// Fetch a single integration to see its ACTUAL providerIdentifier.
export async function getPostizIntegration(creds, integrationId) {
  return postizJsonFallback(
    creds,
    [`/public/v1/integrations/${integrationId}`, `/api/public/v1/integrations/${integrationId}`, `/api/v1/integrations/${integrationId}`],
    { method: 'GET' }
  )
}

export async function fetchPostizChannels(creds) {
  const data = await postizJsonFallback(
    creds,
    ['/public/v1/integrations', '/api/public/v1/integrations', '/api/v1/integrations/list', '/api/v1/integrations'],
    { method: 'GET' }
  )
  const list = Array.isArray(data) ? data : (data?.integrations || data?.channels || data?.data || [])
  return list.map((c) => ({
    id: c.id || c.identifier || c.channelId,
    name: c.name || c.profile?.name || c.username || 'Unknown',
    username: pickUsername(c),
    platform: pickPlatform(c),
    avatar: c.picture || c.profile?.picture || c.avatar || null,
    raw: c,
  })).filter((c) => c.id)
}

// ── Media upload relay ──────────────────────────────────────────────
const MIME_TO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const EXT_TO_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

// Sniff real mime from magic bytes — the only source of truth when the HTTP
// content-type lies (R2 serves octet-stream when ContentType wasn't set on
// upload, which is the common "udah mp4 tapi Postiz 400" cause).
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp'
  // mp4 / mov family: 'ftyp' box at offset 4, brand at 8-12
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return buf.slice(8, 10).toString('ascii').startsWith('qt') ? 'video/quicktime' : 'video/mp4'
  }
  return null
}

// fal (and some encoders) emit ISO-BMFF files branded as QuickTime — the
// ftyp major brand is 'qt  ' even though the file is named .mp4 and is a
// perfectly mp4-demuxable h264/aac container (browsers play it fine). Postiz
// inspects file CONTENT (magic bytes), and its video allowlist is MP4-only, so
// a 'qt  ' brand reads as video/quicktime → "Unsupported file type". The bytes
// are already mp4-compatible; only the brand tag lies. Rewrite it in place to
// 'mp42'/'isom' so content sniffers recognize it as mp4. No re-encode.
export function coerceMp4Brand(buf) {
  if (!buf || buf.length < 16 || buf.toString('ascii', 4, 8) !== 'ftyp') return { buf, changed: false }
  const major = buf.toString('ascii', 8, 12)
  // Already a real mp4 brand → leave untouched.
  if (/^(isom|mp41|mp42|mp4v|avc1|iso2|iso4|iso5|iso6|dash|m4v)/i.test(major)) return { buf, changed: false }
  const out = Buffer.from(buf) // copy — never mutate the source buffer
  out.write('mp42', 8, 'ascii') // major brand
  const boxSize = Math.min(out.readUInt32BE(0), out.length)
  for (let off = 16; off + 4 <= boxSize; off += 4) {
    if (out.toString('ascii', off, off + 4) === 'qt  ') out.write('isom', off, 'ascii')
  }
  return { buf: out, changed: true }
}

// Hard ceiling so a huge export fails fast with an actionable message instead of
// burning the whole serverless budget and leaving the row stuck in 'posting'.
// Budget note: /api/postiz/post runs under maxDuration=60. These caps are sized
// so we fail with a readable error INSIDE that budget instead of being killed by
// the platform mid-flight (which used to strand the row in 'posting' forever).
const MAX_MEDIA_BYTES = 150 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 35_000

async function downloadMedia(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, { cache: 'no-store', signal: ac.signal })
  } catch (e) {
    clearTimeout(timer)
    if (e?.name === 'AbortError') throw new Error(`Download media timeout (>${DOWNLOAD_TIMEOUT_MS / 1000}s) dari R2 — file kegedean atau koneksi lagi lemot.`)
    throw e
  }
  if (!res.ok) { clearTimeout(timer); throw new Error(`Gagal download media (${res.status}) dari ${url.slice(0, 80)}`) }

  const declared = Number(res.headers.get('content-length') || 0)
  if (declared && declared > MAX_MEDIA_BYTES) {
    clearTimeout(timer)
    throw new Error(`Media ${(declared / 1048576).toFixed(0)}MB kegedean buat relay ke Postiz (max ${MAX_MEDIA_BYTES / 1048576}MB). Export ulang dengan bitrate lebih rendah.`)
  }

  let raw
  try { raw = Buffer.from(await res.arrayBuffer()) } finally { clearTimeout(timer) }
  if (raw.length > MAX_MEDIA_BYTES) {
    throw new Error(`Media ${(raw.length / 1048576).toFixed(0)}MB kegedean buat relay ke Postiz (max ${MAX_MEDIA_BYTES / 1048576}MB). Export ulang dengan bitrate lebih rendah.`)
  }
  const { buf: buffer, changed: brandFixed } = coerceMp4Brand(raw)

  let contentType = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
  const lastSeg = url.split('/').pop()?.split('?')[0] || 'media'
  const dot = lastSeg.lastIndexOf('.')
  const baseName = dot > 0 ? lastSeg.slice(0, dot) : lastSeg
  const ext = dot > 0 ? lastSeg.slice(dot + 1).toLowerCase() : ''

  // Postiz /upload validates by mime + extension and 400s on a generic/wrong
  // content-type even when the bytes ARE valid. Recover a real mime: sniff the
  // magic bytes first (most reliable), then the URL extension, then keep what
  // the server said.
  const generic = !contentType || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream'
  if (generic) contentType = sniffMime(buffer) || EXT_TO_MIME[ext] || 'video/mp4'
  // We just rewrote a QuickTime-branded container to a real mp4 brand — force
  // the mime so we don't ship a stale 'video/quicktime' label the server sent.
  if (brandFixed) contentType = 'video/mp4'

  // Guarantee the filename carries the extension that matches the mime — Postiz
  // also infers type from the filename, so a UUID with no extension 400s.
  const wantExt = MIME_TO_EXT[contentType] || ext || 'mp4'
  const name = `${baseName || 'media'}.${wantExt}`
  return { buffer, contentType, name }
}

async function uploadToPostiz(creds, { buffer, name, contentType }) {
  const { url, key } = normCreds(creds)
  // Try the prefix that fetchPostizChannels already proved works on THIS
  // instance first. Probing each endpoint's list independently is how we ended
  // up 404-ing all three upload paths on an instance whose integrations
  // endpoint was answering fine the whole time.
  const known = knownPostizPrefix(url)
  const basePaths = ['/public/v1/upload', '/api/public/v1/upload', '/api/v1/upload', '/api/upload', '/upload']
  const paths = known
    ? [`${known}/upload`, ...basePaths.filter((p) => p !== `${known}/upload`)]
    : basePaths
  const attempted = []
  let lastErr
  for (const path of paths) {
    attempted.push(path)
    try {
      const form = new FormData()
      const FileCtor = globalThis.File
      if (FileCtor) {
        form.append('file', new FileCtor([buffer], name, { type: contentType }))
      } else {
        form.append('file', new Blob([buffer], { type: contentType }), name)
      }
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Authorization': key },
        body: form,
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch {}
      if (!res.ok) {
        let msg = json?.message || json?.error
        if (!msg && text) {
          if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('Cloudflare') || text.includes('502 Bad Gateway')) {
            msg = `502 Bad Gateway (Cloudflare / Reverse Proxy Error — Postiz instance overloaded/down/upload size limit)`
          } else {
            msg = text.slice(0, 240)
          }
        }
        if (!msg) msg = `HTTP ${res.status}`
        const sent = `sent: ${contentType}, "${name}", ${(buffer.length / 1048576).toFixed(1)}MB`
        const err = new Error(`Postiz upload ${res.status} @ ${path}: ${msg} (${sent})`)
        err.status = res.status
        lastErr = err
        // Try next candidate path if 404 or 5xx server error
        if (res.status === 404 || res.status >= 500) continue
        throw err
      }
      const id = json?.id || json?.path || json?.url
      if (!id) throw new Error('Postiz upload response gak include id/path: ' + JSON.stringify(json).slice(0, 200))
      return { id, path: json.path || json.url || null, raw: json }
    } catch (e) {
      lastErr = e
      if (e.status && e.status !== 404 && e.status < 500) throw e
    }
  }
  // Name every path we tried — a bare "404 @ /api/v1/upload" hid the fact that
  // this instance simply doesn't serve upload on any prefix we know, and made it
  // look like one specific URL was broken.
  if (lastErr && lastErr.status === 404) {
    lastErr.message = `${lastErr.message} — dicoba semua path: ${attempted.join(', ')}. ` +
      `Instance Postiz ini kayaknya gak expose endpoint upload di prefix manapun yang kita tau (padahal /integrations jalan). ` +
      `Cek versi Postiz-nya atau reverse-proxy-nya.`
  }
  throw lastErr
}

// ── Platform-specific default settings ──────────────────────────────
// Schema from Postiz docs (docs.postiz.com/providers/tiktok). The MOST
// important field is `__type` — without it Postiz can't dispatch the
// settings to the platform-specific handler and silently falls back to
// defaults (which is why our autoAddMusic toggle wasn't taking effect
// before this fix).
// opts.tiktokAutoAddMusic — workspace-level toggle. When true, TikTok
// auto-attaches a trending sound on landing (boosts sound-algo
// discoverability). User picks it once in /settings.
function defaultSettings(platform, opts = {}) {
  const p = (platform || '').toLowerCase()
  if (p.includes('tiktok')) {
    return {
      __type: 'tiktok',
      title: '',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      duet: false,
      stitch: false,
      comment: true,
      autoAddMusic: opts.tiktokAutoAddMusic ? 'yes' : 'no',
      brand_content_toggle: false,
      brand_organic_toggle: false,
      video_made_with_ai: false,
      content_posting_method: 'DIRECT_POST',
    }
  }
  if (p.includes('instagram')) {
    const type = p === 'instagram-standalone' ? 'instagram-standalone' : 'instagram'
    return { __type: type, post_type: 'reel', collaborators: [] }
  }
  if (p.includes('youtube')) {
    return { __type: 'youtube', title: '', type: 'public' }
  }
  if (p.includes('facebook') || p.includes('fb')) {
    return { __type: 'facebook' }
  }
  return { post_type: 'post' }
}

// ── Create post ─────────────────────────────────────────────────────
// Returns { response, binding } — `binding` tells the caller which channel the
// post ACTUALLY went to, so a healed id can be persisted instead of re-healed
// (and re-risked) on every future post.
export async function createPostizPost({ creds, channelId, channelLabel, content, mediaUrl, scheduledFor, platform, tiktokAutoAddMusic }) {
  if (!channelId) throw new Error('channelId kosong — persona belum link ke Postiz channel')
  normCreds(creds) // throws if missing — fail fast before downloading media

  // Validate the channel binding against the LIVE integration list, with retry.
  // If we still can't get the list, resolveChannelBinding FAILS CLOSED — an
  // unverified id is exactly how a post ends up on someone else's account.
  let liveChannels = []
  let liveChannelsError = null
  try {
    liveChannels = await withRetry(() => fetchPostizChannels(creds), { label: 'fetchChannels' })
  } catch (e) {
    liveChannelsError = String(e?.message || e).slice(0, 200)
  }
  const binding = resolveChannelBinding({ channelId, channelLabel, platform, liveChannels, liveChannelsError })
  channelId = binding.channelId
  platform = binding.platform

  // Authoritative fallback — hit the integration directly for its real
  // providerIdentifier. Without a resolved platform, defaultSettings() emits a
  // GENERIC settings block (no __type / no tiktok fields), and Postiz then 400s
  // the post with "settings.privacy_level must be a string ... (platform=unknown)"
  // because the channel IS TikTok and it validates against the TikTok schema.
  if (!platform || platform === 'unknown') {
    try {
      const integ = await getPostizIntegration(creds, channelId)
      platform = pickPlatform(integ?.integration || integ?.data || integ) || platform
    } catch (e) { /* ignore — defaultSettings will use the generic block */ }
  }

  let imageField = []
  if (mediaUrl) {
    const media = await downloadMedia(mediaUrl)
    // Postiz (and every social target) only ingests a small set of types.
    // WebM is the common offender — our "Draft (fast)" canvas export emits
    // WebM, which TikTok/IG/YT reject. Fail with an actionable message BEFORE
    // burning the upload round-trip on a "Unsupported file type" 400.
    const SUPPORTED = new Set(['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'])
    if (!SUPPORTED.has(media.contentType)) {
      throw new Error(`File type "${media.contentType}" gak didukung Postiz/sosmed. Kemungkinan ini WebM dari export "Draft (fast)" — export ulang pakai MP4 (tombol "Export → QC (MP4)") lalu post lagi.`)
    }
    // NO external-URL fallback here. Postiz only accepts media it hosts (see the
    // header comment), so passing the raw R2 URL produced a post that Postiz
    // ACCEPTED and we marked 'posted' — but that never actually published. A
    // hard failure with a retryable error is strictly better than a silent one.
    // Only 2 attempts: each one re-uploads the whole buffer, and stacking 3 of
    // them on top of the download + channel-fetch retries can blow the 60s
    // budget and get the function killed mid-flight (which is what stranded rows
    // in 'posting'). Failing cleanly at 2 is better than being killed at 3.
    const uploaded = await withRetry(() => uploadToPostiz(creds, media), { label: 'upload', tries: 2, baseMs: 1200 })
    imageField = [{
      id: String(uploaded.id),
      path: uploaded.path || uploaded.raw?.url || '',
      name: uploaded.raw?.name || media.name,
    }]
  }

  const isScheduled = !!scheduledFor
  const settings = defaultSettings(platform, { tiktokAutoAddMusic })

  const body = {
    type: isScheduled ? 'schedule' : 'now',
    date: scheduledFor || new Date().toISOString(),
    shortLink: false,
    tags: [],
    posts: [{
      integration: { id: String(channelId) },
      value: [{ content: content || '', image: imageField }],
      settings,
    }],
  }

  // Gated: this dumps the full caption text on every post. Set POSTIZ_DEBUG=1
  // when you need to confirm the outgoing schema (e.g. TikTok settings block).
  if (process.env.POSTIZ_DEBUG) {
    console.log('[postiz] sending body:', JSON.stringify(body, null, 2))
  } else {
    console.log(`[postiz] posting → channel=${channelId} platform=${platform || '?'} media=${imageField.length ? 'yes' : 'no'} scheduled=${isScheduled}`)
  }

  const paths = ['/public/v1/posts', '/api/public/v1/posts', '/api/v1/posts']
  let lastErr
  for (const path of paths) {
    try {
      const response = await withRetry(
        () => postizJson(creds, path, { method: 'POST', body: JSON.stringify(body) }),
        { label: `POST ${path}` }
      )
      return { response, binding }
    } catch (e) {
      lastErr = e
      if (e.status && e.status !== 404) {
        throw new Error(`${e.message} (channel_id=${channelId}, platform=${platform || '?'})`)
      }
    }
  }
  throw new Error(`${lastErr?.message || 'Postiz post gagal'} — channel_id=${channelId}, platform=${platform || '?'}`)
}
