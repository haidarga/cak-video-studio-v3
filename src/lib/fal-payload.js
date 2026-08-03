// Extract the media URL from a fal result payload.
//
// fal has no single response shape — it varies per model family (images[],
// video{}, videos[], output{}, bare strings...). This used to live only in
// /api/fal/webhook. When the reconcile cron grew its own copy it covered fewer
// shapes, which meant a job the webhook had missed could come back from fal with
// a perfectly good result, fail to match the weaker extractor, and get marked
// 'error' — re-creating the exact "lost generation" bug it was written to fix,
// and then feeding retry-failed-gens into re-billing the same job.
//
// One extractor, imported by every consumer.
export function extractFalUrl(payload) {
  if (!payload || typeof payload !== 'object') return null

  // 1. Images
  if (payload.images?.[0]?.url) return payload.images[0].url
  if (typeof payload.images?.[0] === 'string') return payload.images[0]
  if (payload.image?.url) return payload.image.url
  if (payload.image_url) return payload.image_url

  // 2. Video
  if (payload.video?.url) return payload.video.url
  if (typeof payload.video === 'string') return payload.video
  if (payload.video_url) return payload.video_url
  if (payload.videos?.[0]?.url) return payload.videos[0].url
  if (typeof payload.videos?.[0] === 'string') return payload.videos[0]

  // 3. Generic output / file / audio
  if (payload.output?.url) return payload.output.url
  if (payload.output?.video?.url) return payload.output.video.url
  if (payload.file?.url) return payload.file.url
  if (payload.audio?.url) return payload.audio.url
  if (typeof payload.url === 'string') return payload.url

  return null
}
