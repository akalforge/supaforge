import { describe, it, expect, afterEach } from 'vitest'
import {
  parseDbDiffOutput,
  sqlToIssues,
  resolveDbDiffBin,
  resolveDbDiffTimeoutMs,
  stripDbDiffNoise,
  classifyStatement,
  summariseStatement,
  isDestructiveSql,
  resolveDbDiffMemoryLimit,
  buildDbDiffArgs,
  extractRoutineArgs,
  routineLabel,
  extractRoutineName,
  mergeRoutineReplacements,
  parseDbDiffProgress,
  extractQualifiedName,
} from '../src/dbdiff.js'
import { DBDIFF_EXEC_TIMEOUT_MS } from '../src/constants.js'

describe('resolveDbDiffTimeoutMs', () => {
  afterEach(() => {
    delete process.env.SUPAFORGE_DBDIFF_TIMEOUT
  })

  it('defaults to DBDIFF_EXEC_TIMEOUT_MS when unset', () => {
    expect(resolveDbDiffTimeoutMs()).toBe(DBDIFF_EXEC_TIMEOUT_MS)
  })

  it('honours SUPAFORGE_DBDIFF_TIMEOUT (seconds → ms)', () => {
    process.env.SUPAFORGE_DBDIFF_TIMEOUT = '600'
    expect(resolveDbDiffTimeoutMs()).toBe(600_000)
  })

  it('ignores non-numeric / non-positive overrides', () => {
    process.env.SUPAFORGE_DBDIFF_TIMEOUT = 'abc'
    expect(resolveDbDiffTimeoutMs()).toBe(DBDIFF_EXEC_TIMEOUT_MS)
    process.env.SUPAFORGE_DBDIFF_TIMEOUT = '0'
    expect(resolveDbDiffTimeoutMs()).toBe(DBDIFF_EXEC_TIMEOUT_MS)
  })
})

describe('stripDbDiffNoise', () => {
  it('drops dbdiff info/progress lines like "ℹ Now generating UP migration"', () => {
    const input = ['ℹ Now generating UP migration', 'ℹ Connecting to server'].join('\n')
    expect(stripDbDiffNoise(input)).toBe('')
  })

  it('keeps genuine error lines', () => {
    const input = ['ℹ Now generating UP migration', 'error: connection refused'].join('\n')
    expect(stripDbDiffNoise(input)).toBe('error: connection refused')
  })

  it('drops spinner frames and blank lines', () => {
    const input = ['⠋ working', '', '✔ done', 'real failure here'].join('\n')
    expect(stripDbDiffNoise(input)).toBe('real failure here')
  })
})

describe('resolveDbDiffBin', () => {
  it('resolves to local binary when @dbdiff/cli is installed', () => {
    const { command, prefixArgs } = resolveDbDiffBin()
    // When @dbdiff/cli is a dependency, it resolves to node + bin/dbdiff.js
    expect(command).toBe(process.execPath)
    expect(prefixArgs).toHaveLength(1)
    expect(prefixArgs[0]).toContain('dbdiff.js')
  })
})

describe('buildDbDiffArgs', () => {
  const base = {
    sourceUrl: 'postgres://s',
    targetUrl: 'postgres://t',
    type: 'schema' as const,
    include: 'both' as const,
  }

  afterEach(() => {
    delete process.env.SUPAFORGE_DBDIFF_MEMORY
  })

  it('always passes --allow-destructive so drops are reported, not fatal', () => {
    // Without this, @dbdiff/cli >= 3.0.0-rc.3 exits non-zero and writes no
    // output whenever the target has an extra table or column.
    expect(buildDbDiffArgs(base, '/tmp/o.sql')).toContain('--allow-destructive')
  })

  it('honours the include option instead of hardcoding both', () => {
    expect(buildDbDiffArgs({ ...base, include: 'up' }, '/tmp/o.sql')).toContain('--include=up')
    expect(buildDbDiffArgs(base, '/tmp/o.sql')).toContain('--include=both')
  })

  it('passes the core flags', () => {
    const args = buildDbDiffArgs(base, '/tmp/o.sql')
    expect(args[0]).toBe('diff')
    expect(args).toContain('--server1-url=postgres://s')
    expect(args).toContain('--server2-url=postgres://t')
    expect(args).toContain('--type=schema')
    expect(args).toContain('--nocomments')
    expect(args).toContain('--output=/tmp/o.sql')
  })

  it('omits --memory-limit unless SUPAFORGE_DBDIFF_MEMORY is set', () => {
    expect(buildDbDiffArgs(base, '/tmp/o.sql').some(a => a.startsWith('--memory-limit'))).toBe(false)
    process.env.SUPAFORGE_DBDIFF_MEMORY = '2G'
    expect(buildDbDiffArgs(base, '/tmp/o.sql')).toContain('--memory-limit=2G')
  })

  it('merges ignoreSchemas globs into a single --ignore-tables flag', () => {
    // dbdiff takes one comma-separated list, so these must not be two flags.
    const args = buildDbDiffArgs(
      { ...base, ignoreTables: ['cache_x'], ignoreSchemas: ['auth', 'storage'] },
      '/tmp/o.sql',
    )
    const ignore = args.filter(a => a.startsWith('--ignore-tables='))
    expect(ignore).toEqual(['--ignore-tables=cache_x,auth.*,storage.*'])
  })

  it('emits --ignore-tables from ignoreSchemas alone', () => {
    const args = buildDbDiffArgs({ ...base, ignoreSchemas: ['auth'] }, '/tmp/o.sql')
    expect(args).toContain('--ignore-tables=auth.*')
  })

  it('omits --tables and --ignore-tables when nothing is filtered', () => {
    const args = buildDbDiffArgs(base, '/tmp/o.sql')
    expect(args.some(a => a.startsWith('--tables='))).toBe(false)
    expect(args.some(a => a.startsWith('--ignore-tables='))).toBe(false)
  })
})

