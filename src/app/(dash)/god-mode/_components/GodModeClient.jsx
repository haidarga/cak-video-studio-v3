'use client'
// GOD MODE chatroom — Higgsfield-inspired conversational interface for
// generating videos. User types intent → AI agent picks tool → renders
// structured response (text + optional preset card / persona list /
// product picker / etc) inline in the chat.
//
// Phase 0 ships:
//  - Chatroom UI shell (messages, input, send)
//  - Tool result renderers (cinematic presets, persona list, product list)
//  - Quick-access pills above input
//  - Conversation history persistence (auto-save, list view, resume)
//  - File/image attachment upload (multimodal Gemini input)
//
// Future phases plug new tools into the backend agent route and add
// renderers here; the chatroom shell stays the same.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { IMAGE_MODELS, VIDEO_MODELS } from '@/lib/fal-client'
import { uploadFile } from '@/lib/upload-client'

const WELCOME_MESSAGE = {
  role: 'assistant',
  content: `Halo bro 👋 Gua GOD MODE — agent yang bantu lo bikin video cinematic dari ide. Tulis aja bahasa biasa: "bikin video product review", "kasih preset bullet time", "list persona yang ada", dll. Bisa juga upload gambar/file via tombol 📎. Atau klik quick action di bawah.`,
}

