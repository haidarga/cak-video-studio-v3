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

  return (
    <div>
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">{activeBrandName || 'No brand'}</div>
          <h1 className="text-3xl font-bold mt-1">Personas</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Tiap persona = 1 akun TikTok/IG. Upload foto refs → otomatis dipakai pas generate.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowTemplates(true)}
            className="px-4 py-2 rounded-lg bg-purple-500/30 border border-purple-500/50 text-purple-200 text-sm font-semibold hover:bg-purple-500/50">
            📚 Templates
          </button>
          <button onClick={() => setEditing({ isNew: true })}
            className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90">
            + Tambah Persona
          </button>
        </div>
      </div>

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
