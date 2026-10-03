/**
 * Which servers a scenario run is on, from the environment, and the known gaps
 * that apply to it.
 *
 * SCENARIO_IMAGE picks the server for both sides (default: PostgreSQL 15, the
 * major Supabase runs). SCENARIO_SOURCE_IMAGE and SCENARIO_TARGET_IMAGE make
 * the two sides different servers — a version upgrade, a Supabase source and a
 * plain target. Twins can never show what differs between servers.
 */
import { expect } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import knownGaps from './known-gaps.json' with { type: 'json' }

export function scenarioHarness(): PgHarness {
  return new PgHarness({
    image: process.env.SCENARIO_IMAGE ?? 'docker.io/library/postgres:15-alpine',
    images: {
      source: process.env.SCENARIO_SOURCE_IMAGE || undefined,
      target: process.env.SCENARIO_TARGET_IMAGE || undefined,
    },
    verbose: !!process.env.E2E_VERBOSE,
    keep: !!process.env.E2E_KEEP,
  })
}

/** `pg17→pg15`, or `pg15` when both sides run the same major. */
export async function topologyLabel(h: PgHarness): Promise<string> {
  const major = async (role: 'source' | 'target') => Math.floor(Number(await h.sql(role, 'SHOW server_version_num')) / 10000)
  const [s, t] = [await major('source'), await major('target')]
  return s === t ? `pg${s}` : `pg${s}→pg${t}`
}

type Gaps = Record<string, string>
type Corpus = 'migrations' | 'equivalences' | 'data'
interface KnownGaps {
  migrations: Gaps
  equivalences: Gaps
  data?: Gaps
  topologies: Record<string, Partial<Record<Corpus, Gaps>>>
}

/** The known gaps for a corpus on this topology: everywhere's, plus its own. */
export function gapsFor(corpus: Corpus, topology: string): Gaps {
  const all = knownGaps as unknown as KnownGaps
  return { ...(all[corpus] ?? {}), ...(all.topologies[topology]?.[corpus] ?? {}) }
}

/**
 * Judge one scenario's violations against its known gap, if it has one.
 *
 * A listed scenario must still fail: one that passes fails the suite until it
 * is removed, so the list can only shrink. Except with SCENARIO_FIXED_GAPS=
 * report — DBDiff's CI runs these against its own unreleased change, and a
 * gap that change fixes is SupaForge's to clear when it takes the release,
 * not a failure there.
 */
export function judge(name: string, violations: string[], gap: string | undefined): void {
  if (gap) {
    if (violations.length === 0) {
      if (process.env.SCENARIO_FIXED_GAPS === 'report') {
        process.stderr.write(`known gap fixed by this DBDiff: ${name}\n`)
        return
      }
      expect.fail(`${name} now passes; remove it from known-gaps.json`)
    }
    return
  }
  expect(violations, violations.join('\n\n')).toEqual([])
}
