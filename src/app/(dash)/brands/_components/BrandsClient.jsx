'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function BrandsClient({ workspaceId, activeBrandId: initialActiveId, userId, initialBrands }) {
  const supabase = createClient()
  const [brands, setBrands] = useState(initialBrands)
  const [activeId, setActiveId] = useState(initialActiveId)
  const [editing, setEditing] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const channel = supabase.channel('brands-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands', filter: `workspace_id=eq.${workspaceId}` }, (payload) => {
        if (payload.eventType === 'INSERT') setBrands((p) => p.find((b) => b.id === payload.new.id) ? p : [payload.new, ...p])
        else if (payload.eventType === 'UPDATE') setBrands((p) => p.map((b) => (b.id === payload.new.id ? payload.new : b)))
        else if (payload.eventType === 'DELETE') setBrands((p) => p.filter((b) => b.id !== payload.old.id))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `id=eq.${workspaceId}` }, (payload) => {
        setActiveId(payload.new.active_brand_id)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [supabase, workspaceId])

  async function setActive(id) {
    setErr('')
    const { error } = await supabase.from('workspaces').update({ active_brand_id: id }).eq('id', workspaceId)
    if (error) setErr(error.message)
  }
  async function remove(id, name) {
    if (!confirm(`Hapus brand "${name}"?`)) return
    const { error } = await supabase.from('brands').delete().eq('id', id)
    if (error) setErr(error.message)
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold">Direktori</div>
          <h1 className="text-3xl font-bold mt-1">Brands</h1>
        </div>
        <button onClick={() => setEditing({ isNew: true })}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold hover:opacity-90">
          + Tambah Brand
        </button>
      </div>

      {err && <div className="mb-4 text-xs text-red-400">⚠ {err}</div>}

      {brands.length === 0 ? (
        <div className="text-sm text-[var(--muted)] p-12 border border-dashed border-[var(--border)] rounded-lg text-center">
          Belum ada brand. Klik <strong>+ Tambah Brand</strong> di kanan atas ☝️
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {brands.map((b) => (
            <BrandCard key={b.id} brand={b} isActive={b.id === activeId}
              onPick={() => setActive(b.id)} onEdit={() => setEditing(b)} onDelete={() => remove(b.id, b.name)} />
          ))}
        </div>
      )}

      {editing && (
        <BrandEditor brand={editing.isNew ? null : editing} workspaceId={workspaceId} userId={userId}
          onClose={() => setEditing(null)} onError={setErr} />
      )}
    </div>
  )
}

