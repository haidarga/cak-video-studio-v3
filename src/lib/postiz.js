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
async function downloadMedia(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Gagal download media (${res.status}) dari ${url.slice(0, 80)}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const lastSeg = url.split('/').pop()?.split('?')[0] || 'media'
  return { buffer, contentType, name: lastSeg }
}

async function uploadToPostiz(creds, { buffer, name, contentType }) {
  const { url, key } = normCreds(creds)
  const paths = ['/public/v1/upload', '/api/public/v1/upload', '/api/v1/upload']
  let lastErr
  for (const path of paths) {
    try {
      const form = new FormData()
      const blob = new Blob([buffer], { type: contentType })
      form.append('file', blob, name)
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
        const err = new Error(`Postiz upload ${res.status} @ ${path}: ${msg}`)
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
// opts.tiktokAutoAddMusic — workspace-level toggle. When true we tell
// TikTok via Postiz to auto-attach a trending sound on landing (boosts
// discoverability via TikTok's sound algorithm). User picks it once in
// /settings; every TikTok schedule inherits the choice.
function defaultSettings(platform, opts = {}) {
  const p = (platform || '').toLowerCase()
  if (p.includes('tiktok')) {
    return {
      post_type: 'post',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      duet: false,
      stitch: false,
      comment: true,
      autoAddMusic: opts.tiktokAutoAddMusic ? 'yes' : 'no',
      brand_content_toggle: false,
      brand_organic_toggle: false,
      content_posting_method: 'DIRECT_POST',
      title: '',
    }
  }
  if (p.includes('instagram')) {
    return { post_type: 'post', collaborators: [] }
  }
  if (p.includes('youtube')) {
    return { post_type: 'post', title: '', type: 'public' }
  }
  if (p.includes('facebook') || p.includes('fb')) {
    return { post_type: 'post' }
  }
  return { post_type: 'post' }
}

// ── Create post ─────────────────────────────────────────────────────
export async function createPostizPost({ creds, channelId, content, mediaUrl, scheduledFor, platform, tiktokAutoAddMusic }) {
  if (!channelId) throw new Error('channelId kosong — persona belum link ke Postiz channel')
  normCreds(creds) // throws if missing — fail fast before downloading media

  if (!platform) {
    try {
      const channels = await fetchPostizChannels(creds)
      const ch = channels.find((c) => String(c.id) === String(channelId))
      if (ch) platform = ch.platform || ch.raw?.providerIdentifier || ''
    } catch (e) { /* ignore — fall through */ }
  }

  let imageField = []
  if (mediaUrl) {
    const media = await downloadMedia(mediaUrl)
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
