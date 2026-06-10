// Smoke test for src/lib/fal-paths.js — verifies canonical resolution
// and algorithmic candidates for every model in the catalog.
//
// Run: `node scripts/test-fal-paths.mjs`
//
// Why this exists: fal-paths.js is THE critical reliability infra
// (alias→canonical resolver). A regression here silently breaks every
// async fal gen — the bug user hit (Seedance 2 stuck on "fal: unknown"
// for 95s before we fixed it). A pure-function test gives us a
// regression net without needing a full test framework.

import { canonicalFalPath, candidateFalPaths } from '../src/lib/fal-paths.js'

let passed = 0
let failed = 0
const failures = []

function assert(label, cond, detail) {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push({ label, detail })
    console.error(`✗ ${label}`)
    if (detail) console.error(`  ${detail}`)
  }
}

function assertEqual(label, actual, expected) {
  const ok = actual === expected
  assert(label, ok, ok ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertIncludes(label, arr, expected) {
  const ok = Array.isArray(arr) && arr.includes(expected)
  assert(label, ok, ok ? null : `expected ${JSON.stringify(expected)} in ${JSON.stringify(arr)}`)
}

// ── canonicalFalPath: verified entries from ALIAS_MAP ──

assertEqual('seedance-2 fast r2v: alias -> canonical',
  canonicalFalPath('bytedance/seedance-2.0/fast/reference-to-video'),
  'fal-ai/seedance-2/fast/reference-to-video')

assertEqual('seedance-2 fast i2v: alias -> canonical',
  canonicalFalPath('bytedance/seedance-2.0/fast/image-to-video'),
  'fal-ai/seedance-2/fast/image-to-video')

assertEqual('grok-imagine r2v: alias -> canonical',
  canonicalFalPath('xai/grok-imagine-video/reference-to-video'),
  'fal-ai/xai/reference-to-video')

assertEqual('grok-imagine i2v: alias -> canonical',
  canonicalFalPath('xai/grok-imagine-video/image-to-video'),
  'fal-ai/xai/image-to-video')

assertEqual('canonical passes through unchanged',
  canonicalFalPath('fal-ai/kling-video/v3/pro/image-to-video'),
  'fal-ai/kling-video/v3/pro/image-to-video')

assertEqual('unknown model returned as-is',
  canonicalFalPath('made-up/model/x'),
  'made-up/model/x')

assertEqual('null safe', canonicalFalPath(null), null)
assertEqual('empty safe', canonicalFalPath(''), '')

// ── candidateFalPaths: verified alias generates BOTH directions ──

const seedanceCands = candidateFalPaths('bytedance/seedance-2.0/fast/reference-to-video')
assertIncludes('seedance candidates include canonical',
  seedanceCands, 'fal-ai/seedance-2/fast/reference-to-video')
assertIncludes('seedance candidates include original alias',
  seedanceCands, 'bytedance/seedance-2.0/fast/reference-to-video')

const grokCands = candidateFalPaths('xai/grok-imagine-video/reference-to-video')
assertIncludes('grok candidates include canonical (drop middle)',
  grokCands, 'fal-ai/xai/reference-to-video')

// ── candidateFalPaths: unverified Happy Horse falls back to algorithmic ──
// We don't know the real canonical, but the candidates should cover the
// most likely transformations: add prefix, drop vendor, drop middle.

const happyHorseCands = candidateFalPaths('alibaba/happy-horse/image-to-video')
assertIncludes('happy-horse: add fal-ai/ prefix candidate',
  happyHorseCands, 'fal-ai/alibaba/happy-horse/image-to-video')
assertIncludes('happy-horse: drop-vendor candidate',
  happyHorseCands, 'fal-ai/happy-horse/image-to-video')

// ── candidateFalPaths: canonical input also yields candidates ──
// (for legacy queued messages stored with canonical, need alias too)

const canonicalSeed = candidateFalPaths('fal-ai/seedance-2/fast/reference-to-video')
assertIncludes('canonical seedance includes self',
  canonicalSeed, 'fal-ai/seedance-2/fast/reference-to-video')
assertIncludes('canonical seedance includes reverse alias',
  canonicalSeed, 'bytedance/seedance-2.0/fast/reference-to-video')

// ── candidateFalPaths: no duplicates ──

for (const m of [
  'bytedance/seedance-2.0/fast/reference-to-video',
  'xai/grok-imagine-video/image-to-video',
  'alibaba/happy-horse/reference-to-video',
  'fal-ai/kling-video/v3/pro/image-to-video',
]) {
  const c = candidateFalPaths(m)
  const unique = new Set(c)
  assert(`no duplicates in candidates for ${m}`, unique.size === c.length,
    unique.size === c.length ? null : `${c.length - unique.size} duplicates`)
}

// ── candidateFalPaths: cap at reasonable size (don't blow up rate limit) ──

for (const m of [
  'a/b/c/d/e/f/g/h', // pathological deep path
  'bytedance/seedance-2.0/fast/reference-to-video',
]) {
  const c = candidateFalPaths(m)
  assert(`candidates capped <= 20 for ${m}`, c.length <= 20,
    `got ${c.length} candidates`)
}

// ── Summary ──

console.log(`\n${passed} passed · ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
