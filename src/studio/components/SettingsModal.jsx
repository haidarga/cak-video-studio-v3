import { useState, useEffect } from 'react'
import { useStudio } from '../store'
import { VIDEO_MODELS, IMAGE_MODELS } from '../lib/constants'

export default function SettingsModal({ open, onClose }) {
  const S = useStudio()
  const [fal, setFal] = useState('')
  const [gem, setGem] = useState('')
  const [vid, setVid] = useState('')
  const [img, setImg] = useState('')
  const [ar, setAr] = useState('')

  useEffect(() => {
    if (open) {
      setFal(S.falKey); setGem(S.geminiKey)
      setVid(S.defaultVidModel); setImg(S.defaultImgModel); setAr(S.defaultAR)
    }
  }, [open]) // eslint-disable-line

  if (!open) return null

  const save = () => {
    S.saveSettings({
      falKey: fal.trim(), geminiKey: gem.trim(),
      defaultVidModel: vid, defaultImgModel: img, defaultAR: ar,
    })
    onClose()
  }

  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2>⚙️ API Keys & Defaults</h2>
        <p className="sub">Disimpan di browser (localStorage). Tidak dikirim ke server manapun.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label>fal.ai API Key</label>
            <input type="password" value={fal} onChange={(e) => setFal(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div>
            <label>Google Gemini API Key</label>
            <input type="password" value={gem} onChange={(e) => setGem(e.target.value)} placeholder="AIza..." />
          </div>
          <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
          <div>
            <label>Default Video Model</label>
            <select value={vid} onChange={(e) => setVid(e.target.value)}>
              {VIDEO_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
            </select>
          </div>
          <div>
            <label>Default Image Model</label>
            <select value={img} onChange={(e) => setImg(e.target.value)}>
              {IMAGE_MODELS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
            </select>
          </div>
          <div>
            <label>Default Aspect Ratio</label>
            <select value={ar} onChange={(e) => setAr(e.target.value)}>
              <option value="9:16">9:16 — TikTok / Reels</option>
              <option value="16:9">16:9 — YouTube</option>
              <option value="1:1">1:1 — Instagram</option>
              <option value="4:5">4:5 — Instagram Portrait</option>
              <option value="3:4">3:4 — Portrait</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-green" onClick={save} style={{ flex: 1 }}>💾 Save</button>
            <button className="btn btn-ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}
