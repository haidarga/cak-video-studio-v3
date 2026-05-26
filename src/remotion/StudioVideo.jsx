import { AbsoluteFill, OffthreadVideo, Video, Audio, Sequence, useVideoConfig, useCurrentFrame, interpolate, spring, getRemotionEnvironment } from 'remotion'
import { FONTS } from './fonts.js'

// total play seconds = farthest clip end on the timeline
export function studioDurationSec(clips) {
  const valid = (clips || []).filter((c) => c && c.url)
  if (!valid.length) return 1
  return Math.max(1, ...valid.map((c) => (c.start || 0) + Math.max(0.3, c.duration || 0)))
}

// caption overlay — finds the active caption for the current frame, animates it
function CaptionLayer({ captions = [], capStyle = {} }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const s = {
    fontSize: 70, position: 'bottom', color: '#ffffff', stroke: '#000000',
    uppercase: true, bg: false, fontFamily: 'Inter', anim: 'pop', x: null, y: null, ...capStyle,
  }
  const cur = captions.find((c) => t >= c.start && t < c.end)
  if (!cur) return null

  let anim = {}
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

  const free = s.x != null && s.y != null
  const posStyle = free
    ? { left: `${s.x}%`, top: `${s.y}%`, transform: 'translate(-50%,-50%)', maxWidth: '86%' }
    : s.position === 'top' ? { left: 0, right: 0, top: '9%' }
    : s.position === 'center' ? { left: 0, right: 0, top: '50%', transform: 'translateY(-50%)' }
    : { left: 0, right: 0, bottom: '13%' }

  return (
    <div style={{ position: 'absolute', display: 'flex', justifyContent: 'center', padding: free ? 0 : '0 7%', ...posStyle }}>
      <div style={{
        fontFamily: `'${FONTS[s.fontFamily] || FONTS.Inter}', sans-serif`,
        fontWeight: 900, fontSize: s.fontSize, color: s.color,
        textAlign: 'center', lineHeight: 1.12, letterSpacing: '-0.5px',
        textTransform: s.uppercase ? 'uppercase' : 'none',
        WebkitTextStroke: s.bg ? '0' : `${Math.max(2, Math.round(s.fontSize / 14))}px ${s.stroke}`,
        paintOrder: 'stroke fill',
        ...(s.bg ? { background: 'rgba(0,0,0,0.78)', padding: '10px 26px', borderRadius: 14 } : {}),
        ...anim,
      }}>
        {cur.text}
      </div>
    </div>
  )
}

// Unified editor composition — multi-track CapCut-style.
// Each clip has a `track` number (0 = bottom layer, higher = on top).
// props: clips:[{url,start,duration,trimStart,muted,track}], captions[], capStyle{}, audio{}
export const StudioVideo = ({ clips = [], captions = [], capStyle = {}, audio = null }) => {
  const { fps } = useVideoConfig()
  // OffthreadVideo for server render (accurate), native Video for the Player (smooth playback)
  const Vid = getRemotionEnvironment().isRendering ? OffthreadVideo : Video
  const valid = clips.filter((c) => c && c.url)
  // sort by track ascending so higher tracks render last → on top (CapCut z-order)
  const sorted = [...valid].sort((a, b) => (a.track || 0) - (b.track || 0))

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {sorted.map((c, i) => {
        const trimStart = c.trimStart || 0
        let durFrames = Math.max(2, Math.round((c.duration || 1) * fps))
        // never request frames past the source end — fal videos sometimes over-report
        // their duration, which crashes the compositor ("no frame found at position")
        if (c.srcDur) {
          const availFrames = Math.max(2, Math.floor((c.srcDur - trimStart) * fps) - 2)
          durFrames = Math.min(durFrames, availFrames)
        }
        return (
          <Sequence
            key={c.id || `c${i}`}
            from={Math.round((c.start || 0) * fps)}
            durationInFrames={durFrames}
          >
            <Vid
              src={c.url}
              trimBefore={Math.round(trimStart * fps)}
              muted={!!c.muted}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </Sequence>
        )
      })}
      {audio && audio.url ? (
        <Audio
          src={audio.url}
          trimBefore={Math.round((audio.trimStart || 0) * fps)}
          volume={audio.volume == null ? 1 : audio.volume}
        />
      ) : null}
      <CaptionLayer captions={captions} capStyle={capStyle} />
    </AbsoluteFill>
  )
}
