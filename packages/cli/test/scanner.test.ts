import { describe, it, expect } from 'vitest'
import { scan } from '../src/scanner.js'
import { CheckRegistry } from '../src/checks/registry.js'
import { Check, CheckSkipped, type CheckContext } from '../src/checks/base.js'
import { HookBus } from '../src/hooks.js'
import type { DriftIssue, CheckName } from '../src/types/drift.js'
import type { SupaForgeConfig } from '../src/types/config.js'

class MockLayer extends Check {
  readonly name: CheckName
  private issues: DriftIssue[]

  constructor(name: CheckName, issues: DriftIssue[] = []) {
    super()
    this.name = name
    this.issues = issues
  }

  async scan(_ctx: CheckContext): Promise<DriftIssue[]> {
    return this.issues
  }
}

class ErrorLayer extends Check {
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
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config, checks: ['rls'] })

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].status).toBe('clean')
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })

  it('returns drifted status when issues found', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls', [
      { id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' },
    ]))

    const result = await scan(registry, { config, checks: ['rls'] })

    expect(result.checks[0].status).toBe('drifted')
    expect(result.summary.total).toBe(1)
    expect(result.summary.critical).toBe(1)
  })

  it('handles check errors gracefully', async () => {
    const registry = new CheckRegistry()
    registry.register(new ErrorLayer())

    const result = await scan(registry, { config, checks: ['auth'] })

    expect(result.checks[0].status).toBe('error')
    expect(result.checks[0].error).toContain('Cannot connect to PostgreSQL')
    expect(result.score).toBeLessThan(100)
  })

  it('skips unregistered checks', async () => {
    const registry = new CheckRegistry()

    const result = await scan(registry, { config, checks: ['cron'] })

    expect(result.checks[0].status).toBe('skipped')
  })

  it('scans multiple checks', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('cron', [
      { id: '1', check: 'cron', severity: 'warning', title: 'Missing job', description: '' },
    ]))

    const result = await scan(registry, { config, checks: ['rls', 'cron'] })

    expect(result.checks).toHaveLength(2)
    expect(result.checks[0].status).toBe('clean')
    expect(result.checks[1].status).toBe('drifted')
  })

  it('fires hook bus events', async () => {
    const bus = new HookBus()
    const events: string[] = []

    bus.on('supaforge.scan.before', () => { events.push('scan.before') })
    bus.on('supaforge.check.before', () => { events.push('check.before') })
    bus.on('supaforge.check.after', () => { events.push('check.after') })
    bus.on('supaforge.scan.after', () => { events.push('scan.after') })

    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    await scan(registry, { config, checks: ['rls'] }, bus)

    expect(events).toEqual([
      'scan.before',
      'check.before',
      'check.after',
      'scan.after',
    ])
  })

  it('includes timestamp and environment names', async () => {
    const registry = new CheckRegistry()
    const result = await scan(registry, { config, checks: ['schema'] })

    expect(result.source).toBe('dev')
    expect(result.target).toBe('prod')
    expect(result.timestamp).toBeTruthy()
  })
})

describe('scan — skip option', () => {
  it('skips a check listed in the skip option', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('cron'))

    const result = await scan(registry, { config, skip: ['cron'] })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('cron')
    expect(names).toContain('rls')
  })

  it('skip takes precedence over an explicit checks include', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    // ask for rls but also skip rls → nothing runs
    const result = await scan(registry, { config, checks: ['rls'], skip: ['rls'] })

    expect(result.checks).toHaveLength(0)
  })

  it('skips multiple checks when skip contains several names', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('storage'))
    registry.register(new MockLayer('vault'))

    const result = await scan(registry, { config, skip: ['storage', 'vault'] })

    const names = result.checks.map(c => c.check)
    expect(names).toContain('rls')
    expect(names).not.toContain('storage')
    expect(names).not.toContain('vault')
  })

  it('respects config.checks.exclude as a permanent skip list', async () => {
    const configWithExclude: SupaForgeConfig = {
      ...config,
      checks: { exclude: ['auth', 'edge-functions', 'realtime'] },
    }
    const registry = new CheckRegistry()
    registry.register(new MockLayer('auth'))
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config: configWithExclude })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('auth')
    expect(names).not.toContain('edge-functions')
    expect(names).not.toContain('realtime')
    expect(names).toContain('rls')
  })

  it('merges CLI skip and config.checks.exclude', async () => {
    const configWithExclude: SupaForgeConfig = {
      ...config,
      checks: { exclude: ['vault'] },
    }
    const registry = new CheckRegistry()
    registry.register(new MockLayer('vault'))
    registry.register(new MockLayer('storage'))
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config: configWithExclude, skip: ['storage'] })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('vault')    // from config.checks.exclude
    expect(names).not.toContain('storage')  // from CLI skip
    expect(names).toContain('rls')
  })

  it('returns empty checks array when all checks are skipped', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config, checks: ['rls'], skip: ['rls'] })

    expect(result.checks).toHaveLength(0)
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })
})

// ─── issue #42: a check that declines to run is not a check that passed ──────

describe('skipped checks are distinguishable from clean ones (issue #42)', () => {
  class SkippingCheck extends Check {
    readonly name = 'auth' as const
    async scan(): Promise<DriftIssue[]> {
      throw new CheckSkipped('no projectRef or accessToken configured')
    }
  }

  class CleanCheck extends Check {
    readonly name = 'cron' as const
    async scan(): Promise<DriftIssue[]> {
      return []
    }
  }

  class BrokenCheck extends Check {
    readonly name = 'rls' as const
    async scan(): Promise<DriftIssue[]> {
      throw new Error('connection refused')
    }
  }

  function registryWith(...checks: Check[]): CheckRegistry {
    const reg = new CheckRegistry()
    for (const c of checks) reg.register(c)
    return reg
  }

  const config = {
    environments: { dev: { dbUrl: 'postgres://s' }, prod: { dbUrl: 'postgres://t' } },
    source: 'dev',
    target: 'prod',
  }

  it('records status skipped with the reason, not a clean pass', async () => {
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.checks[0].status).toBe('skipped')
    expect(result.checks[0].skipReason).toBe('no projectRef or accessToken configured')
    expect(result.checks[0].issues).toEqual([])
  })

  it('keeps a genuinely clean check clean', async () => {
    // The distinction is the whole point: both produce zero issues.
    const result = await scan(registryWith(new CleanCheck()), { config, checks: ['cron'] })
    expect(result.checks[0].status).toBe('clean')
    expect(result.checks[0].skipReason).toBeUndefined()
  })

  it('does not treat a skip as an error', async () => {
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.checks[0].status).not.toBe('error')
    expect(result.checks[0].error).toBeUndefined()
  })

  it('still treats a real failure as an error', async () => {
    const result = await scan(registryWith(new BrokenCheck()), { config, checks: ['rls'] })
    expect(result.checks[0].status).toBe('error')
    expect(result.checks[0].error).toBeTruthy()
  })

  it('reports the skip reason through onProgress', async () => {
    const events: Array<Record<string, unknown>> = []
    await scan(registryWith(new SkippingCheck()), {
      config,
      checks: ['auth'],
      onProgress: (e) => events.push(e as unknown as Record<string, unknown>),
    })
    const done = events.find(e => e.phase === 'check:done')!
    expect(done.status).toBe('skipped')
    expect(done.skipReason).toBe('no projectRef or accessToken configured')
  })

  it('a skip does not reduce the drift score', async () => {
    // Penalising it would give every self-hosted project a permanently
    // depressed score for layers it deliberately cannot run. Coverage is
    // reported separately instead.
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.score).toBe(100)
  })
})