export default function GodModeClient({ workspaceId, userId, activeBrand, personas = [], refs = [] }) {
  const productRefs = refs.filter((r) => r.kind === 'product')
  const [conversationId, setConversationId] = useState(null)
  const [messages, setMessages] = useState([WELCOME_MESSAGE])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [historyList, setHistoryList] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState([])
  const [uploadBusy, setUploadBusy] = useState(false)
  // Self-contained gen state held IN THIS CHAT — never redirects to /generate.
  // activePreset = cinematic preset locked for next gen.
  // activePersona = persona character for next gen (auto-picked or user-chosen).
  // activeProduct = product ref for next gen.
  const [activePreset, setActivePreset] = useState(null)
  const [activePersona, setActivePersona] = useState(null)
  const [activeProduct, setActiveProduct] = useState(null)
  // Gen config — defaults user can override before each gen. Agent reads
  // these via activeContext.config and applies them when calling gen tools.
  // User can also override per-message via chat ("pakai Kling Pro").
  const [genConfig, setGenConfig] = useState({
    image_model: 'fal-ai/nano-banana/edit',
    video_model: 'bytedance/seedance-2.0/fast/reference-to-video',
    ar: '9:16',
    duration: 5,
    audio: true,
    resolution: '720p',
  })
  const [showConfig, setShowConfig] = useState(false)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, busy])

  // Auto-save conversation whenever messages change (except the initial
  // welcome-only state). Debounced so rapid back-to-back updates don't
  // hammer the API. Only saves once at least one user message exists.
  useEffect(() => {
    // Skip save if only the welcome message is present
    if (messages.length < 2) return
    const hasUserMsg = messages.some((m) => m.role === 'user')
    if (!hasUserMsg) return
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/god-mode/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: conversationId,
            messages,
            brand_id: activeBrand?.id || null,
          }),
        })
        const j = await res.json()
        if (j.ok && !conversationId) setConversationId(j.conversation.id)
      } catch (e) {
        console.warn('[god-mode] save failed:', e.message)
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [messages, conversationId, activeBrand?.id])

  async function loadHistory(q = '') {
    setHistoryLoading(true)
    try {
      const qs = q ? `?q=${encodeURIComponent(q)}&limit=100` : ''
      const res = await fetch(`/api/god-mode/conversations${qs}`)
      const j = await res.json()
      if (j.ok) setHistoryList(j.conversations || [])
    } catch (e) {
      console.warn('[god-mode] history load failed:', e.message)
    }
    setHistoryLoading(false)
  }

  // Debounce-search: wait 250ms after user stops typing before hitting API.
  // Prevents firing a request per keystroke. Cancels prior pending fetch
  // when user keeps typing.
  useEffect(() => {
    if (!showHistory) return
    const t = setTimeout(() => loadHistory(historySearch), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySearch, showHistory])

  async function openConversation(id) {
    setBusy(true)
    try {
      const res = await fetch(`/api/god-mode/conversations?id=${id}`)
      const j = await res.json()
      if (j.ok) {
        setConversationId(j.conversation.id)
        setMessages(j.conversation.messages || [WELCOME_MESSAGE])
        setShowHistory(false)
      }
    } finally {
      setBusy(false)
    }
  }

  function newConversation() {
    setConversationId(null)
    setMessages([WELCOME_MESSAGE])
    setShowHistory(false)
    setPendingAttachments([])
  }

  async function deleteConversation(id, e) {
    e.stopPropagation()
    if (!confirm('Hapus conversation ini?')) return
    try {
      await fetch(`/api/god-mode/conversations?id=${id}`, { method: 'DELETE' })
      setHistoryList((prev) => prev.filter((c) => c.id !== id))
      if (id === conversationId) newConversation()
    } catch (e) {
      console.warn('[god-mode] delete failed:', e.message)
    }
  }

  // File/image attachment upload — uses the existing /api/upload endpoint
  // which writes to R2 + scopes to workspace. We just collect the URLs and
  // attach them to the next outgoing message. The agent route passes the
  // URLs to Gemini via inline_data (or a follow-up fetch) for multimodal
  // analysis.
  async function handleFiles(files) {
    if (!files || files.length === 0) return
    setUploadBusy(true)
    setErr('')
    try {
      // Use presigned-PUT-direct-to-R2 via uploadFile helper. The previous
      // POST-to-/api/upload route hit Vercel's 4.5MB body cap on videos
      // (returned an HTML 413 page that broke JSON parse with "Request
      // En..." token error). Presigned PUT bypasses Vercel entirely so
      // any size up to R2's 5GB ceiling works.
      for (const file of Array.from(files).slice(0, 5)) { // cap at 5 per send
        const { url } = await uploadFile(file, 'god-mode-attachments')
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')
        setPendingAttachments((prev) => [...prev, {
          type: isImage ? 'image' : isVideo ? 'video' : 'file',
          url,
          name: file.name,
          mime: file.type,
          size: file.size,
        }])
      }
    } catch (e) {
      setErr('Upload gagal: ' + e.message)
    }
    setUploadBusy(false)
  }

  function removeAttachment(idx) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  // Action buttons on gen results trigger follow-up gens (regenerate,
  // animate from image, score virality, continue shot). Some actions
  // (PersonaListPicker, compose-prompt) pass an object instead of
  // (action, result) — handle both shapes.
  async function handleResultAction(action, result) {
    // PersonaListPicker compose-prompt action — single object arg
    if (typeof action === 'object' && action?.type === 'compose-prompt') {
      setInput(action.text || '')
      return
    }
    if (action === 'continue_shot') {
      await send('Lanjutin shot ini — sama persona/style/setting tapi advance ke moment berikutnya. Bikin shot 2.')
    } else if (action === 'regen_image') {
      const p = result.regen_payload || {}
      await send(`Regenerate ulang gambar barusan${p.prompt ? `: ${p.prompt}` : ''}`)
    } else if (action === 'regen_video') {
      const p = result.regen_payload || {}
      await send(`Regenerate ulang video barusan${p.motion_prompt ? `: ${p.motion_prompt}` : ''}`)
    } else if (action === 'animate') {
      await send(`Animate gambar ini jadi video ${genConfig.duration}s, pakai cinematic preset yang aktif. Image URL: ${result.url}`)
    } else if (action === 'predict_virality') {
      await send(`Score virality dari ${result.type === 'gen_video_result' ? 'video' : 'gambar'} ini: ${result.url}`)
    }
  }

  async function send(textOverride) {
    const text = (textOverride ?? input).trim()
    if ((!text && pendingAttachments.length === 0) || busy) return
    setErr('')
    const newUser = {
      role: 'user',
      content: text || '(attachment only)',
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
    }
    const conversation = [...messages, newUser]
    setMessages(conversation)
    setInput('')
    setPendingAttachments([])
    setBusy(true)
    try {
      const res = await fetch('/api/god-mode/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          messages: conversation.map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments || undefined,
          })),
          activeBrand,
          personaCount: personas.length,
          productCount: productRefs.length,
          // Locked context — agent uses these as defaults when calling gen
          // tools. User pinned them from earlier in the chat via picker UI.
          activeContext: {
            preset: activePreset || null,
            persona: activePersona ? {
              id: activePersona.id,
              name: activePersona.name,
              username: activePersona.username,
              avatar_url: activePersona.avatar_url,
              lora_url: activePersona.lora_url || null,
              lora_trigger_word: activePersona.lora_trigger_word || null,
            } : null,
            product: activeProduct ? {
              id: activeProduct.id,
              label: activeProduct.label,
              fal_url: activeProduct.fal_url,
              knowledge: activeProduct.knowledge,
            } : null,
            // Gen config defaults from the picker bar. User can override per
            // message via chat ("pake Kling Pro 1:1 10 detik no audio") and
            // the agent should respect that override.
            config: { ...genConfig },
          },
        }),
      })
      // Graceful non-JSON handling — Vercel function timeouts return an HTML
      // error page, not JSON. Without this, the JSON.parse fails with the
      // user-visible "Unexpected token 'A'..." error and the underlying
      // cause (function timeout) is invisible.
      const raw = await res.text()
      let j
      try { j = JSON.parse(raw) }
      catch {
        if (res.status === 504 || res.status === 502 || res.status === 408) {
          // 504 has multiple possible causes — be honest about which one
          // based on the request shape. Video gen would still be running
          // server-side; analyze (YouTube via Gemini) is just slow upstream.
          throw new Error(`Agent timeout (${res.status}). Kemungkinan penyebabnya: (1) Video gen masih jalan di fal — coba "cek status gen terakhir" buat poll. (2) Analyze YouTube via Gemini lagi lama — coba lagi atau download mp4 dulu lalu upload (lebih cepat). (3) URL paste tapi Gemini gak bisa fetch — pakai upload langsung.`)
        }
        throw new Error(`Server return non-JSON response (status ${res.status}). Kemungkinan function timeout atau crash. Body: ${raw.slice(0, 100)}`)
      }
      if (!j.ok) throw new Error(j.error || 'agent error')
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: j.text, tool: j.tool, toolResult: j.tool_result },
      ])
    } catch (e) {
      setErr(String(e?.message || e))
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `⚠ Error: ${e?.message || e}`, error: true },
      ])
    } finally {
      setBusy(false)
    }
  }

  // Quick-action pills above input. Each fires a pre-canned prompt at the
  // agent so users can discover tools without typing.
  const QUICK_ACTIONS = [
    { label: '🎬 Continue last shot', prompt: 'Lanjutin shot terakhir, sama persona/style tapi scene berikutnya. Bikin shot 2.' },
    { label: '🎥 Browse cinematic presets', prompt: 'Tampilkan semua cinematic presets yang ada, group by category' },
    { label: '🎯 Bullet time effect', prompt: 'Bikin preset bullet time effect untuk produk' },
    { label: '📦 Product 360 spin', prompt: 'Suggest preset untuk product 360 degree spin showcase' },
    { label: '👥 List personas', prompt: 'List semua persona yang ada di workspace ini' },
    { label: '🛒 List produk', prompt: 'List semua produk yang udah ada di workspace' },
  ]

  return (
    <div className="max-w-4xl mx-auto">
      <header className="hero-halo mb-6 pt-4 pb-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-4xl float-soft">🔥</span>
              <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight">
                <span className="gradient-text-strong">God Mode</span>
              </h1>
              <span className="text-[10px] uppercase font-bold bg-[var(--accent)]/20 text-[var(--accent)] px-2 py-0.5 rounded border border-[var(--accent)]/30">Beta</span>
            </div>
            <p className="text-sm md:text-base text-[var(--muted)] max-w-2xl leading-relaxed">
              Conversational AI agent — describe what you want, the agent picks the right tool.
              <br className="hidden md:inline" />
              <span className="text-[var(--muted2)]">
                Built on top of {personas.length} personas · {productRefs.length} products · 28 cinematic presets.
              </span>
            </p>
            {activeBrand && (
              <div className="mt-3 brand-pill">
                BRAND · {activeBrand.name}
              </div>
            )}
          </div>
          {/* Conversation controls — new chat + history toggle. */}
          <div className="flex gap-1 flex-shrink-0">
            <button
              onClick={newConversation}
              title="Start new conversation"
              className="btn-ghost-glow text-xs"
            >
              + New
            </button>
            <button
              onClick={() => { setShowHistory((s) => !s); if (!showHistory) loadHistory() }}
              title="Show conversation history"
              className={`btn-ghost-glow text-xs ${showHistory ? 'border-[var(--accent)]/60 text-[var(--accent)]' : ''}`}
            >
              🕐 History
            </button>
          </div>
        </div>
      </header>

      {/* History panel — slides above chat when toggled. Shows recent
          conversations with click-to-resume + delete affordance. */}
      {showHistory && (
        <div className="mb-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 max-h-72 overflow-y-auto">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <div className="text-[10px] uppercase font-bold text-[var(--muted)]">
              Conversations {historyLoading && '· loading...'}
            </div>
            <input
              type="text"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Search title..."
              className="text-xs px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]/50 w-40"
            />
          </div>
          {historyList.length === 0 && !historyLoading && (
            <div className="text-xs text-[var(--muted2)] px-1 py-2">
              {historySearch ? `Gak nemu conversation dengan "${historySearch}".` : 'Belum ada conversation tersimpan.'}
            </div>
          )}
          <div className="space-y-1">
            {historyList.map((c) => (
              <div
                key={c.id}
                onClick={() => openConversation(c.id)}
                className={`flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-[var(--surface2)] ${conversationId === c.id ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30' : 'border border-transparent'}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate">{c.title}</div>
                  <div className="text-[10px] text-[var(--muted2)]">
                    {c.message_count} msgs · {new Date(c.updated_at).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={(e) => deleteConversation(c.id, e)}
                  className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10">
                  🗑
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat scroll area */}
      <div
        ref={scrollRef}
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 mb-3 overflow-y-auto"
        style={{ height: 'calc(100vh - 320px)', minHeight: 400 }}
      >
        {messages.map((m, i) => (
          <MessageBubble
            key={i}
            msg={m}
            personas={personas}
            onPresetUse={setActivePreset}
            onPersonaPick={setActivePersona}
            onProductPick={setActiveProduct}
            onAction={handleResultAction}
          />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)] mt-2 pl-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
            Agent thinking...
          </div>
        )}
        {err && (
          <div className="mt-3 text-xs text-red-400">⚠ {err}</div>
        )}
      </div>

      {/* Quick-action pills */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            onClick={() => send(a.prompt)}
            disabled={busy}
            className="text-[11px] px-2.5 py-1.5 rounded-full bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--surface)] disabled:opacity-50">
            {a.label}
          </button>
        ))}
      </div>

      {/* Gen config bar — collapsible. Lets user pick image/video model,
          aspect ratio, duration, audio toggle. Agent uses these defaults
          when calling gen tools; user can still override per-message via
          chat ("pake Kling Pro, 1:1, 10 detik"). */}
      <div className="mb-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-hidden">
        <button
          onClick={() => setShowConfig((s) => !s)}
          className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-[var(--surface2)] text-left text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase font-bold text-[var(--muted)]">⚙ Gen config</span>
            <ConfigPill label="📐" value={genConfig.ar} />
            <ConfigPill label="⏱" value={`${genConfig.duration}s`} />
            <ConfigPill label="🎨" value={shortModelLabel(IMAGE_MODELS, genConfig.image_model)} />
            <ConfigPill label="🎬" value={shortModelLabel(VIDEO_MODELS, genConfig.video_model)} />
            <ConfigPill label="🔊" value={genConfig.audio ? 'on' : 'off'} />
          </div>
          <span className="text-[var(--muted)]">{showConfig ? '▲' : '▼'}</span>
        </button>
        {showConfig && (
          <div className="px-3 py-3 border-t border-[var(--border)] space-y-2.5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              <ConfigSelect
                label="🎨 Image model"
                value={genConfig.image_model}
                onChange={(v) => setGenConfig({ ...genConfig, image_model: v })}
                options={IMAGE_MODELS.map((m) => [m.v, m.l])}
              />
              <ConfigSelect
                label="🎬 Video model"
                value={genConfig.video_model}
                onChange={(v) => setGenConfig({ ...genConfig, video_model: v })}
                options={VIDEO_MODELS.map((m) => [m.v, m.l])}
              />
              <ConfigSelect
                label="📐 Aspect ratio"
                value={genConfig.ar}
                onChange={(v) => setGenConfig({ ...genConfig, ar: v })}
                options={[
                  ['9:16', '9:16 vertical (TikTok / Reels)'],
                  ['16:9', '16:9 horizontal (YouTube)'],
                  ['1:1', '1:1 square (Feed)'],
                  ['4:5', '4:5 portrait (IG Post)'],
                  ['3:4', '3:4 portrait'],
                ]}
              />
              <ConfigSelect
                label="⏱ Duration (video)"
                value={String(genConfig.duration)}
                onChange={(v) => setGenConfig({ ...genConfig, duration: parseInt(v) || 5 })}
                options={[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((d) => [String(d), `${d} seconds`])}
              />
              <ConfigSelect
                label="🔊 Audio (video)"
                value={genConfig.audio ? 'on' : 'off'}
                onChange={(v) => setGenConfig({ ...genConfig, audio: v === 'on' })}
                options={[['on', 'With audio'], ['off', 'No audio (silent)']]}
              />
              <ConfigSelect
                label="📺 Resolution"
                value={genConfig.resolution}
                onChange={(v) => setGenConfig({ ...genConfig, resolution: v })}
                options={[['720p', '720p (cheap, fast)'], ['1080p', '1080p (mahal, sharp)']]}
              />
            </div>
            <div className="text-[10px] text-[var(--muted2)]">
              Atau override per-prompt via chat: "pake Kling Pro, 1:1, 10 detik, no audio"
            </div>
          </div>
        )}
      </div>

      {/* Active context pills — locked persona / product / preset that get
          baked into every subsequent gen request. User dismisses via ✕. */}
      {(activePreset || activePersona || activeProduct) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {activePreset && (
            <div className="flex items-center gap-1 text-[10px] bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[var(--accent)] px-2 py-1 rounded-full">
              🎥 {activePreset.label}
              <button onClick={() => setActivePreset(null)} className="ml-1 opacity-60 hover:opacity-100">✕</button>
            </div>
          )}
          {activePersona && (
            <div className="flex items-center gap-1 text-[10px] bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[var(--accent)] px-2 py-1 rounded-full">
              {activePersona.avatar_url && <img src={activePersona.avatar_url} className="w-4 h-4 rounded-full" />}
              👤 {activePersona.name}
              <button onClick={() => setActivePersona(null)} className="ml-1 opacity-60 hover:opacity-100">✕</button>
            </div>
          )}
          {activeProduct && (
            <div className="flex items-center gap-1 text-[10px] bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[var(--accent)] px-2 py-1 rounded-full">
              📦 {activeProduct.label}
              <button onClick={() => setActiveProduct(null)} className="ml-1 opacity-60 hover:opacity-100">✕</button>
            </div>
          )}
        </div>
      )}

      {/* Pending attachments preview — shown above input when files are
          uploaded but not yet sent. User can review + remove before submit. */}
      {pendingAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingAttachments.map((a, i) => (
            <div key={i} className="relative bg-[var(--surface)] border border-[var(--border)] rounded p-1.5 pr-7 flex items-center gap-1.5 max-w-xs">
              {a.type === 'image' ? (
                <img src={a.url} alt={a.name} className="w-8 h-8 object-cover rounded" />
              ) : (
                <div className="w-8 h-8 rounded bg-[var(--surface2)] flex items-center justify-center text-xs">📄</div>
              )}
              <div className="text-[10px] truncate min-w-0">{a.name}</div>
              <button
                onClick={() => removeAttachment(i)}
                className="absolute right-1 top-1 text-[10px] text-[var(--muted)] hover:text-red-400">✕</button>
            </div>
          ))}
          {uploadBusy && <div className="text-[10px] text-[var(--muted)] self-center px-1">⏳ uploading...</div>}
        </div>
      )}

      {/* Input — text + paperclip attach + send button */}
      <form
        onSubmit={(e) => { e.preventDefault(); send() }}
        className="flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.mp4,.mov,.webm,.mkv,.avi,.jpg,.jpeg,.png,.webp,.gif,.heic,application/pdf,.txt,.csv,.json"
          onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || uploadBusy}
          title="Attach image / file"
          className="px-3 py-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)]/40 disabled:opacity-40">
          📎
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter = submit, Shift+Enter = newline (default textarea behavior).
            // Without this, plain Enter would just add a newline since textarea
            // doesn't auto-submit forms like <input> does.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={1}
          placeholder="Tulis instruksi… (Shift+Enter buat baris baru) — misal: bikin preset push-in dramatic untuk wajah Tandy"
          disabled={busy}
          className="flex-1 text-sm px-4 py-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50 resize-none min-h-[48px] max-h-[200px]"
          style={{ height: 'auto' }}
          ref={(el) => {
            // Auto-grow textarea up to max-height as user types.
            if (el) {
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 200) + 'px'
            }
          }}
        />
        <button
          type="submit"
          disabled={busy || (!input.trim() && pendingAttachments.length === 0)}
          className="px-5 py-3 rounded-lg bg-[var(--accent)] text-white font-bold text-sm hover:opacity-90 disabled:opacity-40">
          ↑ Send
        </button>
      </form>
    </div>
  )
}

function MessageBubble({ msg, personas, onPresetUse, onPersonaPick, onProductPick, onAction }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-[var(--accent)] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
          {msg.attachments?.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {msg.attachments.map((a, i) => (
                a.type === 'image'
                  ? <img key={i} src={a.url} alt={a.name} className="max-w-[200px] max-h-[200px] rounded object-cover" />
                  : <a key={i} href={a.url} target="_blank" rel="noreferrer" className="text-[10px] underline opacity-80">📄 {a.name}</a>
              ))}
            </div>
          )}
          {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
        </div>
      </div>
    )
  }
  // Assistant message — text + optional tool result
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[92%] w-full">
        <div className="text-[10px] uppercase font-bold text-[var(--muted2)] mb-1 flex items-center gap-1.5">
          <span>🔥 Agent</span>
          {msg.tool && <span className="text-[var(--accent)]">· {msg.tool}</span>}
        </div>
        <div className={`rounded-2xl rounded-bl-sm px-4 py-3 text-sm ${msg.error ? 'bg-red-500/10 border border-red-500/30 text-red-300' : 'bg-[var(--surface2)] border border-[var(--border)]'}`}>
          <div className="whitespace-pre-wrap">{msg.content}</div>
          {msg.toolResult && (
            <ToolResult
              result={msg.toolResult}
              personas={personas}
              onPresetUse={onPresetUse}
              onPersonaPick={onPersonaPick}
              onProductPick={onProductPick}
              onAction={onAction}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ToolResult({ result, personas, onPresetUse, onPersonaPick, onProductPick, onAction }) {
  if (!result || result.type === 'error') {
    return <div className="mt-3 text-xs text-red-400">⚠ {result?.error || 'tool failed'}</div>
  }
  if (result.type === 'cinematic_preset_suggestions') {
    return <PresetCards presets={result.suggestions} compact onUse={onPresetUse} />
  }
  if (result.type === 'cinematic_preset_library') {
    return (
      <div className="mt-3 space-y-3">
        {result.categories.map((cat) => (
          cat.presets?.length > 0 && (
            <div key={cat.id}>
              <div className="text-[11px] font-semibold mb-1 text-[var(--muted)]">{cat.label}</div>
              <PresetCards presets={cat.presets} compact onUse={onPresetUse} />
            </div>
          )
        ))}
      </div>
    )
  }
  if (result.type === 'persona_list') {
    return <PersonaListPicker result={result} onPersonaPick={onPersonaPick} onAction={onAction} />
  }
  if (result.type === 'product_ref_list') {
    return (
      <div className="mt-3">
        {result.products.length === 0 ? (
          <div className="text-xs text-[var(--muted2)]">Belum ada product ref. Upload di <Link href="/refs" className="underline">/refs</Link></div>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-4 gap-1.5">
            {result.products.map((p) => (
              <button
                key={p.id}
                onClick={() => onProductPick && onProductPick(p)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded p-1.5 hover:border-[var(--accent)]/50 text-left">
                <img src={p.fal_url} alt={p.label} className="w-full aspect-square object-cover rounded" />
                <div className="text-[10px] font-semibold mt-1 truncate">{p.label}</div>
                {p.knowledge && <div className="text-[9px] text-[var(--muted2)] truncate" title={p.knowledge}>📋 has knowledge</div>}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (result.type === 'gen_image_result') {
    return <GenImageResult result={result} onAction={onAction} />
  }
  if (result.type === 'gen_video_result') {
    return <GenVideoResult result={result} onAction={onAction} />
  }
  if (result.type === 'gen_video_queued') {
    return <GenVideoQueued result={result} />
  }
  if (result.type === 'url_marketing_proposal') {
    return <UrlMarketingProposal result={result} />
  }
  if (result.type === 'video_analysis') {
    return <VideoAnalysisCard result={result} />
  }
  if (result.type === 'virality_score') {
    return <ViralityScoreCard result={result} />
  }
  if (result.type === 'soul_training_result') {
    return <SoulTrainingResult result={result} />
  }
  if (result.type === 'brand_builder_result') {
    return <BrandBuilderResult result={result} />
  }
  if (result.type === 'mass_variants_result') {
    return <MassVariantsResult result={result} />
  }
  if (result.type === 'viral_ad_campaign_result') {
    return <ViralAdCampaignResult result={result} />
  }
  if (result.type === 'viral_clip_result') {
    return <ViralClipResult result={result} />
  }
  if (result.type === 'viral_clip_pending') {
    return <ViralClipPending result={result} />
  }
  if (result.type === 'gen_video_multi_queued') {
    return (
      <div className="mt-3 space-y-2">
        <div className="text-[10px] uppercase font-bold text-[var(--accent)]">
          🎬 {result.count} videos queued — each polls independently
        </div>
        {result.items.map((item, i) => (
          <div key={i}>
            {item.type === 'error'
              ? <div className="text-xs text-red-400 bg-red-900/20 p-2 rounded border border-red-900/40">Video {(item.idx || i) + 1}: {item.error}</div>
              : <GenVideoQueued result={item} />}
          </div>
        ))}
      </div>
    )
  }
  return null
}

// Runs ffmpeg.wasm cuts client-side, uploads each result to R2.
// Tool returned a "pending" — we do the actual work here in the browser
// to avoid coupling v3 to v2 HF Space backend (see src/lib/clip-cutter-client.js).
// Multi-select persona picker. User can:
//  - Click a card to toggle selection
//  - "Pick" button: set first selected as activePersona (single-pick)
//  - "Send N to chat": types the persona names into the chat input so agent
//    can use them in next gen (e.g. "bikin video dengan Kevin, Marcus, Eric")
//  - "Clear" resets selection
function PersonaListPicker({ result, onPersonaPick, onAction }) {
  const [selected, setSelected] = useState(new Set())
  const toggle = (id) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const personas = result.personas || []
  const pickedList = personas.filter((p) => selected.has(p.id))
  const hasSelection = pickedList.length > 0

  function setAsActive() {
    if (!pickedList[0]) return
    onPersonaPick?.(pickedList[0])
    if (pickedList.length > 1) {
      // Surface multi-select via chat input
      onAction?.({
        type: 'compose-prompt',
        text: `Pake personas ini buat shots berikutnya: ${pickedList.map((p) => p.name).join(', ')}. Set ${pickedList[0].name} sebagai active dulu, sisanya disebut di prompt biar agent rotate.`,
      })
    }
  }
  function sendToChat() {
    onAction?.({
      type: 'compose-prompt',
      text: `Bikin video pake ${pickedList.length} persona ini sebagai talents: ${pickedList.map((p) => `${p.name} (@${p.username})`).join(', ')}. Rotate per shot.`,
    })
  }

  return (
    <div className="mt-3">
      {personas.length === 0 ? (
        <div className="text-xs text-[var(--muted2)]">Belum ada persona di brand ini. Bikin dulu di <Link href="/personas" className="underline">/personas</Link></div>
      ) : (
        <>
          <div className="text-[10px] uppercase text-[var(--muted)] mb-1.5 flex items-center justify-between">
            <span>{personas.length} personas — tap to multi-select</span>
            {hasSelection && (
              <span className="text-[var(--accent)] font-bold">{pickedList.length} picked</span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
            {personas.map((p) => {
              const isOn = selected.has(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  className={`flex items-center gap-2 rounded p-2 text-left transition-all ${
                    isOn
                      ? 'bg-[var(--accent)]/15 border border-[var(--accent)] shadow-[0_0_12px_var(--accent-soft)]'
                      : 'bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--surface2)]'
                  }`}>
                  <div className="relative shrink-0">
                    {p.avatar_url ? <img src={p.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-[var(--surface2)] flex items-center justify-center text-xs">{p.name?.[0]}</div>}
                    {isOn && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-[var(--accent)] text-white text-[9px] font-bold rounded-full flex items-center justify-center shadow-md">✓</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold truncate">{p.name}</div>
                    <div className="text-[10px] text-[var(--muted2)] truncate">@{p.username || '—'}</div>
                    {p.lora_url && <div className="text-[9px] text-[var(--accent)]">🧬 Soul trained</div>}
                  </div>
                </button>
              )
            })}
          </div>
          {hasSelection && (
            <div className="mt-2 flex gap-1.5 items-center text-[11px]">
              <button
                onClick={setAsActive}
                className="px-3 py-1.5 rounded bg-[var(--accent)] hover:bg-[var(--accent-bright)] text-white font-semibold">
                ★ Set {pickedList[0]?.name} active
              </button>
              {pickedList.length > 1 && (
                <button
                  onClick={sendToChat}
                  className="px-3 py-1.5 rounded bg-[var(--surface2)] border border-[var(--accent)]/40 hover:bg-[var(--accent-soft)] font-semibold">
                  💬 Send {pickedList.length} to chat
                </button>
              )}
              <button
                onClick={() => setSelected(new Set())}
                className="px-2 py-1.5 rounded text-[var(--muted)] hover:text-white hover:bg-[var(--surface2)]">
                Clear
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ViralClipPending({ result }) {
  const [status, setStatus] = useState('init')
  const [progress, setProgress] = useState('')
  const [completed, setCompleted] = useState([])
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    async function run() {
      try {
        setStatus('loading-ffmpeg')
        setProgress('Loading ffmpeg.wasm (~10s first run, then cached)...')
        // Lazy import — these are heavy + only used here.
        const { cutClipClientSide } = await import('@/lib/clip-cutter-client')
        const { uploadFile } = await import('@/lib/upload-client')

        const out = []
        for (let i = 0; i < result.clips.length; i++) {
          const clip = result.clips[i]
          setStatus('cutting')
          setProgress(`Cutting clip ${i + 1}/${result.clips.length} — ${clip.preset?.toUpperCase() || 'CUSTOM'} ${clip.duration}s...`)
          try {
            const blob = await cutClipClientSide(result.source, {
              start: clip.start, duration: clip.duration, preset: clip.preset,
              onLog: () => { /* swallow per-frame logs */ },
            })
            setProgress(`Uploading clip ${i + 1}/${result.clips.length} to R2...`)
            // Wrap Blob as File so uploadFile gets a name.
            const file = new File(
              [blob],
              `${clip.preset || 'clip'}-${clip.start}s-${clip.duration}s.mp4`,
              { type: 'video/mp4' }
            )
            const { url } = await uploadFile(file, 'viral-clips')
            const completedClip = { ok: true, ...clip, url, size_mb: (blob.size / 1024 / 1024).toFixed(1) }
            out.push(completedClip)
            setCompleted([...out])
          } catch (e) {
            out.push({ ok: false, ...clip, error: String(e?.message || e) })
            setCompleted([...out])
          }
        }
        setStatus('done')
        setProgress('')
      } catch (e) {
        setStatus('failed')
        setProgress(String(e?.message || e))
      }
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase font-bold text-[var(--accent)]">
          ✂ Viral Clip Cutter · client-side
        </div>
        <div className="text-[10px] text-[var(--muted)]">
          {status === 'done' ? `${completed.filter((c) => c.ok).length}/${result.clips.length} done` : `${completed.length}/${result.clips.length}`}
        </div>
      </div>

      {status !== 'done' && status !== 'failed' && (
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
          {progress}
        </div>
      )}
      {status === 'failed' && (
        <div className="text-xs text-red-400">{progress}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {result.clips.map((clip, i) => {
          const done = completed[i]
          return (
            <div
              key={i}
              className={`rounded p-2 border text-[11px] ${
                !done ? 'bg-[var(--surface2)] border-[var(--border)] opacity-50' :
                done.ok ? 'bg-[var(--surface2)] border-[var(--border)]' :
                'bg-red-500/10 border-red-500/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-bold truncate">
                  {clip.preset && <span className="text-[var(--accent)]">{clip.preset.toUpperCase()}</span>} {clip.label}
                </div>
                <div className="text-[10px] text-[var(--muted)] tabular-nums shrink-0">
                  {clip.start}s + {clip.duration}s
                </div>
              </div>
              {done?.ok && done.url ? (
                <>
                  <video src={done.url} controls preload="metadata" className="mt-1 w-full rounded bg-black aspect-video object-contain" />
                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    <a href={done.url} target="_blank" rel="noreferrer" download className="text-[var(--accent)] hover:underline">↓ Download mp4</a>
                    <span className="text-[var(--muted2)]">· {done.size_mb}MB · stored R2</span>
                  </div>
                </>
              ) : done?.ok === false ? (
                <div className="text-[10px] text-red-400 mt-1">{done.error}</div>
              ) : (
                <div className="text-[10px] text-[var(--muted2)] mt-1">waiting...</div>
              )}
            </div>
          )
        })}
      </div>

      <div className="text-[10px] text-[var(--muted2)] italic">
        Cut di browser pakai ffmpeg.wasm. Hasil otomatis ke-upload ke R2 (permanent storage).
      </div>
    </div>
  )
}

function ViralClipResult({ result }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase font-bold text-[var(--accent)]">
          ✂ Viral Clip Cuts · {result.count}/{result.count + result.failed} success
        </div>
        {result.failed > 0 && (
          <div className="text-[10px] text-red-400">{result.failed} failed</div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(result.clips || []).map((c, i) => (
          <div
            key={i}
            className={`rounded p-2 border text-[11px] ${c.ok ? 'bg-[var(--surface2)] border-[var(--border)]' : 'bg-red-500/10 border-red-500/30'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold truncate">
                {c.preset && <span className="text-[var(--accent)]">{c.preset.toUpperCase()}</span>} {c.label || `Clip ${i + 1}`}
              </div>
              <div className="text-[10px] text-[var(--muted)] tabular-nums shrink-0">
                {c.start}s + {c.duration}s
              </div>
            </div>
            {c.ok && c.url ? (
              <>
                <video src={c.url} controls preload="metadata" className="mt-1 w-full rounded bg-black aspect-video object-contain" />
                <a
                  href={c.url} target="_blank" rel="noreferrer"
                  download
                  className="inline-block mt-1 text-[10px] text-[var(--accent)] hover:underline"
                >
                  ↓ Download mp4
                </a>
              </>
            ) : (
              <div className="text-[10px] text-red-400 mt-1">{c.error}</div>
            )}
          </div>
        ))}
      </div>
      <div className="text-[10px] text-[var(--muted2)] italic">
        Note: clips di-cache di v2 backend (HF Space) — file mungkin di-evict setelah beberapa jam. Buat permanent storage, download + upload ulang ke R2.
      </div>
    </div>
  )
}

function ViralAdCampaignResult({ result }) {
  const top3 = new Set(result.top_3_ids || [])
  const fp = result.final_package || {}
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 space-y-4">
      <div className="text-[10px] uppercase font-bold text-[var(--accent)]">🚀 Viral Ad Campaign · {result.n_concepts} concepts scored</div>

      {/* Scored concepts table */}
      <div>
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">📊 Scored concepts (top 3 highlighted)</div>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {(result.concepts || []).map((c, i) => {
            const s = (result.scored_concepts || []).find((x) => x.id === c.id) || {}
            const isTop = top3.has(c.id)
            return (
              <div
                key={c.id || i}
                className={`text-[11px] rounded p-2 border ${isTop ? 'bg-[var(--accent)]/10 border-[var(--accent)]/40' : 'bg-[var(--surface2)] border-[var(--border)]'}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-bold truncate">{isTop ? '⭐ ' : ''}{c.name || c.id}</div>
                  <div className="text-[10px] tabular-nums text-[var(--muted)] shrink-0">
                    H:{s.hook_score || 0} · R:{s.retention_score || 0} · C:{s.conversion_score || 0} · <span className="text-[var(--accent)] font-bold">{s.overall || 0}</span>
                  </div>
                </div>
                <div className="text-[10px] text-[var(--muted)] mt-0.5">{c.hook_type} · {c.format}</div>
                <div className="text-[11px] mt-0.5">{c.one_line_pitch}</div>
                {s.why_it_works && <div className="text-[10px] text-[var(--muted2)] italic mt-0.5">→ {s.why_it_works}</div>}
              </div>
            )
          })}
        </div>
      </div>

      {/* Final production package */}
      {fp && (
        <div className="border-t border-[var(--border)] pt-3 space-y-2">
          <div className="text-[10px] uppercase font-bold text-[var(--accent)]">🎬 Final production package — combining strongest elements</div>
          <div className="text-sm font-bold">{fp.title}</div>
          <div className="text-[10px] text-[var(--muted)]">{fp.duration_seconds}s · {fp.music_mood}</div>

          {fp.hook && (
            <div className="bg-[var(--surface2)] rounded p-2 text-[11px]">
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-0.5">⚡ Hook (first 1-3 sec)</div>
              {fp.hook}
            </div>
          )}

          {Array.isArray(fp.storyboard) && fp.storyboard.length > 0 && (
            <div>
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-1">🎞 Storyboard ({fp.storyboard.length} shots)</div>
              <div className="space-y-1">
                {fp.storyboard.map((s, i) => (
                  <div key={i} className="bg-[var(--surface2)] rounded p-2 text-[10px] leading-relaxed">
                    <div className="font-bold">Shot {s.shot} · {s.duration_s}s · {s.camera}</div>
                    <div className="mt-0.5"><span className="text-[var(--muted)]">Visual:</span> {s.visual}</div>
                    {s.voiceover && <div><span className="text-[var(--muted)]">VO:</span> "{s.voiceover}"</div>}
                    {s.on_screen_text && <div><span className="text-[var(--muted)]">Text:</span> {s.on_screen_text}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {fp.voiceover_full && (
            <div className="bg-[var(--surface2)] rounded p-2 text-[11px]">
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-0.5">🎙 Voiceover (full)</div>
              <div className="whitespace-pre-wrap leading-relaxed">{fp.voiceover_full}</div>
            </div>
          )}

          {fp.on_screen_text_full && (
            <div className="bg-[var(--surface2)] rounded p-2 text-[11px]">
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-0.5">📝 On-screen text</div>
              <div className="whitespace-pre-wrap leading-relaxed">{fp.on_screen_text_full}</div>
            </div>
          )}

          {fp.cta && (
            <div className="bg-[var(--surface2)] rounded p-2 text-[11px]">
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-0.5">🎯 CTA</div>
              {fp.cta}
            </div>
          )}

          {Array.isArray(fp.visual_reference_prompts) && fp.visual_reference_prompts.length > 0 && (
            <div className="bg-[var(--surface2)] rounded p-2 text-[11px]">
              <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-0.5">🎨 Visual reference prompts</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {fp.visual_reference_prompts.map((v, i) => <li key={i}>{v}</li>)}
              </ul>
            </div>
          )}

          {fp.why_this_combo && (
            <div className="text-[10px] italic text-[var(--muted)] border-l-2 border-[var(--accent)] pl-2">
              💡 {fp.why_this_combo}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BrandBuilderResult({ result }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="text-xs">
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">🎯 Niche analysis</div>
        <div className="text-[var(--text)] leading-relaxed">{result.niche_analysis}</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">🏷 Brand name suggestions</div>
          <div className="space-y-0.5">
            {result.brand_name_suggestions?.map((n, i) => (
              <div key={i} className="text-xs font-bold text-[var(--accent)]">• {n}</div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">📣 Taglines</div>
          <div className="space-y-0.5">
            {result.tagline_suggestions?.map((t, i) => (
              <div key={i} className="text-xs italic">"{t}"</div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">🎨 Brand voice</div>
          <div className="text-xs">{result.brand_voice}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">🎨 Color palette</div>
          <div className="flex gap-1">
            {result.color_palette?.map((c, i) => (
              <div key={i} className="flex items-center gap-1 text-[10px] font-mono">
                <div className="w-5 h-5 rounded border border-[var(--border)]" style={{ backgroundColor: c }} />
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">📦 Product concept</div>
        <div className="text-xs leading-relaxed">{result.product_concept}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">👥 Target audience</div>
        <div className="text-xs leading-relaxed">{result.target_audience}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">📸 Listing photo prompts (click ✨ to gen)</div>
        <div className="space-y-1">
          {result.listing_photo_prompts?.map((p, i) => (
            <div key={i} className="bg-[var(--surface2)] border border-[var(--border)] rounded p-2 text-[11px] italic">
              "{p}"
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">🎬 Hero video naskah</div>
        <div className="bg-[var(--surface2)] border border-[var(--border)] rounded p-2 text-[11px] whitespace-pre-wrap leading-relaxed">
          {result.hero_video_naskah}
        </div>
      </div>
      {result.marketing_angles?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-1">📈 Marketing angles</div>
          <div className="space-y-0.5">
            {result.marketing_angles.map((a, i) => <div key={i} className="text-xs">• {a}</div>)}
          </div>
        </div>
      )}
    </div>
  )
}

function MassVariantsResult({ result }) {
  const ok = result.variants?.filter((v) => v && !v.error) || []
  const failed = result.variants?.filter((v) => v?.error) || []
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div>
          <span className="font-bold">🏭 Mass variants</span>
          {result.product_label && <span className="text-[var(--muted)]"> · {result.product_label}</span>}
        </div>
        <div className="text-[10px] text-[var(--muted2)]">
          {ok.length}/{result.requested} generated{failed.length > 0 && ` · ${failed.length} failed`}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {ok.map((v) => (
          <div key={v.index} className="bg-[var(--surface2)] border border-[var(--border)] rounded overflow-hidden">
            <a href={v.url} target="_blank" rel="noreferrer">
              <img src={v.url} alt={v.scene} className="w-full aspect-square object-cover hover:opacity-80" />
            </a>
            <div className="p-1.5 text-[9px] text-[var(--muted2)]">
              <div className="font-bold text-[var(--text)] truncate">{v.hook}</div>
              <div className="truncate">{v.scene}</div>
            </div>
          </div>
        ))}
      </div>
      {failed.length > 0 && (
        <details className="text-[10px] text-red-400">
          <summary className="cursor-pointer">⚠ {failed.length} failed</summary>
          <div className="mt-1 space-y-0.5">
            {failed.map((v, i) => (
              <div key={i}>variant {v.index + 1} ({v.scene}): {v.error}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function GenImageResult({ result, onAction }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-hidden">
      <img src={result.url} alt="generated" className="w-full max-h-[400px] object-contain bg-black" />
      <div className="p-2 space-y-1.5">
        <div className="flex gap-1.5 text-[10px] text-[var(--muted2)] flex-wrap">
          {result.model && <span>🎨 {result.model.split('/').pop()}</span>}
          {result.ar && <span>📐 {result.ar}</span>}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => onAction?.('continue_shot', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/30 border border-[var(--accent)]/60 text-white font-bold hover:bg-[var(--accent)]/50">🎬 Continue</button>
          <button type="button" onClick={() => onAction?.('animate', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold">▶ Animate</button>
          <button type="button" onClick={() => onAction?.('regen_image', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">↻ Regenerate</button>
          <button type="button" onClick={() => onAction?.('predict_virality', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] cursor-pointer">📊 Score</button>
          <a href={result.url} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">⬇ Download</a>
          {result.result_id && <Link href={`/qc#${result.result_id}`} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)]">🧪 QC</Link>}
        </div>
      </div>
    </div>
  )
}

function GenVideoResult({ result, onAction }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-hidden">
      <video src={result.url} controls className="w-full max-h-[500px] bg-black" />
      <div className="p-2 space-y-1.5">
        <div className="flex gap-1.5 text-[10px] text-[var(--muted2)] flex-wrap">
          {result.model && <span>🎬 {result.model.split('/').pop()}</span>}
          {result.ar && <span>📐 {result.ar}</span>}
          {result.duration && <span>⏱ {result.duration}s</span>}
          {result.audio !== undefined && <span>🔊 {result.audio ? 'audio' : 'silent'}</span>}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => onAction?.('continue_shot', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/30 border border-[var(--accent)]/60 text-white font-bold hover:bg-[var(--accent)]/50">🎬 Continue</button>
          <button type="button" onClick={() => onAction?.('regen_video', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold">↻ Regenerate</button>
          <button type="button" onClick={() => onAction?.('predict_virality', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)] cursor-pointer">📊 Score</button>
          <a href={result.url} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">⬇ Download</a>
          {result.result_id && <Link href={`/qc#${result.result_id}`} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)]">🧪 QC</Link>}
          {result.result_id && <Link href={`/editor`} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)]">✂ Editor</Link>}
        </div>
      </div>
    </div>
  )
}

// Video gen returned queued (didn't complete in 30s inline poll). Auto-poll
// /api/god-mode/gen-status every 5s and swap to GenVideoResult when ready.
function GenVideoQueued({ result, onResolved }) {
  const [status, setStatus] = useState('queued')
  const [resolved, setResolved] = useState(null)
  const [err, setErr] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [falStatus, setFalStatus] = useState('')
  const cancelRef = useRef(false)
  const timerRef = useRef(null)

  const checkOnce = async () => {
    if (cancelRef.current) return
    setAttempts((n) => n + 1)
    try {
      // Forward status_url + response_url if present — gen-status uses
      // these directly (authoritative, no path-guessing). See
      // src/lib/fal-paths.js for the alias→canonical bug story.
      const qs = new URLSearchParams({
        request_id: result.request_id,
        model: result.model,
        ar: result.ar || '',
        duration: String(result.duration || ''),
        motion: result.motion || '',
        persona_id: result.persona_id || '',
        ...(result.status_url ? { status_url: result.status_url } : {}),
        ...(result.response_url ? { response_url: result.response_url } : {}),
      })
      const r = await fetch(`/api/god-mode/gen-status?${qs}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({ ok: false, error: 'non-json response' }))
      if (cancelRef.current) return
      if (j.ok && j.status === 'done') {
        setStatus('done'); setResolved(j); onResolved?.(j); return true
      }
      if (j.ok && j.status === 'failed') {
        setStatus('failed'); setErr(j.error || 'gen failed'); return true
      }
      if (!j.ok) {
        // Endpoint error — surface it instead of silently looping forever.
        setErr(j.error || `gen-status returned ok:false`)
      } else {
        setErr('')
        if (j.fal_status) setFalStatus(j.fal_status)
      }
      return false
    } catch (e) {
      if (!cancelRef.current) setErr(e.message)
      return false
    }
  }

  useEffect(() => {
    cancelRef.current = false
    let localAttempts = 0
    const loop = async () => {
      if (cancelRef.current) return
      localAttempts++
      const done = await checkOnce()
      if (done || cancelRef.current) return
      // Cap polling at 120 attempts. With 5s base interval + background-tab
      // throttling, this can span up to ~2hrs in inactive tabs (Chrome
      // throttles setTimeout to ~1/min in background). User can also click
      // "Check now" to force-refresh manually.
      if (localAttempts > 120) { setStatus('timeout'); setErr('Polling timeout — klik "Check now" buat retry.'); return }
      timerRef.current = setTimeout(loop, 5000)
    }
    loop()

    // Re-check immediately when tab becomes visible — Chrome throttles
    // setTimeout to once per minute in background tabs, so the user might
    // come back to a stale spinner even though fal is long done.
    const onVis = () => {
      if (document.visibilityState === 'visible' && !cancelRef.current && !resolved) {
        if (timerRef.current) clearTimeout(timerRef.current)
        loop()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.request_id])

  if (resolved) return <GenVideoResult result={resolved} />
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
        <div className="text-xs font-bold">
          {status === 'queued' ? 'Video gen di fal.ai queue...' : status === 'failed' ? 'Gen failed' : status === 'timeout' ? 'Polling timeout' : 'Gen done'}
        </div>
      </div>
      <div className="text-[10px] text-[var(--muted2)] mt-1">
        Model: {result.model?.split('/').pop()} · {result.ar} · {result.duration}s
      </div>
      <div className="text-[10px] text-[var(--muted)] mt-2 flex items-center gap-2 flex-wrap">
        <span>Attempt {attempts}{falStatus ? ` · fal: ${falStatus}` : ''}</span>
        <button
          onClick={checkOnce}
          className="px-2 py-0.5 text-[10px] rounded border border-[var(--border)] hover:bg-[var(--surface2)]"
        >
          ↻ Check now
        </button>
      </div>
      <div className="text-[10px] text-[var(--muted)] mt-1">Lo bisa keep chatting — auto-updates di sini saat selesai.</div>
      {err && <div className="text-[10px] text-red-400 mt-1">⚠ {err}</div>}
    </div>
  )
}

function UrlMarketingProposal({ result }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-3">
        {result.image && <img src={result.image} alt="" className="w-20 h-20 object-cover rounded border border-[var(--border)]" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold truncate">{result.title || 'Product'}</div>
          {result.price && <div className="text-xs text-[var(--accent)] mt-0.5">{result.price}</div>}
          {result.description && <div className="text-[11px] text-[var(--muted)] mt-1 line-clamp-3">{result.description}</div>}
        </div>
      </div>
      {result.naskah && (
        <div className="bg-[var(--surface2)] border border-[var(--border)] rounded p-2 text-[11px] whitespace-pre-wrap leading-relaxed">
          <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-1">📝 Suggested naskah</div>
          {result.naskah}
        </div>
      )}
    </div>
  )
}

function VideoAnalysisCard({ result }) {
  const fields = [
    ['Style', result.style],
    ['Camera', result.camera],
    ['Mood', result.mood],
    ['Pacing', result.pacing],
    ['Character notes', result.character_notes],
    ['Suggested model', result.suggested_model],
    ['Replication strategy', result.replication_strategy],
  ]
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 space-y-1.5">
      {fields.filter(([_, v]) => v).map(([k, v]) => (
        <div key={k} className="text-[11px]">
          <span className="font-bold text-[var(--muted)]">{k}:</span>{' '}
          <span className="text-[var(--text)]">{v}</span>
        </div>
      ))}
    </div>
  )
}

function ViralityScoreCard({ result }) {
  const Bar = ({ label, value }) => (
    <div className="mb-1">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="text-[var(--muted)]">{label}</span>
        <span className="font-bold">{value}/100</span>
      </div>
      <div className="h-1.5 bg-[var(--surface2)] rounded overflow-hidden">
        <div
          className={`h-full ${value >= 75 ? 'bg-green-500' : value >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs font-bold">Virality score</div>
        <div className={`text-2xl font-bold ${result.overall >= 75 ? 'text-green-400' : result.overall >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
          {result.overall}<span className="text-xs text-[var(--muted)]">/100</span>
        </div>
      </div>
      <Bar label="Hook strength" value={result.hook || 0} />
      <Bar label="Retention" value={result.retention || 0} />
      <Bar label="Visual impact" value={result.visual || 0} />
      {Array.isArray(result.advice) && result.advice.length > 0 && (
        <div className="bg-[var(--surface2)] border border-[var(--border)] rounded p-2 mt-2">
          <div className="text-[9px] uppercase font-bold text-[var(--muted)] mb-1">💡 Improvement tips</div>
          <ul className="text-[11px] space-y-0.5">
            {result.advice.map((tip, i) => <li key={i}>• {tip}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

function ConfigPill({ label, value }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-1 bg-[var(--surface2)] border border-[var(--border)] rounded-full px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
      <span>{label}</span>
      <span className="text-[var(--text)] font-mono">{value}</span>
    </span>
  )
}

function ConfigSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase font-bold text-[var(--muted)] mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-xs px-2 py-1.5 rounded bg-[var(--surface2)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}

function shortModelLabel(models, modelId) {
  const m = models.find((x) => x.v === modelId)
  if (!m) return modelId.split('/').pop()
  // Strip pricing info from label like "Grok Imagine — ~$0.07/dtk 720p (audio)"
  return m.l.split('—')[0].trim()
}

function SoulTrainingResult({ result }) {
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3">
      {result.status === 'training' && (
        <div className="text-xs">
          ⏳ Training Soul untuk <strong>{result.persona_name}</strong>...
          <div className="text-[10px] text-[var(--muted2)] mt-1">
            Trigger word: <code className="bg-[var(--surface2)] px-1 rounded">{result.trigger_word}</code>
          </div>
          <div className="text-[10px] text-[var(--muted2)] mt-1">
            Estimasi: 3-5 menit. Lo bisa keep chatting; agent bakal update kalau udah selesai.
          </div>
        </div>
      )}
      {result.status === 'done' && (
        <div className="text-xs">
          ✓ Soul training done untuk <strong>{result.persona_name}</strong>!
          <div className="text-[10px] text-[var(--muted2)] mt-1">
            Trigger: <code className="bg-[var(--surface2)] px-1 rounded">{result.trigger_word}</code>
          </div>
          <div className="text-[10px] mt-1">
            Sekarang generate apapun yang mention persona ini akan pake Soul LoRA = karakter 95%+ konsisten.
          </div>
        </div>
      )}
      {result.status === 'failed' && (
        <div className="text-xs text-red-400">⚠ Training gagal: {result.error}</div>
      )}
    </div>
  )
}

function PresetCards({ presets, compact = false, onUse }) {
  const [copied, setCopied] = useState(null)
  return (
    <div className={`mt-2 space-y-1.5 ${compact ? '' : ''}`}>
      {presets.map((p) => (
        <div key={p.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 group hover:border-[var(--accent)]/40 transition-colors">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">{p.label}</div>
              <div className="text-[11px] text-[var(--muted)] mt-0.5">{p.desc}</div>
              <div className="text-[10px] text-[var(--muted2)] mt-1.5 italic line-clamp-2">"{p.prompt}"</div>
            </div>
            <div className="flex flex-col gap-1 flex-shrink-0">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(p.prompt)
                  setCopied(p.id)
                  setTimeout(() => setCopied(null), 1500)
                }}
                className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] hover:bg-[var(--accent)]/20 border border-[var(--border)] whitespace-nowrap">
                {copied === p.id ? '✓ Copied' : '📋 Copy'}
              </button>
              {onUse && (
                <button
                  onClick={() => onUse(p)}
                  className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold whitespace-nowrap text-center">
                  🎥 Lock preset
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