describe('resolveDbDiffMemoryLimit', () => {
  afterEach(() => {
    delete process.env.SUPAFORGE_DBDIFF_MEMORY
  })

  it('is undefined when unset, leaving dbdiff on its own 1G default', () => {
    expect(resolveDbDiffMemoryLimit()).toBeUndefined()
  })

  it('passes through the values dbdiff accepts', () => {
    for (const v of ['512M', '2G', '1024K', '-1', '2g']) {
      process.env.SUPAFORGE_DBDIFF_MEMORY = v
      expect(resolveDbDiffMemoryLimit()).toBe(v)
    }
  })

  it('trims surrounding whitespace', () => {
    process.env.SUPAFORGE_DBDIFF_MEMORY = '  2G  '
    expect(resolveDbDiffMemoryLimit()).toBe('2G')
  })

  it('ignores malformed values rather than forwarding a rejected flag', () => {
    for (const v of ['', 'lots', '2GB', '2 G', '1G;rm -rf /']) {
      process.env.SUPAFORGE_DBDIFF_MEMORY = v
      expect(resolveDbDiffMemoryLimit()).toBeUndefined()
    }
  })
})

describe('isDestructiveSql', () => {
  it('flags statements that destroy rows', () => {
    expect(isDestructiveSql('DROP TABLE "stale";')).toBe(true)
    expect(isDestructiveSql('ALTER TABLE "users" DROP COLUMN "bio";')).toBe(true)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(isDestructiveSql('  drop table "stale";')).toBe(true)
    expect(isDestructiveSql('alter table "users" drop column "bio";')).toBe(true)
  })

  it('does not flag additive or non-row-destroying statements', () => {
    expect(isDestructiveSql('ALTER TABLE "users" ADD COLUMN "bio" text;')).toBe(false)
    expect(isDestructiveSql('CREATE TABLE "t" (id int);')).toBe(false)
    expect(isDestructiveSql('CREATE INDEX idx ON users(bio);')).toBe(false)
  })

  it('does not flag drops that only lose a definition', () => {
    // These are recreatable from the migration, so they stay applyable —
    // matching how @dbdiff/cli splits its linter into errors and warnings.
    expect(isDestructiveSql('DROP VIEW "v";')).toBe(false)
    expect(isDestructiveSql('DROP INDEX idx_bio;')).toBe(false)
    expect(isDestructiveSql('DROP TRIGGER "t" ON "users";')).toBe(false)
    expect(isDestructiveSql('DROP FUNCTION "f"();')).toBe(false)
  })

  it('does not flag DROP CONSTRAINT or DROP DEFAULT on a table', () => {
    expect(isDestructiveSql('ALTER TABLE "users" DROP CONSTRAINT "fk";')).toBe(false)
    expect(isDestructiveSql('ALTER TABLE "users" ALTER COLUMN "a" DROP DEFAULT;')).toBe(false)
    expect(isDestructiveSql('ALTER TABLE "users" ALTER COLUMN "a" DROP NOT NULL;')).toBe(false)
  })
})

describe('parseDbDiffOutput', () => {
  it('parses UP and DOWN sections', () => {
    const output = `
-- ==================== UP ====================
ALTER TABLE "users" ADD COLUMN "bio" text;
CREATE INDEX idx_bio ON users(bio);
-- ==================== DOWN ====================
ALTER TABLE "users" DROP COLUMN "bio";
DROP INDEX idx_bio;
`
    const result = parseDbDiffOutput(output)
    expect(result.up).toContain('ALTER TABLE "users" ADD COLUMN "bio" text;')
    expect(result.up).toContain('CREATE INDEX idx_bio')
    expect(result.down).toContain('ALTER TABLE "users" DROP COLUMN "bio";')
    expect(result.down).toContain('DROP INDEX idx_bio')
  })

  it('handles UP-only output', () => {
    const output = `
-- ==================== UP ====================
ALTER TABLE "users" ADD COLUMN "bio" text;
`
    const result = parseDbDiffOutput(output)
    expect(result.up).toContain('ADD COLUMN')
    expect(result.down).toBe('')
  })

  it('handles output without markers (raw SQL)', () => {
    const output = 'ALTER TABLE "users" ADD COLUMN "bio" text;'
    const result = parseDbDiffOutput(output)
    expect(result.up).toContain('ADD COLUMN')
    expect(result.down).toBe('')
  })

  it('handles empty output', () => {
    const result = parseDbDiffOutput('')
    expect(result.up).toBe('')
    expect(result.down).toBe('')
  })

  it('handles whitespace-only output', () => {
    const result = parseDbDiffOutput('   \n  \n  ')
    expect(result.up).toBe('')
    expect(result.down).toBe('')
  })
})

