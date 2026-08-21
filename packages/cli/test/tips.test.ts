import { describe, it, expect } from 'vitest'
import { pickTip, renderTip } from '../src/tips.js'
import type { TipContext } from '../src/tips.js'

// Use a fixed seed so tests aren't flaky
const SEED = 0

describe('pickTip — diff: summary mode with drift', () => {
  const ctx: TipContext = { command: 'diff', detail: false, driftTotal: 3, driftedChecks: ['rls', 'schema'] }

  it('returns a non-null string', () => {
    expect(pickTip(ctx, SEED)).not.toBeNull()
  })

  it('mentions --detail or --apply in the tip', () => {
    // The contextual pool for summary+drift contains --detail and --apply tips
    const tips = [0, 1, 2, 3].map(s => pickTip(ctx, s) ?? '')
    const combined = tips.join(' ')
    expect(combined).toMatch(/--detail|--apply/)
  })

  it('suggests the first drifted check when multiple checks drifted', () => {
    const tips = [0, 1, 2, 3].map(s => pickTip(ctx, s) ?? '')
    const combined = tips.join(' ')
    expect(combined).toMatch(/--check=rls|--skip/)
  })
})

describe('pickTip — diff: detail mode with drift', () => {
  const ctx: TipContext = { command: 'diff', detail: true, driftTotal: 2, driftedChecks: ['schema', 'rls'] }

  it('mentions --apply', () => {
    const tips = [0, 1, 2].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/--apply/)
  })
})

describe('pickTip — diff: clean', () => {
  const ctx: TipContext = { command: 'diff', driftTotal: 0, driftedChecks: [] }

  it('mentions snapshot or CI', () => {
    const tips = [0, 1, 2, 3].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/snapshot|CI|--check/)
  })
})

describe('pickTip — diff: apply mode', () => {
  it('after apply with remaining drift mentions re-run or snapshot', () => {
    const ctx: TipContext = { command: 'diff', apply: true, driftTotal: 2, driftedChecks: ['rls'] }
    const tips = [0, 1].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/diff|snapshot/)
  })

  it('after apply with no drift mentions snapshot', () => {
    const ctx: TipContext = { command: 'diff', apply: true, driftTotal: 0 }
    const tip = pickTip(ctx, SEED) ?? ''
    expect(tip).toMatch(/snapshot|No drift/)
  })
})

describe('pickTip — diff: skip hints for clone noise', () => {
  it('suggests --skip when no checks are skipped and there is drift', () => {
    const ctx: TipContext = {
      command: 'diff',
      detail: false,
      driftTotal: 5,
      driftedChecks: ['storage', 'auth'],
      skippedChecks: [],
    }
    const tips = [0, 1, 2, 3].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/--skip|--detail|--apply/)
  })
})

describe('pickTip — clone', () => {
  it('dry-run: hints to add --apply', () => {
    const ctx: TipContext = { command: 'clone', cloneApplied: false }
    const tip = pickTip(ctx, SEED) ?? ''
    expect(tip).toMatch(/--apply/)
  })

  it('after clone: mentions --skip for storage/auth/vault noise', () => {
    const ctx: TipContext = { command: 'clone', cloneApplied: true }
    const tips = [0, 1, 2].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/--skip|storage|restore|snapshot/)
  })
})

describe('pickTip — snapshot', () => {
  it('list mode: mentions prune or restore', () => {
    const ctx: TipContext = { command: 'snapshot', snapshotList: true }
    const tips = [0, 1].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/prune|restore/)
  })

  it('migration mode: mentions migrations dir or restore', () => {
    const ctx: TipContext = { command: 'snapshot', snapshotMigration: true }
    const tips = [0, 1].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/migration|restore/)
  })

  it('plain capture: mentions --migration or --list', () => {
    const ctx: TipContext = { command: 'snapshot', snapshotMigration: false, snapshotList: false }
    const tips = [0, 1, 2].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/--migration|--list|restore/)
  })
})

describe('pickTip — restore', () => {
  it('returns a tip mentioning diff or snapshot', () => {
    const ctx: TipContext = { command: 'restore' }
    const tips = [0, 1].map(s => pickTip(ctx, s) ?? '')
    expect(tips.join(' ')).toMatch(/diff|snapshot/)
  })
})

describe('renderTip', () => {
  it('returns a string starting with a newline and containing "tip:"', () => {
    const out = renderTip({ command: 'diff', driftTotal: 1, driftedChecks: ['rls'] })
    expect(out).toMatch(/tip:/)
    expect(out.startsWith('\n')).toBe(true)
  })

  it('never returns empty string — always has content', () => {
    const contexts: TipContext[] = [
      { command: 'diff', driftTotal: 0 },
      { command: 'clone', cloneApplied: true },
      { command: 'snapshot', snapshotList: false },
      { command: 'restore' },
    ]
    for (const ctx of contexts) {
      expect(renderTip(ctx).length).toBeGreaterThan(0)
    }
  })
})

