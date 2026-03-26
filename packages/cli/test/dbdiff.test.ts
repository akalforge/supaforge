import { describe, it, expect } from 'vitest'
import { parseDbDiffOutput, sqlToIssues } from '../src/dbdiff.js'

describe('parseDbDiffOutput', () => {
  it('parses UP and DOWN sections', () => {
    const output = `
#---------- UP ----------
ALTER TABLE "users" ADD COLUMN "bio" text;
CREATE INDEX idx_bio ON users(bio);
#---------- DOWN ----------
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
#---------- UP ----------
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
    expect(issues[0].layer).toBe('schema')
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

  it('creates data-layer issues with correct titles', () => {
    const issues = sqlToIssues({
      up: `INSERT INTO "plans" VALUES('3','premium');`,
      down: `DELETE FROM "plans" WHERE "id" = '3';`,
    }, 'data')

    expect(issues[0].layer).toBe('data')
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
