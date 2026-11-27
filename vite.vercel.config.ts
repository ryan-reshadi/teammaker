import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { ocrAliases } from './vite.ocr-alias'

/**
 * Vercel build: the browser bundle only. The Cloudflare plugin (and its
 * wrangler dependency) stays out of this build because Vercel cannot run a
 * Worker; `api/index.ts` provides the serverless half instead.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: ocrAliases },
  build: { outDir: 'dist-client', emptyOutDir: true },
})
