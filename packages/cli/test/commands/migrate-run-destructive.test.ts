import { describe, it, expect } from 'vitest'
import { findDestructiveStatements } from '../../src/commands/migrate/run.js'

/**
 * The destructive gate on `migrate run` (issue #88).
 *
 * `migrate run` executes by design — it is the one family that does not take
 * `--apply` — but it also had no destructive check at all, so a migration file
 * holding `DROP TABLE` ran with no opt-in while `diff --apply` held the same
 * statement back. In the report a table with a row in it was dropped and the
 * command reported success.
 */
describe('findDestructiveStatements', () => {
  const file = (filename: string, path: string) => ({ filename, path })

  /** Serve file contents from a map, so no filesystem is involved. */
  const reader = (files: Record<string, string>) =>
    async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)
      return files[path]
    }

  it('finds a DROP TABLE in a migration file', async () => {
    const found = await findDestructiveStatements(
      [file('001_drop.sql', '/m/001_drop.sql')],
      reader({ '/m/001_drop.sql': 'DROP TABLE public.scratch_unprotected;' }),
    )

    expect(found).toHaveLength(1)
    expect(found[0].filename).toBe('001_drop.sql')
    expect(found[0].sql).toContain('DROP TABLE')
  })

  it('finds DELETE FROM and a dropped policy', async () => {
    const found = await findDestructiveStatements(
      [file('001.sql', '/m/001.sql')],
      reader({
        '/m/001.sql': [
          `DELETE FROM "ref_codes" WHERE "id" = '4';`,
          'DROP POLICY "target_only_guard" ON "public"."plans";',
        ].join('\n'),
      }),
    )

    expect(found).toHaveLength(2)
  })

  it('reports every destructive statement in a file, not just the first', async () => {
    const found = await findDestructiveStatements(
      [file('001.sql', '/m/001.sql')],
      reader({
        '/m/001.sql': 'DROP TABLE a;\nDROP TABLE b;\nCREATE TABLE c (id int);\nDROP TABLE d;',
      }),
    )

    expect(found).toHaveLength(3)
  })

  it('passes an additive migration', async () => {
    const found = await findDestructiveStatements(
      [file('001.sql', '/m/001.sql')],
      reader({
        '/m/001.sql': 'ALTER TABLE public.plans ADD COLUMN notes text;\nCREATE INDEX i ON public.plans (notes);',
      }),
    )

    expect(found).toEqual([])
  })

  it('does not split a routine body and misread it', async () => {
    // The body holds a semicolon and the word DELETE; neither ends a statement
    // nor makes the migration destructive.
    const found = await findDestructiveStatements(
      [file('001.sql', '/m/001.sql')],
      reader({
        '/m/001.sql': `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM audit_log WHERE created_at < now();
END;
$$;`,
      }),
    )

    expect(found).toEqual([])
  })

  it('names each file it found something in', async () => {
    const found = await findDestructiveStatements(
      [file('001_a.sql', '/m/001_a.sql'), file('002_b.sql', '/m/002_b.sql')],
      reader({
        '/m/001_a.sql': 'CREATE TABLE a (id int);',
        '/m/002_b.sql': 'DROP TABLE b;',
      }),
    )

    expect(found).toHaveLength(1)
    expect(found[0].filename).toBe('002_b.sql')
  })

  it('reports an unreadable file rather than passing it as safe', async () => {
    // Treating a file it cannot read as harmless is the one wrong answer here.
    const found = await findDestructiveStatements(
      [file('001.sql', '/m/missing.sql')],
      reader({}),
    )

    expect(found).toHaveLength(1)
    expect(found[0].sql).toContain('unreadable')
  })

  it('returns nothing for no migrations', async () => {
    expect(await findDestructiveStatements([], reader({}))).toEqual([])
  })
})
