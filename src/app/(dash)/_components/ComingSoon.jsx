export default function ComingSoon({ title, hint }) {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold mb-2">{title}</h1>
      <p className="text-sm text-[var(--muted)]">{hint}</p>
      <div className="mt-6 text-xs text-[var(--muted2)]">🚧 Lagi dibangun. Coming next.</div>
    </div>
  )
}
