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
  async headers() {
    return [
      {
        // ffmpeg.wasm needs SharedArrayBuffer which requires cross-origin
        // isolation via these headers. Only on /editor route to avoid
        // breaking third-party embeds elsewhere.
        source: '/editor',
        headers: [
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}
export default nextConfig
