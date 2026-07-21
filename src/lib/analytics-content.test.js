import { describe, it, expect } from 'vitest'
import {
  aggregateContent,
  countBy,
  parsePaging,
  MAX_PAGE_SIZE,
} from './analytics-content.js'

describe('countBy', () => {
  it('counts occurrences and sorts biggest first', () => {
    const rows = [{ s: 'a' }, { s: 'b' }, { s: 'a' }]
    expect(countBy(rows, 's', 'stage')).toEqual([
      { stage: 'a', count: 2 },
      { stage: 'b', count: 1 },
    ])
  })

  it('returns an empty list for no rows', () => {
    expect(countBy([], 's', 'stage')).toEqual([])
  })

  it('buckets null values under a null key rather than dropping them', () => {
    expect(countBy([{ s: null }], 's', 'stage')).toEqual([
      { stage: null, count: 1 },
    ])
  })
})

describe('parsePaging', () => {
  it('defaults to the first page of 25', () => {
    expect(parsePaging({})).toEqual({ limit: 25, offset: 0 })
  })

  it('honours explicit limit and offset', () => {
    expect(parsePaging({ limit: '10', offset: '20' })).toEqual({
      limit: 10,
      offset: 20,
    })
  })

  it('clamps limit to the maximum', () => {
    expect(parsePaging({ limit: '5000' }).limit).toBe(MAX_PAGE_SIZE)
  })

  it('clamps nonsense values back to safe defaults', () => {
    expect(parsePaging({ limit: '0', offset: '-5' })).toEqual({
      limit: 25,
      offset: 0,
    })
    expect(parsePaging({ limit: 'abc' })).toEqual({ limit: 25, offset: 0 })
  })
})

describe('aggregateContent', () => {
  const pipeline = [
    { stage: 'posted', content_type: 'ugc', content_format: 'video', production_url: 'https://x/1.mp4', performance_score: 0.8, posted_at: '2026-06-29T00:00:00Z' },
    { stage: 'posted', content_type: 'ugc', content_format: 'slideshow', production_url: null, performance_score: 0.6, posted_at: '2026-06-30T00:00:00Z' },
    { stage: 'scripted', content_type: 'ads', content_format: 'video', production_url: null, performance_score: null, posted_at: null },
  ]
  const naskah = [{ status: 'draft' }, { status: 'draft' }, { status: 'approved' }]
  const genJobs = [{ status: 'done' }, { status: 'error' }]
  const qcFlags = [{ severity: 'high' }, { severity: 'low' }, { severity: 'high' }]

  it('counts the pipeline funnel by stage', () => {
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.pipelineByStage).toEqual([
      { stage: 'posted', count: 2 },
      { stage: 'scripted', count: 1 },
    ])
  })

  it('splits content by format and by type', () => {
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.byFormat).toEqual([
      { format: 'video', count: 2 },
      { format: 'slideshow', count: 1 },
    ])
    expect(c.byType).toEqual([
      { type: 'ugc', count: 2 },
      { type: 'ads', count: 1 },
    ])
  })

  it('counts naskah and gen jobs by status', () => {
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.naskahByStatus).toEqual([
      { status: 'draft', count: 2 },
      { status: 'approved', count: 1 },
    ])
    expect(c.genJobsByStatus).toEqual([
      { status: 'done', count: 1 },
      { status: 'error', count: 1 },
    ])
  })

  it('summarises qc flags by severity', () => {
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.qcFlags.total).toBe(3)
    expect(c.qcFlags.bySeverity).toEqual([
      { severity: 'high', count: 2 },
      { severity: 'low', count: 1 },
    ])
  })

  it('averages performance only over scored rows', () => {
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.postedCount).toBe(2)
    expect(c.avgPerformanceScore).toBeCloseTo(0.7, 5)
  })

  it('counts how many rows actually carry a production url', () => {
    // production_url is null across the current dataset — surfacing the count
    // keeps that visible instead of implying every posted item has a video.
    const c = aggregateContent({ pipeline, naskah, genJobs, qcFlags })
    expect(c.withProductionUrl).toBe(1)
  })

  it('reports a null average rather than NaN when nothing is scored', () => {
    const c = aggregateContent({
      pipeline: [{ stage: 'briefed', content_type: 'ugc', content_format: 'video', production_url: null, performance_score: null, posted_at: null }],
      naskah: [],
      genJobs: [],
      qcFlags: [],
    })
    expect(c.avgPerformanceScore).toBeNull()
    expect(c.postedCount).toBe(0)
  })

  it('handles every input being empty', () => {
    const c = aggregateContent({ pipeline: [], naskah: [], genJobs: [], qcFlags: [] })
    expect(c).toEqual({
      pipelineByStage: [],
      byFormat: [],
      byType: [],
      naskahByStatus: [],
      genJobsByStatus: [],
      qcFlags: { total: 0, bySeverity: [] },
      postedCount: 0,
      avgPerformanceScore: null,
      withProductionUrl: 0,
    })
  })
})
