// SERVER-ONLY Postiz API client.
// Env: POSTIZ_API_URL + POSTIZ_API_KEY
// Public API path varies by Postiz install — we try `/public/v1`, `/api/public/v1`,
// and legacy `/api/v1` in order.

function getCreds() {
  const url = (process.env.POSTIZ_API_URL || '').replace(/\/$/, '')
  const key = process.env.POSTIZ_API_KEY
  if (!url) throw new Error('POSTIZ_API_URL belum di-set di Vercel env vars')
  if (!key) throw new Error('POSTIZ_API_KEY belum di-set di Vercel env vars')
  return { url, key }
}

async function postizFetch(path, init = {}) {
  const { url, key } = getCreds()
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
    const errMsg = json?.message || json?.error || text.slice(0, 240) || `HTTP ${res.status}`
    const err = new Error(`Postiz ${res.status} @ ${path}: ${errMsg}`)
    err.status = res.status
    err.path = path
    err.body = json
    throw err
  }
  return json
}

async function postizFetchWithFallback(paths, init) {
  let lastErr
  for (const p of paths) {
    try { return await postizFetch(p, init) }
    catch (e) {
      lastErr = e
      // Only fall through on 404 (path mismatch). Other errors (401/400/500) bubble
      // because trying other paths won't help — the issue is elsewhere.
      if (e.status && e.status !== 404) throw e
    }
  }
  throw lastErr
}

// Fetch the workspace's connected channels/integrations from Postiz.
export async function fetchPostizChannels() {
  const data = await postizFetchWithFallback(
    ['/public/v1/integrations', '/api/public/v1/integrations', '/api/v1/integrations/list', '/api/v1/integrations'],
    { method: 'GET' }
  )
  const list = Array.isArray(data) ? data : (data?.integrations || data?.channels || data?.data || [])
  return list.map((c) => ({
    // Postiz docs show integration.id is the DB id used in POST /posts body.
    id: c.id || c.identifier || c.channelId,
    name: c.name || c.profile?.name || c.username || 'Unknown',
    username: c.username || c.profile?.username || '',
    platform: (c.providerIdentifier || c.platform || c.provider || '').toLowerCase(),
    avatar: c.picture || c.profile?.picture || c.avatar || null,
    raw: c,
  })).filter((c) => c.id)
}

// Create a post on Postiz — either post now or schedule.
// channelId: Postiz integration id (string/cuid)
// content: caption text
// mediaUrl: public URL of image OR video (Supabase Storage URL works)
// scheduledFor: ISO timestamp, or null/undefined for post-now
export async function createPostizPost({ channelId, content, mediaUrl, scheduledFor }) {
  if (!channelId) throw new Error('channelId kosong — persona belum link ke Postiz channel')
  const isScheduled = !!scheduledFor

  // Build body with integration as { id }. Per Postiz public API docs:
  // https://docs.postiz.com/public-api/posts
  const buildBody = (integration) => ({
    type: isScheduled ? 'schedule' : 'now',
    date: scheduledFor || new Date(Date.now() + 60_000).toISOString(),
    shortLink: false,
    posts: [{
      integration,
      value: [{
        content: content || '',
        image: mediaUrl ? [{ path: mediaUrl }] : [],
      }],
    }],
  })

  const paths = ['/public/v1/posts', '/api/public/v1/posts', '/api/v1/posts']
  // Try { id } shape first (per docs), then fallback to plain string in case
  // a self-hosted build expects that.
  const shapes = [
    { integration: { id: String(channelId) } },
    { integration: String(channelId) },
  ]

  let lastErr
  for (const path of paths) {
    for (const s of shapes) {
      try {
        return await postizFetch(path, {
          method: 'POST',
          body: JSON.stringify(buildBody(s.integration)),
        })
      } catch (e) {
        lastErr = e
        // 404 -> try next path/shape. Other status codes -> bail (no point retrying).
        if (e.status && e.status !== 404) {
          throw new Error(`${e.message} (channel_id=${channelId})`)
        }
      }
    }
  }
  // All combinations 404'd — surface the channel id so user can verify it exists in Postiz.
  throw new Error(`${lastErr?.message || 'Postiz post gagal'} — channel_id=${channelId} gak match integration apapun di Postiz. Cek list channel di /posting → klik 🔄 Sync Channels → pastikan persona lu link ke channel yang valid.`)
}
