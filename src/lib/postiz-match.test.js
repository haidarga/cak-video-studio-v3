import { describe, it, expect } from 'vitest'
import { normalizeLabel, findChannelByLabel, resolveChannelBinding } from './postiz-match.js'

const BEN_TT = { id: 'tt-ben', name: 'Ben Official', username: 'ben.official', platform: 'tiktok' }
const RIO_IG = { id: 'ig-rio', name: 'riocollagetech', username: 'riocollagetech', platform: 'instagram' }
const live = [BEN_TT, RIO_IG]

describe('normalizeLabel', () => {
  it('ignores case, @, spaces, dots, dashes and underscores', () => {
    expect(normalizeLabel('@Ben_Official')).toBe('benofficial')
    expect(normalizeLabel('Ben Official')).toBe('benofficial')
    expect(normalizeLabel('ben.official')).toBe('benofficial')
    expect(normalizeLabel('  BEN-OFFICIAL ')).toBe('benofficial')
  })
  it('returns empty string for nullish input', () => {
    expect(normalizeLabel(null)).toBe('')
    expect(normalizeLabel(undefined)).toBe('')
  })
})

describe('findChannelByLabel — exact wins over fuzzy, ambiguity is refused', () => {
  it('prefers an EXACT match even when a fuzzy candidate comes first in the array', () => {
    // 'urbanben' contains 'ben' → fuzzy candidate, and it is listed FIRST.
    // The real Ben must still win because his username matches exactly.
    const channels = [
      { id: 'x-urban', name: 'Urban Ben Reels', username: 'urbanben', platform: 'instagram' },
      BEN_TT,
    ]
    const out = findChannelByLabel(channels, 'ben.official')
    expect(out.match.id).toBe('tt-ben')
    expect(out.reason).toBe('exact')
  })

  it('refuses to guess when MULTIPLE channels fuzzy-match (the Ben→Rio class of bug)', () => {
    const channels = [
      { id: 'x-urban', name: 'Urban Ben Reels', username: 'urbanben', platform: 'instagram' },
      { id: 'x-benny', name: 'Benny UGC', username: 'benny.ugc', platform: 'tiktok' },
    ]
    const out = findChannelByLabel(channels, 'ben')
    expect(out.match).toBeNull()
    expect(out.reason).toBe('ambiguous-fuzzy')
    expect(out.candidates).toHaveLength(2)
  })

  it('still fuzzy-matches when exactly one candidate contains the label', () => {
    const out = findChannelByLabel(live, 'ben')
    expect(out.match.id).toBe('tt-ben')
    expect(out.reason).toBe('fuzzy')
  })

  it('does not fuzzy-match substrings shorter than 3 chars', () => {
    const out = findChannelByLabel(live, 'io')
    expect(out.match).toBeNull()
  })

  it('returns no-label when the label is empty', () => {
    expect(findChannelByLabel(live, '').reason).toBe('no-label')
    expect(findChannelByLabel(live, null).match).toBeNull()
  })
})

describe('resolveChannelBinding — FAIL CLOSED when the binding cannot be verified', () => {
  it('THROWS when the live channel list could not be fetched (transient Postiz outage)', () => {
    // This is the regression: previously it returned the unvalidated stored id,
    // and self-hosted Postiz silently routed the post to a fallback channel.
    expect(() => resolveChannelBinding({
      channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'tiktok',
      liveChannels: null, liveChannelsError: 'ECONNRESET',
    })).toThrow(/gak bisa diverifikasi/i)
  })

  it('THROWS when the live channel list is empty', () => {
    expect(() => resolveChannelBinding({
      channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'tiktok', liveChannels: [],
    })).toThrow(/gak bisa diverifikasi/i)
  })

  it('passes through when the id is live and the label matches', () => {
    const out = resolveChannelBinding({ channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'tiktok', liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.healed).toBe(false)
  })

  it('CASE C: the live channel platform overrides a stale stored platform', () => {
    const out = resolveChannelBinding({ channelId: 'tt-ben', channelLabel: 'Ben Official', platform: 'instagram', liveChannels: live })
    expect(out.platform).toBe('tiktok')
  })

  it('CASE A: heals a dead id via an exact label match', () => {
    const out = resolveChannelBinding({ channelId: 'old-dead-id', channelLabel: 'ben.official', platform: null, liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.platform).toBe('tiktok')
    expect(out.healed).toBe(true)
  })

  it('CASE B: re-binds a valid-but-wrong-account id to the channel matching the label', () => {
    const out = resolveChannelBinding({ channelId: 'ig-rio', channelLabel: 'Ben Official', platform: 'instagram', liveChannels: live })
    expect(out.channelId).toBe('tt-ben')
    expect(out.healed).toBe(true)
  })

  it('CASE B: FAILS CLOSED when the id is a wrong account and nothing matches the label', () => {
    expect(() => resolveChannelBinding({ channelId: 'ig-rio', channelLabel: 'NonExistent', platform: null, liveChannels: live }))
      .toThrow(/Binding salah/)
  })

  it('FAILS CLOSED rather than healing to an ambiguous fuzzy candidate', () => {
    const channels = [
      { id: 'x-urban', name: 'Urban Ben Reels', username: 'urbanben', platform: 'instagram' },
      { id: 'x-benny', name: 'Benny UGC', username: 'benny.ugc', platform: 'tiktok' },
    ]
    expect(() => resolveChannelBinding({ channelId: 'dead', channelLabel: 'ben', platform: null, liveChannels: channels }))
      .toThrow(/ambigu/i)
  })

  it('throws when a dead id cannot be healed', () => {
    expect(() => resolveChannelBinding({ channelId: 'ghost', channelLabel: 'ghost-handle', platform: null, liveChannels: live }))
      .toThrow(/gak ketemu di Postiz/)
  })

  it('with NO label: accepts a live id but reports it as unverified', () => {
    const out = resolveChannelBinding({ channelId: 'ig-rio', channelLabel: null, platform: null, liveChannels: live })
    expect(out.channelId).toBe('ig-rio')
    expect(out.platform).toBe('instagram')
    expect(out.unverified).toBe(true)
  })

  it('with NO label: still throws on a dead id', () => {
    expect(() => resolveChannelBinding({ channelId: 'dead', channelLabel: null, platform: null, liveChannels: live }))
      .toThrow(/gak ketemu di Postiz/)
  })

  it('reports the verified channel label so the caller can persist the healed binding', () => {
    const out = resolveChannelBinding({ channelId: 'old-dead-id', channelLabel: 'ben.official', platform: null, liveChannels: live })
    expect(out.verifiedLabel).toBe('Ben Official')
  })
})
