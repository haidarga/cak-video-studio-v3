import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireAnalyticsKey } from './analytics-auth.js'

const KEY = 'test-analytics-key-0123456789'
const req = (authorization) =>
  new Request('http://localhost/api/external/analytics/overview', {
    headers: authorization ? { authorization } : {},
  })

describe('requireAnalyticsKey', () => {
  const original = process.env.ANALYTICS_API_KEY

  beforeEach(() => {
    process.env.ANALYTICS_API_KEY = KEY
  })
  afterEach(() => {
    if (original === undefined) delete process.env.ANALYTICS_API_KEY
    else process.env.ANALYTICS_API_KEY = original
  })

  it('lets a correct bearer key through', () => {
    expect(requireAnalyticsKey(req(`Bearer ${KEY}`))).toBeNull()
  })

  it('accepts the key without the Bearer prefix', () => {
    expect(requireAnalyticsKey(req(KEY))).toBeNull()
  })

  it('rejects a missing header with 401', () => {
    expect(requireAnalyticsKey(req()).status).toBe(401)
  })

  it('rejects a wrong key with 401', () => {
    expect(requireAnalyticsKey(req(`Bearer ${KEY}-nope`)).status).toBe(401)
  })

  it('rejects a key that is a prefix of the real one', () => {
    expect(requireAnalyticsKey(req(`Bearer ${KEY.slice(0, 10)}`)).status).toBe(401)
  })

  it('fails closed with 503 when the server has no key configured', () => {
    delete process.env.ANALYTICS_API_KEY
    expect(requireAnalyticsKey(req(`Bearer ${KEY}`)).status).toBe(503)
  })
})
