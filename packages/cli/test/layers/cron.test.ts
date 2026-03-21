import { describe, it, expect } from 'vitest'
import { CronLayer } from '../../src/layers/cron.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): LayerContext {
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

describe('CronLayer', () => {
  it('detects missing cron jobs in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob()]
      return []
    }

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

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

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('extra_job')
  })

  it('detects modified schedule', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob()]
      return [makeJob({ schedule: '0 6 * * *' })]
    }

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

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

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('Modified cron job')
  })

  it('returns no issues when jobs match', async () => {
    const job = makeJob()
    const queryFn: QueryFn = async () => [job]

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('handles pg_cron not installed gracefully', async () => {
    const queryFn: QueryFn = async () => {
      throw new Error('relation "cron.job" does not exist')
    }

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('uses jobname as key when available', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ jobname: 'my_job' })]
      return []
    }

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues[0].id).toBe('cron-missing-my_job')
  })

  it('falls back to jobid when jobname is null', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeJob({ jobname: null, jobid: 42 })]
      return []
    }

    const layer = new CronLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues[0].id).toBe('cron-missing-job-42')
  })
})
