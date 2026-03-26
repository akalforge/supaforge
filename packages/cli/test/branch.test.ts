import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchDbName,
  replaceDbName,
  loadManifest,
  BRANCH_DB_PREFIX,
  type BranchesManifest,
} from '../src/branch.js'

describe('branchDbName', () => {
  it('converts name to safe DB identifier', () => {
    expect(branchDbName('feature-x')).toBe(`${BRANCH_DB_PREFIX}feature_x`)
  })

  it('lowercases the name', () => {
    expect(branchDbName('FEATURE-X')).toBe(`${BRANCH_DB_PREFIX}feature_x`)
  })

  it('collapses multiple underscores', () => {
    expect(branchDbName('my--long---name')).toBe(`${BRANCH_DB_PREFIX}my_long_name`)
  })

  it('strips leading/trailing underscores from safe name', () => {
    expect(branchDbName('-feature-')).toBe(`${BRANCH_DB_PREFIX}feature`)
  })

  it('throws for empty branch name', () => {
    expect(() => branchDbName('')).toThrow('Invalid branch name')
  })

  it('throws for name with only special characters', () => {
    expect(() => branchDbName('---')).toThrow('Invalid branch name')
  })

  it('handles numeric names', () => {
    expect(branchDbName('123')).toBe(`${BRANCH_DB_PREFIX}123`)
  })
})

describe('replaceDbName', () => {
  it('replaces the database name in a PostgreSQL URL', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb', 'newdb')
    expect(result).toContain('/newdb')
    expect(result).not.toContain('/mydb')
  })

  it('preserves authentication and host', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb', 'newdb')
    expect(result).toContain('user:pass@host:5432')
  })

  it('handles URLs with query parameters', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb?sslmode=require', 'newdb')
    expect(result).toContain('/newdb')
    expect(result).toContain('sslmode=require')
  })
})

describe('loadManifest', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty manifest when no file exists', async () => {
    const manifest = await loadManifest(tempDir)
    expect(manifest).toEqual({ branches: [] })
  })

  it('loads existing manifest file', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(tempDir, '.supaforge')
    await mkdir(dir, { recursive: true })

    const data: BranchesManifest = {
      branches: [
        {
          name: 'feature-x',
          dbName: `${BRANCH_DB_PREFIX}feature_x`,
          dbUrl: 'postgresql://user:pass@host:5432/supaforge_branch_feature_x',
          createdFrom: 'production',
          createdAt: '2025-01-01T00:00:00.000Z',
          schemaOnly: false,
        },
      ],
    }

    await writeFile(join(dir, 'branches.json'), JSON.stringify(data))
    const manifest = await loadManifest(tempDir)
    expect(manifest.branches).toHaveLength(1)
    expect(manifest.branches[0].name).toBe('feature-x')
  })
})
