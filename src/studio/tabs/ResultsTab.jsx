import { useMemo } from 'react'
import { useStudio } from '../store'
import { downloadFile } from '../lib/api'

export default function ResultsTab() {
  const S = useStudio()

  // group results by their `group` field — preserves insertion order
  const groups = useMemo(() => {
    const m = new Map()
    S.results.forEach((r) => {
      const g = r.group || ''
      if (!m.has(g)) m.set(g, [])
      m.get(g).push(r)
    })
    return [...m.entries()]
  }, [S.results])

  // distinct group names for the move-to dropdown
  const groupNames = useMemo(() => {
    const set = new Set(S.results.map((r) => r.group || '').filter(Boolean))
    if (S.resultGroup) set.add(S.resultGroup)
    return [...set].sort()
  }, [S.results, S.resultGroup])

  const fname = (r) => (r.label || 'video').replace(/[^\w-]+/g, '_') + (r.type === 'video' ? '.mp4' : '.png')

  return (
    <div className="pane active">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div className="section-title" style={{ marginBottom: 0 }}>Generated Results <span className="badge badge-blue">{S.results.length}</span></div>
        <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm('Hapus semua hasil?')) S.clearResults() }}>🗑 Clear All</button>
      </div>

      {/* active project — new gens get tagged with this group */}
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>📁 Project aktif</span>
        <input type="text" value={S.resultGroup} onChange={(e) => S.setResultGroup(e.target.value)}
          placeholder="e.g. AceKid — Konten Mei" style={{ flex: 1, minWidth: 180 }} />
        <span style={{ fontSize: 10.5, color: 'var(--muted2)' }}>Hasil baru otomatis masuk grup ini</span>
      </div>

      {!S.results.length ? (
        <div className="card">
          <div className="empty-state">
            <div className="es-icon">📁</div>
            <h3>Belum ada hasil</h3>
            <p>Video yang lo generate dari tab Quick, Pipeline, Bulk, atau Chain bakal nongol di sini — siap di-download.</p>
          </div>
        </div>
      ) : (
        groups.map(([gname, items]) => (
          <div key={gname || '__none'} style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: gname ? 'var(--text)' : 'var(--muted)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              {gname ? '📁 ' + gname : '— Tanpa grup —'}
              <span className="badge badge-gray">{items.length}</span>
            </div>
            <div className="result-grid">
              {items.map((r) => (
                <div key={r.id} className={'result-card ' + (r.ar === '16:9' ? 'ar169' : r.ar === '1:1' ? 'ar11' : '')}>
                  {r.type === 'video'
                    ? <video src={r.url} controls muted loop playsInline style={{ width: '100%', aspectRatio: r.ar === '16:9' ? '16/9' : r.ar === '1:1' ? '1/1' : '9/16', objectFit: 'cover', display: 'block', background: '#000' }} />
                    : <img src={r.url} alt="" style={{ width: '100%', display: 'block' }} />}
                  <div className="result-info">
                    <input type="text" value={r.label || ''} onChange={(e) => S.renameResult(r.id, e.target.value)}
                      placeholder="Kasih nama file..." style={{ fontSize: 12, fontWeight: 600, padding: '4px 6px', width: '100%' }} />
                    <p style={{ margin: '4px 0' }}>{r.ar} • {new Date(r.ts).toLocaleString()}</p>
                    <select value={r.group || ''} onChange={(e) => S.moveResultToGroup(r.id, e.target.value)}
                      style={{ fontSize: 11, padding: '4px 6px', width: '100%', marginBottom: 6 }}>
                      <option value="">— Tanpa grup —</option>
                      {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: 'center' }}
                        onClick={() => downloadFile(r.url, fname(r))}>⬇️ Download</button>
                      {r.type === 'video' && (
                        <button className="btn btn-sm" style={{ flex: 1, justifyContent: 'center' }}
                          onClick={() => S.sendToPostPro(r.url)}>🎞️ Post-Pro</button>
                      )}
                    </div>
                    {r.type === 'video' && (
                      r.qc
                        ? <div style={{ marginTop: 6, fontSize: 11, color: '#86efac', textAlign: 'center' }}>✅ Udah di QC ({r.qc.status})</div>
                        : <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 6, justifyContent: 'center' }}
                            onClick={() => { S.setResultQC(r.id, { status: 'pending' }); S.toast('Dikirim ke QC ✓'); }}>🧪 Kirim ke QC</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