describe('sqlToIssues', () => {
  it('returns empty for no diff', () => {
    const issues = sqlToIssues({ up: '', down: '' }, 'schema')
    expect(issues).toEqual([])
  })

  it('creates one issue per UP statement', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;\nCREATE INDEX idx_bio ON users(bio);',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";\nDROP INDEX idx_bio;',
    }, 'schema')

    expect(issues).toHaveLength(2)
    expect(issues[0].id).toBe('schema-alter-1')
    expect(issues[0].check).toBe('schema')
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
    expect(issues[0].sql?.down).toContain('DROP COLUMN')
    expect(issues[1].id).toBe('schema-create-index-2')
  })

  it('classifies DROP as critical severity', () => {
    const issues = sqlToIssues({
      up: 'DROP TABLE "legacy";',
      down: 'CREATE TABLE "legacy" (id int);',
    }, 'schema')

    expect(issues[0].severity).toBe('critical')
  })

  it('classifies ALTER as warning severity', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    }, 'schema')

    expect(issues[0].severity).toBe('warning')
  })

  it('creates data-check issues with correct titles', () => {
    const issues = sqlToIssues({
      up: `INSERT INTO "plans" VALUES('3','premium');`,
      down: `DELETE FROM "plans" WHERE "id" = '3';`,
    }, 'data')

    expect(issues[0].check).toBe('data')
    expect(issues[0].title).toContain('plans')
    expect(issues[0].title).toContain('Missing row')
  })

  it('handles UPDATE data issues', () => {
    const issues = sqlToIssues({
      up: `UPDATE "plans" SET "name" = 'Premium' WHERE "id" = '1';`,
      down: `UPDATE "plans" SET "name" = 'Basic' WHERE "id" = '1';`,
    }, 'data')

    expect(issues[0].title).toContain('Modified row')
  })

  it('handles DELETE data issues', () => {
    const issues = sqlToIssues({
      up: `DELETE FROM "plans" WHERE "id" = '99';`,
      down: `INSERT INTO "plans" VALUES('99','old');`,
    }, 'data')

    expect(issues[0].title).toContain('Extra row')
  })

  it('keeps a dollar-quoted function body as a single statement', () => {
    const up = [
      'CREATE OR REPLACE FUNCTION public.handle_new_user()',
      'RETURNS trigger',
      'LANGUAGE plpgsql',
      'AS $$',
      'BEGIN',
      "  INSERT INTO public.profiles (id, full_name) VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');",
      '  RETURN NEW;',
      'END;',
      '$$;',
    ].join('\n')

    const issues = sqlToIssues({ up, down: 'DROP FUNCTION public.handle_new_user();' }, 'schema')

    expect(issues).toHaveLength(1)
    expect(issues[0].sql?.up).toContain('$$')
    expect(issues[0].sql?.up).toContain('INSERT INTO public.profiles')
    expect(issues[0].sql?.up).toContain('END;')
    expect(issues[0].sql?.up).toContain('RETURN NEW;')
  })

  it('splits correctly at boundaries outside dollar-quoted blocks', () => {
    const up = [
      'CREATE OR REPLACE FUNCTION public.foo()',
      'RETURNS void',
      'LANGUAGE plpgsql',
      'AS $$',
      'BEGIN',
      '  INSERT INTO t VALUES (1);',
      'END;',
      '$$;',
      'ALTER TABLE t ADD COLUMN bio text;',
    ].join('\n')

    const issues = sqlToIssues({ up, down: '' }, 'schema')

    expect(issues).toHaveLength(2)
    expect(issues[0].sql?.up).toContain('CREATE OR REPLACE FUNCTION')
    expect(issues[0].sql?.up).toContain('$$')
    expect(issues[1].sql?.up).toContain('ADD COLUMN bio')
  })

  it('handles named dollar-quote tags like $body$', () => {
    const up = [
      'CREATE OR REPLACE FUNCTION public.bar()',
      'RETURNS void',
      'LANGUAGE plpgsql',
      'AS $body$',
      'BEGIN',
      '  DELETE FROM t WHERE id = 1;',
      'END;',
      '$body$;',
    ].join('\n')

    const issues = sqlToIssues({ up, down: '' }, 'schema')

    expect(issues).toHaveLength(1)
    expect(issues[0].sql?.up).toContain('$body$')
    expect(issues[0].sql?.up).toContain('DELETE FROM t')
  })
})

describe('classifyStatement', () => {
  it.each([
    ['CREATE VIEW "v_users" AS SELECT * FROM users;', 'create-view'],
    ['CREATE OR REPLACE VIEW "v_users" AS SELECT * FROM users;', 'create-view'],
    ['ALTER VIEW "v_users" RENAME TO "v_customers";', 'alter-view'],
    ['DROP VIEW "v_users";', 'drop-view'],
    ['CREATE FUNCTION calculate_total() RETURNS integer AS $$ SELECT 1; $$ LANGUAGE sql;', 'create-function'],
    ['CREATE OR REPLACE FUNCTION calculate_total() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;', 'create-function'],
    ['ALTER FUNCTION calculate_total() OWNER TO admin;', 'alter-function'],
    ['DROP FUNCTION calculate_total();', 'drop-function'],
    ['CREATE PROCEDURE sync_data() AS $$ BEGIN END; $$ LANGUAGE plpgsql;', 'create-function'],
    ['DROP PROCEDURE sync_data();', 'drop-function'],
    ['CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION audit_fn();', 'create-trigger'],
    ['ALTER TRIGGER trg_audit ON users RENAME TO trg_audit_v2;', 'alter-trigger'],
    ['DROP TRIGGER trg_audit ON users;', 'drop-trigger'],
    ['CREATE TYPE mood AS ENUM (\'happy\', \'sad\');', 'create-type'],
    ['ALTER TYPE mood ADD VALUE \'neutral\';', 'alter-type'],
    ['DROP TYPE mood;', 'drop-type'],
    ['CREATE DOMAIN email AS text CHECK (VALUE ~ \'@\');', 'create-type'],
    ['ALTER DOMAIN email SET NOT NULL;', 'alter-type'],
    ['DROP DOMAIN email;', 'drop-type'],
    ['CREATE SEQUENCE orders_seq;', 'create-sequence'],
    ['ALTER SEQUENCE orders_seq RESTART WITH 100;', 'alter-sequence'],
    ['DROP SEQUENCE orders_seq;', 'drop-sequence'],
    ['ALTER TABLE "users" ADD COLUMN "bio" text;', 'alter'],
    ['CREATE TABLE "users" (id int);', 'create-table'],
    ['DROP TABLE "users";', 'drop'],
    ['CREATE INDEX idx_email ON users(email);', 'create-index'],
    ['CREATE UNIQUE INDEX idx_email ON users(email);', 'create-index'],
    ['DROP INDEX idx_email;', 'drop'],
    ['INSERT INTO "plans" VALUES(1);', 'insert'],
    ['UPDATE "plans" SET name = \'x\';', 'update'],
    ['DELETE FROM "plans" WHERE id = 1;', 'delete'],
    ['GRANT SELECT ON users TO reader;', 'change'],
  ])('classifies %j as %s', (sql, expected) => {
    expect(classifyStatement(sql)).toBe(expected)
  })
})

