// Cross-check the columns the CODE writes against the columns the MIGRATIONS
// create.
//
// WHY THIS EXISTS: `scheduled_posts.target_channel_label` was written by the
// scheduling UI and read by /api/postiz/post, but NO migration ever created it.
// Every insert failed, so the scheduled_posts row was never created and the post
// silently never happened — and because the failure was a caught error on the
// client, nothing surfaced. It took a full audit to find.
//
// A column that exists only in JavaScript is invisible until production breaks.
// This catches it at test time instead.
//
// Heuristic by design: it only inspects `.from('table').insert/update/upsert({…})`
// with an object literal, and only TOP-LEVEL keys (nested objects are jsonb
// payloads, not columns). False negatives are possible; false positives should
// be fixed or added to ALLOWLIST with a reason.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Columns intentionally absent from migrations. Keep this empty if you can; a
// entry here is a promise that the column is created some other way.
const ALLOWLIST = new Set([
  // 'table.column', // reason
])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

export function migrationColumns(migDir = path.join(ROOT, 'supabase/migrations')) {
  const cols = new Map()
  const add = (table, col) => {
    if (!table || !col) return
    const t = table.replace(/^public\./, '')
    if (!cols.has(t)) cols.set(t, new Set())
    cols.get(t).add(col)
  }
  const text = fs.readdirSync(migDir).sort()
    .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n')

  for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
    for (const line of m[2].split('\n')) {
      const c = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i)
      if (c && !/^(primary|unique|foreign|constraint|check|references)$/i.test(c[1])) add(m[1], c[1])
    }
  }
  // One ALTER can carry many `add column` clauses — parse the whole statement.
  for (const m of text.matchAll(/alter\s+table\s+([\w.]+)([\s\S]*?);/gi)) {
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      add(m[1], c[1])
    }
  }
  return cols
}

export function findSchemaDrift(srcDir = path.join(ROOT, 'src')) {
  const known = migrationColumns()
  const found = []
  for (const file of walk(srcDir)) {
    const text = fs.readFileSync(file, 'utf8')
    const re = /from\(\s*['"`](\w+)['"`]\s*\)([\s\S]{0,120}?)\.(insert|update|upsert)\(\s*(\{)/g
    let m
    while ((m = re.exec(text))) {
      const table = m[1]
      const open = m.index + m[0].length - 1
      let depth = 0, end = -1
      for (let i = open; i < text.length && i < open + 4000; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
      }
      if (end === -1) continue
      const body = text.slice(open + 1, end)
      let d = 0
      for (const km of body.matchAll(/[{}[\]]|(^|[,\n])\s*([a-z_][a-z0-9_]*)\s*:/gi)) {
        const tok = km[0].trim()
        if (tok === '{' || tok === '[') { d++; continue }
        if (tok === '}' || tok === ']') { d--; continue }
        if (d !== 0 || !km[2]) continue
        const col = km[2]
        const cols = known.get(table)
        if (!cols) continue // table unknown to migrations — out of scope here
        if (cols.has(col) || ALLOWLIST.has(`${table}.${col}`)) continue
        found.push({
          table, col,
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: text.slice(0, open).split('\n').length,
        })
      }
    }
  }
  const seen = new Set()
  return found.filter((f) => {
    const k = `${f.table}.${f.col}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}
