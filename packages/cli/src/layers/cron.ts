import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

interface CronJob {
  jobid: number
  schedule: string
  command: string
  nodename: string
  nodeport: number
  database: string
  username: string
  active: boolean
  jobname: string | null
}

export class CronLayer extends Layer {
  readonly name = 'cron' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchCronJobs(ctx.source.dbUrl),
      this.fetchCronJobs(ctx.target.dbUrl),
    ])
    return diffCronJobs(source, target)
  }

  private async fetchCronJobs(dbUrl: string): Promise<CronJob[]> {
    try {
      return await this.queryFn(dbUrl, CRON_SQL) as unknown as CronJob[]
    } catch {
      // pg_cron extension may not be installed
      return []
    }
  }
}

const CRON_SQL = `
  SELECT jobid, schedule, command, nodename, nodeport, database, username, active, jobname
  FROM cron.job
  ORDER BY jobname, jobid
`

function jobKey(j: CronJob): string {
  return j.jobname ?? `job-${j.jobid}`
}

export function diffCronJobs(source: CronJob[], target: CronJob[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(j => [jobKey(j), j]))
  const targetMap = new Map(target.map(j => [jobKey(j), j]))

  for (const [key, j] of sourceMap) {
    if (!targetMap.has(key)) {
      issues.push({
        id: `cron-missing-${key}`,
        layer: 'cron',
        severity: 'warning',
        title: `Missing cron job: ${key}`,
        description: `Cron job "${key}" (schedule: ${j.schedule}) exists in source but not in target.`,
        sourceValue: j,
        sql: {
          up: `SELECT cron.schedule('${key}', '${j.schedule}', $$ ${j.command} $$);`,
          down: `SELECT cron.unschedule('${key}');`,
        },
      })
    }
  }

  for (const [key, j] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `cron-extra-${key}`,
        layer: 'cron',
        severity: 'info',
        title: `Extra cron job: ${key}`,
        description: `Cron job "${key}" exists in target but not in source.`,
        targetValue: j,
      })
    }
  }

  for (const [key, sj] of sourceMap) {
    const tj = targetMap.get(key)
    if (!tj) continue

    if (sj.schedule !== tj.schedule || sj.command !== tj.command) {
      issues.push({
        id: `cron-modified-${key}`,
        layer: 'cron',
        severity: 'warning',
        title: `Modified cron job: ${key}`,
        description: `Cron job "${key}" has different schedule or command between environments.`,
        sourceValue: sj,
        targetValue: tj,
        sql: {
          up: `SELECT cron.unschedule('${key}');\nSELECT cron.schedule('${key}', '${sj.schedule}', $$ ${sj.command} $$);`,
          down: `SELECT cron.unschedule('${key}');\nSELECT cron.schedule('${key}', '${tj.schedule}', $$ ${tj.command} $$);`,
        },
      })
    }
  }

  return issues
}
