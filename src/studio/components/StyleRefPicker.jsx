import { useRef, useState } from 'react'
import { useStudio } from '../store'
import { falUpload } from '../lib/api'

// Optional style reference image — uploaded once, passed to every image gen so the
// model imitates its look/mood/color. Shared by Pipeline + Bulk (lives in config).
export default function StyleRefPicker() {
  const S = useStudio()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const url = S.config.styleRefUrl

  const onPick = async (file) => {
    if (!file) return
    setBusy(true)
    S.setConfig({ styleRefUrl: URL.createObjectURL(file) }) // instant preview
    try { const fu = await falUpload(file); S.setConfig({ styleRefUrl: fu }) } catch { S.toast('Upload style ref gagal', 'error') }
    setBusy(false)
  }

  return (
    <div>
      <label>Style Reference <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— opsional, gambar acuan look/mood/warna</span></label>
      {url ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--accent)' }} />
          <div style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>{busy ? '⏳ uploading…' : '✓ Style ref aktif — diniru di tiap gambar'}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => S.setConfig({ styleRefUrl: '' })}>✕ Hapus</button>
        </div>
      ) : (
        <div className="upload-zone" style={{ padding: 14, cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>
          <p style={{ fontSize: 11, margin: 0 }}>📷 Upload gambar style referensi (mood, warna, look)</p>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={(e) => { onPick(e.target.files[0]); e.target.value = '' }} />
    </div>
  )
}
