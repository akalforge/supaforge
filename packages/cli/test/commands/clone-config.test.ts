import { describe, it, expect } from 'vitest'
import { configAfterClone } from '../../src/commands/clone.js'
import type { SupaForgeConfig } from '../../src/types/config.js'

/**
 * Where a clone leaves the project pointed (issue #89).
 *
 * `clone` used to set `source: local` and `target: <the environment cloned
 * from>`, and the closing guidance recommended a bare `supaforge diff --apply`.
 * Together those aimed the next unqualified apply at the hosted database the
 * clone had just been taken from — carrying the roles, grants and platform
 * absences the same screen warns about.
 */
describe('configAfterClone', () => {
  const base = (): SupaForgeConfig => ({
    environments: {
      dev: { dbUrl: 'postgresql://example/dev' },
      staging: { dbUrl: 'postgresql://example/staging' },
    },
    source: 'dev',
    target: 'staging',
  })

  it('makes the clone the target, so a bare apply writes into it', () => {
    const after = configAfterClone(base(), 'dev', 'postgresql://localhost/dev_clone')

    expect(after.target).toBe('local')
    expect(after.source).toBe('dev')
    expect(after.environments.local.dbUrl).toBe('postgresql://localhost/dev_clone')
  })

  it('never points the target at the environment that was cloned', () => {
    // The property that matters, stated directly: whatever else this function
    // does, an unqualified apply must not reach the cloned-from database.
    for (const env of ['dev', 'staging']) {
      const after = configAfterClone(base(), env, 'postgresql://localhost/c')
      expect(after.target).not.toBe(env)
      expect(after.target).toBe('local')
    }
  })

  it('keeps every other environment', () => {
    const after = configAfterClone(base(), 'dev', 'postgresql://localhost/c')

    expect(Object.keys(after.environments).sort()).toEqual(['dev', 'local', 'staging'])
    expect(after.environments.staging.dbUrl).toBe('postgresql://example/staging')
  })

  it('keeps unrelated config untouched', () => {
    const config: SupaForgeConfig = {
      ...base(),
      ignoreSchemas: ['auth', 'storage'],
      checks: { exclude: ['vault'], data: { tables: ['plans'] } },
    }

    const after = configAfterClone(config, 'dev', 'postgresql://localhost/c')

    expect(after.ignoreSchemas).toEqual(['auth', 'storage'])
    expect(after.checks).toEqual({ exclude: ['vault'], data: { tables: ['plans'] } })
  })

  it('repoints an existing local environment rather than duplicating it', () => {
    const config: SupaForgeConfig = {
      ...base(),
      environments: {
        ...base().environments,
        local: { dbUrl: 'postgresql://localhost/old_clone', projectRef: 'keep-me' },
      },
    }

    const after = configAfterClone(config, 'dev', 'postgresql://localhost/new_clone')

    expect(after.environments.local.dbUrl).toBe('postgresql://localhost/new_clone')
    // `local` names a database and the clone is the database it now names, but
    // anything else set on it is still the user's.
    expect(after.environments.local.projectRef).toBe('keep-me')
  })

  it('works when the config had no source or target', () => {
    const single: SupaForgeConfig = {
      environments: { prod: { dbUrl: 'postgresql://example/prod' } },
    }

    const after = configAfterClone(single, 'prod', 'postgresql://localhost/c')

    expect(after.source).toBe('prod')
    expect(after.target).toBe('local')
  })
})
