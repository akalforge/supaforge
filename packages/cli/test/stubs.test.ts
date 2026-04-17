import { describe, it, expect } from 'vitest'
import { AUTH_STUBS_SQL, STORAGE_STUBS_SQL, CLONE_STUBS_SQL } from '../src/stubs.js'

describe('stubs', () => {
  describe('AUTH_STUBS_SQL', () => {
    it('creates auth schema', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE SCHEMA IF NOT EXISTS auth')
    })

    it('creates auth.users table with uuid PK', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE TABLE IF NOT EXISTS auth.users')
      expect(AUTH_STUBS_SQL).toContain('id uuid NOT NULL PRIMARY KEY')
    })

    it('creates auth.uid() function', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE OR REPLACE FUNCTION auth.uid()')
      expect(AUTH_STUBS_SQL).toContain('RETURNS uuid')
    })

    it('creates auth.role() function', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE OR REPLACE FUNCTION auth.role()')
      expect(AUTH_STUBS_SQL).toContain('RETURNS text')
    })

    it('creates auth.jwt() function', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE OR REPLACE FUNCTION auth.jwt()')
      expect(AUTH_STUBS_SQL).toContain('RETURNS jsonb')
    })

    it('creates auth.email() function', () => {
      expect(AUTH_STUBS_SQL).toContain('CREATE OR REPLACE FUNCTION auth.email()')
    })

    it('reads from request.jwt.claims setting', () => {
      expect(AUTH_STUBS_SQL).toContain("request.jwt.claims")
    })
  })

  describe('STORAGE_STUBS_SQL', () => {
    it('creates storage schema', () => {
      expect(STORAGE_STUBS_SQL).toContain('CREATE SCHEMA IF NOT EXISTS storage')
    })

    it('creates storage.buckets table', () => {
      expect(STORAGE_STUBS_SQL).toContain('CREATE TABLE IF NOT EXISTS storage.buckets')
    })

    it('includes required bucket columns', () => {
      expect(STORAGE_STUBS_SQL).toContain('id text NOT NULL PRIMARY KEY')
      expect(STORAGE_STUBS_SQL).toContain('name text NOT NULL UNIQUE')
      expect(STORAGE_STUBS_SQL).toContain('public boolean')
      expect(STORAGE_STUBS_SQL).toContain('file_size_limit bigint')
      expect(STORAGE_STUBS_SQL).toContain('allowed_mime_types text[]')
    })

    it('creates storage.objects table', () => {
      expect(STORAGE_STUBS_SQL).toContain('CREATE TABLE IF NOT EXISTS storage.objects')
    })
  })

  describe('CLONE_STUBS_SQL', () => {
    it('includes auth stubs', () => {
      expect(CLONE_STUBS_SQL).toContain('auth.users')
      expect(CLONE_STUBS_SQL).toContain('auth.uid()')
    })

    it('includes storage stubs', () => {
      expect(CLONE_STUBS_SQL).toContain('storage.buckets')
    })

    it('uses IF NOT EXISTS for all created objects', () => {
      // All CREATE statements should be idempotent
      const createStatements = CLONE_STUBS_SQL.match(/CREATE\s+(SCHEMA|TABLE)/gi) ?? []
      expect(createStatements.length).toBeGreaterThan(0)
      for (const match of createStatements) {
        const idx = CLONE_STUBS_SQL.indexOf(match)
        const surrounding = CLONE_STUBS_SQL.slice(idx, idx + 60)
        expect(surrounding).toContain('IF NOT EXISTS')
      }
    })

    it('uses CREATE OR REPLACE for functions', () => {
      const fnStatements = CLONE_STUBS_SQL.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) ?? []
      expect(fnStatements.length).toBeGreaterThan(0)
      for (const match of fnStatements) {
        expect(match.toUpperCase()).toContain('OR REPLACE')
      }
    })
  })
})
