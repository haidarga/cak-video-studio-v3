import { describe, it, expect } from 'vitest'
import { buildResultRowFromJob } from './gen-ingest.js'

const JOB = {
  request_id: 'req-123',
  workspace_id: 'ws-1',
  user_id: 'user-1',
  kind: 'video',
  model: 'xai/grok-imagine-video/image-to-video',
  meta: {
    duration: 5,
    ingest: {
      persona_id: 'p-ben',
      label: 'Shot 3 — hook',
      ar: '9:16',
      group_label: 'Ben',
      type: 'video',
      image_url: 'https://r2/frame.png',
      source: 'generate',
    },
  },
}

describe('buildResultRowFromJob — server-side ingestion of a finished fal job', () => {
  it('stamps request_id so the unique index can reject a second ingestion', () => {
    const row = buildResultRowFromJob(JOB, 'https://fal.media/out.mp4')
    expect(row.request_id).toBe('req-123')
    expect(row.workspace_id).toBe('ws-1')
    expect(row.url).toBe('https://fal.media/out.mp4')
  })

  it('carries the persona/label/ar the browser would have set', () => {
    const row = buildResultRowFromJob(JOB, 'https://fal.media/out.mp4')
    expect(row.persona_id).toBe('p-ben')
    expect(row.label).toBe('Shot 3 — hook')
    expect(row.ar).toBe('9:16')
    expect(row.group_label).toBe('Ben')
    expect(row.type).toBe('video')
  })

  it('marks the row as server-ingested so it is distinguishable from a browser insert', () => {
    const row = buildResultRowFromJob(JOB, 'https://fal.media/out.mp4')
    expect(row.meta.source).toBe('generate')
    expect(row.meta.ingested_by).toBe('server')
    expect(row.meta.image_url).toBe('https://r2/frame.png')
  })

  it('falls back to the job kind when ingest.type is absent', () => {
    const job = { ...JOB, meta: { ingest: { persona_id: 'p' } } }
    expect(buildResultRowFromJob(job, 'u').type).toBe('video')
    expect(buildResultRowFromJob({ ...job, kind: 'image' }, 'u').type).toBe('image')
  })

  it('returns null when the job carries no ingest intent — do NOT invent rows', () => {
    // god-mode and one-off jobs own their own persistence; ingesting them here
    // would create assets the user never asked to keep.
    expect(buildResultRowFromJob({ ...JOB, meta: { duration: 5 } }, 'u')).toBeNull()
    expect(buildResultRowFromJob({ ...JOB, meta: null }, 'u')).toBeNull()
  })

  it('returns null without a url — nothing to ingest', () => {
    expect(buildResultRowFromJob(JOB, null)).toBeNull()
    expect(buildResultRowFromJob(JOB, '')).toBeNull()
  })

  it('requires a workspace_id — an unscoped row would be invisible and unowned', () => {
    expect(buildResultRowFromJob({ ...JOB, workspace_id: null }, 'u')).toBeNull()
  })
})