describe('summariseStatement', () => {
  it.each([
    ['CREATE VIEW "v_active_users" AS SELECT * FROM users;', 'schema', 'View missing: v_active_users'],
    ['DROP VIEW "v_active_users";', 'schema', 'Extra view: v_active_users'],
    ['ALTER VIEW "v_active_users" RENAME TO "v_old";', 'schema', 'View altered: v_active_users'],
    // Titles carry the argument signature so overloads are distinguishable
    // (issue #40); a zero-argument routine therefore renders as `name()`.
    ['CREATE FUNCTION calculate_total() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;', 'schema', 'Function missing: calculate_total()'],
    ['DROP FUNCTION calculate_total();', 'schema', 'Extra function: calculate_total()'],
    ['ALTER FUNCTION calculate_total() OWNER TO admin;', 'schema', 'Function altered: calculate_total()'],
    ['CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn();', 'schema', 'Trigger missing: trg_audit'],
    ['DROP TRIGGER trg_audit ON users;', 'schema', 'Extra trigger: trg_audit'],
    ['ALTER TRIGGER trg_audit ON users RENAME TO trg_v2;', 'schema', 'Trigger altered: trg_audit'],
    ['CREATE TYPE mood AS ENUM (\'happy\', \'sad\');', 'schema', 'Type missing: mood'],
    ['ALTER TYPE mood ADD VALUE \'neutral\';', 'schema', 'Type altered: mood'],
    ['DROP TYPE mood;', 'schema', 'Extra type: mood'],
    ['CREATE DOMAIN email AS text;', 'schema', 'Domain missing: email'],
    ['DROP DOMAIN email;', 'schema', 'Extra domain: email'],
    ['CREATE SEQUENCE orders_seq;', 'schema', 'Sequence missing: orders_seq'],
    ['ALTER SEQUENCE orders_seq RESTART;', 'schema', 'Sequence altered: orders_seq'],
    ['DROP SEQUENCE orders_seq;', 'schema', 'Extra sequence: orders_seq'],
    ['ALTER TABLE "users" ADD COLUMN "bio" text;', 'schema', 'Table altered: users'],
    ['CREATE TABLE "posts" (id int);', 'schema', 'Table missing: posts'],
    ['DROP TABLE "posts";', 'schema', 'Extra table: posts'],
    // Named by the index, not the table it is on, and not the schema (issue #47).
    ['CREATE INDEX idx_bio ON users(bio);', 'schema', 'Index missing: idx_bio'],
    ['DROP INDEX idx_bio;', 'schema', 'Extra index: idx_bio'],
  ] as const)('summarises %j (%s) → %s', (sql, check, expected) => {
    expect(summariseStatement(sql, check)).toBe(expected)
  })

  it.each([
    ['INSERT INTO "plans" VALUES(1);', 'data', 'Missing row in plans'],
    ['DELETE FROM "plans" WHERE id = 1;', 'data', 'Extra row in plans'],
    ['UPDATE "plans" SET name = \'x\';', 'data', 'Modified row in plans'],
  ] as const)('summarises data: %j → %s', (sql, check, expected) => {
    expect(summariseStatement(sql, check)).toBe(expected)
  })
})

