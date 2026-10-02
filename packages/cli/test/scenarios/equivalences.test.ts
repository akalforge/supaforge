/**
 * @akalforge/pg-conformance's `equivalences` corpus: one schema written as a
 * developer writes it and as PostgreSQL renders it. Compared either way round,
 * the pair is the same schema, so every comparison check must find nothing.
 *
 * Reporting drift here is the false positive that sends a user to "fix" two
 * environments that already match — and, applied, rewrites a correct object.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { loadCorpus } from '@akalforge/pg-conformance'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { comparisonFindings } from './runner.js'
import { scenarioHarness, topologyLabel, gapsFor, judge } from './topology.js'

const describeE2E = describeWithContainers()

const pairs = loadCorpus('equivalences').flatMap((c, i) => [
  { key: `e${i}a`, name: `${c.id} (written vs rendered)`, source: c.written, target: c.rendered },
  { key: `e${i}b`, name: `${c.id} (rendered vs written)`, source: c.rendered, target: c.written },
])

describeE2E('scenarios: the equivalences corpus', () => {
  let h: PgHarness
  let gaps: Record<string, string> = {}

  beforeAll(async () => {
    h = scenarioHarness()
    await h.up()
    gaps = gapsFor('equivalences', await topologyLabel(h))
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  // The control: without it, a scan that silently skipped every check would
  // pass every case above.
  it('reports a pair that really differs', async () => {
    const findings = await comparisonFindings(h, 'ectl', 'CREATE TABLE t (id int, n int);', 'CREATE TABLE t (id int);')
    expect(findings.some(f => f.startsWith('schema:'))).toBe(true)
  }, 600_000)

  // A loop rather than it.each, whose $name truncates the title known-gaps.json
  // is matched on.
  for (const { key, name, source, target } of pairs) it.concurrent(name, async () => {
    const findings = await comparisonFindings(h, key, source, target)
    judge(name, findings, gaps[name])
  }, 600_000)
})
