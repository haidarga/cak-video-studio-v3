// SERVER-ONLY Postiz API client. Uses POSTIZ_API_URL + POSTIZ_API_KEY env vars.
//
// Postiz public API base: ${POSTIZ_API_URL}/api/public/v1
// Auth header: Authorization: <api-key> (no "Bearer" prefix per Postiz docs)
// Docs ref: github.com/gitroomhq/postiz-app

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
    const errMsg = json?.message || json?.error || text.slice(0, 200) || `HTTP ${res.status}`
    throw new Error(`Postiz ${res.status}: ${errMsg}`)
  }
  return json
}

// Try the public/v1 path first, fall back to other common shapes for older Postiz builds.
async function postizFetchWithFallback(paths, init) {
  let lastErr
  for (const p of paths) {
    try { return await postizFetch(p, init) }
    catch (e) { lastErr = e }
  }
  throw lastErr
}

// Fetch the workspace's connected channels/integrations from Postiz.
export async function fetchPostizChannels() {
  const data = await postizFetchWithFallback(
    ['/api/public/v1/integrations', '/api/v1/integrations/list', '/api/v1/integrations'],
    { method: 'GET' }
  )
  const list = Array.isArray(data) ? data : (data?.integrations || data?.channels || data?.data || [])
  return list.map((c) => ({
    id: c.id || c.identifier || c.channelId,
    name: c.name || c.profile?.name || c.username || 'Unknown',
    username: c.username || c.profile?.username || '',
    platform: (c.providerIdentifier || c.platform || c.provider || '').toLowerCase(),
    avatar: c.picture || c.profile?.picture || c.avatar || null,
    raw: c,
  })).filter((c) => c.id)
}

// Create a post on Postiz — either post now or schedule.
// channelId: Postiz integration id
// content: caption text
// mediaUrl: public URL of image OR video to attach (Supabase Storage URL works)
// scheduledFor: ISO timestamp string, or null/undefined for post-now
export async function createPostizPost({ channelId, content, mediaUrl, scheduledFor }) {
  if (!channelId) throw new Error('channelId kosong')
  const isScheduled = !!scheduledFor
  const body = {
    type: isScheduled ? 'schedule' : 'now',
    date: scheduledFor || new Date().toISOString(),
    shortLink: false,
    posts: [{
      integration: { id: String(channelId) },
      value: [{
        content: content || '',
        image: mediaUrl ? [{ path: mediaUrl }] : [],
      }],
    }],
  }
  return postizFetchWithFallback(
    ['/api/public/v1/posts', '/api/v1/posts'],
    { method: 'POST', body: JSON.stringify(body) }
  )
}
