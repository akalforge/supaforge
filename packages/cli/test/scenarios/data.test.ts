/**
 * @akal/pg-conformance's `data` corpus through the data check, which
 * syncs a project's reference data — see runDataScenario() for what is
 * checked. The values are the ones found quoted wrongly, or not handled at
 * all: text needing quoting, JSON, bytea, a table with no key.
 *
 * Which servers it runs on, and the known gaps for them: see topology.ts.
 */
import { it, beforeAll, afterAll } from 'vitest'
import { loadCorpus } from '@akal/pg-conformance'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { runDataScenario } from './runner.js'
import { scenarioHarness, topologyLabel, gapsFor, judge } from './topology.js'

const describeE2E = describeWithContainers()

const cases = loadCorpus('data').map((c, i) => ({ key: `d${i}`, name: c.id, minPgVersion: c.minPgVersion, scenario: c }))

describeE2E('scenarios: the data corpus', () => {
  let h: PgHarness
  let gaps: Record<string, string> = {}
  let oldest = 0

  beforeAll(async () => {
    h = scenarioHarness()
    await h.up()
    gaps = gapsFor('data', await topologyLabel(h))
    const major = async (role: 'source' | 'target') => Math.floor(Number(await h.sql(role, 'SHOW server_version_num')) / 10000)
    oldest = Math.min(await major('source'), await major('target'))
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  // A loop rather than it.each, whose $name truncates the title known-gaps.json
  // is matched on.
  for (const { key, name, minPgVersion, scenario } of cases) it.concurrent(name, async () => {
    if (minPgVersion && oldest < minPgVersion) return
    judge(name, await runDataScenario(h, key, scenario), gaps[name])
  }, 600_000)
})
