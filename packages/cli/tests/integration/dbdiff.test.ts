/**
 * Integration tests for @dbdiff/cli invocation via supaforge's dbdiff adapter.
 *
 * Verifies that:
 * 1. resolveDbDiffBin() finds the installed binary
 * 2. runDbDiff() produces valid UP/DOWN SQL against real Postgres
 * 3. SchemaLayer and DataLayer return DriftIssues via the real CLI
 *
 * Requires containers from scripts/test-integration.sh or CI services.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { runDbDiff, resolveDbDiffBin, parseDbDiffOutput, sqlToIssues } from '../../src/dbdiff'
import { SchemaLayer } from '../../src/layers/schema'
import { DataLayer } from '../../src/layers/data'
import type { LayerContext } from '../../src/layers/base'
import { SOURCE_URL, TARGET_URL, skipIfNoContainers } from './helpers'

function makeContext(overrides?: Partial<LayerContext>): LayerContext {
  return {
    source: { dbUrl: SOURCE_URL! },
    target: { dbUrl: TARGET_URL! },
    config: {
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: TARGET_URL! },
      },
      source: 'source',
      target: 'target',
      layers: {
        data: { tables: ['plans'] },
      },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Binary resolution
// ---------------------------------------------------------------------------
describe('integration: resolveDbDiffBin', () => {
  it('resolves to local node + dbdiff.js binary', () => {
    const { command, prefixArgs } = resolveDbDiffBin()
    expect(command).toBe(process.execPath)
    expect(prefixArgs).toHaveLength(1)
    expect(prefixArgs[0]).toContain('dbdiff')
  })
})

// ---------------------------------------------------------------------------
// 2. Raw CLI invocation — schema diff
// ---------------------------------------------------------------------------
describe('integration: runDbDiff schema', () => {
  it.skipIf(skipIfNoContainers())('returns parseable UP/DOWN output for schema diff', async () => {
    const result = await runDbDiff({
      sourceUrl: SOURCE_URL!,
      targetUrl: TARGET_URL!,
      type: 'schema',
      include: 'both',
    })

    // Source and target have identical table structure but source has an
    // extra column (bio on users) added by the seed fixture, so we expect
    // at least one ALTER statement.
    expect(result).toHaveProperty('up')
    expect(result).toHaveProperty('down')

    // The schema diff should detect the extra "bio" column on source.users
    expect(result.up).toContain('bio')
  })

  it.skipIf(skipIfNoContainers())('handles identical schemas with empty output', async () => {
    // Diff source against itself — should be empty
    const result = await runDbDiff({
      sourceUrl: SOURCE_URL!,
      targetUrl: SOURCE_URL!,
      type: 'schema',
      include: 'both',
    })

    expect(result.up).toBe('')
    expect(result.down).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 3. Raw CLI invocation — data diff
// ---------------------------------------------------------------------------
describe('integration: runDbDiff data', () => {
  it.skipIf(skipIfNoContainers())('detects reference data drift in plans table', async () => {
    const result = await runDbDiff({
      sourceUrl: SOURCE_URL!,
      targetUrl: TARGET_URL!,
      type: 'data',
      include: 'both',
      tables: ['plans'],
    })

    expect(result.up).toBeTruthy()

    // Source has Enterprise plan (missing in target) and different Pro price
    const issues = sqlToIssues(result, 'data')
    expect(issues.length).toBeGreaterThanOrEqual(1)

    // Should detect the missing Enterprise plan or the price difference
    const plansMentioned = issues.some(i => i.title.includes('plans'))
    expect(plansMentioned).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. SchemaLayer with real CLI
// ---------------------------------------------------------------------------
describe('integration: SchemaLayer via @dbdiff/cli', () => {
  it.skipIf(skipIfNoContainers())('produces DriftIssues from real schema diff', async () => {
    const layer = new SchemaLayer() // uses real runDbDiff
    const issues = await layer.scan(makeContext())

    // Source has extra "bio" column → at least one schema issue
    expect(issues.length).toBeGreaterThanOrEqual(1)
    expect(issues[0].layer).toBe('schema')
    expect(issues[0].sql?.up).toBeTruthy()
    expect(issues[0].sql?.down).toBeTruthy()
  })

  it.skipIf(skipIfNoContainers())('returns empty when diffing source against itself', async () => {
    const layer = new SchemaLayer()
    const ctx = makeContext({
      target: { dbUrl: SOURCE_URL! },
    })
    ctx.config.environments.target = { dbUrl: SOURCE_URL! }

    const issues = await layer.scan(ctx)
    expect(issues).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. DataLayer with real CLI
// ---------------------------------------------------------------------------
describe('integration: DataLayer via @dbdiff/cli', () => {
  it.skipIf(skipIfNoContainers())('detects data drift in plans table', async () => {
    const layer = new DataLayer() // uses real runDbDiff
    const issues = await layer.scan(makeContext())

    expect(issues.length).toBeGreaterThanOrEqual(1)
    expect(issues[0].layer).toBe('data')
  })

  it.skipIf(skipIfNoContainers())('returns empty when no data tables configured', async () => {
    const layer = new DataLayer()
    const ctx = makeContext()
    ctx.config.layers = {} // no data tables
    const issues = await layer.scan(ctx)
    expect(issues).toHaveLength(0)
  })
})
