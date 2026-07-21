import { describe, it, expect } from 'vitest'
import { aggregateOps } from './analytics-ops.js'

const agentRows = [
  { agent_name: 'account_monitor', status: 'failed', error_message: 'boom', created_at: '2026-07-20T06:00:00Z' },
  { agent_name: 'account_monitor', status: 'failed', error_message: 'boom again', created_at: '2026-07-20T07:00:00Z' },
  { agent_name: 'lead', status: 'success', error_message: null, created_at: '2026-07-20T08:00:00Z' },
]

describe('aggregateOps', () => {
  it('computes the agent failure rate', () => {
    const ops = aggregateOps({ agentRows })
    expect(ops.agentFailureRate).toBeCloseTo(2 / 3, 6)
  })

  it('reports a zero failure rate rather than NaN with no runs', () => {
    expect(aggregateOps({ agentRows: [] }).agentFailureRate).toBe(0)
  })

  it('lists the most recent failures newest first', () => {
    const ops = aggregateOps({ agentRows })
    expect(ops.recentFailures).toEqual([
      { agent: 'account_monitor', error: 'boom again', at: '2026-07-20T07:00:00Z' },
      { agent: 'account_monitor', error: 'boom', at: '2026-07-20T06:00:00Z' },
    ])
  })

  it('caps the failure sample so the payload stays small', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      agent_name: 'a',
      status: 'failed',
      error_message: `e${i}`,
      created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    expect(aggregateOps({ agentRows: many }).recentFailures).toHaveLength(10)
  })

  it('breaks failures down by agent', () => {
    const ops = aggregateOps({ agentRows })
    expect(ops.failuresByAgent).toEqual([
      { agent: 'account_monitor', failures: 2, runs: 2 },
      { agent: 'lead', failures: 0, runs: 1 },
    ])
  })

  it('counts tasks by status and type', () => {
    const ops = aggregateOps({
      agentRows: [],
      tasks: [{ status: 'todo', type: 'qc' }, { status: 'todo', type: 'dev' }],
    })
    expect(ops.tasksByStatus).toEqual([{ status: 'todo', count: 2 }])
    expect(ops.tasksByType).toEqual([
      { type: 'qc', count: 1 },
      { type: 'dev', count: 1 },
    ])
  })

  it('passes integration health through with its last error', () => {
    const ops = aggregateOps({
      agentRows: [],
      integrations: [
        { provider: 'postiz', status: 'error', last_synced_at: '2026-07-01T00:00:00Z', last_error: 'token expired' },
      ],
    })
    expect(ops.integrations).toEqual([
      {
        provider: 'postiz',
        status: 'error',
        lastSyncedAt: '2026-07-01T00:00:00Z',
        lastError: 'token expired',
      },
    ])
  })

  it('counts dev issues and unread notifications', () => {
    const ops = aggregateOps({
      agentRows: [],
      devIssues: [{ id: 1 }, { id: 2 }],
      notifications: [{ read: false }, { read: true }, { read: false }],
    })
    expect(ops.devIssues).toBe(2)
    expect(ops.unreadNotifications).toBe(2)
  })

  it('returns a fully zeroed shape when nothing is supplied', () => {
    expect(aggregateOps({})).toEqual({
      agentFailureRate: 0,
      recentFailures: [],
      failuresByAgent: [],
      tasksByStatus: [],
      tasksByType: [],
      devIssues: 0,
      integrations: [],
      unreadNotifications: 0,
    })
  })
})
