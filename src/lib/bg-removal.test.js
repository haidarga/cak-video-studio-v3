import { describe, it, expect, beforeEach } from 'vitest'
import { buildBgRemovalInput, extractCleanUrl, cleanProductBg, _resetBgCache, BIREFNET_MODEL } from './bg-removal.js'

beforeEach(() => _resetBgCache())

describe('buildBgRemovalInput', () => {
  it('isolates the foreground (product) of the given image', () => {
    expect(buildBgRemovalInput('https://x/p.jpg')).toEqual({
      image_url: 'https://x/p.jpg', model: 'General Use (Light)', output_type: 'foreground',
    })
  })
})

describe('extractCleanUrl', () => {
  it('reads the url across response shapes', () => {
    expect(extractCleanUrl({ image: { url: 'a' } })).toBe('a')
    expect(extractCleanUrl({ images: [{ url: 'b' }] })).toBe('b')
    expect(extractCleanUrl({ url: 'c' })).toBe('c')
    expect(extractCleanUrl({})).toBeNull()
  })
})

describe('cleanProductBg (fail-safe + cached)', () => {
  it('returns the cleaned url on success', async () => {
    const fal = async (model, input) => {
      expect(model).toBe(BIREFNET_MODEL)
      expect(input.image_url).toBe('https://x/p.jpg')
      return { image: { url: 'https://x/p-clean.png' } }
    }
    expect(await cleanProductBg('https://x/p.jpg', 'k', fal)).toBe('https://x/p-clean.png')
  })

  it('falls back to the ORIGINAL url when fal throws (gen never breaks)', async () => {
    const fal = async () => { throw new Error('birefnet 422') }
    expect(await cleanProductBg('https://x/p.jpg', 'k', fal)).toBe('https://x/p.jpg')
  })

  it('falls back when the response has no url', async () => {
    const fal = async () => ({})
    expect(await cleanProductBg('https://x/p.jpg', 'k', fal)).toBe('https://x/p.jpg')
  })

  it('caches — second call does not hit fal again', async () => {
    let calls = 0
    const fal = async () => { calls++; return { url: 'https://x/clean.png' } }
    await cleanProductBg('https://x/same.jpg', 'k', fal)
    await cleanProductBg('https://x/same.jpg', 'k', fal)
    expect(calls).toBe(1)
  })

  it('passes through empty/invalid input unchanged', async () => {
    const fal = async () => { throw new Error('should not be called') }
    expect(await cleanProductBg('', 'k', fal)).toBe('')
    expect(await cleanProductBg(null, 'k', fal)).toBeNull()
  })
})
