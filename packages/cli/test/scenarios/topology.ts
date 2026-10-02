/**
 * Which servers a scenario run is on, from the environment, and the known gaps
 * that apply to it.
 *
 * SCENARIO_IMAGE picks the server for both sides (default: PostgreSQL 15, the
 * major Supabase runs). SCENARIO_SOURCE_IMAGE and SCENARIO_TARGET_IMAGE make
 * the two sides different servers — a version upgrade, a Supabase source and a
 * plain target. Twins can never show what differs between servers.
 */
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
interface KnownGaps {
  migrations: Gaps
  equivalences: Gaps
  topologies: Record<string, { migrations?: Gaps; equivalences?: Gaps }>
}

/** The known gaps for a corpus on this topology: everywhere's, plus its own. */
export function gapsFor(corpus: 'migrations' | 'equivalences', topology: string): Gaps {
  const all = knownGaps as unknown as KnownGaps
  return { ...all[corpus], ...(all.topologies[topology]?.[corpus] ?? {}) }
}
