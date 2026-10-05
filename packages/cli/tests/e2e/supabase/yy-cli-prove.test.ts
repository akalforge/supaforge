/**
 * The CLI end to end on two real Supabase projects: every check applied with
 * --prove and --allow-destructive, then the target compared with the source
 * by pg-conformance's state of every schema the project owns, independently
 * of SupaForge's own checks.
 *
 * What the release smoke test did by hand. It found a proof refusing a
 * migration that reproduced the schema exactly — a column comment read
 * differently because the column sat at another position — which nothing
 * automated ran into: the scenario suites use plain PostgreSQL, and the
 * tests before this one drive scan() and promote() rather than the CLI.
 *
 * Runs before zz-verify-clean, which then checks what this leaves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile as _execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stateSql, type SchemaState } from '@akalforge/pg-conformance'
import { pgQuery } from '../../../src/db'
import { comparedSchemas } from '../../../src/prove'
import { schemaDiffIgnores } from '../../../src/defaults'
import { diffState } from '../../../src/state-diff'
import { buildConfig, shouldSkip } from './helpers'

const execFile = promisify(_execFile)
const CLI = fileURLToPath(new URL('../../../bin/run.js', import.meta.url))

async function state(dbUrl: string, schemas: string[]): Promise<SchemaState> {
  const [row] = await pgQuery(dbUrl, stateSql(schemas)) as Array<{ state: string }>
  return JSON.parse(Object.values(row)[0] as string) as SchemaState
}

describe('e2e: the CLI applies and proves every check', () => {
  const config = buildConfig()
  let dir: string

  const sf = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await execFile('node', [CLI, ...args], {
        cwd: dir, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 600_000,
      })
      return { code: 0, out: stdout + stderr }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  beforeAll(async () => {
    if (shouldSkip()) return
    dir = await mkdtemp(join(tmpdir(), 'sf-e2e-cli-'))
    await writeFile(join(dir, 'supaforge.config.json'), JSON.stringify(config), { mode: 0o600 })
  })
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it.skipIf(shouldSkip())('proves the whole migration converges, then applies it', async () => {
    const { code, out } = await sf('diff', '--apply', '--prove', '--allow-destructive')
    expect(out, out).not.toMatch(/does not reproduce|Convergence not proven|Rolled back/)
    expect(out, out).toMatch(/Converged/)
    expect(code, out).toBe(0)
  }, 900_000)

  it.skipIf(shouldSkip())("leaves the target holding the source's schemas, by an independent account", async () => {
    const source = config.environments.source.dbUrl
    const target = config.environments.target.dbUrl
    const schemas = await comparedSchemas(source, target, schemaDiffIgnores(config.ignoreSchemas))
    expect(schemas).toEqual(expect.arrayContaining(['public', 'app', 'Reporting']))
    expect(diffState(await state(source, schemas), await state(target, schemas))).toEqual([])
  }, 120_000)

  it.skipIf(shouldSkip())('finds no schema drift left', async () => {
    const { out } = await sf('diff', '--check=schema')
    expect(out, out).toMatch(/no drift detected/)
  }, 300_000)
})
