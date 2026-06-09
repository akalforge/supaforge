import type { HookBus } from './hooks'
import type { CheckRegistry } from './checks/registry'
import type { SupaForgeConfig } from './types/config'
import type { CheckName, CheckResult, ScanResult } from './types/drift'
import { CHECK_NAMES } from './types/drift'
import { computeScore, summarize } from './scoring'
import { friendlyDbError } from './utils/error'

export type ScanProgressEvent =
  | { phase: 'check:start'; check: CheckName; index: number; total: number }
  | { phase: 'check:done'; check: CheckName; index: number; total: number; status: CheckResult['status']; issueCount: number; durationMs: number }

export interface ScanOptions {
  config: SupaForgeConfig
  /** Whitelist: only run these checks. Defaults to all checks. */
  checks?: CheckName[]
  /** Blacklist: skip these checks (CLI --skip flag). Merged with config.checks.exclude. */
  skip?: CheckName[]
  onProgress?: (event: ScanProgressEvent) => void
}

export async function scan(
  registry: CheckRegistry,
  options: ScanOptions,
  bus?: HookBus,
): Promise<ScanResult> {
  const { config } = options
  const configExclude = (config.checks?.exclude ?? []) as CheckName[]
  const skipSet = new Set([...(options.skip ?? []), ...configExclude])
  const checksToScan = (options.checks ?? [...CHECK_NAMES]).filter(n => !skipSet.has(n))

  const source = config.environments[config.source!]
  const target = config.environments[config.target!]
  const ctx = { source, target, config }

  await bus?.emit('supaforge.scan.before', ctx)

  const results: CheckResult[] = []

  for (let i = 0; i < checksToScan.length; i++) {
    const name = checksToScan[i]
    const check = registry.get(name)
    const total = checksToScan.length

    options.onProgress?.({ phase: 'check:start', check: name, index: i, total })

    if (!check) {
      results.push({ check: name, status: 'skipped', issues: [], durationMs: 0 })
      options.onProgress?.({ phase: 'check:done', check: name, index: i, total, status: 'skipped', issueCount: 0, durationMs: 0 })
      continue
    }

    await bus?.emit('supaforge.check.before', { check: name })
    const start = performance.now()

    try {
      const issues = await check.scan(ctx)
      const durationMs = Math.round(performance.now() - start)
      const status = issues.length > 0 ? 'drifted' : 'clean'
      results.push({ check: name, status, issues, durationMs })
      options.onProgress?.({ phase: 'check:done', check: name, index: i, total, status, issueCount: issues.length, durationMs })
    } catch (err) {
      const durationMs = Math.round(performance.now() - start)
      results.push({
        check: name,
        status: 'error',
        issues: [],
        error: friendlyDbError(err, source.dbUrl),
        durationMs,
      })
      options.onProgress?.({ phase: 'check:done', check: name, index: i, total, status: 'error', issueCount: 0, durationMs })
    }

    await bus?.emit('supaforge.check.after', { check: name, result: results.at(-1) })
  }

  const summary = summarize(results)
  const score = computeScore(results)

  const scanResult: ScanResult = {
    timestamp: new Date().toISOString(),
    source: config.source!,
    target: config.target!,
    checks: results,
    score,
    summary,
  }

  await bus?.emit('supaforge.scan.after', scanResult)

  return scanResult
}
