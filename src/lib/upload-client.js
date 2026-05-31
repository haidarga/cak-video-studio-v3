// Browser-side upload helper. Replaces the old direct-to-Supabase pattern:
//   const { error } = await supabase.storage.from('refs').upload(path, file, {...})
//   const { data: { publicUrl } } = supabase.storage.from('refs').getPublicUrl(path)
// with:
//   const { url, key } = await uploadFile(file, 'preset-style')
//
// `folder` is a logical sub-bucket (refs / preset-style / editor-audio /
// editor-video / cloned-voice). Workspace_id is scoped server-side from the
// session; caller doesn't pass it.

export async function uploadFile(file, folder = 'refs', { name } = {}) {
  const fd = new FormData()
  fd.append('file', file, name || file.name || 'upload.bin')
  fd.append('folder', folder)
  if (name) fd.append('name', name)
  const r = await fetch('/api/upload', { method: 'POST', body: fd })
  let j
  try { j = await r.json() }
  catch { throw new Error(`upload failed: HTTP ${r.status}`) }
  if (!j.ok) throw new Error(j.error || `upload failed: HTTP ${r.status}`)
  return { url: j.url, key: j.key }
}

// Upload from a Blob (e.g. canvas.toBlob output, ffmpeg.wasm result).
export async function uploadBlob(blob, filename, folder = 'refs') {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  return uploadFile(file, folder, { name: filename })
}
