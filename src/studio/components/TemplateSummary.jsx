// Readable breakdown of what an active template will imitate.
// Used in Template tab (Active card) + Pipeline tab (banner) so the
// Template→Pipeline connection is visible, not buried in the prompt.
export default function TemplateSummary({ analysis, compact }) {
  if (!analysis) return null
  const cs = analysis.caption_style || {}
  const rows = [
    ['🪝', 'Hook', analysis.hook_pattern],
    ['🎞️', 'Format', [analysis.estimated_shot_count && `${analysis.estimated_shot_count} shots`, analysis.shot_pacing].filter(Boolean).join(' · ')],
    ['🎨', 'Visual', [analysis.mood, analysis.color_grade, analysis.lighting].filter(Boolean).join(' · ')],
    ['💬', 'Caption', cs.language_vibe || cs.font_style || (cs.present ? 'ada caption' : null)],
    ['🧩', 'Elemen', (analysis.key_visual_elements || []).join(', ')],
  ].filter(([, , v]) => v && String(v).trim())
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 5 : 7 }}>
      {rows.map(([icon, label, val]) => (
        <div key={label} style={{ fontSize: 11.5, lineHeight: 1.5, display: 'flex', gap: 6 }}>
          <span style={{ flexShrink: 0 }}>{icon}</span>
          <span>
            <strong style={{ color: 'var(--text)' }}>{label}:</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>{val}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