function BrandCard({ brand, isActive, onPick, onEdit, onDelete }) {
  const cfg = brand.config || {}
  const pillars = cfg.content_pillars || []
  return (
    <div className={`rounded-lg border p-5 bg-[var(--surface)] relative ${isActive ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
      {isActive && (
        <span className="absolute top-3 right-3 px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--accent)] text-white">Aktif</span>
      )}
      <div className="text-xl font-bold mb-1 pr-14">{brand.name}</div>
      <div className="text-xs text-[var(--muted)] mb-3">
        {pillars.length} content pillar{pillars.length !== 1 ? 's' : ''}
        {cfg.category && <> · {cfg.category}</>}
      </div>
      <div className="text-xs text-[var(--muted)] line-clamp-3 mb-4 min-h-[3.6em] leading-relaxed">
        {brand.notes || '— belum ada guardrails —'}
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
        <button onClick={onPick} disabled={isActive}
          className="text-xs font-semibold text-[var(--accent)] disabled:opacity-50 disabled:cursor-default">
          {isActive ? '✓ Aktif' : 'Pilih'}
        </button>
        <div className="flex gap-1">
          <button onClick={onEdit} className="p-1.5 rounded hover:bg-[var(--surface2)] text-[var(--muted)]" title="Edit">✏️</button>
          <button onClick={onDelete} className="p-1.5 rounded hover:bg-[var(--surface2)] text-red-400" title="Hapus">🗑</button>
        </div>
      </div>
    </div>
  )
}

function BrandEditor({ brand, workspaceId, userId, onClose, onError }) {
  const supabase = createClient()
  const [name, setName] = useState(brand?.name || '')
  const cfg = brand?.config || {}
  const [category, setCategory] = useState(cfg.category || '')
  const [guardrails, setGuardrails] = useState(brand?.notes || '')
  const [visualOff, setVisualOff] = useState(cfg.visual_guideline_off || false)
  const [targetAudience, setTargetAudience] = useState(cfg.target_audience || '')
  const [toneOfVoice, setToneOfVoice] = useState(cfg.tone_of_voice || '')
  const [contentPillars, setContentPillars] = useState((cfg.content_pillars || []).join('\n'))
  const [keyMessages, setKeyMessages] = useState((cfg.key_messages || []).join('\n'))
  const [campaignGoals, setCampaignGoals] = useState(cfg.campaign_goals || '')
  const [competitorInsight, setCompetitorInsight] = useState(cfg.competitor_insight || '')
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)

  async function aiDraft() {
    if (!name.trim()) { onError('Isi Nama Brand dulu sebelum AI Draft'); return }
    setDrafting(true); onError('')
    try {
      const res = await fetch('/api/draft/brand-strategy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), category: category.trim(), guardrails: guardrails.trim() }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      const d = data.draft
      // Only fill fields that are currently empty — jangan timpa kalau user udah isi
      if (!targetAudience.trim() && d.target_audience) setTargetAudience(d.target_audience)
      if (!toneOfVoice.trim() && d.tone_of_voice) setToneOfVoice(d.tone_of_voice)
      if (!contentPillars.trim() && d.content_pillars?.length) setContentPillars(d.content_pillars.join('\n'))
      if (!keyMessages.trim() && d.key_messages?.length) setKeyMessages(d.key_messages.join('\n'))
      if (!campaignGoals.trim() && d.campaign_goals) setCampaignGoals(d.campaign_goals)
      if (!competitorInsight.trim() && d.competitor_insight) setCompetitorInsight(d.competitor_insight)
    } catch (e) { onError('AI Draft: ' + e.message) }
    setDrafting(false)
  }

  async function save() {
    if (!name.trim()) { onError('Nama brand wajib diisi'); return }
    setBusy(true); onError('')
    const newCfg = {
      category: category.trim(),
      visual_guideline_off: visualOff,
      target_audience: targetAudience.trim(),
      tone_of_voice: toneOfVoice.trim(),
      content_pillars: contentPillars.split('\n').map((s) => s.trim()).filter(Boolean),
      key_messages: keyMessages.split('\n').map((s) => s.trim()).filter(Boolean),
      campaign_goals: campaignGoals.trim(),
      competitor_insight: competitorInsight.trim(),
    }
    const payload = { name: name.trim(), notes: guardrails.trim(), config: newCfg }
    let error
    if (brand?.id) ({ error } = await supabase.from('brands').update(payload).eq('id', brand.id))
    else ({ error } = await supabase.from('brands').insert({ ...payload, workspace_id: workspaceId, created_by: userId }))
    setBusy(false)
    if (error) onError(error.message)
    else onClose()
  }

  return (
    <Modal title="Brand Editor" onClose={onClose}
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
        <Field label="Nama Brand">
          <Input value={name} onChange={setName} placeholder="e.g. AceKid" />
        </Field>
        <Field label="Industry / Kategori">
          <Input value={category} onChange={setCategory} placeholder="e.g. Kids and Care" />
        </Field>
      </div>

      <Field label="Guardrails (Do & Don'ts)">
        <Textarea rows={5} value={guardrails} onChange={setGuardrails}
          placeholder="Aturan visual + klaim: yang boleh & yang gak boleh. AI inject ini di tiap generate." />
      </Field>

      <label className="flex items-start gap-3 cursor-pointer py-2">
        <input type="checkbox" checked={visualOff} onChange={(e) => setVisualOff(e.target.checked)} className="mt-1 w-4 h-4" />
        <div className="flex-1">
          <div className="text-sm font-semibold">🟡 Visual Guideline ON (brand wins)</div>
          <div className="text-xs text-[var(--muted)]">Brand visual identity kaku — inject brand rules ke SEMUA template. Off = template 100% menang.</div>
        </div>
      </label>

      <div className="pt-3 border-t border-[var(--border)]">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-bold">📋 Communication Strategy</div>
          <button onClick={aiDraft} disabled={drafting || !name.trim()}
            className="px-3 py-1.5 rounded text-xs font-semibold bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:opacity-90 disabled:opacity-50">
            {drafting ? '⏳ Drafting...' : '✨ AI Draft Strategy'}
          </button>
        </div>
        <div className="text-xs text-[var(--muted)] mb-4">Foundation buat semua konten. AI pake ini sebagai "brain" strategik saat generate. Klik ✨ AI Draft buat auto-isi field yang masih kosong.</div>

        <Field label="Target Audience">
          <Textarea rows={2} value={targetAudience} onChange={setTargetAudience}
            placeholder="Siapa target audience-nya? Demografi, perilaku, kebutuhan." />
        </Field>
        <Field label="Tone of Voice">
          <Textarea rows={2} value={toneOfVoice} onChange={setToneOfVoice}
            placeholder="Hangat & relatable / formal / playful / dll." />
        </Field>
        <Field label="Content Pillars (satu per baris)">
          <Textarea rows={3} value={contentPillars} onChange={setContentPillars}
            placeholder={'Tumbuh Kembang Optimal: edukasi milestone perkembangan anak\nKeamanan & Kualitas: tips memilih produk anak yang aman'} />
        </Field>
        <Field label="Key Messages (satu per baris, max 15 kata)">
          <Textarea rows={3} value={keyMessages} onChange={setKeyMessages}
            placeholder={'Mendukung tahap tumbuh kembang si kecil dengan aman\nPilihan tepat untuk keluarga Indonesia yang peduli kualitas'} />
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Campaign Goals">
            <Textarea rows={3} value={campaignGoals} onChange={setCampaignGoals} placeholder="Tujuan campaign-nya apa?" />
          </Field>
          <Field label="Competitor Insight">
            <Textarea rows={3} value={competitorInsight} onChange={setCompetitorInsight} placeholder="Insight dari kompetitor — gap yang bisa lu ambil." />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

// ─── Small shared UI helpers (could move to a shared file later) ───
export function Modal({ title, onClose, footer, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 md:p-6 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-3xl bg-[var(--surface)] rounded-xl border border-[var(--border)] my-8">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-end gap-3">{footer}</div>}
      </div>
    </div>
  )
}
export function Field({ label, children }) {
  return (
    <div>
      <label className="block text-[10px] uppercase text-[var(--muted)] tracking-wider font-semibold mb-1.5">{label}</label>
      {children}
    </div>
  )
}
export function Input({ value, onChange, ...rest }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} {...rest}
    className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
}
export function Textarea({ value, onChange, ...rest }) {
  return <textarea value={value} onChange={(e) => onChange(e.target.value)} {...rest}
    className="w-full text-sm px-3 py-2 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]" />
}
