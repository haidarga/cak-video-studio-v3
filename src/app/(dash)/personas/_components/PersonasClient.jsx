'use client'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal, Field, Input, Textarea } from '../../brands/_components/BrandsClient'
import { PERSONA_TEMPLATES } from '@/lib/persona-templates'

const EMOTIONAL_ANGLES = ['Happy', 'Concerned', 'Curious', 'Skeptical', 'Excited', 'Confident', 'Empathetic', 'Aspirational']

export default function PersonasClient({ workspaceId, userId, activeBrandName, initialPersonas }) {
  const supabase = createClient()
  const [personas, setPersonas] = useState(initialPersonas)
  const [editing, setEditing] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [err, setErr] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)

  async function importFromTemplate(tpl) {
    setErr('')
    const { error } = await supabase.from('personas').insert({
      workspace_id: workspaceId,
      name: tpl.name,
      role_label: tpl.role_label,
      character_prompt: tpl.character_prompt,
      emotional_angle: tpl.emotional_angle,
      username: tpl.name.toLowerCase().replace(/\s+/g, ''),
      created_by: userId,
    })
    if (error) setErr(error.message)
    else setShowTemplates(false)
  }

  useEffect(() => {
    const ch = supabase.channel('personas-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'personas', filter: `workspace_id=eq.${workspaceId}` }, async (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          // Re-fetch the full row with refs join (realtime payload doesn't include joined data)
          const { data } = await supabase
            .from('personas')
            .select('*, persona_refs(ref_id, refs(id, fal_url, label))')
            .eq('id', payload.new.id).single()
          if (data) setPersonas((p) => {
            const idx = p.findIndex((x) => x.id === data.id)
            if (idx === -1) return [data, ...p]
            const next = [...p]; next[idx] = data; return next
          })
        } else if (payload.eventType === 'DELETE') {
          setPersonas((p) => p.filter((x) => x.id !== payload.old.id))
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, workspaceId])

  async function remove(id, name) {
    if (!confirm(`Hapus persona "${name}"?`)) return
    const { error } = await supabase.from('personas').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  function toggleSel(id) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setSelected((s) => s.size === personas.length ? new Set() : new Set(personas.map((p) => p.id)))
  }

  const [csvOpen, setCsvOpen] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [csvPreview, setCsvPreview] = useState(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const csvFileRef = useRef(null)

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) return { error: 'CSV harus minimal punya header + 1 baris data' }
    // Simple CSV parser (quoted strings with commas inside double quotes)
    function parseRow(line) {
      const cells = []
      let cur = '', inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"' && line[i - 1] !== '\\') { inQuotes = !inQuotes; continue }
        if (ch === ',' && !inQuotes) { cells.push(cur); cur = ''; continue }
        cur += ch
      }
      cells.push(cur)
      return cells.map((s) => s.trim())
    }
    const headers = parseRow(lines[0]).map((h) => h.toLowerCase())
    const rows = lines.slice(1).map(parseRow)
    const required = ['name']
    for (const r of required) if (!headers.includes(r)) return { error: `Missing required column: ${r}` }
    return { headers, rows }
  }

  async function onCsvFile(e) {
    const f = e.target.files?.[0]; if (!f) return; e.target.value = ''
    const text = await f.text()
    setCsvText(text)
    const parsed = parseCsv(text)
    setCsvPreview(parsed)
  }

  async function importCsv() {
    if (!csvPreview || csvPreview.error) return
    setCsvBusy(true); setErr('')
    try {
      const { headers, rows } = csvPreview
      const toInsert = rows.map((cells) => {
        const obj = { workspace_id: workspaceId, created_by: userId }
        headers.forEach((h, i) => {
          const v = cells[i]
          if (!v) return
          // Map common columns
          if (['name', 'username', 'role_label', 'character_prompt', 'emotional_angle', 'avatar_url', 'postiz_channel_id', 'postiz_platform'].includes(h)) {
            obj[h] = v
          }
        })
        return obj
      }).filter((r) => r.name)
      const { error } = await supabase.from('personas').insert(toInsert)
      if (error) throw error
      setCsvOpen(false); setCsvText(''); setCsvPreview(null)
    } catch (e) { setErr('CSV import: ' + e.message) }
    setCsvBusy(false)
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">{activeBrandName || 'No brand'}</div>
          <h1 className="text-3xl font-bold mt-1">Personas</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Tiap persona = 1 akun TikTok/IG. Upload foto refs → otomatis dipakai pas generate.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setShowTemplates(true)}
            className="px-3 py-2 rounded-lg bg-purple-500/30 border border-purple-500/50 text-purple-200 text-sm font-semibold hover:bg-purple-500/50">
            📚 Templates
          </button>
          <button onClick={() => setCsvOpen(true)}
            className="px-3 py-2 rounded-lg bg-cyan-500/30 border border-cyan-500/50 text-cyan-200 text-sm font-semibold hover:bg-cyan-500/50">
            📥 CSV Import
          </button>
          <button onClick={() => setEditing({ isNew: true })}
            className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90">
            + Tambah Persona
          </button>
        </div>
      </div>

      {csvOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setCsvOpen(false)}>
          <div className="w-full max-w-2xl bg-[var(--surface)] rounded-xl border border-[var(--border)] max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-base font-bold">📥 CSV Persona Import</h2>
              <button onClick={() => setCsvOpen(false)} className="text-[var(--muted)] hover:text-white">✕</button>
            </div>
            <div className="p-5 space-y-3">
              <div className="text-xs text-[var(--muted)]">
                Format header: <code className="bg-[var(--surface2)] px-1.5 py-0.5 rounded">name,username,role_label,character_prompt,emotional_angle,avatar_url,postiz_channel_id,postiz_platform</code>
                <br />Required: <strong>name</strong>. Sisanya optional. String dengan koma = quote dengan double-quotes.
              </div>
              <div className="flex gap-2">
                <button onClick={() => csvFileRef.current?.click()}
                  className="px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold hover:bg-[var(--border)]">
                  📤 Upload .csv
                </button>
                <input ref={csvFileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvFile} />
                <span className="text-xs text-[var(--muted)] self-center">atau paste CSV di bawah:</span>
              </div>
              <textarea value={csvText} onChange={(e) => { setCsvText(e.target.value); setCsvPreview(parseCsv(e.target.value)) }}
                rows={8} placeholder="name,username,role_label&#10;Emma,@emma,Ibu muda"
                className="w-full text-xs font-mono px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] resize-y" />
              {csvPreview?.error && <div className="text-xs text-red-400">⚠ {csvPreview.error}</div>}
              {csvPreview && !csvPreview.error && (
                <div className="bg-[var(--surface2)]/50 rounded p-2 text-xs">
                  <div className="font-bold mb-1">Preview: {csvPreview.rows.length} persona akan di-import</div>
                  <div className="max-h-32 overflow-auto space-y-1 text-[10px] text-[var(--muted)]">
                    {csvPreview.rows.slice(0, 10).map((r, i) => <div key={i}>• {r[csvPreview.headers.indexOf('name')] || '(no name)'}</div>)}
                    {csvPreview.rows.length > 10 && <div className="text-[var(--muted2)]">...dan {csvPreview.rows.length - 10} lainnya</div>}
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end gap-2">
              <button onClick={() => setCsvOpen(false)} className="px-3 py-1.5 text-sm rounded">Batal</button>
              <button onClick={importCsv} disabled={csvBusy || !csvPreview || csvPreview.error}
                className="px-4 py-1.5 text-sm rounded bg-[var(--accent)] text-white font-semibold disabled:opacity-50">
                {csvBusy ? '⏳' : `✓ Import ${csvPreview?.rows?.length || 0} persona`}
              </button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="mt-3 text-xs text-red-400">⚠ {err}</div>}

      {personas.length > 0 && (
        <label className="flex items-center gap-2 my-5 text-sm cursor-pointer">
          <input type="checkbox" checked={selected.size === personas.length && personas.length > 0}
            onChange={toggleAll} className="w-4 h-4" />
          <span>Select all {personas.length}</span>
        </label>
      )}

      {personas.length === 0 ? (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center mt-6">
          Belum ada persona. Klik <strong>+ Tambah Persona</strong> di kanan atas ☝️
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {personas.map((p) => (
            <PersonaCard key={p.id} persona={p} selected={selected.has(p.id)}
              onSelect={() => toggleSel(p.id)} onEdit={() => setEditing(p)} onDelete={() => remove(p.id, p.name)} />
          ))}
        </div>
      )}

      {editing && (
        <PersonaEditor persona={editing.isNew ? null : editing} workspaceId={workspaceId} userId={userId}
          onClose={() => setEditing(null)} onError={setErr} />
      )}

      {showTemplates && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={() => setShowTemplates(false)}>
          <div className="w-full max-w-3xl bg-[var(--surface)] rounded-xl border border-[var(--border)] max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-lg font-bold">📚 Persona Templates</h2>
              <button onClick={() => setShowTemplates(false)} className="text-[var(--muted)] hover:text-white">✕</button>
            </div>
            <div className="p-4 text-xs text-[var(--muted)]">Pilih archetype buat quick-start. Bisa di-edit setelah dibuat.</div>
            <div className="px-6 pb-6 grid grid-cols-1 md:grid-cols-2 gap-3">
              {PERSONA_TEMPLATES.map((tpl, i) => (
                <button key={i} onClick={() => importFromTemplate(tpl)}
                  className="text-left bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--accent)] rounded p-3">
                  <div className="text-sm font-bold mb-1">{tpl.label}</div>
                  <div className="text-[10px] text-[var(--muted)] mb-2 line-clamp-2">{tpl.role_label}</div>
                  <div className="text-[10px] text-[var(--muted2)] line-clamp-3">{tpl.character_prompt}</div>
                  <div className="text-[10px] text-[var(--accent)] mt-1.5">💭 {tpl.emotional_angle.split('.')[0]}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PersonaCard({ persona, selected, onSelect, onEdit, onDelete }) {
  const refsCount = (persona.persona_refs || []).length
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 relative">
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onSelect} className="mt-2 w-4 h-4" />
        <Avatar url={persona.avatar_url} name={persona.name} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="font-bold text-lg truncate pr-2">{persona.name}</div>
            <span className="text-[10px] font-semibold text-[#7dd3fc] border border-[#7dd3fc]/40 px-2 py-0.5 rounded">Inspired</span>
          </div>
          {persona.username && <div className="text-xs text-[#93c5fd]">@{persona.username}</div>}
          <div className="text-xs text-[var(--muted)] mt-1">
            {persona.role_label || persona.occupation || '—'}
            {persona.age && <> · {persona.age}y</>}
          </div>
          <div className="text-xs text-[var(--muted)] line-clamp-3 mt-2 leading-relaxed min-h-[3.6em]">
            {persona.character_prompt || persona.voice_style || '— belum ada character prompt —'}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border)]">
        <div className="flex gap-3 text-xs">
          <button onClick={onEdit} className="text-[var(--muted)] hover:text-white">✏️ Edit</button>
          <button onClick={onDelete} className="text-red-400 hover:text-red-300">🗑</button>
        </div>
        <div className="text-xs text-[var(--muted)]">{refsCount} ref{refsCount !== 1 ? 's' : ''}</div>
      </div>
    </div>
  )
}

function Avatar({ url, name }) {
  if (url) return <img src={url} alt={name} className="w-14 h-14 rounded-full object-cover flex-shrink-0" />
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return <div className="w-14 h-14 rounded-full bg-[var(--surface2)] flex items-center justify-center text-lg font-bold flex-shrink-0">{initial}</div>
}

// Voice attachment widget — 3 modes:
//   🎙 Clone (upload audio file → ElevenLabs IVC → voice_id)
//   🪄 Design (text prompt → 3 previews → pick → save → voice_id)
//   🎵 Library (pick from existing voices in this workspace's ElevenLabs account)
function VoicePicker({ voiceId, voiceName, voiceSource, onAttach, onClear, onError }) {
  const [mode, setMode] = useState('clone')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  // clone
  const cloneFileRef = useRef(null)
  // design
  const [designDesc, setDesignDesc] = useState('')
  const [designText, setDesignText] = useState('')
  const [previews, setPreviews] = useState([]) // [{ generated_voice_id, audio_url }]
  const [picked, setPicked] = useState(null)
  // library
  const [libVoices, setLibVoices] = useState(null)
  const [libSearch, setLibSearch] = useState('')

  async function handleClone() {
    const files = [...(cloneFileRef.current?.files || [])]
    if (!name.trim()) { onError('Voice name kosong'); return }
    if (!files.length) { onError('Pilih file audio dulu'); return }
    setBusy(true); onError('')
    try {
      const fd = new FormData()
      fd.append('name', name.trim())
      files.forEach((f) => fd.append('files', f, f.name || 'sample.mp3'))
      const r = await fetch('/api/voice/clone', { method: 'POST', body: fd })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'clone failed')
      onAttach({ voice_id: j.voice_id, voice_name: name.trim(), voice_source: 'clone' })
      setName(''); if (cloneFileRef.current) cloneFileRef.current.value = ''
    } catch (e) { onError('Clone gagal: ' + e.message) }
    setBusy(false)
  }

  async function handleDesign() {
    setBusy(true); onError('')
    setPreviews([]); setPicked(null)
    try {
      const r = await fetch('/api/voice/design', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: designDesc, text: designText }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'design failed')
      // Convert each base64 to a blob URL for <audio>
      const withUrls = (j.previews || []).map((p) => {
        const bin = atob(p.audio_base_64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        return {
          generated_voice_id: p.generated_voice_id,
          audio_url: URL.createObjectURL(new Blob([arr], { type: p.media_type || 'audio/mpeg' })),
        }
      })
      setPreviews(withUrls)
    } catch (e) { onError('Design gagal: ' + e.message) }
    setBusy(false)
  }

  async function handleSavePicked() {
    if (!picked) { onError('Pilih preview dulu'); return }
    if (!name.trim()) { onError('Voice name kosong'); return }
    setBusy(true); onError('')
    try {
      const r = await fetch('/api/voice/save-design', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generated_voice_id: picked.generated_voice_id, voice_name: name.trim(), voice_description: designDesc }),
      })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'save failed')
      onAttach({ voice_id: j.voice_id, voice_name: name.trim(), voice_source: 'design' })
      previews.forEach((p) => URL.revokeObjectURL(p.audio_url))
      setPreviews([]); setPicked(null); setName(''); setDesignDesc(''); setDesignText('')
    } catch (e) { onError('Save gagal: ' + e.message) }
    setBusy(false)
  }

  async function loadLibrary() {
    setBusy(true); onError('')
    try {
      const r = await fetch('/api/voice/library')
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'load failed')
      setLibVoices(j.voices || [])
    } catch (e) { onError('Library load gagal: ' + e.message); setLibVoices([]) }
    setBusy(false)
  }

  async function handleRemove() {
    if (!voiceId) return
    if (!confirm(`Hapus voice "${voiceName}" dari ElevenLabs library?`)) return
    setBusy(true); onError('')
    try {
      const r = await fetch('/api/voice/' + voiceId, { method: 'DELETE' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'delete failed')
      onClear()
    } catch (e) { onError('Hapus gagal: ' + e.message) }
    setBusy(false)
  }

  // ── current state badge ──
  if (voiceId) {
    return (
      <div className="bg-[var(--surface2)] border border-[var(--border)] rounded p-3">
        <div className="flex items-center gap-3">
          <span className="text-xl">🎙</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate text-green-300">{voiceName || 'unnamed voice'}</div>
            <div className="text-[10px] text-[var(--muted2)]">
              <span className="uppercase font-semibold">{voiceSource || 'attached'}</span> · ID: <code className="font-mono">{voiceId.slice(0, 12)}...</code>
            </div>
          </div>
          <button type="button" onClick={onClear} disabled={busy}
            className="text-xs px-2 py-1 rounded text-[var(--muted)] hover:text-white disabled:opacity-50">
            Lepas
          </button>
          <button type="button" onClick={handleRemove} disabled={busy}
            className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10 disabled:opacity-50">
            🗑 Hapus dari ElevenLabs
          </button>
        </div>
        <div className="text-[10px] text-[var(--muted2)] mt-2 leading-relaxed">
          Auto-applied saat generate video — native AI audio akan di-swap ke voice ini via ElevenLabs Speech-to-Speech (lip-sync preserved).
        </div>
      </div>
    )
  }

  // ── mode picker ──
  return (
    <div className="bg-[var(--surface2)] border border-[var(--border)] rounded p-3 space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {[
          ['clone', '🎙 Clone (audio)'],
          ['design', '🪄 Design (teks)'],
          ['library', '🎵 Library'],
        ].map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setMode(k); if (k === 'library' && !libVoices) loadLibrary() }}
            className={`text-xs px-2.5 py-1 rounded font-semibold ${mode === k ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]'}`}>
            {l}
          </button>
        ))}
      </div>

      {mode === 'clone' && (
        <div className="space-y-2">
          <div className="text-[10px] text-[var(--muted2)] leading-relaxed">
            Upload audio sample (≥10dtk, MP3/WAV/M4A). Boleh dari mana aja — recording sendiri, rip TikTok, sample talent.
            <strong> Yang penting clean</strong> — gak ada BGM / multiple speakers.
          </div>
          <Input value={name} onChange={setName} placeholder="Nama voice (e.g. AceKid Mom)" />
          <input ref={cloneFileRef} type="file" accept="audio/*" multiple
            className="text-xs w-full file:mr-2 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-[var(--surface)] file:text-white file:font-semibold" />
          <button type="button" onClick={handleClone} disabled={busy}
            className="w-full px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '⏳ Cloning...' : '🎙 Clone Voice'}
          </button>
        </div>
      )}

      {mode === 'design' && (
        <div className="space-y-2">
          <div className="text-[10px] text-[var(--muted2)] leading-relaxed">
            Generate voice baru dari teks — gak butuh recording sama sekali. Jelasin karakter suara → dapet 3 preview → pilih.
          </div>
          <div>
            <label className="text-[10px] uppercase text-[var(--muted)] font-semibold">Voice description (≥20 char)</label>
            <Textarea rows={2} value={designDesc} onChange={setDesignDesc}
              placeholder={'e.g. "Wanita Indonesia 30-an, suara hangat ramah energik, aksen Jakarta natural, cocok buat iklan produk anak"'} />
          </div>
          <div>
            <label className="text-[10px] uppercase text-[var(--muted)] font-semibold">Sample text (≥100 char — yang bakal diucap di preview)</label>
            <Textarea rows={3} value={designText} onChange={setDesignText}
              placeholder={'e.g. "Halo bunda! Aku punya rekomendasi nih buat si kecil yang lagi tumbuh. AceKid susu pertumbuhan dengan bahan alami pilihan, bikin anak makin aktif dan sehat."'} />
          </div>
          <button type="button" onClick={handleDesign} disabled={busy}
            className="w-full px-4 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '⏳ Generating 3 preview...' : '🪄 Generate 3 Voice Previews'}
          </button>
          {!!previews.length && (
            <div className="space-y-2 pt-2 border-t border-[var(--border)]">
              <div className="text-[10px] text-[var(--muted)]">Dengerin, pilih yang paling match:</div>
              {previews.map((p, i) => {
                const on = picked?.generated_voice_id === p.generated_voice_id
                return (
                  <div key={p.generated_voice_id} onClick={() => setPicked(p)}
                    className={`p-2 rounded border cursor-pointer ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--surface)]'}`}>
                    <div className="text-xs font-semibold mb-1">{on ? '✓ ' : ''}Preview {i + 1}</div>
                    <audio src={p.audio_url} controls className="w-full h-8" />
                  </div>
                )
              })}
              {picked && (
                <>
                  <Input value={name} onChange={setName} placeholder="Kasih nama voice (e.g. AceKid Mom v2)" />
                  <button type="button" onClick={handleSavePicked} disabled={busy || !name.trim()}
                    className="w-full px-4 py-2 rounded bg-green-500 text-white text-sm font-semibold disabled:opacity-50">
                    💾 Save Voice to Library
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'library' && (
        <div className="space-y-2">
          <div className="text-[10px] text-[var(--muted2)] leading-relaxed">
            Pilih dari voice yang udah ada di akun ElevenLabs workspace ini — clone lama, designed voice, library voice yang udah lu add.
          </div>
          {libVoices === null ? (
            <div className="text-xs text-[var(--muted)]">⏳ Loading...</div>
          ) : !libVoices.length ? (
            <div className="text-xs text-[var(--muted)]">Library kosong. Bikin Clone/Design dulu.</div>
          ) : (
            <>
              <div className="flex gap-2">
                <Input value={libSearch} onChange={setLibSearch} placeholder={`Cari (${libVoices.length} voice)...`} />
                <button type="button" onClick={loadLibrary} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">🔄</button>
              </div>
              <Input value={name} onChange={setName} placeholder="Nama panggilan (optional, kosong = pake nama asli)" />
              <div className="max-h-64 overflow-y-auto space-y-2">
                {libVoices
                  .filter((v) => !libSearch || (v.name || '').toLowerCase().includes(libSearch.toLowerCase()))
                  .map((v) => (
                    <div key={v.voice_id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-2">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate">{v.name || 'unnamed'}</div>
                          <div className="text-[9px] text-[var(--muted2)] truncate">
                            {(v.category || '').replace('_', ' ')} {v.labels?.gender ? '· ' + v.labels.gender : ''} {v.labels?.accent ? '· ' + v.labels.accent : ''}
                          </div>
                        </div>
                        <button type="button" onClick={() => onAttach({ voice_id: v.voice_id, voice_name: (name.trim() || v.name), voice_source: 'library' })}
                          className="text-[10px] px-2.5 py-1 rounded bg-[var(--accent)] text-white font-semibold">
                          Attach
                        </button>
                      </div>
                      {v.preview_url && <audio src={v.preview_url} controls className="w-full h-7" />}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PersonaEditor({ persona, workspaceId, userId, onClose, onError }) {
  const supabase = createClient()
  const [name, setName] = useState(persona?.name || '')
  const [username, setUsername] = useState(persona?.username || '')
  const [age, setAge] = useState(persona?.age || '')
  const [occupation, setOccupation] = useState(persona?.role_label || '')
  const [emotionalAngle, setEmotionalAngle] = useState(persona?.emotional_angle || 'Happy')
  const [characterPrompt, setCharacterPrompt] = useState(persona?.character_prompt || persona?.voice_style || '')
  const [postizChannelId, setPostizChannelId] = useState(persona?.postiz_channel_id || '')
  const [avatarUrl, setAvatarUrl] = useState(persona?.avatar_url || '')
  const [refs, setRefs] = useState(persona?.persona_refs?.map((pr) => pr.refs).filter(Boolean) || [])
  // ElevenLabs voice attached to this persona — drives auto S2S post-gen.
  const [voiceId, setVoiceId] = useState(persona?.voice_id || null)
  const [voiceName, setVoiceName] = useState(persona?.voice_name || '')
  const [voiceSource, setVoiceSource] = useState(persona?.voice_source || null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)
  const refsInputRef = useRef(null)

  async function uploadToStorage(file, prefix) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${workspaceId}/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage.from('refs').upload(path, file, { upsert: false, contentType: file.type })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
    return publicUrl
  }

  async function onAvatarPick(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); onError('')
    try {
      const url = await uploadToStorage(file, 'avatar')
      setAvatarUrl(url)
    } catch (e) { onError(e.message) }
    setBusy(false)
    e.target.value = ''
  }

  async function onRefsPick(e) {
    const files = [...(e.target.files || [])]
    if (!files.length) return
    setBusy(true); onError('')
    try {
      const newRefs = []
      for (const file of files.slice(0, 10 - refs.length)) {
        const url = await uploadToStorage(file, 'ref')
        const { data: ref, error } = await supabase.from('refs')
          .insert({ workspace_id: workspaceId, fal_url: url, label: name || 'unnamed', kind: 'character', created_by: userId })
          .select('id, fal_url, label').single()
        if (error) throw error
        newRefs.push(ref)
      }
      setRefs((p) => [...p, ...newRefs])
    } catch (e) { onError(e.message) }
    setBusy(false)
    e.target.value = ''
  }

  async function removeRef(refId) {
    setRefs((p) => p.filter((r) => r.id !== refId))
    // we keep the ref row for now; will get unlinked when persona_refs is rebuilt on save
  }

  async function save() {
    if (!name.trim()) { onError('Display name wajib'); return }
    setBusy(true); onError('')
    const payload = {
      name: name.trim(),
      username: username.trim().replace(/^@/, '') || null,
      age: age ? parseInt(age) || null : null,
      role_label: occupation.trim() || null,
      emotional_angle: emotionalAngle,
      character_prompt: characterPrompt.trim() || null,
      postiz_channel_id: postizChannelId.trim() || null,
      avatar_url: avatarUrl || null,
      voice_id: voiceId || null,
      voice_name: voiceName || null,
      voice_source: voiceSource || null,
    }
    let personaId = persona?.id
    let error
    if (personaId) {
      ({ error } = await supabase.from('personas').update(payload).eq('id', personaId))
    } else {
      const ins = await supabase.from('personas')
        .insert({ ...payload, workspace_id: workspaceId, created_by: userId }).select('id').single()
      error = ins.error
      personaId = ins.data?.id
    }
    if (!error && personaId) {
      // sync persona_refs to match `refs` state
      await supabase.from('persona_refs').delete().eq('persona_id', personaId)
      if (refs.length) {
        const rows = refs.map((r) => ({ persona_id: personaId, ref_id: r.id }))
        const { error: linkErr } = await supabase.from('persona_refs').insert(rows)
        if (linkErr) error = linkErr
      }
    }
    setBusy(false)
    if (error) onError(error.message)
    else onClose()
  }

  return (
    <Modal title="Persona Editor" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="px-4 py-2 rounded text-sm">Batal</button>
          <button onClick={save} disabled={busy}
            className="px-5 py-2 rounded bg-[var(--accent)] text-white text-sm font-semibold disabled:opacity-50">
            {busy ? '...' : '✓ Simpan'}
          </button>
        </>
      }>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Display Name">
          <Input value={name} onChange={setName} placeholder="Desak Venny" />
        </Field>
        <Field label="Username">
          <Input value={username} onChange={(v) => setUsername(v.replace(/^@/, ''))} placeholder="desakvenny" />
        </Field>
        <Field label="Umur">
          <Input type="number" value={age} onChange={setAge} placeholder="28" min={13} max={99} />
        </Field>
        <Field label="Occupation">
          <Input value={occupation} onChange={setOccupation} placeholder="Housewife / Notary / Auditor" />
        </Field>
      </div>

      <Field label="Emotional Angle">
        <select value={emotionalAngle} onChange={(e) => setEmotionalAngle(e.target.value)}
          className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
          {EMOTIONAL_ANGLES.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>

      <Field label="Character Prompt">
        <Textarea rows={5} value={characterPrompt} onChange={setCharacterPrompt}
          placeholder="Karakter & latar belakang persona. Disuntik AI pas generate." />
      </Field>

      <Field label={<>Postiz Integration ID <span className="text-[9px] text-[var(--muted2)] ml-1">OPTIONAL</span></>}>
        <Input value={postizChannelId} onChange={setPostizChannelId} placeholder="cmo77ygq..." />
        <div className="text-[10px] text-[var(--muted2)] mt-1">
          ID channel TikTok/IG di Postiz. Wajib kalau mau fitur Post Now. Cek /posting → Sync Channels buat lihat list.
        </div>
      </Field>

      <Field label={<>🎙 Voice Clone <span className="text-[9px] text-[var(--muted2)] ml-1">OPTIONAL — ElevenLabs</span></>}>
        <VoicePicker
          voiceId={voiceId} voiceName={voiceName} voiceSource={voiceSource}
          onAttach={(v) => { setVoiceId(v.voice_id); setVoiceName(v.voice_name); setVoiceSource(v.voice_source) }}
          onClear={() => { setVoiceId(null); setVoiceName(''); setVoiceSource(null) }}
          onError={onError}
        />
      </Field>

      {/* Avatar */}
      <Field label="Avatar (foto profil utama)">
        <div className="flex items-center gap-3">
          <Avatar url={avatarUrl} name={name} />
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPick} />
          <div className="flex gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}
              className="px-3 py-1.5 rounded text-xs bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50">
              📷 Upload foto
            </button>
            {avatarUrl && (
              <button type="button" onClick={() => setAvatarUrl('')}
                className="px-3 py-1.5 rounded text-xs text-red-400 border border-[var(--border)] hover:bg-[var(--surface2)]">
                ✕ Hapus
              </button>
            )}
          </div>
        </div>
      </Field>

      <Field label={`Image References (${refs.length}/10)`}>
        <div className="grid grid-cols-4 md:grid-cols-5 gap-3">
          {refs.map((r) => (
            <div key={r.id} className="relative aspect-square rounded overflow-hidden border border-[var(--border)]">
              <img src={r.fal_url} alt={r.label} className="w-full h-full object-cover" />
              <button onClick={() => removeRef(r.id)}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-xs flex items-center justify-center">✕</button>
            </div>
          ))}
          {refs.length < 10 && (
            <button type="button" onClick={() => refsInputRef.current?.click()} disabled={busy}
              className="aspect-square rounded border-2 border-dashed border-[var(--border)] flex items-center justify-center text-2xl text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50">
              {busy ? '⏳' : '↑'}
            </button>
          )}
          <input ref={refsInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onRefsPick} />
        </div>
        <div className="text-[10px] text-[var(--muted2)] mt-2">
          Foto dengan variasi ekspresi/pose/outfit → dipakai random di slide untuk dinamika.
        </div>
      </Field>
    </Modal>
  )
}
