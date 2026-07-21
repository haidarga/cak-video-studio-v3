// Ops health aggregation — agent failures, task board, integration status.

import { countBy } from './analytics-content.js'

const FAILURE_SAMPLE = 10

export function aggregateOps({
  agentRows = [],
  tasks = [],
  devIssues = [],
  integrations = [],
  notifications = [],
}) {
  const failures = agentRows.filter((r) => r.status === 'failed')

  const perAgent = new Map()
  for (const row of agentRows) {
    const entry = perAgent.get(row.agent_name) ?? { failures: 0, runs: 0 }
    entry.runs += 1
    if (row.status === 'failed') entry.failures += 1
    perAgent.set(row.agent_name, entry)
  }

  return {
    agentFailureRate: agentRows.length ? failures.length / agentRows.length : 0,
    recentFailures: [...failures]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, FAILURE_SAMPLE)
      .map((r) => ({
        agent: r.agent_name,
        error: r.error_message,
        at: r.created_at,
      })),
    failuresByAgent: [...perAgent]
      .map(([agent, v]) => ({ agent, failures: v.failures, runs: v.runs }))
      .sort((a, b) => b.failures - a.failures || b.runs - a.runs),
    tasksByStatus: countBy(tasks, 'status', 'status'),
    tasksByType: countBy(tasks, 'type', 'type'),
    devIssues: devIssues.length,
    integrations: integrations.map((i) => ({
      provider: i.provider,
      status: i.status,
      lastSyncedAt: i.last_synced_at,
      lastError: i.last_error,
    })),
    unreadNotifications: notifications.filter((n) => !n.read).length,
  }
}
