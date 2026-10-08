/**
 * Every schema change in @akal/pg-conformance's `migrations` corpus, in
 * both directions, through the real CLI — see runner.ts for what is checked.
 *
 * The corpus is shared with DBDiff, so a scenario added there is exercised
 * here on the next version bump, with no test written for it.
 *
 * Which servers it runs on, and the known gaps for them: see topology.ts.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { loadCorpus } from '@akal/pg-conformance'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { runScenario, type Scenario } from './runner.js'
import { scenarioHarness, topologyLabel, gapsFor, judge } from './topology.js'

const describeE2E = describeWithContainers()

const scenarios: Array<{ key: string; name: string; minPgVersion?: number; scenario: Scenario }> =
  loadCorpus('migrations').flatMap((c, i) => [
    {
      key: `m${i}f`, name: `${c.id} (before → after)`, minPgVersion: c.minPgVersion,
      scenario: { id: c.id, source: c.after, target: c.before, preserve: c.preserve },
    },
    {
      key: `m${i}r`, name: `${c.id} (after → before)`, minPgVersion: c.minPgVersion,
      scenario: { id: c.id, source: c.before, target: c.after, preserve: c.preserve },
    },
  ])

describeE2E('scenarios: the migrations corpus', () => {
  let h: PgHarness
  let gaps: Record<string, string> = {}
  let versions: { source: number; target: number }
  let serversBefore: unknown

  beforeAll(async () => {
    h = scenarioHarness()
    await h.up()
    gaps = gapsFor('migrations', await topologyLabel(h))
    const version = async (role: 'source' | 'target') => Math.floor(Number(await h.sql(role, 'SHOW server_version_num')) / 10000)
    versions = { source: await version('source'), target: await version('target') }
    serversBefore = { source: await h.serverState('source'), target: await h.serverState('target') }
  }, 300_000)

  afterAll(async () => {
    try {
      // Every scenario drops its own databases, so the servers end as they began.
      if (h && serversBefore) {
        expect({ source: await h.serverState('source'), target: await h.serverState('target') })
          .toEqual(serversBefore)
      }
    } finally {
      await h?.down()
    }
  }, 120_000)

  // A loop rather than it.each: each's $name truncates a title at 40
  // characters, and the title is the key known-gaps.json is matched on.
  for (const { key, name, minPgVersion, scenario } of scenarios) it.concurrent(name, async () => {
    if (minPgVersion && Math.min(versions.source, versions.target) < minPgVersion) return

    const { violations } = await runScenario(h, key, scenario)
    judge(name, violations, gaps[name])
  }, 600_000)
})
