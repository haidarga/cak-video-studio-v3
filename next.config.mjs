/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Tree-shake heavy deps so unused exports don't bloat the client bundle.
  // Biggest impact: @supabase/* import everything from index by default.
  experimental: {
    optimizePackageImports: [
      '@supabase/ssr',
      '@supabase/supabase-js',
      '@fal-ai/client',
    ],
  },
  compress: true,
  // Skip ESLint during prod builds — keep lint as a separate `npm run lint`
  // step so Vercel deploys aren't blocked by stylistic warnings.
  eslint: { ignoreDuringBuilds: true },
  // COEP/COOP removed.
  //
  // Previously /editor set COEP=require-corp so ffmpeg.wasm could use
  // SharedArrayBuffer for multi-threaded encoding. Side effect: every
  // cross-origin resource (fal.media videos, Supabase ref images) had to
  // come back with a Cross-Origin-Resource-Policy header — they don't —
  // so the editor went dark and exports failed. Worse: browsers retain
  // COEP state across SPA navigations, so /generate's ref thumbnails
  // started failing too once a user visited /editor first.
  //
  // Trade-off: ffmpeg.wasm now runs single-threaded (auto-fallback in
  // @ffmpeg/core when SharedArrayBuffer is unavailable). Slower MP4
  // encoding but still functional. Fast Export (canvas+MediaRecorder)
  // is the default anyway and doesn't care about SharedArrayBuffer at
  // all. proxify() in editor-render stays as a defensive net for any
  // host that ever stops sending Access-Control-Allow-Origin.
}
export default nextConfig