describe('sqlToIssues — programmable objects', () => {
  it('classifies DROP VIEW as critical', () => {
    const issues = sqlToIssues({
      up: 'DROP VIEW "v_active_users";',
      down: 'CREATE VIEW "v_active_users" AS SELECT * FROM users;',
    }, 'schema')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('schema-drop-view-1')
    expect(issues[0].title).toBe('Extra view: v_active_users')
  })

  it('classifies DROP FUNCTION as critical', () => {
    const issues = sqlToIssues({
      up: 'DROP FUNCTION calculate_total();',
      down: 'CREATE FUNCTION calculate_total() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
    }, 'schema')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('schema-drop-function-1')
  })

  it('classifies DROP TRIGGER as critical', () => {
    const issues = sqlToIssues({
      up: 'DROP TRIGGER trg_audit ON users;',
      down: 'CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn();',
    }, 'schema')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('schema-drop-trigger-1')
  })

  it('classifies DROP TYPE as critical', () => {
    const issues = sqlToIssues({
      up: 'DROP TYPE mood;',
      down: "CREATE TYPE mood AS ENUM ('happy', 'sad');",
    }, 'schema')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('schema-drop-type-1')
  })

  it('classifies CREATE VIEW as warning', () => {
    const issues = sqlToIssues({
      up: 'CREATE VIEW "v_active" AS SELECT * FROM users WHERE active;',
      down: 'DROP VIEW "v_active";',
    }, 'schema')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('schema-create-view-1')
    expect(issues[0].title).toBe('View missing: v_active')
  })

  it('classifies CREATE FUNCTION as warning', () => {
    const issues = sqlToIssues({
      up: 'CREATE FUNCTION calc() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      down: 'DROP FUNCTION calc();',
    }, 'schema')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('schema-create-function-1')
  })

  it('handles mixed table + view + function diff', () => {
    const issues = sqlToIssues({
      up: [
        'ALTER TABLE "users" ADD COLUMN "bio" text;',
        'CREATE VIEW "v_active" AS SELECT * FROM users WHERE active;',
        'CREATE FUNCTION calc() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      ].join('\n'),
      down: [
        'ALTER TABLE "users" DROP COLUMN "bio";',
        'DROP VIEW "v_active";',
        'DROP FUNCTION calc();',
      ].join('\n'),
    }, 'schema')
    expect(issues).toHaveLength(3)
    expect(issues[0].id).toBe('schema-alter-1')
    expect(issues[1].id).toBe('schema-create-view-2')
    expect(issues[2].id).toBe('schema-create-function-3')
  })
})

describe('sqlToIssues — cross-schema FK filtering', () => {
  it('filters out FK constraint referencing schema-qualified ignored schema', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id") ON DELETE CASCADE;',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'schema', ['auth', 'storage'])
    expect(issues).toHaveLength(0)
  })

  it('filters out FK with broken empty REFERENCES from dbdiff', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "" ("");',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'schema', ['auth'])
    expect(issues).toHaveLength(0)
  })

  it('filters out unqualified FK when DOWN has broken REFERENCES', () => {
    // This is the actual dbdiff output format: UP strips the schema, DOWN has empty refs
    const issues = sqlToIssues({
      up: [
        'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
      ].join('\n'),
      down: [
        'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "" ("") ON UPDATE NO ACTION ON DELETE CASCADE;',
      ].join('\n'),
    }, 'schema', ['auth'])
    expect(issues).toHaveLength(0)
  })

  it('keeps FK constraints referencing public schema tables', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("id");',
      down: 'ALTER TABLE "comments" DROP CONSTRAINT "comments_post_id_fkey";',
    }, 'schema', ['auth', 'storage'])
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('comments')
  })

  it('does not filter when ignoreSchemas is not provided', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id");',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'schema')
    expect(issues).toHaveLength(1)
  })

  it('does not filter FK constraints for data checks', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id");',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'data', ['auth'])
    expect(issues).toHaveLength(1)
  })

  it('filters FK and keeps other statements in mixed output', () => {
    const issues = sqlToIssues({
      up: [
        'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
        'ALTER TABLE "users" ADD COLUMN "bio" text;',
      ].join('\n'),
      down: [
        'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "" ("") ON UPDATE NO ACTION ON DELETE CASCADE;',
        'ALTER TABLE "users" DROP COLUMN "bio";',
      ].join('\n'),
    }, 'schema', ['auth'])
    // Only the ADD COLUMN survives — both FK statements are filtered
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('users')
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
  })

  // ── ignoredSchemaTables (unqualified REFERENCES) ─────────────────────────

  it('filters unqualified FK when referenced table is in ignoredSchemaTables', () => {
    // Real-world case: dbdiff outputs REFERENCES "users" (no schema prefix) because
    // Supabase sets search_path. The auth schema was excluded from the local clone
    // so local has no FK, prod has the FK referencing auth.users.
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'schema', ['auth'], new Set(['users', 'refresh_tokens']))
    expect(issues).toHaveLength(0)
  })

  it('keeps unqualified FK when referenced table is NOT in ignoredSchemaTables', () => {
    const issues = sqlToIssues({
      up: 'ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("id");',
      down: 'ALTER TABLE "comments" DROP CONSTRAINT "comments_post_id_fkey";',
    }, 'schema', ['auth'], new Set(['users', 'refresh_tokens']))
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('comments')
  })

  it('filters unqualified FK and keeps unrelated statements in mixed output', () => {
    // Mirrors the exact output seen in the field: lone ADD CONSTRAINT (no preceding DROP)
    // with unqualified REFERENCES, paired with a legitimate schema change
    const issues = sqlToIssues({
      up: [
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
        'ALTER TABLE "projects" ADD COLUMN "description" text;',
      ].join('\n'),
      down: [
        'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
        'ALTER TABLE "projects" DROP COLUMN "description";',
      ].join('\n'),
    }, 'schema', ['auth'], new Set(['users']))
    expect(issues).toHaveLength(1)
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
  })

  it('falls back gracefully when ignoredSchemaTables is omitted (no regression)', () => {
    // Without ignoredSchemaTables the unqualified ref is NOT filtered — existing behaviour
    const issues = sqlToIssues({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    }, 'schema', ['auth'])
    // Still shows as an issue — caller must provide ignoredSchemaTables to suppress it
    expect(issues).toHaveLength(1)
  })
})

// ── Regression: issue #35 ─────────────────────────────────────────────────
// "Schema check double-counts modified functions and mislabels them as
// missing / extra". A function present on both sides with a differing body
// was reported twice — once CRITICAL "Extra function: IF", once WARNING
// "Function missing: public" — and neither title named the function.

describe('extractRoutineName (issue #35)', () => {
  it('skips IF EXISTS instead of returning the IF keyword', () => {
    expect(extractRoutineName('DROP FUNCTION IF EXISTS "example_fn";')).toBe('example_fn')
    expect(extractRoutineName('DROP FUNCTION if exists example_fn;')).toBe('example_fn')
  })

  it('keeps the schema qualifier instead of returning it alone', () => {
    expect(
      extractRoutineName('CREATE OR REPLACE FUNCTION public.example_fn() RETURNS integer AS $$ SELECT 1 $$;'),
    ).toBe('public.example_fn')
  })

  it('handles quoting on either side of the dot', () => {
    expect(extractRoutineName('DROP FUNCTION "public"."my_fn";')).toBe('public.my_fn')
    expect(extractRoutineName('DROP FUNCTION public."my_fn";')).toBe('public.my_fn')
  })

  it('handles unqualified and procedure forms', () => {
    expect(extractRoutineName('DROP FUNCTION "plain_fn";')).toBe('plain_fn')
    expect(extractRoutineName('DROP PROCEDURE IF EXISTS public.do_thing;')).toBe('public.do_thing')
  })

  it('returns unknown rather than throwing on unrecognised SQL', () => {
    expect(extractRoutineName('ALTER TABLE "t" ADD COLUMN "c" text;')).toBe('unknown')
  })
})

describe('routine titles name the routine (issue #35)', () => {
  it('no longer reports the IF keyword as the function name', () => {
    const title = summariseStatement('DROP FUNCTION IF EXISTS "example_fn";', 'schema')
    expect(title).toBe('Extra function: example_fn')
    expect(title).not.toContain('IF')
  })

  it('no longer reports the schema qualifier as the function name', () => {
    const title = summariseStatement(
      'CREATE OR REPLACE FUNCTION public.example_fn() RETURNS integer AS $$ SELECT 1 $$;',
      'schema',
    )
    expect(title).toBe('Function missing: public.example_fn()')
  })
})

