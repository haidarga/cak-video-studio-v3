import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Test harness for cak-video-studio-v3. Node environment (the libs under test
// are pure/server logic, no DOM). `@/` alias mirrors the Next/jsconfig path so
// modules importing `@/lib/...` resolve the same way they do in the app.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs}', 'tests/**/*.{test,spec}.{js,mjs}'],
    coverage: { provider: 'v8', include: ['src/lib/**'], reporter: ['text', 'html'] },
  },
})
