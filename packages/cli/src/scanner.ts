import type { HookBus } from './hooks'
import type { CheckRegistry } from './checks/registry'
import type { SupaForgeConfig } from './types/config'
import type { CheckName, CheckResult, ScanResult } from './types/drift'
import { CHECK_NAMES } from './types/drift'
import { computeScore, summarize } from './scoring'

export interface ScanOptions {
  config: SupaForgeConfig
  checks?: CheckName[]
}

export async function scan(
  registry: CheckRegistry,
  options: ScanOptions,
  bus?: HookBus,
): Promise<ScanResult> {
  const { config } = options
  const checksToScan = options.checks ?? [...CHECK_NAMES]

  const source = config.environments[config.source!]
  const target = config.environments[config.target!]
  const ctx = { source, target, config }

  await bus?.emit('supaforge.scan.before', ctx)

  const results: CheckResult[] = []

  for (const name of checksToScan) {
    const check = registry.get(name)
    if (!check) {
      results.push({ check: name, status: 'skipped', issues: [], durationMs: 0 })
      continue
    }

    await bus?.emit('supaforge.check.before', { check: name })
    const start = performance.now()

    try {
      const issues = await check.scan(ctx)
      const durationMs = Math.round(performance.now() - start)
      const status = issues.length > 0 ? 'drifted' : 'clean'
      results.push({ check: name, status, issues, durationMs })
    } catch (err) {
      const durationMs = Math.round(performance.now() - start)
      results.push({
        check: name,
        status: 'error',
        issues: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      })
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