describe('mergeRoutineReplacements (issue #35)', () => {
  const DROP = 'DROP FUNCTION IF EXISTS "example_fn";'
  const CREATE = 'CREATE OR REPLACE FUNCTION public.example_fn() RETURNS integer AS $$ SELECT 2 $$;'

  it('collapses a DROP + CREATE pair for the same routine into one entry', () => {
    const merged = mergeRoutineReplacements([DROP, CREATE], ['', ''])
    expect(merged).toHaveLength(1)
    expect(merged[0].modifiedRoutine).toBe('public.example_fn')
    expect(merged[0].up).toContain('DROP FUNCTION')
    expect(merged[0].up).toContain('CREATE OR REPLACE FUNCTION')
  })

  it('leaves an unpaired DROP alone — that is a genuine extra function', () => {
    const merged = mergeRoutineReplacements([DROP], [''])
    expect(merged).toHaveLength(1)
    expect(merged[0].modifiedRoutine).toBeUndefined()
  })

  it('leaves an unpaired CREATE alone — that is a genuine missing function', () => {
    const merged = mergeRoutineReplacements([CREATE], [''])
    expect(merged).toHaveLength(1)
    expect(merged[0].modifiedRoutine).toBeUndefined()
  })

  it('does not pair a DROP with a CREATE for a different routine', () => {
    const other = 'CREATE OR REPLACE FUNCTION public.other_fn() RETURNS void AS $$ SELECT $$;'
    const merged = mergeRoutineReplacements([DROP, other], ['', ''])
    expect(merged).toHaveLength(2)
    expect(merged.every(m => m.modifiedRoutine === undefined)).toBe(true)
  })

  it('leaves non-routine statements untouched', () => {
    const stmts = ['ALTER TABLE "t" ADD COLUMN "c" text;', 'DROP TABLE "old";']
    expect(mergeRoutineReplacements(stmts, ['', ''])).toHaveLength(2)
  })
})

describe('mergeRoutineReplacements with overloaded routines (@dbdiff/cli 3.0.0-rc.7)', () => {
  // Verbatim from `dbdiff --driver=pgsql` 3.0.0-rc.7 against two PostgreSQL 16
  // databases whose three `dist` overloads all differ. Before rc.7 the adapter
  // never saw this: dbdiff collapsed overloads onto one name and emitted a
  // single pair. Now it emits one pair per overload, argument-qualified.
  const up = [
    'DROP FUNCTION IF EXISTS "dist"(bigint,bigint);',
    'CREATE OR REPLACE FUNCTION public.dist(a bigint, b bigint)\n RETURNS bigint\n LANGUAGE sql\nAS $function$ SELECT a * b; $function$;',
    'DROP FUNCTION IF EXISTS "dist"(integer,integer);',
    'CREATE OR REPLACE FUNCTION public.dist(a integer, b integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a - b; $function$;',
    'DROP FUNCTION IF EXISTS "dist"(text,text);',
    'CREATE OR REPLACE FUNCTION public.dist(a text, b text)\n RETURNS text\n LANGUAGE sql\nAS $function$ SELECT a || b; $function$;',
  ]
  const down = up.map(() => '')

  it('reports one modified-routine entry per overload, not five entries', () => {
    const merged = mergeRoutineReplacements(up, down)
    expect(merged).toHaveLength(3)
    expect(merged.every(m => m.modifiedRoutine !== undefined)).toBe(true)
  })

  it('pairs each DROP with its own CREATE, not with the last one', () => {
    const merged = mergeRoutineReplacements(up, down)

    // The failure this guards against attached the text body to the bigint
    // drop, so the applied migration removed two overloads permanently.
    expect(merged[0].up).toContain('"dist"(bigint,bigint)')
    expect(merged[0].up).toContain('SELECT a * b;')
    expect(merged[0].up).not.toContain('SELECT a || b;')

    expect(merged[1].up).toContain('"dist"(integer,integer)')
    expect(merged[1].up).toContain('SELECT a - b;')

    expect(merged[2].up).toContain('"dist"(text,text)')
    expect(merged[2].up).toContain('SELECT a || b;')
  })

  it('consumes each CREATE once so none is duplicated across entries', () => {
    const merged = mergeRoutineReplacements(up, down)
    const bodies = merged.map(m => /SELECT a [*|-]+ b;/.exec(m.up)?.[0])
    expect(new Set(bodies).size).toBe(3)
  })

  it('distinguishes the overloads by argument signature in the title', () => {
    const merged = mergeRoutineReplacements(up, down)
    expect(merged.map(m => m.modifiedRoutine)).toEqual([
      'public.dist(bigint,bigint)',
      'public.dist(integer,integer)',
      'public.dist(text,text)',
    ])
  })

  it('still merges a bare DROP with no argument list (MySQL, pre-rc.7)', () => {
    const merged = mergeRoutineReplacements(
      [
        'DROP FUNCTION IF EXISTS "example_fn";',
        'CREATE OR REPLACE FUNCTION public.example_fn() RETURNS integer AS $$ SELECT 2 $$;',
      ],
      ['', ''],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].modifiedRoutine).toBe('public.example_fn')
  })

  it('keeps an overload unpaired when only its DROP is present', () => {
    const merged = mergeRoutineReplacements(
      [
        'DROP FUNCTION IF EXISTS "dist"(bigint,bigint);',
        'DROP FUNCTION IF EXISTS "dist"(text,text);',
        'CREATE OR REPLACE FUNCTION public.dist(a text, b text) RETURNS text AS $$ SELECT a $$;',
      ],
      ['', '', ''],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0].modifiedRoutine).toBeUndefined()
    expect(merged[1].modifiedRoutine).toBe('public.dist(text,text)')
  })
})

describe('extractRoutineArgs', () => {
  it('returns the argument list of an argument-qualified DROP', () => {
    expect(extractRoutineArgs('DROP FUNCTION IF EXISTS "dist"(bigint,bigint);')).toBe('(bigint,bigint)')
  })

  it('returns empty for a bare DROP', () => {
    expect(extractRoutineArgs('DROP FUNCTION IF EXISTS "dist";')).toBe('')
  })

  it('returns empty for a zero-argument routine written without parens', () => {
    expect(extractRoutineArgs('DROP PROCEDURE IF EXISTS "do_thing";')).toBe('')
  })

  it('keeps an empty argument list distinct from an absent one', () => {
    expect(extractRoutineArgs('DROP FUNCTION IF EXISTS "f"();')).toBe('()')
  })

  it('handles types that carry their own parens', () => {
    expect(extractRoutineArgs('DROP FUNCTION IF EXISTS "f"(numeric(10,2),text);')).toBe('(numeric(10,2),text)')
  })

  it('returns empty rather than a truncated list when parens are unbalanced', () => {
    expect(extractRoutineArgs('DROP FUNCTION IF EXISTS "f"(text;')).toBe('')
  })
})

