import { describe, it, expect } from 'vitest'
import { inverseStatement, schemaChangeNotes } from '../src/migration.js'
import { splitSqlStatements, isCommentOnly } from '../src/utils/sql-split.js'

/**
 * What an incremental snapshot migration records (issue #92).
 *
 * The statement extractor split a layer file on `;\n` and discarded any chunk
 * beginning with `--`. Every layer file opens with a `-- SupaForge … Snapshot`
 * header, and that header lands in the same chunk as the *first* statement —
 * so the first statement of every layer was thrown away with it. Adding or
 * removing the alphabetically-first cron job, policy, webhook or extension was
 * invisible, and the previous first statement then appeared as newly added.
 */
describe('reading a snapshot layer file', () => {
  /** A layer file as `snapshot` writes one: header, count, then statements. */
  const rlsFile = `-- SupaForge RLS Policy Snapshot
-- 2 policies

DROP POLICY IF EXISTS "aaa_first_policy" ON "public"."profiles";
CREATE POLICY "aaa_first_policy"
  ON "public"."profiles"
  FOR SELECT
;

DROP POLICY IF EXISTS "zzz_last_policy" ON "public"."profiles";
CREATE POLICY "zzz_last_policy"
  ON "public"."profiles"
  FOR UPDATE
;
`

  /** The extractor's behaviour, which is private to migration.ts. */
  function extract(content: string): string[] {
    return splitSqlStatements(content)
      .filter(s => !isCommentOnly(s))
      .map(s => {
        const lines = s.split('\n')
        let start = 0
        while (start < lines.length) {
          const line = lines[start].trim()
          if (line === '' || line.startsWith('--')) { start++; continue }
          break
        }
        return lines.slice(start).join('\n').trim()
      })
      .filter(s => s.length > 0)
      .map(s => s.endsWith(';') ? s : `${s};`)
  }

  it('does not lose the first statement to the file header', () => {
    const statements = extract(rlsFile)

    // The header sits in the same chunk as the first DROP. Discarding chunks
    // that start with `--` took the DROP with it.
    expect(statements.some(s => s.includes('aaa_first_policy'))).toBe(true)
  })

  it('keeps every statement in the file', () => {
    // Two policies, each a DROP and a CREATE.
    expect(extract(rlsFile)).toHaveLength(4)
  })

  it('strips the header, so a changed count does not change a statement', () => {
    // The header carries `-- 2 policies`. Left attached, the first statement
    // of two snapshots would differ whenever the count changed, and be
    // reported as both added and removed though nothing about it moved.
    const withTwo = extract(rlsFile)
    const withOne = extract(rlsFile.replace('-- 2 policies', '-- 1 policies'))

    expect(withOne[0]).toBe(withTwo[0])
    expect(withTwo[0]).not.toContain('--')
  })

  it('drops a file that is only a header', () => {
    expect(extract('-- No RLS policies found\n')).toEqual([])
  })
})

/**
 * Undoing a change (issue #92).
 *
 * `up` was the added statements alone and `down` the removed ones, so each
 * direction did half its job: applying a migration that *removed* a policy did
 * not drop it, and reverting one that *added* a policy left it in place.
 */
describe('inverseStatement', () => {
  it('unschedules a cron job', () => {
    expect(inverseStatement(`SELECT cron.schedule('nightly-noop', '0 3 * * *', $$SELECT 1$$);`))
      .toBe("SELECT cron.unschedule('nightly-noop');")
  })

  it('drops a policy', () => {
    expect(inverseStatement('CREATE POLICY "read_own" ON "public"."orders" FOR SELECT USING (true);'))
      .toBe('DROP POLICY IF EXISTS "read_own" ON "public"."orders";')
  })

  it('drops a trigger, naming its table', () => {
    // A trigger name is unique only per table.
    expect(inverseStatement('CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();'))
      .toBe('DROP TRIGGER IF EXISTS orders_webhook ON public.orders;')
  })

  it('drops an extension', () => {
    expect(inverseStatement('CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public";'))
      .toBe('DROP EXTENSION IF EXISTS "pgcrypto";')
  })

  it('returns null rather than guessing', () => {
    // A wrong inverse in a `down` is worse than an absent one: it looks like a
    // revert and is not.
    expect(inverseStatement('ALTER TABLE public.orders ADD COLUMN note text;')).toBeNull()
    expect(inverseStatement('UPDATE public.plans SET price = 1;')).toBeNull()
    expect(inverseStatement('SELECT 1;')).toBeNull()
  })

  it('handles a quoted cron job name with an apostrophe', () => {
    expect(inverseStatement(`SELECT cron.schedule('it''s-nightly', '0 3 * * *', $$SELECT 1$$);`))
      .toBe("SELECT cron.unschedule('it''s-nightly');")
  })
})

/**
 * What the schema layer says when it carries no DDL (issue #92).
 *
 * It was the single line "Schema changed. Use @dbdiff/cli to generate
 * migration SQL." — true, and useless: it named nothing that had changed.
 */
describe('schemaChangeNotes', () => {
  const before = JSON.stringify({
    tables: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'gone' }],
    views: [],
  })
  const after = JSON.stringify({
    tables: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'added' }],
    views: [{ schema: 'public', name: 'summary' }],
  })

  it('names what was added and removed', () => {
    // Matched on content rather than exact padding, which varies with the
    // length of the object kind.
    const notes = schemaChangeNotes(before, after).join('\n')

    expect(notes).toMatch(/tables added:\s+public\.added/)
    expect(notes).toMatch(/tables removed:\s+public\.gone/)
    expect(notes).toMatch(/views added:\s+public\.summary/)
  })

  it('does not mention what did not change', () => {
    expect(schemaChangeNotes(before, after).join('\n')).not.toContain('public.orders')
  })

  it('is entirely comments, so it cannot be mistaken for SQL', () => {
    for (const line of schemaChangeNotes(before, after)) {
      expect(line.trim().startsWith('--'), line).toBe(true)
    }
  })

  it('says where the DDL comes from instead', () => {
    expect(schemaChangeNotes(before, after).join('\n')).toContain('supaforge migrate create')
  })

  it('still explains itself when the documents will not parse', () => {
    const notes = schemaChangeNotes('not json', 'also not json')

    expect(notes.length).toBeGreaterThan(0)
    expect(notes.join('\n')).toContain('migrate create')
  })
})
