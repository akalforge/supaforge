/**
 * Integration tests for `supaforge diff` against real Postgres containers.
 *
 * Validates the detailed drift output includes SQL fixes.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../src/scanner.js'
import { createDefaultRegistry } from '../../src/checks/index.js'
import type { ScanResult } from '../../src/types/drift.js'
import { skipIfNoContainers, makeConfig } from './helpers.js'

describe('integration: diff (detailed scan)', () => {
  let result: ScanResult
  const config = makeConfig()

  beforeAll(async () => {
    if (skipIfNoContainers()) return
    const registry = createDefaultRegistry()
    result = await scan(registry, { config })
  })

  it.skipIf(skipIfNoContainers())('should include SQL fix suggestions for drifted checks', () => {
    const rls = result.checks.find(l => l.check === 'rls')!
    expect(rls.status).toBe('drifted')

    // Each RLS issue should have SQL remediation
    for (const issue of rls.issues) {
      expect(issue.sql, `${issue.id} should have sql`).toBeDefined()
    }
  })

  it.skipIf(skipIfNoContainers())('should include SQL for cron drift', () => {
    const cron = result.checks.find(l => l.check === 'cron')!
    expect(cron.status).toBe('drifted')

    const missingDigest = cron.issues.find(i => i.id.includes('weekly_digest'))
    expect(missingDigest).toBeDefined()
    expect(missingDigest!.sql).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should include SQL for webhook drift', () => {
    const webhooks = result.checks.find(l => l.check === 'webhooks')!
    expect(webhooks.status).toBe('drifted')
    expect(webhooks.issues.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(skipIfNoContainers())('should produce schema diff with SQL', () => {
    const schema = result.checks.find(l => l.check === 'schema')!
    expect(schema.status).toBe('drifted')
    // Schema issues should contain SQL from @dbdiff/cli
    const withSql = schema.issues.filter(i => i.sql)
    expect(withSql.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(skipIfNoContainers())('should produce enum diff with CREATE TYPE and DROP+CREATE SQL', () => {
    const schema = result.checks.find(l => l.check === 'schema')!

    // Missing mood enum → CREATE TYPE in UP
    const createMood = schema.issues.find(i => i.sql?.up.match(/CREATE TYPE.*mood/i))
    expect(createMood).toBeDefined()
    expect(createMood!.sql!.up).toMatch(/CREATE TYPE.*mood.*ENUM/i)

    // post_status missing 'archived' → dbdiff recreates via DROP + CREATE
    const postStatusIssues = schema.issues.filter(i =>
      i.sql?.up.match(/post_status/i),
    )
    expect(postStatusIssues.length).toBeGreaterThanOrEqual(1)
    const allUp = postStatusIssues.map(i => i.sql!.up).join('\n')
    expect(allUp).toMatch(/post_status/i)
  })

  it.skipIf(skipIfNoContainers())('should produce data diff', () => {
    const data = result.checks.find(l => l.check === 'data')!
    // Data check should detect plan differences if configured
    // Without explicit data config, it may be clean
    expect(data).toBeDefined()
    expect(data.status).not.toBe('error')
  })

  it.skipIf(skipIfNoContainers())('diff with --check=rls returns only rls', async () => {
    const registry = createDefaultRegistry()
    const filtered = await scan(registry, { config, checks: ['rls'] })

    const active = filtered.checks.filter(l => l.status !== 'skipped')
    expect(active).toHaveLength(1)
    expect(active[0].check).toBe('rls')
    expect(active[0].status).toBe('drifted')
  })
})
