import { describe, it, expect } from 'vitest'
import { findSchemaDrift, migrationColumns } from '../scripts/schema-drift.mjs'

// Guard against the `scheduled_posts.target_channel_label` bug class: a column
// that exists only in JavaScript. The UI wrote it, the API read it, no migration
// created it — so every insert failed, the row never existed, and the post
// silently never happened. Invisible until production broke.
describe('schema drift — every column the code writes must exist in a migration', () => {
  it('parses columns out of the migrations', () => {
    const cols = migrationColumns()
    // Sanity-check the parser itself, so a regex regression can't make this
    // suite pass by finding nothing at all.
    expect(cols.get('results')).toBeTruthy()
    expect(cols.get('results').has('request_id')).toBe(true)   // 0032
    expect(cols.get('results').has('poster_url')).toBe(true)   // 0033
    expect(cols.get('scheduled_posts').has('target_channel_label')).toBe(true) // 0031
    // Multi-column ALTER form (`add column a, add column b, …`) must parse too.
    expect(cols.get('personas').has('lora_training_status')).toBe(true) // 0025
  })

  it('finds no column written by code but missing from migrations', () => {
    const drift = findSchemaDrift()
    if (drift.length) {
      const detail = drift.map((d) => `  ${d.table}.${d.col}  (${d.file}:${d.line})`).join('\n')
      throw new Error(
        `Kolom ditulis kode tapi gak ada di supabase/migrations:\n${detail}\n\n` +
        `Tambahin migration-nya, atau kalau memang sengaja masukin ke ALLOWLIST di scripts/schema-drift.mjs beserta alasannya.`
      )
    }
    expect(drift).toEqual([])
  })
})
