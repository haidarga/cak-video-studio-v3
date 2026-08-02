// Pure channel-binding logic. NO Node built-ins, NO fetch — so both the
// server (lib/postiz.js) and client components (ScheduledClient, PostingClient)
// can import the SAME matcher.
//
// Why this file exists: the codebase used to carry three different label
// matchers (server fuzzy ≥3 chars, bulk-preview ≥4 chars + prefix heuristic,
// debug route strict equality). The bulk preview could show "→ Ben" green while
// the server re-bound the post somewhere else at publish time. One matcher now.
//
// THE BUG THIS GUARDS AGAINST: self-hosted Postiz does not reject an unknown
// integration id — it silently routes the post to the account's fallback
// channel. So an unvalidated stale id publishes Ben's video on Rio's account.
// Every path here therefore FAILS CLOSED: if we cannot positively verify which
// channel a post is going to, we refuse to post at all.

export function normalizeLabel(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\s._\-]+/g, '')
    .trim()
}

const MIN_FUZZY = 3

// Does this one channel satisfy the label? Exact normalized hit, or a
// containment hit when both sides are long enough to be meaningful.
export function channelMatchesLabel(channel, label) {
  const nl = normalizeLabel(label)
  if (!nl || !channel) return false
  return [channel.username, channel.name].some((v) => {
    const nv = normalizeLabel(v)
    if (!nv) return false
    if (nv === nl) return true
    return nv.length >= MIN_FUZZY && nl.length >= MIN_FUZZY && (nv.includes(nl) || nl.includes(nv))
  })
}

// Resolve a label to exactly ONE channel, in tiers.
//
// Tier 1 exact — wins outright. Order-independent, so a fuzzy candidate sitting
//   earlier in the array can no longer steal the match (Postiz does not
//   guarantee a stable order for GET /integrations).
// Tier 2 fuzzy — accepted ONLY when it is unambiguous. Two candidates means we
//   genuinely do not know which account the user meant, and guessing is how a
//   post lands on the wrong persona. We refuse.
//
// Returns { match, reason, candidates } — reason ∈
//   no-label | exact | ambiguous-exact | too-short | fuzzy | ambiguous-fuzzy | none
export function findChannelByLabel(liveChannels, label) {
  const nl = normalizeLabel(label)
  if (!nl) return { match: null, reason: 'no-label', candidates: [] }
  if (!Array.isArray(liveChannels) || liveChannels.length === 0) {
    return { match: null, reason: 'none', candidates: [] }
  }

  const exact = liveChannels.filter((c) =>
    [c.username, c.name].some((v) => normalizeLabel(v) === nl))
  if (exact.length === 1) return { match: exact[0], reason: 'exact', candidates: exact }
  if (exact.length > 1) return { match: null, reason: 'ambiguous-exact', candidates: exact }

  if (nl.length < MIN_FUZZY) return { match: null, reason: 'too-short', candidates: [] }

  const fuzzy = liveChannels.filter((c) => channelMatchesLabel(c, label))
  if (fuzzy.length === 1) return { match: fuzzy[0], reason: 'fuzzy', candidates: fuzzy }
  if (fuzzy.length > 1) return { match: null, reason: 'ambiguous-fuzzy', candidates: fuzzy }
  return { match: null, reason: 'none', candidates: [] }
}

function describe(channels) {
  return channels.map((c) => `"${c.name || c.username}" (${c.id})`).join(', ')
}

// Validate — and where safe, heal — which Postiz channel a post actually goes to.
// Pure + sync so it is fully unit-testable without network.
//
// Returns { channelId, platform, healed, unverified, verifiedLabel } or THROWS.
// The caller is expected to persist a healed binding so the next post does not
// pay the same lookup and take the same risk.
export function resolveChannelBinding({ channelId, channelLabel, platform, liveChannels, liveChannelsError }) {
  // ── FAIL CLOSED ──────────────────────────────────────────────────
  // Previously this returned the stored id unvalidated whenever the live list
  // was unavailable, which meant one transient 502 from a self-hosted Postiz
  // disabled every guard below and let a drifted id publish to the wrong
  // account. A post we cannot verify is a post we do not send.
  if (liveChannelsError) {
    throw new Error(
      `Channel gak bisa diverifikasi — daftar channel Postiz gagal diambil (${liveChannelsError}). ` +
      `Post DIBATALIN biar gak nyasar ke akun lain. Coba Retry setelah Postiz-nya balik normal.`
    )
  }
  if (!Array.isArray(liveChannels) || liveChannels.length === 0) {
    throw new Error(
      `Channel gak bisa diverifikasi — Postiz balikin 0 channel. ` +
      `Cek koneksi Postiz account di /settings, lalu Retry. Post DIBATALIN biar gak nyasar ke akun lain.`
    )
  }

  let healed = false
  let match = liveChannels.find((c) => String(c.id) === String(channelId))
  const byLabel = findChannelByLabel(liveChannels, channelLabel)

  if (byLabel.reason === 'ambiguous-exact' || byLabel.reason === 'ambiguous-fuzzy') {
    // Only fatal when we actually need the label to decide (dead id, or the
    // bound channel contradicts the label). A healthy binding is unaffected.
    const needsLabel = !match || !channelMatchesLabel(match, channelLabel)
    if (needsLabel) {
      throw new Error(
        `Label channel "${channelLabel}" ambigu — cocok ke ${byLabel.candidates.length} channel: ${describe(byLabel.candidates)}. ` +
        `Post DIBATALIN. Re-link persona ke channel yang bener di /posting, atau bikin nama channelnya lebih spesifik.`
      )
    }
  }

  // CASE A — stored id no longer exists live (Postiz reissued it on reconnect).
  if (!match) {
    if (byLabel.match) {
      console.warn(`[postiz] dead-id drift HEALED (${byLabel.reason}): "${channelId}" → "${byLabel.match.id}" via label "${channelLabel}"`)
      channelId = String(byLabel.match.id)
      match = byLabel.match
      healed = true
    } else {
      throw new Error(
        `Channel "${channelLabel || channelId}" gak ketemu di Postiz (channel ID drift / channel ke-disconnect). ` +
        `Klik 🔄 Sync Channels di /posting lalu re-link persona — post DIBATALIN biar gak nyasar ke akun lain.`
      )
    }
  }
  // CASE B — id is live but belongs to a DIFFERENT account than the label says.
  else if (channelLabel && !channelMatchesLabel(match, channelLabel)) {
    if (byLabel.match) {
      console.warn(`[postiz] WRONG-ACCOUNT binding HEALED: id "${channelId}" = "${match.name || match.username}" but label is "${channelLabel}" → "${byLabel.match.id}"`)
      channelId = String(byLabel.match.id)
      match = byLabel.match
      healed = true
    } else {
      throw new Error(
        `Binding salah: channel id "${channelId}" di Postiz itu akun "${match.name || match.username}", BUKAN "${channelLabel}". ` +
        `Gak ada channel "${channelLabel}" yang cocok — post DIBATALIN biar gak nyasar ke akun lain. ` +
        `Klik 🔄 Sync Channels di /posting lalu re-link persona.`
      )
    }
  }

  // CASE C — the live channel's platform is authoritative. A stale platform
  // makes defaultSettings() emit the wrong settings block → Postiz 400.
  if (match.platform) platform = match.platform

  return {
    channelId,
    platform,
    healed,
    // No label means we could only prove the id EXISTS — not that it belongs to
    // the intended persona. Surfaced so the caller can log/flag it.
    unverified: !normalizeLabel(channelLabel),
    verifiedLabel: match.name || match.username || null,
  }
}
