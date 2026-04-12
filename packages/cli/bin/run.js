#!/usr/bin/env node
import {execute} from '@oclif/core'

await execute({dir: import.meta.url}).catch((err) => {
  // oclif handles CLIError internally — this catches truly unexpected errors.
  if (err && typeof err === 'object' && 'oclif' in err) return
  process.stderr.write(`\nUnexpected error: ${err?.message ?? err}\n`)
  process.stderr.write('If this looks like a bug, please report it:\n')
  process.stderr.write('  https://github.com/akalforge/supaforge/issues/new\n\n')
  process.exitCode = 1
})