describe('sqlToIssues routine reporting (issue #35)', () => {
  const up = [
    'DROP FUNCTION IF EXISTS "example_fn";',
    'CREATE OR REPLACE FUNCTION public.example_fn() RETURNS integer AS $$ SELECT 2 $$;',
  ].join('\n')

  it('reports a modified function once, as a warning, correctly named', () => {
    const issues = sqlToIssues({ up, down: '' }, 'schema')
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Function modified: public.example_fn')
    // Was CRITICAL via the bogus "Extra function", which inflated the
    // critical count and dragged the drift score down.
    expect(issues[0].severity).toBe('warning')
  })

  it('keeps both statements in the fix so the replacement still applies', () => {
    const issues = sqlToIssues({ up, down: '' }, 'schema')
    expect(issues[0].sql?.up).toContain('DROP FUNCTION')
    expect(issues[0].sql?.up).toContain('CREATE OR REPLACE FUNCTION')
  })

  it('still reports a genuinely extra function as critical', () => {
    const issues = sqlToIssues({ up: 'DROP FUNCTION IF EXISTS "gone_fn";', down: '' }, 'schema')
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toBe('Extra function: gone_fn')
  })
})

// ── Issue #29 remainder ───────────────────────────────────────────────────

describe('resolveDbDiffTimeoutMs precedence (issue #29)', () => {
  afterEach(() => { delete process.env.SUPAFORGE_DBDIFF_TIMEOUT })

  it('uses the per-environment config value when no env var is set', () => {
    expect(resolveDbDiffTimeoutMs(900)).toBe(900_000)
  })

  it('lets the env var win over config — it is the runtime escape hatch', () => {
    process.env.SUPAFORGE_DBDIFF_TIMEOUT = '120'
    expect(resolveDbDiffTimeoutMs(900)).toBe(120_000)
  })

  it('falls back to the default when config is absent or nonsensical', () => {
    for (const bad of [undefined, 0, -5, NaN, Infinity]) {
      expect(resolveDbDiffTimeoutMs(bad as number)).toBe(DBDIFF_EXEC_TIMEOUT_MS)
    }
  })
})

describe('parseDbDiffProgress (issue #29)', () => {
  it('extracts the table from dbdiff progress lines', () => {
    expect(parseDbDiffProgress('ℹ Now calculating schema diff for table `users`')).toBe('users')
    expect(parseDbDiffProgress('Now calculating schema diff for table "orders"')).toBe('orders')
  })

  it('handles schema-qualified names', () => {
    expect(parseDbDiffProgress('calculating schema diff for table `public.users`')).toBe('public.users')
  })

  it('returns null for unrelated output, so nothing is miscounted', () => {
    expect(parseDbDiffProgress('ℹ Now generating UP migration')).toBeNull()
    expect(parseDbDiffProgress('Pre-scan: skipped 284 / 291 unchanged tables')).toBeNull()
    expect(parseDbDiffProgress('')).toBeNull()
    expect(parseDbDiffProgress('random noise')).toBeNull()
  })
})

// ─── issue #40: overloaded routines must be distinguishable by title alone ──

