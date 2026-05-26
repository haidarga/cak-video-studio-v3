import { useState } from 'react'
import { useStudio } from '../store'

export default function BrandModal({ open, onClose }) {
  const S = useStudio()
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState(null)
  const [notes, setNotes] = useState('')

  if (!open) return null

  const create = () => {
    if (!newName.trim()) { S.toast('Kasih nama brand dulu', 'error'); return }
    const b = S.createBrand(newName.trim())
    setNewName(''); setEditId(b.id); setNotes('')
  }
  const openEdit = (b) => { setEditId(b.id); setNotes(b.notes || '') }
  const saveNotes = () => { S.saveBrandNotes(editId, notes.trim()); S.toast('Brand knowledge disimpan ✓') }
  const editBrand = S.brands.find((b) => b.id === editId)

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 560 }}>
        <h2>🏷️ Brand Manager</h2>
        <p className="sub">1 brand = paket aset: reference images, template aktif, config & brand knowledge. Disimpan di browser.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14 }}>
            <div className="section-title" style={{ marginBottom: 10 }}>💾 Simpan Setup Sekarang</div>
            <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>Snapshot refs + template aktif + config jadi brand baru.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" placeholder="Nama brand (e.g. AceKid)" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-green btn-sm" onClick={create}>+ Save as Brand</button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={S.updateActiveBrand} style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}>
              🔄 Update Brand Aktif dari Setup Sekarang
            </button>
          </div>

          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>📚 Brand Tersimpan</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {S.brands.length ? S.brands.map((b) => {
                const active = b.id === S.activeBrandId
                return (
                  <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, background: 'var(--surface)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{b.name} {active && <span className="badge badge-green" style={{ marginLeft: 4 }}>active</span>}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>🖼️ {(b.refs || []).length} refs · 🎯 {b.activeTemplateId ? 'template ✓' : 'no template'} · 📝 {b.notes ? 'notes ✓' : 'no notes'}</div>
                    </div>
                    {!active && <button className="btn btn-ghost btn-sm" onClick={() => S.applyBrand(b.id)}>Load</button>}
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(b)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" style={{ color: '#fca5a5' }} onClick={() => { if (confirm(`Hapus brand "${b.name}"?`)) S.deleteBrand(b.id) }}>✕</button>
                  </div>
                )
              }) : <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>Belum ada brand. Simpan setup di atas ☝️</div>}
            </div>
          </div>

          {editBrand && (
            <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: 14 }}>
              <div className="section-title" style={{ marginBottom: 10 }}>✏️ Edit: <span style={{ color: 'var(--accent)' }}>{editBrand.name}</span></div>
              <label>Product Knowledge</label>
              <textarea rows={9} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontSize: 12 }}
                placeholder={'Isi sedetail mungkin biar produk konsisten:\n• NAMA & VARIAN: AceKid Activegro — kaleng 130g & 400g\n• TEKS DI KEMASAN (persis, biar AI render bener): "AceKid", "Activegro", "3+ Years", "Powdered Milk Drink"\n• WARNA & CIRI: kaleng biru-kuning, tutup biru, ada ikon nutrisi\n• ATURAN VISUAL: kaleng tegak, logo hadap kamera, JANGAN distorsi, teks harus kebaca\n• BOLEH / GAK BOLEH: klaim yang boleh dipake / kata terlarang\n• TARGET & TONE: ibu muda, hangat & relatable'} />
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                Di-inject ke Gemini (parse) <strong>dan</strong> prompt gambar (directive produk yang galak). <br />
                💡 <strong>Paling penting:</strong> upload <strong>foto kemasan produk</strong> sebagai reference image + kasih label = itu yang bikin visual-nya akurat. Knowledge ini cuma pelengkap.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-green btn-sm" onClick={saveNotes} style={{ flex: 1 }}>💾 Update Brand</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)} style={{ flex: 1 }}>Tutup</button>
              </div>
            </div>
          )}

          <button className="btn btn-ghost" onClick={onClose} style={{ justifyContent: 'center' }}>Close</button>
        </div>
      </div>
    </div>
  )
}