describe('pickTip — general pool fallback', () => {
  it('falls back to a general tip for unknown scenarios', () => {
    // Pass an effectively empty context to exercise fallback
    const ctx: TipContext = { command: 'diff', driftTotal: 0, driftedChecks: [], apply: false, detail: false }
    // With a clean result and no --apply, pool has contextual items — still non-null
    expect(pickTip(ctx, SEED)).not.toBeNull()
  })
})

// ── Regression: issue #29 ─────────────────────────────────────────────────
// With the only check errored, the tip read "Environments are in sync — run
// supaforge snapshot to capture this state." Nothing had been compared.

describe('renderTip with errored checks (issue #29)', () => {
  const errored: TipContext = {
    command: 'diff', detail: false, driftTotal: 0, erroredChecks: ['schema'],
  }

  it('never says environments are in sync when a check could not run', () => {
    const out = renderTip(errored)
    expect(out).not.toContain('in sync')
  })

  it('says drift is unknown and names the failed check', () => {
    // renderTip draws one tip from the pool, so assert across the pool.
    const seen = new Set<string>()
    for (let seed = 0; seed < 12; seed++) seen.add(String(pickTip(errored, seed)))
    const pool = [...seen].join(' ')
    expect(pool).toContain('unknown')
    expect(pool).toContain('schema')
  })

  it('every tip offered for an errored scan avoids implying success', () => {
    for (let seed = 0; seed < 12; seed++) {
      const tip = String(pickTip(errored, seed))
      expect(tip).not.toContain('in sync')
      expect(tip).not.toContain('capture this state')
    }
  })

  it('still offers the in-sync tip on a genuinely clean scan', () => {
    const clean: TipContext = { command: 'diff', detail: false, driftTotal: 0, erroredChecks: [] }
    // pickTip rotates, so check the pool rather than a single draw.
    const seen = new Set<string>()
    for (let seed = 0; seed < 12; seed++) seen.add(String(pickTip(clean, seed)))
    expect([...seen].join(' ')).toContain('in sync')
  })

  it('treats a missing erroredChecks as none, for older callers', () => {
    const legacy: TipContext = { command: 'diff', detail: false, driftTotal: 0 }
    const seen = new Set<string>()
    for (let seed = 0; seed < 12; seed++) seen.add(String(pickTip(legacy, seed)))
    expect([...seen].join(' ')).toContain('in sync')
  })
})

/**
 * Issue #48 (4): on a clone → remote diff, "push all fixes to the target in one
 * shot" means reshaping a shared remote to match a vanilla-PostgreSQL copy,
 * dropping the roles and policies the clone never had. The tip has to stop
 * reading as a recommendation in that direction.
 */
describe('pickTip — diff: --apply advice depends on the direction (issue #48)', () => {
  const drifted: TipContext['driftedChecks'] = ['schema', 'roles']

  function allTips(ctx: TipContext): string {
    return [0, 1, 2, 3, 4, 5].map(s => pickTip(ctx, s) ?? '').join(' ')
  }

  it('recommends --apply plainly when the source is not a clone', () => {
    const combined = allTips({ command: 'diff', detail: false, driftTotal: 3, driftedChecks: drifted })
    expect(combined).toMatch(/push all fixes to the target in one shot/)
  })

  it('warns instead of recommending when the source is a clone', () => {
    const ctx: TipContext = {
      command: 'diff', detail: false, driftTotal: 3, driftedChecks: drifted, sourceIsClone: true,
    }
    const combined = allTips(ctx)
    expect(combined).not.toMatch(/push all fixes to the target in one shot/)
    expect(combined).toMatch(/Source is a local clone/)
    expect(combined).toMatch(/roles, grants and policies the clone never had/)
  })

  it('points a clone diff at a scoped dry run rather than a bare apply', () => {
    const ctx: TipContext = {
      command: 'diff', detail: false, driftTotal: 3, driftedChecks: drifted, sourceIsClone: true,
    }
    expect(allTips(ctx)).toMatch(/--check=schema --apply --dry-run/)
  })

  it('carries the same warning into --detail mode', () => {
    const ctx: TipContext = {
      command: 'diff', detail: true, driftTotal: 3, driftedChecks: drifted, sourceIsClone: true,
    }
    const combined = allTips(ctx)
    expect(combined).toMatch(/Source is a local clone/)
    expect(combined).not.toMatch(/execute all the SQL fixes above/)
  })

  it('still names --apply in --detail mode when the source is not a clone', () => {
    const ctx: TipContext = { command: 'diff', detail: true, driftTotal: 3, driftedChecks: drifted }
    expect(allTips(ctx)).toMatch(/execute all the SQL fixes above/)
  })
})
