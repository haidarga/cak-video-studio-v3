// Server-only fal.ai client using the official SDK. FAL_KEY stays on the
// server; the browser proxies through /api/fal/* routes. SDK handles all the
// URL+header quirks across different model families.

import { fal } from '@fal-ai/client'

let configured = false
function ensureConfigured() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY belum di-set di Vercel env vars')
  if (!configured) {
    fal.config({ credentials: process.env.FAL_KEY })
    configured = true
  }
}

export async function falSubmit(model, input, { webhookUrl } = {}) {
  ensureConfigured()
  // webhookUrl: fal POSTs to it when job COMPLETED/FAILED — eliminates polling.
  // Without it the SDK still works but caller has to poll fal.queue.status.
  const opts = { input }
  if (webhookUrl) opts.webhookUrl = webhookUrl
  const { request_id } = await fal.queue.submit(model, opts)
  if (!request_id) throw new Error('fal submit: no request_id returned')
  return { request_id }
}

export async function falStatus(model, requestId) {
  ensureConfigured()
  // SDK returns { status, logs?, ... } — pass through.
  return await fal.queue.status(model, { requestId, logs: false })
}

export async function falResult(model, requestId) {
  ensureConfigured()
  // SDK returns { data, requestId } — we expose data as the result shape v2's
  // browser client expected (images / video / etc.).
  const res = await fal.queue.result(model, { requestId })
  return res.data || res
}
