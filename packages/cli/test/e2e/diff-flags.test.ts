/**
 * diff's flags, against two real databases.
 *
 * These ran against unreachable hosts and read the JSON of a scan in which
 * every check had failed. diff now stops at the reachability check in every
 * mode, so they need servers that answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: diff flags', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  const checksIn = (stdout: string): string[] => JSON.parse(stdout).checks.map((c: { check: string }) => c.check)

  it('runs only the check named by --check, rls-coverage included', async () => {
    const ws = await h.workspace()
    const r = await h.cli(['diff', '--json', '--check=rls-coverage'], { cwd: ws })
    expect(checksIn(r.stdout)).toEqual(['rls-coverage'])
  }, 120_000)

  it('leaves out --skip checks, checks.exclude checks, and both together', async () => {
    const plain = await h.workspace()
    const skipped = checksIn((await h.cli(['diff', '--json', '--skip=storage', '--skip=vault'], { cwd: plain })).stdout)
    expect(skipped).not.toContain('storage')
    expect(skipped).not.toContain('vault')
    expect(skipped).toContain('rls')

    const excluding = await h.workspace({ checks: { exclude: ['vault'] } })
    const merged = checksIn((await h.cli(['diff', '--json', '--skip=storage'], { cwd: excluding })).stdout)
    expect(merged).not.toContain('vault')
    expect(merged).not.toContain('storage')
    expect(merged).toContain('rls')
  }, 240_000)

  it('prints a tip in text mode and none under --json', async () => {
    const ws = await h.workspace()
    const text = await h.cli(['diff', '--check=rls'], { cwd: ws })
    expect(text.stdout).toMatch(/tip:/)
    const json = await h.cli(['diff', '--json', '--check=rls'], { cwd: ws })
    expect(json.stdout).not.toContain('tip:')
    expect(() => JSON.parse(json.stdout)).not.toThrow()
  }, 120_000)

  it('reports a failed schema diff without the raw command line', async () => {
    const ws = await h.workspace()
    const failing = join(ws, 'dbdiff-fails')
    await writeFile(failing, '#!/bin/sh\necho "boom" >&2\nexit 3\n')
    await chmod(failing, 0o755)
    const r = await h.cli(['diff', '--json', '--check=schema'], { cwd: ws, env: { SUPAFORGE_DBDIFF_BIN: failing } })
    const schema = JSON.parse(r.stdout).checks.find((c: { check: string }) => c.check === 'schema')
    expect(schema.status).toBe('error')
    expect(schema.error).not.toContain('Command failed:')
    expect(schema.error).not.toContain('dbdiff-fails diff')
  }, 120_000)
})