describe('routine titles carry the signature (issue #40)', () => {
  it('names which overload an Extra function refers to', () => {
    // The generated SQL was already signature-aware; only the title lost it.
    expect(summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(uuid,integer);', 'schema'))
      .toBe('Extra function: example_fn(uuid,integer)')
  })

  it('gives two target-only overloads of one name different titles', () => {
    // Previously both read "Extra function: example_fn" and were
    // indistinguishable without reading the SQL fix line.
    const a = summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(uuid,integer);', 'schema')
    const b = summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(text,text);', 'schema')
    expect(a).not.toBe(b)
  })

  it('matches the format Function modified already used', () => {
    const modified = extractRoutineName('CREATE OR REPLACE FUNCTION public.dist(a text, b text) RETURNS text AS $$ SELECT a $$;')
      + extractRoutineArgs('DROP FUNCTION IF EXISTS "dist"(text,text);')
    expect(modified).toBe('public.dist(text,text)')
    expect(summariseStatement('DROP FUNCTION IF EXISTS "dist"(text,text);', 'schema'))
      .toBe('Extra function: dist(text,text)')
  })

  it('covers procedures too', () => {
    expect(summariseStatement('DROP PROCEDURE IF EXISTS "do_thing"(integer);', 'schema'))
      .toBe('Extra procedure: do_thing(integer)')
  })

  it('keeps the schema qualifier when the statement has one', () => {
    expect(summariseStatement('CREATE OR REPLACE FUNCTION public.fn(a int) RETURNS void AS $$ $$;', 'schema'))
      .toBe('Function missing: public.fn(a int)')
  })

  it('adds no schema qualifier when the statement lacks one', () => {
    // dbdiff emits the DROP unqualified. Inventing `public.` would be wrong
    // for a routine that lives anywhere else.
    expect(summariseStatement('DROP FUNCTION IF EXISTS "fn"(int);', 'schema'))
      .not.toContain('public.')
  })
})

describe('routineLabel', () => {
  it('joins the name and its argument list', () => {
    expect(routineLabel('DROP FUNCTION IF EXISTS "f"(numeric(10,2),text);')).toBe('f(numeric(10,2),text)')
  })

  it('renders a zero-argument routine with empty parens', () => {
    expect(routineLabel('DROP FUNCTION IF EXISTS "f"();')).toBe('f()')
  })

  it('returns the bare name when there is no argument list at all', () => {
    // MySQL has no overloading and pre-rc.7 dbdiff emitted no signature.
    expect(routineLabel('DROP FUNCTION IF EXISTS "f";')).toBe('f')
  })
})

/**
 * Issue #47 (1): titles across the schema check did not agree on a format, and
 * two of them dropped information the SQL fix just below carried. Both came
 * from per-kind regexes that reached the schema qualifier rather than the
 * identifier.
 */
describe('schema titles are one schema-qualified format (issue #47)', () => {
  it('names an index by the index, qualified by its table\'s schema', () => {
    const sql = 'CREATE INDEX idx_orders_status ON public.orders USING btree (status);'
    // Was "Index missing on public" — the schema, in the name's place.
    expect(summariseStatement(sql, 'schema')).toBe('Index missing: public.idx_orders_status')
  })

  it('leaves an index bare when its table carries no schema either', () => {
    expect(summariseStatement('CREATE INDEX idx_bio ON users (bio);', 'schema')).toBe('Index missing: idx_bio')
  })

  it('handles a quoted, qualified table in the ON clause', () => {
    const sql = 'CREATE UNIQUE INDEX "idx_a" ON "billing"."invoices" USING btree (a);'
    expect(summariseStatement(sql, 'schema')).toBe('Index missing: billing.idx_a')
  })

  it('qualifies an Extra function from the DOWN statement that restores it', () => {
    // dbdiff emits the DROP unqualified and the DOWN from pg_get_functiondef,
    // which is qualified — so the schema is reported, never invented.
    const up = 'DROP FUNCTION IF EXISTS "example_fn"(uuid,integer);'
    const down = 'CREATE OR REPLACE FUNCTION public.example_fn(a uuid, b integer) RETURNS void AS $$ $$;'
    expect(summariseStatement(up, 'schema', down)).toBe('Extra function: public.example_fn(uuid,integer)')
  })

  it('keeps the signature that tells two overloads apart', () => {
    const down = 'CREATE OR REPLACE FUNCTION public.example_fn(a text, b text) RETURNS void AS $$ $$;'
    const a = summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(uuid,integer);', 'schema', down)
    const b = summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(text,text);', 'schema', down)
    expect(a).not.toBe(b)
  })

  it('never borrows a schema from a counterpart naming a different routine', () => {
    const up = 'DROP FUNCTION IF EXISTS "example_fn"(uuid);'
    const down = 'CREATE OR REPLACE FUNCTION billing.other_fn(a uuid) RETURNS void AS $$ $$;'
    expect(summariseStatement(up, 'schema', down)).toBe('Extra function: example_fn(uuid)')
  })

  it('stays unqualified when nothing reports a schema', () => {
    expect(summariseStatement('DROP FUNCTION IF EXISTS "example_fn"(uuid);', 'schema')).toBe(
      'Extra function: example_fn(uuid)',
    )
  })

  it('keeps the schema an already-qualified title had', () => {
    const sql = 'CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$ $$;'
    expect(summariseStatement(sql, 'schema')).toBe('Function missing: public.touch_updated()')
  })

  it('qualifies every other kind that names a schema', () => {
    expect(summariseStatement('CREATE VIEW public.active_orders AS SELECT 1;', 'schema'))
      .toBe('View missing: public.active_orders')
    expect(summariseStatement('ALTER TABLE "public"."orders" ADD COLUMN s text;', 'schema'))
      .toBe('Table altered: public.orders')
    expect(summariseStatement('DROP TABLE public.legacy_notes;', 'schema'))
      .toBe('Extra table: public.legacy_notes')
    expect(summariseStatement('CREATE SEQUENCE public.orders_seq;', 'schema'))
      .toBe('Sequence missing: public.orders_seq')
    expect(summariseStatement('DROP INDEX public.idx_bio;', 'schema'))
      .toBe('Extra index: public.idx_bio')
  })

  it('uses a colon everywhere, so no title reads as prose', () => {
    const statements = [
      'CREATE INDEX idx_a ON public.t (a);',
      'CREATE VIEW v AS SELECT 1;',
      'ALTER TABLE "t" ADD COLUMN a int;',
      'CREATE TYPE mood AS ENUM (\'happy\');',
    ]
    for (const sql of statements) {
      expect(summariseStatement(sql, 'schema')).toMatch(/^[A-Z][a-z]+ [a-z]+: \S/)
    }
  })

  it('reads a trigger as a trigger even though it executes a function', () => {
    const sql = 'CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();'
    expect(summariseStatement(sql, 'schema')).toBe('Trigger missing: trg_orders_touch')
  })

  it('carries the recovered schema through sqlToIssues', () => {
    const issues = sqlToIssues(
      {
        up: 'DROP FUNCTION IF EXISTS "example_fn"(uuid);',
        down: 'CREATE OR REPLACE FUNCTION public.example_fn(a uuid) RETURNS void AS $$ $$;',
      },
      'schema',
    )
    expect(issues[0].title).toBe('Extra function: public.example_fn(uuid)')
  })
})

describe('extractQualifiedName', () => {
  it('reads a bare, a qualified and a quoted identifier alike', () => {
    const head = /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?/i
    expect(extractQualifiedName('ALTER TABLE orders ADD COLUMN a int;', head)).toBe('orders')
    expect(extractQualifiedName('ALTER TABLE public.orders ADD COLUMN a int;', head)).toBe('public.orders')
    expect(extractQualifiedName('ALTER TABLE "public"."orders" ADD COLUMN a int;', head)).toBe('public.orders')
    expect(extractQualifiedName('ALTER TABLE "public" . "orders" ADD a int;', head)).toBe('public.orders')
  })

  it('skips the optional IF EXISTS / ONLY noise rather than naming it', () => {
    const head = /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?/i
    expect(extractQualifiedName('DROP TABLE IF EXISTS "posts";', head)).toBe('posts')
    expect(extractQualifiedName('ALTER TABLE ONLY public.posts ADD a int;', head)).toBe('public.posts')
  })

  it('returns "unknown" when the keyword is absent or nothing follows it', () => {
    expect(extractQualifiedName('SELECT 1;', /\bTABLE\s+/i)).toBe('unknown')
    expect(extractQualifiedName('ALTER TABLE ', /\bTABLE\s+/i)).toBe('unknown')
  })
})
