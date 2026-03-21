import { describe, it, expect } from 'vitest'
import { scan } from '../src/scanner.js'
import { LayerRegistry } from '../src/layers/registry.js'
import { Layer, type LayerContext } from '../src/layers/base.js'
import { HookBus } from '../src/hooks.js'
import type { DriftIssue, LayerName } from '../src/types/drift.js'
import type { SupaForgeConfig } from '../src/types/config.js'

class MockLayer extends Layer {
  readonly name: LayerName
  private issues: DriftIssue[]

  constructor(name: LayerName, issues: DriftIssue[] = []) {
    super()
    this.name = name
    this.issues = issues
  }

  async scan(_ctx: LayerContext): Promise<DriftIssue[]> {
    return this.issues
  }
}

class ErrorLayer extends Layer {
  readonly name = 'auth' as const
  async scan(): Promise<DriftIssue[]> {
    throw new Error('connection refused')
  }
}

const config: SupaForgeConfig = {
  environments: {
    dev: { dbUrl: 'postgres://localhost/dev' },
    prod: { dbUrl: 'postgres://localhost/prod' },
  },
  source: 'dev',
  target: 'prod',
}

describe('scan', () => {
  it('returns clean results when no issues found', async () => {
    const registry = new LayerRegistry()
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config, layers: ['rls'] })

    expect(result.layers).toHaveLength(1)
    expect(result.layers[0].status).toBe('clean')
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })

  it('returns drifted status when issues found', async () => {
    const registry = new LayerRegistry()
    registry.register(new MockLayer('rls', [
      { id: '1', layer: 'rls', severity: 'critical', title: 'Missing policy', description: '' },
    ]))

    const result = await scan(registry, { config, layers: ['rls'] })

    expect(result.layers[0].status).toBe('drifted')
    expect(result.summary.total).toBe(1)
    expect(result.summary.critical).toBe(1)
  })

  it('handles layer errors gracefully', async () => {
    const registry = new LayerRegistry()
    registry.register(new ErrorLayer())

    const result = await scan(registry, { config, layers: ['auth'] })

    expect(result.layers[0].status).toBe('error')
    expect(result.layers[0].error).toBe('connection refused')
  })

  it('skips unregistered layers', async () => {
    const registry = new LayerRegistry()

    const result = await scan(registry, { config, layers: ['cron'] })

    expect(result.layers[0].status).toBe('skipped')
  })

  it('scans multiple layers', async () => {
    const registry = new LayerRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('cron', [
      { id: '1', layer: 'cron', severity: 'warning', title: 'Missing job', description: '' },
    ]))

    const result = await scan(registry, { config, layers: ['rls', 'cron'] })

    expect(result.layers).toHaveLength(2)
    expect(result.layers[0].status).toBe('clean')
    expect(result.layers[1].status).toBe('drifted')
  })

  it('fires hook bus events', async () => {
    const bus = new HookBus()
    const events: string[] = []

    bus.on('supaforge.scan.before', () => { events.push('scan.before') })
    bus.on('supaforge.layer.before', () => { events.push('layer.before') })
    bus.on('supaforge.layer.after', () => { events.push('layer.after') })
    bus.on('supaforge.scan.after', () => { events.push('scan.after') })

    const registry = new LayerRegistry()
    registry.register(new MockLayer('rls'))

    await scan(registry, { config, layers: ['rls'] }, bus)

    expect(events).toEqual([
      'scan.before',
      'layer.before',
      'layer.after',
      'scan.after',
    ])
  })

  it('includes timestamp and environment names', async () => {
    const registry = new LayerRegistry()
    const result = await scan(registry, { config, layers: ['schema'] })

    expect(result.source).toBe('dev')
    expect(result.target).toBe('prod')
    expect(result.timestamp).toBeTruthy()
  })
})
