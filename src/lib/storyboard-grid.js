// Snap a storyboard panel list to a clean grid (4 / 6 / 9) WITHOUT dropping any
// beat.
//
// THE BUG THIS EXISTS TO PREVENT — the old inline code sliced DOWN to the
// nearest clean grid (5 panels → 4), which silently DELETED the last panel.
// That's exactly how a 15s script's final CTA beat (e.g. "angkat kaleng Acekid
// + closing line", 0:11–0:15) vanished and the storyboard collapsed to 11s.
//
// THE FIX — round UP to the next clean grid and SPLIT the longest-seconds
// panel(s) to fill the extra cell(s). Splitting preserves total seconds
// (ceil + floor), so the video duration is unchanged and every beat survives.
// Only >9 panels are truncated — a single grid image physically can't show more
// than 9 stills — and that case is warned, not silent.
export function normalizeToGrid(rawPanels) {
  const panels = (rawPanels || []).slice(0, 9)
  if ((rawPanels || []).length > 9) {
    console.warn(`[storyboard] ${rawPanels.length} panels > 9-cell grid cap — extra beats dropped. Trim the script or split into segments.`)
  }
  if (panels.length <= 1) return panels.map((p, i) => ({ ...p, n: i + 1 }))
  const CLEAN = [4, 6, 9]
  const target = CLEAN.find((c) => c >= panels.length) || 9
  while (panels.length < target) {
    let idx = 0, max = -1
    panels.forEach((p, i) => { const s = parseInt(p.seconds) || 2; if (s > max) { max = s; idx = i } })
    const p = panels[idx]
    const s = parseInt(p.seconds) || 2
    panels.splice(idx, 1, { ...p, seconds: Math.ceil(s / 2) }, { ...p, seconds: Math.max(1, Math.floor(s / 2)) })
  }
  return panels.map((p, i) => ({ ...p, n: i + 1 }))
}

// Sum panel seconds → the storyboard's total clip duration.
export function totalSeconds(panels) {
  return (panels || []).reduce((sum, p) => sum + (parseInt(p.seconds) || 2), 0)
}
