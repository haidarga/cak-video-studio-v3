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

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/god-mode/conversations')
      const j = await res.json()
      if (j.ok) setHistoryList(j.conversations || [])
    } catch (e) {
      console.warn('[god-mode] history load failed:', e.message)
    }
    setHistoryLoading(false)
  }

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
      for (const file of Array.from(files).slice(0, 5)) { // cap at 5 per send
        const form = new FormData()
        form.append('file', file)
        form.append('folder', 'god-mode-attachments')
        const res = await fetch('/api/upload', { method: 'POST', body: form })
        const j = await res.json()
        if (!j.ok) throw new Error(j.error || 'upload failed')
        setPendingAttachments((prev) => [...prev, {
          type: file.type.startsWith('image/') ? 'image' : 'file',
          url: j.url,
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
  // animate from image, score virality). Translates the click into a chat
  // message so the existing send() pipeline handles it.
  async function handleResultAction(action, result) {
    if (action === 'regen_image') {
      const p = result.regen_payload || {}
      await send(`Regenerate ulang gambar barusan${p.prompt ? `: ${p.prompt}` : ''}`)
    } else if (action === 'regen_video') {
      const p = result.regen_payload || {}
      await send(`Regenerate ulang video barusan${p.motion_prompt ? `: ${p.motion_prompt}` : ''}`)
    } else if (action === 'animate') {
      // Animate the image — send instruction to gen_video with image_url.
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
          throw new Error(`Agent timeout (${res.status}). Video gen kemungkinan masih jalan di fal.ai server-side — coba "cek status gen terakhir" untuk poll hasilnya, atau tunggu 2-3 menit lalu refresh.`)
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
    { label: '🎥 Browse cinematic presets', prompt: 'Tampilkan semua cinematic presets yang ada, group by category' },
    { label: '🎯 Bullet time effect', prompt: 'Bikin preset bullet time effect untuk produk' },
    { label: '📦 Product 360 spin', prompt: 'Suggest preset untuk product 360 degree spin showcase' },
    { label: '👥 List personas', prompt: 'List semua persona yang ada di workspace ini' },
    { label: '🛒 List produk', prompt: 'List semua produk yang udah ada di workspace' },
  ]

  return (
    <div className="max-w-4xl mx-auto">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-3xl">🔥</span>
            <h1 className="text-3xl font-bold">God Mode</h1>
            <span className="text-[10px] uppercase font-bold bg-[var(--accent)]/20 text-[var(--accent)] px-2 py-0.5 rounded">Beta</span>
          </div>
          <p className="text-sm text-[var(--muted)]">
            Conversational AI agent — describe what you want, the agent picks the right tool. Built on top of {personas.length} personas + {productRefs.length} products + 28 cinematic presets.
          </p>
          {activeBrand && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] uppercase font-semibold text-[var(--accent)] bg-[var(--accent)]/10 px-2 py-1 rounded border border-[var(--accent)]/30">
              🏷 brand: {activeBrand.name}
            </div>
          )}
        </div>
        {/* Conversation controls — new chat + history toggle. Compact icon
            buttons so the header doesn't compete with content. */}
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={newConversation}
            title="Start new conversation"
            className="text-xs px-3 py-2 rounded-lg bg-[var(--surface2)] border border-[var(--border)] hover:border-[var(--accent)]/40 font-semibold">
            + New
          </button>
          <button
            onClick={() => { setShowHistory((s) => !s); if (!showHistory) loadHistory() }}
            title="Show conversation history"
            className={`text-xs px-3 py-2 rounded-lg border font-semibold ${showHistory ? 'bg-[var(--accent)]/20 border-[var(--accent)]/50 text-[var(--accent)]' : 'bg-[var(--surface2)] border-[var(--border)] hover:border-[var(--accent)]/40'}`}>
            🕐 History
          </button>
        </div>
      </header>

      {/* History panel — slides above chat when toggled. Shows recent
          conversations with click-to-resume + delete affordance. */}
      {showHistory && (
        <div className="mb-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 max-h-72 overflow-y-auto">
          <div className="text-[10px] uppercase font-bold text-[var(--muted)] mb-2 px-1">
            Recent conversations {historyLoading && '· loading...'}
          </div>
          {historyList.length === 0 && !historyLoading && (
            <div className="text-xs text-[var(--muted2)] px-1 py-2">Belum ada conversation tersimpan.</div>
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
          accept="image/*,video/*,application/pdf,.txt,.csv,.json"
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
    return (
      <div className="mt-3">
        {result.personas.length === 0 ? (
          <div className="text-xs text-[var(--muted2)]">Belum ada persona di brand ini. Bikin dulu di <Link href="/personas" className="underline">/personas</Link></div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
            {result.personas.map((p) => (
              <button
                key={p.id}
                onClick={() => onPersonaPick && onPersonaPick(p)}
                className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded p-2 hover:border-[var(--accent)]/50 hover:bg-[var(--surface2)] text-left">
                {p.avatar_url ? <img src={p.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-[var(--surface2)] flex items-center justify-center text-xs">{p.name?.[0]}</div>}
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{p.name}</div>
                  <div className="text-[10px] text-[var(--muted2)] truncate">@{p.username || '—'}</div>
                  {p.lora_url && <div className="text-[9px] text-[var(--accent)]">🧬 Soul trained</div>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
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
  return null
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
          <button onClick={() => onAction?.('animate', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold">🎬 Animate</button>
          <button onClick={() => onAction?.('regen_image', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">↻ Regenerate</button>
          <button onClick={() => onAction?.('predict_virality', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">📊 Score</button>
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
          <button onClick={() => onAction?.('regen_video', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold">↻ Regenerate</button>
          <button onClick={() => onAction?.('predict_virality', result)} className="text-[10px] px-2 py-1 rounded bg-[var(--surface2)] border border-[var(--border)] hover:bg-[var(--border)]">📊 Score</button>
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

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    async function poll() {
      if (cancelled) return
      attempts++
      try {
        const qs = new URLSearchParams({
          request_id: result.request_id,
          model: result.model,
          ar: result.ar || '',
          duration: String(result.duration || ''),
          motion: result.motion || '',
          persona_id: result.persona_id || '',
        })
        const r = await fetch(`/api/god-mode/gen-status?${qs}`)
        const j = await r.json()
        if (cancelled) return
        if (j.ok && j.status === 'done') {
          setStatus('done')
          setResolved(j)
          onResolved?.(j)
          return
        }
        if (j.ok && j.status === 'failed') {
          setStatus('failed'); setErr(j.error || 'gen failed'); return
        }
        // Cap polling at 60 attempts (5 min). After that user can reload page.
        if (attempts > 60) { setStatus('timeout'); setErr('Polling timeout — refresh page to retry'); return }
        setTimeout(poll, 5000)
      } catch (e) {
        if (!cancelled) { setErr(e.message); setStatus('failed') }
      }
    }
    poll()
    return () => { cancelled = true }
  }, [result.request_id])

  if (resolved) return <GenVideoResult result={resolved} />
  return (
    <div className="mt-3 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
        <div className="text-xs font-bold">
          {status === 'queued' ? 'Video gen di fal.ai queue...' : status === 'failed' ? 'Gen failed' : 'Gen done'}
        </div>
      </div>
      <div className="text-[10px] text-[var(--muted2)] mt-1">
        Model: {result.model?.split('/').pop()} · {result.ar} · {result.duration}s
      </div>
      <div className="text-[10px] text-[var(--muted)] mt-2">
        Polling every 5s. Auto-updates di sini saat selesai. Lo bisa keep chatting.
      </div>
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
