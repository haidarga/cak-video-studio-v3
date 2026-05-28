export default function EditorLoading() {
  return (
    <div className="animate-pulse">
      <div className="flex justify-between mb-4">
        <div className="h-7 w-32 bg-[var(--surface2)] rounded" />
        <div className="flex gap-2">
          <div className="h-8 w-20 bg-[var(--surface2)] rounded" />
          <div className="h-8 w-20 bg-[var(--surface2)] rounded" />
        </div>
      </div>
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-3 space-y-2">
          <div className="h-32 bg-[var(--surface)] border border-[var(--border)] rounded" />
          <div className="h-80 bg-[var(--surface)] border border-[var(--border)] rounded" />
        </div>
        <div className="col-span-6 space-y-2">
          <div className="aspect-[9/16] max-w-[360px] mx-auto bg-[var(--surface)] border border-[var(--border)] rounded" />
        </div>
        <div className="col-span-3 space-y-2">
          <div className="h-48 bg-[var(--surface)] border border-[var(--border)] rounded" />
          <div className="h-48 bg-[var(--surface)] border border-[var(--border)] rounded" />
        </div>
      </div>
    </div>
  )
}
