import type { HookBus } from './hooks'
import type { LayerRegistry } from './layers/registry'
import type { SupaForgeConfig } from './types/config'
import type { LayerName, LayerResult, ScanResult } from './types/drift'
import { LAYER_NAMES } from './types/drift'
import { computeScore, summarize } from './scoring'

export interface ScanOptions {
  config: SupaForgeConfig
  layers?: LayerName[]
}

export async function scan(
  registry: LayerRegistry,
  options: ScanOptions,
  bus?: HookBus,
): Promise<ScanResult> {
  const { config } = options
  const layersToScan = options.layers ?? [...LAYER_NAMES]

  const source = config.environments[config.source]
  const target = config.environments[config.target]
  const ctx = { source, target, config }

  await bus?.emit('supaforge.scan.before', ctx)

  const results: LayerResult[] = []

  for (const name of layersToScan) {
    const layer = registry.get(name)
    if (!layer) {
      results.push({ layer: name, status: 'skipped', issues: [], durationMs: 0 })
      continue
    }

    await bus?.emit('supaforge.layer.before', { layer: name })
    const start = performance.now()

    try {
      const issues = await layer.scan(ctx)
      const durationMs = Math.round(performance.now() - start)
      const status = issues.length > 0 ? 'drifted' : 'clean'
      results.push({ layer: name, status, issues, durationMs })
    } catch (err) {
      const durationMs = Math.round(performance.now() - start)
      results.push({
        layer: name,
        status: 'error',
        issues: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      })
    }

    await bus?.emit('supaforge.layer.after', { layer: name, result: results.at(-1) })
  }

  const summary = summarize(results)
  const score = computeScore(results)

  const scanResult: ScanResult = {
    timestamp: new Date().toISOString(),
    source: config.source,
    target: config.target,
    layers: results,
    score,
    summary,
  }

  await bus?.emit('supaforge.scan.after', scanResult)

  return scanResult
}
