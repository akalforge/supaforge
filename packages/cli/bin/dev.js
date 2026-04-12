#!/usr/bin/env tsx
import {execute} from '@oclif/core'

await execute({development: true, dir: import.meta.url}).catch((err) => {
  if (err && typeof err === 'object' && 'oclif' in err) return
  process.stderr.write(`\nUnexpected error: ${err?.message ?? err}\n`)
  process.stderr.write('If this looks like a bug, please report it:\n')
  process.stderr.write('  https://github.com/akalforge/supaforge/issues/new\n\n')
  process.exitCode = 1
})
