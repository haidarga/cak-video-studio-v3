import { describe, it, expect } from 'vitest'
import { sniffMime, coerceMp4Brand } from './postiz.js'

// Channel-binding tests now live in ./postiz-match.test.js — the logic moved to
// the pure ./postiz-match.js module so the UI can share the same matcher.

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
