import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The uploader accepts dedicated public output, without metadata/source maps.
function clean(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name.startsWith('.') || entry.name.endsWith('.map'))
      rmSync(path, { recursive: true, force: true })
    else if (entry.isDirectory()) clean(path)
  }
}
clean(fileURLToPath(new URL('../dist', import.meta.url)))
