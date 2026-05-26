// SERVER-ONLY Postiz API client. Uses POSTIZ_API_URL + POSTIZ_API_KEY env vars.
// We don't know the exact Postiz instance shape until the user wires it; this
// client tries a few common endpoints and surfaces failures clearly.

function getCreds() {
  const url = (process.env.POSTIZ_API_URL || '').replace(/\/$/, '')
  const key = process.env.POSTIZ_API_KEY
  if (!url) throw new Error('POSTIZ_API_URL belum di-set di Vercel env vars')
  if (!key) throw new Error('POSTIZ_API_KEY belum di-set di Vercel env vars')
  return { url, key }
}

async function tryFetch(url, init) {
  const res = await fetch(url, { ...init, cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`)
  }
  return res.json()
}

// Fetch the workspace's connected channels/integrations from Postiz.
export async function fetchPostizChannels() {
  const { url, key } = getCreds()
  const headers = { Authorization: key, 'Content-Type': 'application/json' }

  // Try the most likely endpoints in order; whichever works, we use.
  const candidates = [
    `${url}/api/v1/integrations/list`,
    `${url}/api/v1/integrations`,
    `${url}/integrations/list`,
    `${url}/public/v1/integrations`,
  ]
  let lastErr
  for (const endpoint of candidates) {
    try {
      const data = await tryFetch(endpoint, { headers })
      // Normalize: Postiz returns either an array or { integrations: [...] }
      const list = Array.isArray(data) ? data : (data.integrations || data.channels || data.data || [])
      return list.map((c) => ({
        id: c.id || c.identifier || c.channelId,
        name: c.name || c.profile?.name || c.username || 'Unknown',
        username: c.username || c.profile?.username || '',
        platform: (c.providerIdentifier || c.platform || c.provider || '').toLowerCase(),
        avatar: c.picture || c.profile?.picture || c.avatar || null,
        raw: c,
      })).filter((c) => c.id)
    } catch (e) { lastErr = e }
  }
  throw new Error('Postiz API gak nyambung: ' + (lastErr?.message || 'unknown'))
}

// Create a post on Postiz — either post now or schedule.
export async function createPostizPost({ channelId, content, mediaUrl, scheduledFor }) {
  const { url, key } = getCreds()
  const headers = { Authorization: key, 'Content-Type': 'application/json' }
  const body = {
    type: scheduledFor ? 'schedule' : 'now',
    date: scheduledFor || new Date().toISOString(),
    posts: [{
      integration: { id: channelId },
      value: [{ content, image: mediaUrl ? [{ path: mediaUrl }] : [] }],
    }],
  }
  return tryFetch(`${url}/api/v1/posts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}
