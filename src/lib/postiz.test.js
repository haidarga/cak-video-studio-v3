import { describe, it, expect } from 'vitest'
import { sniffMime, coerceMp4Brand, resolveChannelBinding } from './postiz.js'

describe('resolveChannelBinding — channel drift / wrong-account / stale-platform guard', () => {
  const BEN_TT = { id: 'tt-ben', name: 'Ben Official', username: 'ben.official', platform: 'tiktok' }
  const RIO_IG = { id: 'ig-rio', name: 'riocollagetech', username: 'riocollagetech', platform: 'instagram' }
  const live = [BEN_TT, RIO_IG]

  it('passes through when the id is live and the label matches', () => {
    const out = resolveChannelBinding({ channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'tiktok', liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.healed).toBe(false)
  })

  it('CASE C: live channel platform OVERRIDES a stale stored platform (IG→TikTok)', () => {
    // Ben attached as IG in the row, but the channel he posts to is TikTok.
    const out = resolveChannelBinding({ channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'instagram', liveChannels: live })
    expect(out.platform).toBe('tiktok') // authoritative from live channel — fixes "gak mau upload"
  })

  it('CASE A: heals a DEAD id by matching the label', () => {
    const out = resolveChannelBinding({ channelId: 'old-dead-id', channelLabel: 'ben.official', platform: null, liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.platform).toBe('tiktok')
    expect(out.healed).toBe(true)
  })

  it('CASE B: re-binds a VALID-but-wrong-account id to the channel matching the label', () => {
    // Ben's row points at Rio's (valid) IG id — must NOT post there.
    const out = resolveChannelBinding({ channelId: 'ig-rio', channelLabel: 'Ben Official', platform: 'instagram', liveChannels: live })
    expect(out.channelId).toBe('tt-ben') // switched to Ben's real channel
    expect(out.platform).toBe('tiktok')
    expect(out.healed).toBe(true)
  })

  it('CASE B: FAILS CLOSED when id is wrong account and no channel matches the label', () => {
    expect(() => resolveChannelBinding({ channelId: 'ig-rio', channelLabel: 'NonExistent Persona', platform: 'instagram', liveChannels: live }))
      .toThrow(/Binding salah/)
  })

  it('throws when a dead id cannot be healed (label matches nothing)', () => {
    expect(() => resolveChannelBinding({ channelId: 'ghost', channelLabel: 'ghost-handle', platform: null, liveChannels: live }))
      .toThrow(/gak ketemu di Postiz/)
  })

  it('does NOT block when the live list is empty (network down — skip validation)', () => {
    const out = resolveChannelBinding({ channelId: 'tt-ben', channelLabel: 'whatever', platform: 'tiktok', liveChannels: [] })
    expect(out.channelId).toBe('tt-ben')
  })

  it('does NOT enforce label match when no label is provided (best-effort id-only)', () => {
    const out = resolveChannelBinding({ channelId: 'ig-rio', channelLabel: null, platform: null, liveChannels: live })
    expect(out.channelId).toBe('ig-rio')
    expect(out.platform).toBe('instagram')
  })

  it('fuzzy: heals when label is a SUBSTRING of channel name (display name drift)', () => {
    const out = resolveChannelBinding({ channelId: 'old-dead', channelLabel: 'ben', platform: null, liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.healed).toBe(true)
  })

  it('fuzzy: heals when channel username CONTAINS the label', () => {
    const channels = [{ id: 'ch-1', name: 'Lyra Nala', username: 'lyranarll', platform: 'instagram' }]
    const out = resolveChannelBinding({ channelId: 'dead-id', channelLabel: 'lyra', platform: null, liveChannels: channels })
    expect(out.channelId).toBe('ch-1')
    expect(out.healed).toBe(true)
  })

  it('fuzzy: does NOT match very short substrings (< 3 chars) to avoid false positives', () => {
    // 'io' is too short to fuzzy match 'riocollagetech'
    expect(() => resolveChannelBinding({ channelId: 'dead', channelLabel: 'io', platform: null, liveChannels: live }))
      .toThrow(/gak ketemu di Postiz/)
  })
})

// Build a minimal ftyp box: [size][ftyp][majorBrand][minorVer][...compatible]
function ftyp(major, compatible = major) {
  const brands = [major, '\0\0\0\0', compatible]
  const body = brands.join('')
  const size = 8 + body.length
  const buf = Buffer.alloc(size + 8) // + a couple trailing bytes
  buf.writeUInt32BE(size, 0)
  buf.write('ftyp', 4, 'ascii')
  buf.write(major, 8, 'ascii')
  // minor version 0 at 12..16 already zeroed
  buf.write(compatible, 16, 'ascii')
  return buf
}

describe('sniffMime', () => {
  it('detects jpeg / png from magic bytes', () => {
    expect(sniffMime(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/png')
  })
  it('detects mp4 from ftyp box', () => {
    expect(sniffMime(ftyp('mp42'))).toBe('video/mp4')
  })
  it('detects quicktime brand as video/quicktime', () => {
    expect(sniffMime(ftyp('qt  '))).toBe('video/quicktime')
  })
  it('returns null for too-short / unknown buffers', () => {
    expect(sniffMime(Buffer.from([1, 2, 3]))).toBeNull()
  })
})

describe('coerceMp4Brand', () => {
  it('rewrites a QuickTime-branded container to mp42 (the real Postiz-400 fix)', () => {
    const { buf, changed } = coerceMp4Brand(ftyp('qt  '))
    expect(changed).toBe(true)
    expect(buf.toString('ascii', 8, 12)).toBe('mp42')
    expect(buf.toString('ascii', 16, 20)).toBe('isom') // qt compatible brand patched
  })
  it('leaves a real mp4 brand untouched', () => {
    const original = ftyp('isom')
    const { buf, changed } = coerceMp4Brand(original)
    expect(changed).toBe(false)
    expect(buf).toBe(original) // same ref, no copy
  })
  it('ignores non-ftyp buffers', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(coerceMp4Brand(png).changed).toBe(false)
  })
  it('does not mutate the source buffer when coercing', () => {
    const src = ftyp('qt  ')
    const before = Buffer.from(src)
    coerceMp4Brand(src)
    expect(src.equals(before)).toBe(true) // original untouched (copy was modified)
  })
})
