import { AbsoluteFill, OffthreadVideo, Video, useCurrentFrame, useVideoConfig, interpolate, spring, getRemotionEnvironment } from 'remotion'
import { FONTS } from './fonts.js'

// Shared composition — used by the in-browser Player AND server-side render.
// props: videoUrl, captions:[{start,end,text}], capStyle:{}
export const CaptionedVideo = ({ videoUrl, captions = [], capStyle = {} }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  // OffthreadVideo for server render (accurate), native Video for the Player (smooth playback)
  const Vid = getRemotionEnvironment().isRendering ? OffthreadVideo : Video
  const t = frame / fps
  const s = {
    fontSize: 70, position: 'bottom', color: '#ffffff', stroke: '#000000',
    uppercase: true, bg: false, fontFamily: 'Inter', anim: 'pop', x: null, y: null, ...capStyle,
  }
  const cur = captions.find((c) => t >= c.start && t < c.end)

  // entrance animation
  let anim = {}
  if (cur) {
    const lf = frame - Math.round(cur.start * fps)
    if (s.anim === 'pop') {
      const sp = spring({ frame: lf, fps, config: { damping: 12, stiffness: 200 }, durationInFrames: 14 })
      anim = { transform: `scale(${interpolate(sp, [0, 1], [0.62, 1])})`, opacity: Math.min(1, sp * 1.6) }
    } else if (s.anim === 'slide') {
      const sp = spring({ frame: lf, fps, config: { damping: 14 }, durationInFrames: 14 })
      anim = { transform: `translateY(${interpolate(sp, [0, 1], [44, 0])}px)`, opacity: Math.min(1, sp * 1.6) }
    } else if (s.anim === 'fade') {
      anim = { opacity: interpolate(lf, [0, 9], [0, 1], { extrapolateRight: 'clamp' }) }
    } else if (s.anim === 'bounce') {
      const sp = spring({ frame: lf, fps, config: { damping: 6, stiffness: 130 }, durationInFrames: 22 })
      anim = { transform: `scale(${sp})`, opacity: Math.min(1, sp * 2) }
    }
  }

  // positioning — free (x/y set) or preset
  const free = s.x != null && s.y != null
  const posStyle = free
    ? { left: `${s.x}%`, top: `${s.y}%`, transform: 'translate(-50%,-50%)', maxWidth: '86%' }
    : s.position === 'top' ? { left: 0, right: 0, top: '9%' }
    : s.position === 'center' ? { left: 0, right: 0, top: '50%', transform: 'translateY(-50%)' }
    : { left: 0, right: 0, bottom: '13%' }

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {videoUrl ? <Vid src={videoUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      {cur ? (
        <div style={{ position: 'absolute', display: 'flex', justifyContent: 'center', padding: free ? 0 : '0 7%', ...posStyle }}>
          <div
            style={{
              fontFamily: `'${FONTS[s.fontFamily] || FONTS.Inter}', sans-serif`,
              fontWeight: 900, fontSize: s.fontSize, color: s.color,
              textAlign: 'center', lineHeight: 1.12, letterSpacing: '-0.5px',
              textTransform: s.uppercase ? 'uppercase' : 'none',
              WebkitTextStroke: s.bg ? '0' : `${Math.max(2, Math.round(s.fontSize / 14))}px ${s.stroke}`,
              paintOrder: 'stroke fill',
              ...(s.bg ? { background: 'rgba(0,0,0,0.78)', padding: '10px 26px', borderRadius: 14 } : {}),
              ...anim,
            }}
          >
            {cur.text}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  )
}
