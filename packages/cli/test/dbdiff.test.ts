import { describe, it, expect } from 'vitest'
import { parseDbDiffOutput, sqlToIssues, resolveDbDiffBin, classifyStatement, summariseStatement } from '../src/dbdiff.js'

describe('resolveDbDiffBin', () => {
  it('resolves to local binary when @dbdiff/cli is installed', () => {
    const { command, prefixArgs } = resolveDbDiffBin()
    // When @dbdiff/cli is a dependency, it resolves to node + bin/dbdiff.js
    expect(command).toBe(process.execPath)
    expect(prefixArgs).toHaveLength(1)
    expect(prefixArgs[0]).toContain('dbdiff.js')
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
    ['CREATE FUNCTION calculate_total() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;', 'schema', 'Function missing: calculate_total'],
    ['DROP FUNCTION calculate_total();', 'schema', 'Extra function: calculate_total'],
    ['ALTER FUNCTION calculate_total() OWNER TO admin;', 'schema', 'Function altered: calculate_total'],
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
    ['CREATE INDEX idx_bio ON users(bio);', 'schema', 'Index missing on users'],
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
})
