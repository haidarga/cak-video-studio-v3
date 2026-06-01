// Browser-side upload helper. Replaces the old direct-to-Supabase pattern:
//   const { error } = await supabase.storage.from('refs').upload(path, file, {...})
//   const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
// with:
//   const { url, key } = await uploadFile(file, 'preset-style')
//
// Implementation: presigned-PUT-direct-to-R2. The server issues a signed URL
// (cheap — just an HMAC), the browser PUTs the bytes directly to R2. This
// bypasses Vercel's 4.5MB serverless body cap, so videos up to 5GB upload
// fine without any server bandwidth cost. Works for tiny PNGs the same way
// as 200MB MP4s — one code path.
//
// `folder` is a logical sub-bucket (refs / preset-style / editor-audio /
// editor-video / cloned-voice / external). Workspace_id is scoped server-side
// from the session; caller doesn't pass it.

async function presign(folder, name, contentType) {
  const r = await fetch('/api/upload-presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name, contentType }),
  })
  let j
  try { j = await r.json() }
  catch { throw new Error(`presign failed: HTTP ${r.status}`) }
  if (!j.ok) throw new Error(j.error || `presign failed: HTTP ${r.status}`)
  return j  // { uploadUrl, publicUrl, key }
}

async function putToR2(uploadUrl, body, contentType) {
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new Error(`R2 PUT failed: HTTP ${r.status} ${detail}`)
  }
}

export async function uploadFile(file, folder = 'refs', { name } = {}) {
  const filename = name || file.name || 'upload.bin'
  const contentType = file.type || 'application/octet-stream'
  const { uploadUrl, publicUrl, key } = await presign(folder, filename, contentType)
  await putToR2(uploadUrl, file, contentType)
  return { url: publicUrl, key }
}

// Upload from a Blob (e.g. canvas.toBlob output, ffmpeg.wasm result).
export async function uploadBlob(blob, filename, folder = 'refs') {
  const contentType = blob.type || 'application/octet-stream'
  const { uploadUrl, publicUrl, key } = await presign(folder, filename, contentType)
  await putToR2(uploadUrl, blob, contentType)
  return { url: publicUrl, key }
}
