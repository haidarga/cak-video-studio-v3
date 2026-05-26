import { useRef, useState } from 'react'
import { useStudio } from '../store'

// Character / product reference uploader — shared by Pipeline + Bulk.
// Each ref can carry optional PRODUCT KNOWLEDGE (exact label text, rules) so a
// product stays consistent. Multiple products = multiple refs, each with its own
// knowledge; link the relevant ones per shot.
export default function RefManager() {
  const S = useStudio()
  const fileRef = useRef(null)
  const [openId, setOpenId] = useState(null) // which ref's knowledge editor is open

  return (
    <div className="card">
      <div className="section-title">Character / Product References</div>
      <div className="upload-zone" style={{ padding: 20 }} onClick={() => fileRef.current?.click()}>
        <div className="icon">👤</div>
        <p>Upload reference images (karakter, produk) — kasih label biar auto-match. Klik 📋 buat isi product knowledge.</p>
      </div>
      <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
        onChange={(e) => { [...e.target.files].forEach((f) => S.addRefFromFile(f)); e.target.value = '' }} />
      {!!S.refImages.length && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {S.refImages.map((r) => {
            const hasK = !!(r.knowledge || '').trim()
            return (
              <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', width: 84 }}>
                <div style={{ position: 'relative' }}>
                  <img src={r.url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: `1px solid ${hasK ? 'var(--accent)' : 'var(--border)'}` }} />
                  <button onClick={() => S.removeRef(r.id)} style={{ position: 'absolute', top: -6, right: -6, background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: '50%', width: 18, height: 18, cursor: 'pointer', fontSize: 11, padding: 0 }}>×</button>
                  <button onClick={() => setOpenId(openId === r.id ? null : r.id)} title="Product knowledge"
                    style={{ position: 'absolute', bottom: -6, right: -6, background: hasK ? 'var(--accent)' : 'var(--surface3)', border: '1px solid var(--border2)', color: '#fff', borderRadius: '50%', width: 20, height: 20, cursor: 'pointer', fontSize: 10, padding: 0 }}>📋</button>
                </div>
                <input type="text" value={r.label} placeholder="nama..." onChange={(e) => S.updateRefLabel(r.id, e.target.value)}
                  style={{ width: 84, padding: '4px 6px', fontSize: 11, textAlign: 'center' }} />
              </div>
            )
          })}
        </div>
      )}

      {/* per-ref product knowledge editor */}
      {openId && (() => {
        const r = S.refImages.find((x) => x.id === openId)
        if (!r) return null
        return (
          <div style={{ marginTop: 12, background: 'var(--surface2)', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
              📋 Product Knowledge — <span style={{ color: 'var(--accent)' }}>{r.label || 'ref ini'}</span>
            </div>
            <textarea rows={6} value={r.knowledge || ''} onChange={(e) => S.updateRefKnowledge(r.id, e.target.value)} style={{ fontSize: 11.5 }}
              placeholder={'Khusus produk — biar konsisten:\n• TEKS KEMASAN (persis): "AceKid", "Activegro", "3+ Years"\n• WARNA & CIRI: kaleng biru-kuning, tutup biru\n• ATURAN: kaleng tegak, logo hadap kamera, jangan distorsi, teks kebaca\n• VARIAN: 130g / 400g'} />
            <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 5, lineHeight: 1.4 }}>
              Knowledge ini cuma ke-inject pas ref ini di-link ke shot. Karakter gak usah diisi — kosongin aja.
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={() => setOpenId(null)}>Tutup</button>
          </div>
        )
      })()}
    </div>
  )
}
