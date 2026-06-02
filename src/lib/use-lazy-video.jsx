'use client'

// useLazyVideo — turn a <video> on/off based on IntersectionObserver.
//
// Why this exists: the app serves video from Cloudflare R2's pub-*.r2.dev
// subdomain. That endpoint has known performance limits (no edge cache, slow
// TTFB ~300-500ms, per-origin bandwidth cap). With preload="none" everywhere
// the click-to-play UX feels sluggish (several-second wait); but bulk
// preload="metadata" wastes egress fetching headers for off-screen items.
//
// This hook sets preload="auto" when the <video> scrolls into view (browser
// starts buffering first chunk) and reverts to preload="none" when it leaves.
// Net effect: by the time the user clicks play on a visible card, the first
// frame is already buffered — feels instant. Off-screen videos consume zero
// bandwidth.
//
// Usage:
//   const ref = useLazyVideo()
//   return <video ref={ref} src={url} preload="none" muted ... />
//
// preload="none" is the initial state the JSX should declare; the hook flips
// it dynamically.

import { useEffect, useRef } from 'react'

// Convenience wrapper — drop-in replacement for <video> in .map() lists where
// you can't call useLazyVideo() per item (Rules of Hooks). Forwards all props
// to the underlying <video>; the hook attaches its ref.
export function LazyVideo(props) {
  const ref = useLazyVideo()
  return <video ref={ref} preload="none" {...props} />
}

export function useLazyVideo(opts = {}) {
  const ref = useRef(null)
  const { rootMargin = '200px', threshold = 0 } = opts

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Old browser fallback — eager-load. The page still works, just
      // without the bandwidth saving.
      el.preload = 'metadata'
      return
    }
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry) return
      if (entry.isIntersecting) {
        // Visible — buffer first chunk so the next click-to-play is instant.
        if (el.preload !== 'auto') el.preload = 'auto'
      } else {
        // Off-screen — stop buffering. Don't pause if the user explicitly
        // started playback (let the video keep going while they scroll).
        if (el.preload !== 'none' && el.paused) el.preload = 'none'
      }
    }, { rootMargin, threshold })
    obs.observe(el)
    return () => obs.disconnect()
  }, [rootMargin, threshold])

  return ref
}
