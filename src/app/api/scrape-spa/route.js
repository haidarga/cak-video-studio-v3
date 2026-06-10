// POST /api/scrape-spa { url, waitFor?, waitForSelector? }
//
// Fully-rendered HTML scraper via Browserless.io (managed Playwright).
//
// Why this exists:
// fetchUrlAsHtml (server-side fetch) returns the bare server HTML.
// Modern e-commerce sites (Sociolla, Shopee, Tokopedia, Lazada) are
// fully JS-hydrated SPAs — the server response is an empty shell;
// product data only appears AFTER the browser runs the JS bundle and
// hits internal APIs.
//
// Playwright renders the page in a real headless Chromium and returns
// the post-hydration DOM. The catch: Chromium is too big for Vercel
// serverless (150MB binary, 500MB RAM). We outsource to Browserless,
// a managed Playwright service with a free tier (1000 ops/mo) — enough
// for internal-tool usage without infra setup.
//
// SECURITY:
// - BROWSERLESS_TOKEN read from env, never hardcoded
// - Workspace-scoped auth (only logged-in users can hit this)
// - URL validated as http/https before forwarding
//
// LIMITATIONS:
// - Doesn't bypass Akamai/Cloudflare Bot Manager (LV/Nike still blocked)
// - 5-10s per scrape due to browser launch + page load
// - Free tier 1000 ops/mo; check usage at https://browserless.io/account

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

const BROWSERLESS_BASE = process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io'

export async function POST(req) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const token = process.env.BROWSERLESS_TOKEN
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: 'BROWSERLESS_TOKEN not set in env. Add it to Vercel project env vars.',
    }, { status: 503 })
  }

  try {
    const body = await req.json()
    const { url, waitFor = 4000, waitForSelector = null } = body || {}
    if (!url || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ ok: false, error: 'valid http(s) url required' }, { status: 400 })
    }

    // Browserless /content endpoint: returns fully-rendered HTML after
    // JS execution. Skip useless asset types to speed up + reduce data
    // transfer. waitFor gives the SPA time to fetch product data.
    const params = new URLSearchParams({ token })
    const blRes = await fetch(`${BROWSERLESS_BASE}/content?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        ...(waitForSelector ? { waitForSelector: { selector: waitForSelector, timeout: 10000 } } : { waitForTimeout: waitFor }),
        rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
      }),
    })

    if (!blRes.ok) {
      const errText = await blRes.text().catch(() => '')
      return NextResponse.json({
        ok: false,
        error: `Browserless ${blRes.status}: ${errText.slice(0, 200)}`,
      }, { status: 502 })
    }

    const html = await blRes.text()
    return NextResponse.json({ ok: true, html, length: html.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
