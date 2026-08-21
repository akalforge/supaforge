import { describe, it, expect } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import { CronCheck } from '../../src/checks/cron.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

const makeJob = (overrides: Record<string, unknown> = {}) => ({
  jobid: 1,
  schedule: '0 3 * * *',
  command: 'SELECT cleanup_old_sessions()',
  nodename: 'localhost',
  nodeport: 5432,
  database: 'postgres',
  username: 'postgres',
  active: true,
  jobname: 'cleanup_sessions',
  ...overrides,
})

describe('CronCheck', () => {
  it('detects missing cron jobs in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob()]
      return []
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('cleanup_sessions')
    expect(issues[0].sql?.up).toContain('cron.schedule')
    expect(issues[0].sql?.down).toContain('cron.unschedule')
  })

  it('detects extra cron jobs in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makeJob({ jobname: 'extra_job' })]
      return []
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('extra_job')
  })

  it('detects modified schedule', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob()]
      return [makeJob({ schedule: '0 6 * * *' })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('Modified cron job')
    expect(issues[0].sql?.up).toContain('0 3 * * *')
  })

  it('detects modified command', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob()]
      return [makeJob({ command: 'SELECT other_cleanup()' })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('Modified cron job')
  })

  it('returns no issues when jobs match', async () => {
    const job = makeJob()
    const queryFn: QueryFn = async () => [job]

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('skips with a reason when neither side has pg_cron', async () => {
    // Was: returned [], reported as a clean pass. `snapshot` already says
    // "skipped — pg_cron extension not installed" for exactly this (issue #42).
    const queryFn: QueryFn = async () => {
      throw new Error('relation "cron.job" does not exist')
    }

    const check = new CronCheck(queryFn)
    await expect(check.scan(mockContext())).rejects.toThrow(CheckSkipped)
    await expect(check.scan(mockContext())).rejects.toThrow('pg_cron extension not installed')
  })

  it('still reports drift when only one side has pg_cron', async () => {
    // Asymmetric: the source schedules jobs the target does not run at all.
    // That is genuine drift and must not be swallowed by the skip above.
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ jobname: 'nightly' })] as unknown as Record<string, unknown>[]
      throw new Error('relation "cron.job" does not exist')
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues.length).toBeGreaterThan(0)
  })

  it('uses jobname as key when available', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ jobname: 'my_job' })]
      return []
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].id).toBe('cron-missing-my_job')
  })

  it('falls back to jobid when jobname is null', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ jobname: null, jobid: 42 })]
      return []
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].id).toBe('cron-missing-job-42')
  })

  it('detects active/inactive state mismatch', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ active: true })]
      return [makeJob({ active: false })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    const issue = issues[0]
    expect(issue.id).toBe('cron-active-cleanup_sessions')
    expect(issue.severity).toBe('warning')
    expect(issue.title).toContain('active state mismatch')
    expect(issue.title).toContain('cleanup_sessions')
    expect(issue.description).toContain('active in source')
    expect(issue.description).toContain('inactive in target')
  })

  it('detects inactive-to-active mismatch', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ active: false })]
      return [makeJob({ active: true })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].description).toContain('inactive in source')
    expect(issues[0].description).toContain('active in target')
  })

  it('active state issue SQL updates the active column', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ active: true })]
      return [makeJob({ active: false })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).toContain('UPDATE cron.job')
    expect(issues[0].sql?.up).toContain('active = true')
    expect(issues[0].sql?.down).toContain('active = false')
  })

  it('emits both modified and active issues when schedule and active both differ', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ schedule: '0 1 * * *', active: true })]
      return [makeJob({ schedule: '0 2 * * *', active: false })]
    }

    const check = new CronCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('cron-modified-cleanup_sessions')
    expect(ids).toContain('cron-active-cleanup_sessions')
  })
})
