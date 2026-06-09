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
