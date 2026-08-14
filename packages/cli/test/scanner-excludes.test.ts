import { describe, it, expect } from 'vitest'
import { resolveExcludedChecks } from '../src/scanner.js'
import type { SupaForgeConfig } from '../src/types/config.js'

// ── Issue #29 ─────────────────────────────────────────────────────────────
// A check can be fine against a fast local clone and hopeless against a
// remote environment, so a single top-level checks.exclude was too coarse.

function cfg(over: Partial<SupaForgeConfig> = {}): SupaForgeConfig {
  return {
    environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
    source: 'dev',
    target: 'prod',
    ...over,
  } as SupaForgeConfig
}

describe('resolveExcludedChecks (issue #29)', () => {
  it('returns the top-level exclusions', () => {
    expect(resolveExcludedChecks(cfg({ checks: { exclude: ['storage'] } }))).toEqual(['storage'])
  })

  it('returns the target environment exclusions', () => {
    const config = cfg({
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '', checks: { exclude: ['schema'] } } },
    })
    expect(resolveExcludedChecks(config)).toEqual(['schema'])
  })

  it('unions both, so neither silently overrides the other', () => {
    const config = cfg({
      checks: { exclude: ['storage'] },
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '', checks: { exclude: ['schema'] } } },
    })
    expect(resolveExcludedChecks(config).sort()).toEqual(['schema', 'storage'])
  })

  it('keys on the target, not the source — checks read from the target', () => {
    const config = cfg({
      environments: { dev: { dbUrl: '', checks: { exclude: ['schema'] } }, prod: { dbUrl: '' } },
    })
    expect(resolveExcludedChecks(config)).toEqual([])
  })

  it('ignores unknown check names rather than skipping nothing silently', () => {
    const config = cfg({ checks: { exclude: ['storage', 'not-a-check'] } })
    expect(resolveExcludedChecks(config)).toEqual(['storage'])
  })

  it('tolerates a malformed config rather than throwing', () => {
    // A bad config should narrow nothing, not take the scan down.
    expect(resolveExcludedChecks(cfg())).toEqual([])
    expect(resolveExcludedChecks(cfg({ checks: { exclude: 'storage' as never } }))).toEqual([])
    expect(resolveExcludedChecks(cfg({ target: 'missing-env' }))).toEqual([])
    expect(resolveExcludedChecks({} as SupaForgeConfig)).toEqual([])
  })
})
