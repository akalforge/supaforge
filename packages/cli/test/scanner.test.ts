import { describe, it, expect } from 'vitest'
import { scan } from '../src/scanner.js'
import { CheckRegistry } from '../src/checks/registry.js'
import { Check, type CheckContext } from '../src/checks/base.js'
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
