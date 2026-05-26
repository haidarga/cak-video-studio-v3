import dynamic from 'next/dynamic'

// SSR off: v2's store reads localStorage at first render, plus @remotion/player
// is browser-only. Defer mount to the client.
const StudioApp = dynamic(() => import('@/studio/StudioApp'), {
  ssr: false,
  loading: () => (
    <div className="p-12 text-sm text-[var(--muted)] text-center">
      ⏳ Loading Studio (Quick / Pipeline / Bulk / Template / Chain / Editor / Results / QC)...
    </div>
  ),
})

export default function StudioPage() {
  return <StudioApp />
}
