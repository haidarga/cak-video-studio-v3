import { useMemo, useState } from 'react'
import { useStudio } from '../store'
import { downloadFile } from '../lib/api'

const STATUSES = [
  { v: 'pending', l: '⏳ Pending', color: '#fcd34d' },
  { v: 'approved', l: '✅ Approved', color: '#86efac' },
  { v: 'revise', l: '🔁 Revisi', color: '#fdba74' },
  { v: 'rejected', l: '❌ Rejected', color: '#fca5a5' },
]
const stMeta = (v) => STATUSES.find((s) => s.v === v) || STATUSES[0]

export default function QCTab() {
  const S = useStudio()
  const [filter, setFilter] = useState('all')

  const items = useMemo(() => S.results.filter((r) => r.qc), [S.results])
  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, approved: 0, revise: 0, rejected: 0 }
    items.forEach((r) => { c[r.qc.status] = (c[r.qc.status] || 0) + 1 })
    return c
  }, [items])
  const shown = filter === 'all' ? items : items.filter((r) => r.qc.status === filter)
  const fname = (r) => (r.label || 'video').replace(/[^\w-]+/g, '_') + '.mp4'

  return (
    <div className="pane active">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div className="section-title" style={{ marginBottom: 0 }}>QC — Review sebelum upload <span className="badge badge-blue">{items.length}</span></div>
        {counts.approved > 0 && <span style={{ fontSize: 12, color: '#86efac', fontWeight: 600 }}>✅ {counts.approved} siap upload</span>}
      </div>

      {/* status filter */}
      <div className="pill-group" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {[['all', 'Semua'], ...STATUSES.map((s) => [s.v, s.l])].map(([v, l]) => (
          <div key={v} className={'pill' + (filter === v ? ' active' : '')} onClick={() => setFilter(v)}>
            {l} <span style={{ opacity: 0.6 }}>{counts[v] || 0}</span>
          </div>
        ))}
      </div>

      {!items.length ? (
        <div className="card">
          <div className="empty-state">
            <div className="es-icon">🧪</div>
            <h3>QC queue kosong</h3>
            <p>Dari tab <strong>Results</strong>, klik <strong>🧪 Kirim ke QC</strong> di video yang udah final/diedit. Di sini lo kasih status Approved / Revisi / Rejected + catatan sebelum upload.</p>
          </div>
        </div>
      ) : !shown.length ? (
        <div className="card"><div className="empty-state"><div className="es-icon">🔍</div><h3>Gak ada yang status "{stMeta(filter).l}"</h3></div></div>
      ) : (
        <div className="result-grid">
          {shown.map((r) => {
            const meta = stMeta(r.qc.status)
            return (
              <div key={r.id} className={'result-card ' + (r.ar === '16:9' ? 'ar169' : r.ar === '1:1' ? 'ar11' : '')}
                style={{ outline: `2px solid ${meta.color}`, outlineOffset: -2 }}>
                <video src={r.url} controls muted loop playsInline
                  style={{ width: '100%', aspectRatio: r.ar === '16:9' ? '16/9' : r.ar === '1:1' ? '1/1' : '9/16', objectFit: 'cover', display: 'block', background: '#000' }} />
                <div className="result-info">
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{r.label || 'video'}</div>
                  <p style={{ margin: '0 0 6px' }}>{r.ar} • {new Date(r.ts).toLocaleDateString()}</p>

                  {/* status selector */}
                  <div className="pill-group" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 4 }}>
                    {STATUSES.map((s) => (
                      <div key={s.v} onClick={() => S.setResultQC(r.id, { status: s.v })}
                        className={'pill' + (r.qc.status === s.v ? ' active' : '')}
                        style={{ fontSize: 10, padding: '4px 8px' }}>{s.l}</div>
                    ))}
                  </div>

                  <textarea rows={2} value={r.qc.notes || ''} placeholder="Catatan QC (revisi apa, dll)..."
                    onChange={(e) => S.setResultQC(r.id, { notes: e.target.value })}
                    style={{ fontSize: 11, width: '100%', marginBottom: 6 }} />

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => downloadFile(r.url, fname(r))}>⬇️ Download</button>
                    <button className="btn btn-sm" style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => S.sendToPostPro(r.url)}>🎞️ Edit lagi</button>
                  </div>
                  <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 6, justifyContent: 'center', color: 'var(--muted)' }}
                    onClick={() => S.setResultQC(r.id, null)}>✕ Keluarin dari QC</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
