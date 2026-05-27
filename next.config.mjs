/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
