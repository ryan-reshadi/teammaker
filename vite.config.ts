import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { ocrAliases } from './vite.ocr-alias'

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: { alias: ocrAliases },
})
