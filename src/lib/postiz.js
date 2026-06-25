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

function normCreds(creds) {
  if (!creds || !creds.url || !creds.key) {
    throw new Error('Postiz creds gak lengkap — pastikan workspace punya postiz_accounts row valid.')
  }
  return { url: String(creds.url).replace(/\/$/, ''), key: String(creds.key) }
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
    const errMsg = json?.message || json?.error || text.slice(0, 400) || `HTTP ${res.status}`
    const err = new Error(`Postiz ${res.status} @ ${path}: ${errMsg}`)
    err.status = res.status
    err.path = path
    err.body = json
    throw err
  }
  return json
}

async function postizJsonFallback(creds, paths, init) {
  let lastErr
  for (const p of paths) {
    try { return await postizJson(creds, p, init) }
    catch (e) {
      lastErr = e
      if (e.status && e.status !== 404) throw e
    }
  }
  throw lastErr
}

// ── Channels / integrations ─────────────────────────────────────────
function pickPlatform(c) {
  const v =
    c?.providerIdentifier ||
    c?.platform ||
    c?.provider ||
    c?.platform_type ||
    c?.type ||
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

async function downloadMedia(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Gagal download media (${res.status}) dari ${url.slice(0, 80)}`)
  const raw = Buffer.from(await res.arrayBuffer())
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
  const paths = ['/public/v1/upload', '/api/public/v1/upload', '/api/v1/upload']
  let lastErr
  for (const path of paths) {
    try {
      const form = new FormData()
      // Use File (not bare Blob) so the multipart part carries BOTH the
      // filename AND the content-type explicitly. With a plain Blob + filename
      // arg, some Node/undici versions drop the part's Content-Type → Postiz's
      // multer sees application/octet-stream → "Unsupported file type" even for
      // a valid mp4. File makes both unambiguous.
      const FileCtor = globalThis.File
      if (FileCtor) {
        form.append('file', new FileCtor([buffer], name, { type: contentType }))
      } else {
        form.append('file', new Blob([buffer], { type: contentType }), name)
      }
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Authorization': key }, // no Content-Type — let fetch set multipart boundary
        body: form,
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch {}
      if (!res.ok) {
        const msg = json?.message || json?.error || text.slice(0, 240) || `HTTP ${res.status}`
        const sent = `sent: ${contentType}, "${name}", ${(buffer.length / 1048576).toFixed(1)}MB`
        const err = new Error(`Postiz upload ${res.status} @ ${path}: ${msg} (${sent})`)
        err.status = res.status
        if (res.status !== 404) throw err
        lastErr = err
        continue
      }
      const id = json?.id || json?.path || json?.url
      if (!id) throw new Error('Postiz upload response gak include id/path: ' + JSON.stringify(json).slice(0, 200))
      return { id, path: json.path || json.url || null, raw: json }
    } catch (e) {
      lastErr = e
      if (e.status && e.status !== 404) throw e
    }
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
    return { __type: 'instagram', post_type: 'post', collaborators: [] }
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
export async function createPostizPost({ creds, channelId, channelLabel, content, mediaUrl, scheduledFor, platform, tiktokAutoAddMusic }) {
  if (!channelId) throw new Error('channelId kosong — persona belum link ke Postiz channel')
  normCreds(creds) // throws if missing — fail fast before downloading media

  // CHANNEL DRIFT GUARD (critical — "kok postingan Rio nyasar ke akun Ben?"):
  // Postiz reissues integration ids when a channel is reconnected. A stale id
  // stored on the persona no longer exists in Postiz — and self-hosted Postiz,
  // given an unknown integration id, silently routes the post to the account's
  // FALLBACK integration (another persona's channel). So we MUST verify the id
  // against the live integration list before posting. If the id is gone, try to
  // self-heal by matching the bound channel username/name; if that fails too,
  // FAIL CLOSED — never let content land on the wrong account.
  let liveChannels = []
  try { liveChannels = await fetchPostizChannels(creds) } catch (e) { /* network down — skip validation rather than block a good post */ }
  if (liveChannels.length) {
    let match = liveChannels.find((c) => String(c.id) === String(channelId))
    if (!match && channelLabel) {
      const want = String(channelLabel).toLowerCase().replace(/^@/, '').trim()
      match = liveChannels.find((c) =>
        [c.username, c.name].some((v) => String(v || '').toLowerCase().replace(/^@/, '').trim() === want))
      if (match) {
        console.warn(`[postiz] channel id drift HEALED: "${channelId}" → "${match.id}" via label "${channelLabel}"`)
        channelId = String(match.id)
        if (!platform || platform === 'unknown') platform = match.platform || platform
      }
    }
    if (!match) {
      throw new Error(`Channel "${channelLabel || channelId}" gak ketemu di Postiz (channel ID drift / channel ke-disconnect). Klik 🔄 Sync Channels di /posting lalu re-link persona ke channel yang bener — post DIBATALIN biar gak nyasar ke akun lain.`)
    }
  }

  if (!platform) {
    const ch = liveChannels.find((c) => String(c.id) === String(channelId))
    if (ch) platform = ch.platform || ch.raw?.providerIdentifier || ''
  }
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
    const uploaded = await uploadToPostiz(creds, media)
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

  // Diagnostic log — shows up in Vercel function logs. Use when debugging why
  // TikTok features (autoAddMusic, etc) aren't taking effect — we can confirm
  // the body we send matches Postiz's documented schema.
  console.log('[postiz] sending body:', JSON.stringify(body, null, 2))

  const paths = ['/public/v1/posts', '/api/public/v1/posts', '/api/v1/posts']
  let lastErr
  for (const path of paths) {
    try {
      return await postizJson(creds, path, { method: 'POST', body: JSON.stringify(body) })
    } catch (e) {
      lastErr = e
      if (e.status && e.status !== 404) {
        throw new Error(`${e.message} (channel_id=${channelId}, platform=${platform || '?'})`)
      }
    }
  }
  throw new Error(`${lastErr?.message || 'Postiz post gagal'} — channel_id=${channelId}, platform=${platform || '?'}`)
}
