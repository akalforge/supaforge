import { describe, it, expect } from 'vitest'
import Diff from '../../src/commands/diff.js'
import Sync from '../../src/commands/sync.js'

// ─── issue #40: env vars belong in --help, not only the README ──────────────

interface WithEnvVars { envVars?: Array<{ name: string; description: string }> }

const envVarsOf = (cmd: unknown): WithEnvVars['envVars'] => (cmd as WithEnvVars).envVars

describe('diff declares the environment variables it reads (issue #40)', () => {
  it('lists every variable that changes diff behaviour', () => {
    // These were documented only in the README, and --help is where users look
    // first — the timeout ones in particular affect `diff` specifically.
    expect(envVarsOf(Diff)?.map(v => v.name)).toEqual([
      'SUPAFORGE_CONNECT_TIMEOUT',
      'SUPAFORGE_DBDIFF_TIMEOUT',
      'SUPAFORGE_DBDIFF_MEMORY',
    ])
  })

  it('gives each one a description and its default', () => {
    const vars = envVarsOf(Diff) ?? []
    expect(vars.length).toBeGreaterThan(0)
    expect(vars.every(v => v.description.trim().length > 0)).toBe(true)
    expect(vars.every(v => /default/i.test(v.description))).toBe(true)
  })

  it('sync inherits them, since it is diff --apply', () => {
    expect(envVarsOf(Sync)).toBe(envVarsOf(Diff))
  })
})
