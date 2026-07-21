// PostgREST caps a single response at db-max-rows (1000 on this project), so a
// plain .limit() silently truncates and every total comes out wrong. Page instead.

export const PAGE_SIZE = 1000
export const MAX_ROWS = 20000

export async function fetchAllRows(buildQuery) {
  const rows = []
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1)
    if (error) return { data: null, error }
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return { data: rows, error: null }
}
