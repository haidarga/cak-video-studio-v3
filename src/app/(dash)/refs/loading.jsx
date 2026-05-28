export default function RefsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-32 bg-[var(--surface2)] rounded mb-4" />
      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
        {Array.from({ length: 28 }).map((_, i) => (
          <div key={i} className="aspect-square bg-[var(--surface)] border border-[var(--border)] rounded" />
        ))}
      </div>
    </div>
  )
}
