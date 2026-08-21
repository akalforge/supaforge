import type { HookBus } from './hooks'
import type { CheckRegistry } from './checks/registry'
import type { SupaForgeConfig } from './types/config'
import type { CheckName, CheckResult, ScanResult } from './types/drift'
import type { TableFilter } from './utils/table-filter'
import { resolveTableFilter } from './utils/table-filter'
import { CHECK_NAMES } from './types/drift'
import { computeScore, computePostureScore, summarize } from './scoring'
import type { Check, CheckContext } from './checks/base'
import { isCheckSkipped } from './checks/base'
import { friendlyDbError } from './utils/error'

export type ScanProgressEvent =
  | { phase: 'check:start'; check: CheckName; index: number; total: number }
  | { phase: 'check:done'; check: CheckName; index: number; total: number; status: CheckResult['status']; issueCount: number; durationMs: number; skipReason?: string }

export interface ScanOptions {
  config: SupaForgeConfig
  /** Whitelist: only run these checks. Defaults to all checks. */
  checks?: CheckName[]
  /** Blacklist: skip these checks (CLI --skip flag). Merged with config.checks.exclude. */
  skip?: CheckName[]
  onProgress?: (event: ScanProgressEvent) => void
  /** Fine-grained progress from within a single check, e.g. "42 tables · users". */
  onDetail?: (check: CheckName, detail: string) => void
  /**
   * Scope the schema and data comparisons to a subset of tables (issue #43).
   * Merged with the config's own `checks.tables` / `checks.excludeTables`.
   */
  tableFilter?: TableFilter
}

/**
 * Checks to skip: the top-level `checks.exclude` unioned with the target
 * environment's own `checks.exclude`.
 *
 * Per-environment because a check can be fine against a fast local clone and
 * hopeless against a remote environment (issue #29). Keyed on the *target*,
 * which is the environment every check reads from.
 *
 * Tolerates a malformed config — a non-array or an unknown environment name
 * yields no extra exclusions rather than throwing, so a bad config narrows
 * nothing instead of taking the scan down.
 */
export function resolveExcludedChecks(config: SupaForgeConfig): CheckName[] {
  const lists = [config?.checks?.exclude, config?.environments?.[config?.target ?? '']?.checks?.exclude]
  const out: CheckName[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const name of list) {
      if (typeof name === 'string' && (CHECK_NAMES as readonly string[]).includes(name)) {
        out.push(name as CheckName)
      }
    }
  }
  return out
}

/**
 * Run one check and classify the outcome.
 *
 * Three outcomes, not two: a check can compare and find nothing, or decline to
 * run. Collapsing the second into the first is what made a layer that never
 * opened a connection render as a green pass (issue #42).
 */
async function runCheck(
  check: Check,
  ctx: CheckContext,
  name: CheckName,
  sourceDbUrl: string,
): Promise<CheckResult> {
  const start = performance.now()
  try {
    const issues = await check.scan(ctx)
    return {
      check: name,
      status: issues.length > 0 ? 'drifted' : 'clean',
      issues,
      durationMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - start)

    // A skip is a normal outcome, not a failure — the layer declined to run
    // for a reason the user can act on, rather than breaking (issue #42).
    if (isCheckSkipped(err)) {
      return { check: name, status: 'skipped', issues: [], skipReason: err.message, durationMs }
    }
    return {
      check: name,
      status: 'error',
      issues: [],
      error: friendlyDbError(err, sourceDbUrl),
      durationMs,
    }
  }
}

export async function scan(
  registry: CheckRegistry,
  options: ScanOptions,
  bus?: HookBus,
): Promise<ScanResult> {
  const { config } = options
  const skipSet = new Set([...(options.skip ?? []), ...resolveExcludedChecks(config)])
  const checksToScan = (options.checks ?? [...CHECK_NAMES]).filter(n => !skipSet.has(n))

  const source = config.environments[config.source!]
  const target = config.environments[config.target!]
  const tableFilter = options.tableFilter ?? resolveTableFilter(config)
  const ctx = { source, target, config, tableFilter }

  await bus?.emit('supaforge.scan.before', ctx)

  const results: CheckResult[] = []

  for (let i = 0; i < checksToScan.length; i++) {
    const name = checksToScan[i]
    const check = registry.get(name)
    const total = checksToScan.length

    options.onProgress?.({ phase: 'check:start', check: name, index: i, total })

    // Sub-check progress (e.g. the schema diff's table counter) is reported
    // through the same channel, tagged with the owning check.
    const checkCtx = {
      ...ctx,
      onDetail: options.onDetail ? (detail: string) => options.onDetail?.(name, detail) : undefined,
    }

    if (!check) {
      const skipReason = 'not registered'
      results.push({ check: name, status: 'skipped', issues: [], skipReason, durationMs: 0 })
      options.onProgress?.({ phase: 'check:done', check: name, index: i, total, status: 'skipped', issueCount: 0, durationMs: 0, skipReason })
      continue
    }

    await bus?.emit('supaforge.check.before', { check: name })

    const result = await runCheck(check, checkCtx, name, source.dbUrl)
    results.push(result)
    options.onProgress?.({
      phase: 'check:done',
      check: name,
      index: i,
      total,
      status: result.status,
      issueCount: result.issues.length,
      durationMs: result.durationMs,
      ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    })

    await bus?.emit('supaforge.check.after', { check: name, result })
  }

  const summary = summarize(results)
  const score = computeScore(results)
  const postureScore = computePostureScore(results)

  const scanResult: ScanResult = {
    timestamp: new Date().toISOString(),
    source: config.source!,
    target: config.target!,
    checks: results,
    score,
    postureScore,
    summary,
  }

  await bus?.emit('supaforge.scan.after', scanResult)

  return scanResult
}
