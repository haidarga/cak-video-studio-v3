// Server-only fal.ai client. FAL_KEY stays on the server; the browser proxies
// through /api/fal/* routes. Same async pattern as fal's queue API:
// submit -> poll status -> fetch result.

const FAL_KEY = process.env.FAL_KEY

function key() {
  if (!FAL_KEY) throw new Error('FAL_KEY belum di-set di Vercel env vars')
  return `Key ${FAL_KEY}`
}

export async function falSubmit(model, input) {
  const res = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: key(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`fal submit ${res.status}: ${text.slice(0, 240)}`)
  return JSON.parse(text)
}

export async function falStatus(model, requestId) {
  const res = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
    headers: { Authorization: key() },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`fal status ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export async function falResult(model, requestId) {
  const res = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
    headers: { Authorization: key() },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`fal result ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}
