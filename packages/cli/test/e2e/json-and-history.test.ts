/**
 * `--json` means stdout is JSON, and a migration history that cannot be read
 * is not reported as nothing applied.
 *
 * `migrate list --json` and `clone --json` printed their preflight checks on
 * stdout first, so the output did not parse. And `migrate list`, connected as a
 * role that cannot read the history table, warned and then listed every
 * applied migration as pending, exiting 0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const HISTORY = `
  CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
  INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261007000001', 'init');
  DO $$ BEGIN CREATE ROLE sf_mig_user LOGIN PASSWORD 'sf_mig_pass'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT CONNECT ON DATABASE postgres TO sf_mig_user;
`

describeE2E('e2e: --json output, and a history the role cannot read', () => {
  let h: PgHarness
  let ws: string

  /** stdout parsed as JSON, or the test fails showing what was printed. */
  function parsed(stdout: string): unknown {
    try {
      return JSON.parse(stdout)
    } catch {
      throw new Error(`stdout is not JSON:\n${stdout.slice(0, 400)}`)
    }
  }

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', 'CREATE TABLE public.items (id int PRIMARY KEY);')
    await h.applySql('target', HISTORY)
    const limited = new URL(h.connectionString('target'))
    limited.username = 'sf_mig_user'
    limited.password = 'sf_mig_pass'
    ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') },
        target: { dbUrl: h.connectionString('target') },
        limited: { dbUrl: limited.toString() },
      },
    })
    await mkdir(join(ws, 'supabase', 'migrations'), { recursive: true })
    await writeFile(join(ws, 'supabase', 'migrations', '20261007000001_init.sql'), 'SELECT 1;\n')
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('migrate list --json prints JSON alone', async () => {
    const r = await h.cli(['migrate', 'list', '--env', 'target', '--json'], { cwd: ws })
    expect(r.code, r.stderr).toBe(0)
    expect(parsed(r.stdout)).toMatchObject([{ version: '20261007000001', applied: true }])
  }, 120_000)

  it('migrate list says the status is unknown, and exits 1, when the role cannot read the history', async () => {
    const text = await h.cli(['migrate', 'list', '--env', 'limited'], { cwd: ws })
    expect(text.code).toBe(1)
    expect(text.stdout).toMatch(/status unknown/)
    expect(text.stdout).not.toMatch(/pending/)

    const json = await h.cli(['migrate', 'list', '--env', 'limited', '--json'], { cwd: ws })
    expect(json.code).toBe(1)
    expect(parsed(json.stdout)).toMatchObject([{ version: '20261007000001', applied: null }])
  }, 120_000)

  it('clone --json prints JSON alone, previewed and applied', async () => {
    const args = ['clone', '--env', 'source', '--local-url', h.urlFor('target', 'postgres'), '--local-db', 'sf_clone_json', '--schema-only', '--json']
    const preview = await h.cli(args, { cwd: ws })
    expect(parsed(preview.stdout)).toMatchObject({ dryRun: true, passed: true })

    const applied = await h.cli([...args, '--apply'], { cwd: ws })
    expect(parsed(applied.stdout)).toHaveProperty('snapshot')
  }, 300_000)
})
