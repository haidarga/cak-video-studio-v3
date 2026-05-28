export default function ErrorsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-24 bg-[var(--surface2)] rounded mb-4" />
      <div className="h-10 bg-[var(--surface)] border border-[var(--border)] rounded mb-3" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-16 bg-[var(--surface)] border border-[var(--border)] rounded" />
        ))}
      </div>
    </div>
  )
}
