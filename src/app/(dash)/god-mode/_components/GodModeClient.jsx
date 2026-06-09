'use client'
// GOD MODE chatroom — Higgsfield-inspired conversational interface for
// generating videos. User types intent → AI agent picks tool → renders
// structured response (text + optional preset card / persona list /
// product picker / etc) inline in the chat.
//
// Phase 0 ships:
//  - Chatroom UI shell (messages, input, send)
//  - Tool result renderers (cinematic presets, persona list, product list)
//  - Quick-access pills above input (one-click into common flows)
//
// Future phases plug new tools into the backend agent route and add
// renderers here; the chatroom shell stays the same.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

export default function GodModeClient({ workspaceId, userId, activeBrand, personas = [], refs = [] }) {
  const productRefs = refs.filter((r) => r.kind === 'product')
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: `Halo bro 👋 Gua GOD MODE — agent yang bantu lo bikin video cinematic dari ide. Tulis aja bahasa biasa: "bikin video product review", "kasih preset bullet time", "list persona yang ada", dll. Atau klik quick action di bawah.`,
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const scrollRef = useRef(null)

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, busy])

  async function send(textOverride) {
    const text = (textOverride ?? input).trim()
    if (!text || busy) return
    setErr('')
    const newUser = { role: 'user', content: text }
    const conversation = [...messages, newUser]
    setMessages(conversation)
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/god-mode/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          messages: conversation.map((m) => ({ role: m.role, content: m.content })),
          activeBrand,
          personaCount: personas.length,
          productCount: productRefs.length,
        }),
      })
      const j = await res.json()
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
      <header className="mb-5">
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
      </header>

      {/* Chat scroll area */}
      <div
        ref={scrollRef}
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 mb-3 overflow-y-auto"
        style={{ height: 'calc(100vh - 320px)', minHeight: 400 }}
      >
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} personas={personas} />
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

      {/* Input */}
      <form
        onSubmit={(e) => { e.preventDefault(); send() }}
        className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tulis instruksi… misal: bikin preset push-in dramatic untuk wajah Tandy"
          disabled={busy}
          className="flex-1 text-sm px-4 py-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-5 py-3 rounded-lg bg-[var(--accent)] text-white font-bold text-sm hover:opacity-90 disabled:opacity-40">
          ↑ Send
        </button>
      </form>
    </div>
  )
}

function MessageBubble({ msg, personas }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-[var(--accent)] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
          {msg.content}
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
          {msg.toolResult && <ToolResult result={msg.toolResult} personas={personas} />}
        </div>
      </div>
    </div>
  )
}

function ToolResult({ result, personas }) {
  if (!result || result.type === 'error') {
    return <div className="mt-3 text-xs text-red-400">⚠ {result?.error || 'tool failed'}</div>
  }
  if (result.type === 'cinematic_preset_suggestions') {
    return <PresetCards presets={result.suggestions} compact />
  }
  if (result.type === 'cinematic_preset_library') {
    return (
      <div className="mt-3 space-y-3">
        {result.categories.map((cat) => (
          cat.presets?.length > 0 && (
            <div key={cat.id}>
              <div className="text-[11px] font-semibold mb-1 text-[var(--muted)]">{cat.label}</div>
              <PresetCards presets={cat.presets} compact />
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
              <div key={p.id} className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded p-2">
                {p.avatar_url ? <img src={p.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-[var(--surface2)] flex items-center justify-center text-xs">{p.name?.[0]}</div>}
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{p.name}</div>
                  <div className="text-[10px] text-[var(--muted2)] truncate">@{p.username || '—'}</div>
                </div>
              </div>
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
              <div key={p.id} className="bg-[var(--surface)] border border-[var(--border)] rounded p-1.5">
                <img src={p.fal_url} alt={p.label} className="w-full aspect-square object-cover rounded" />
                <div className="text-[10px] font-semibold mt-1 truncate">{p.label}</div>
                {p.knowledge && <div className="text-[9px] text-[var(--muted2)] truncate" title={p.knowledge}>📋 has knowledge</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  return null
}

function PresetCards({ presets, compact = false }) {
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
              <Link
                href={`/generate?preset=${p.id}`}
                className="text-[10px] px-2 py-1 rounded bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30 border border-[var(--accent)]/40 text-[var(--accent)] font-semibold whitespace-nowrap text-center">
                Use →
              </Link>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
