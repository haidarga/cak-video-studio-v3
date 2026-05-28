export default function PersonasLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-32 bg-[var(--surface2)] rounded mb-4" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-48 bg-[var(--surface)] border border-[var(--border)] rounded-lg" />
        ))}
      </div>
    </div>
  )
}
