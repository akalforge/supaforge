/**
 * Unit tests for defaults — ensure constants are correctly defined.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_IGNORE_SCHEMAS, INIT_HINTS, RELATION_NOT_FOUND } from '../src/defaults.js'

describe('defaults', () => {
  describe('DEFAULT_IGNORE_SCHEMAS', () => {
    it('should be a non-empty array of strings', () => {
      expect(Array.isArray(DEFAULT_IGNORE_SCHEMAS)).toBe(true)
      expect(DEFAULT_IGNORE_SCHEMAS.length).toBeGreaterThan(0)
      for (const s of DEFAULT_IGNORE_SCHEMAS) {
        expect(typeof s).toBe('string')
      }
    })

    it('should include core Supabase internal schemas', () => {
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('auth')
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('storage')
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('realtime')
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('vault')
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('supabase_migrations')
    })

    it('should include Postgres system schemas', () => {
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('pg_catalog')
      expect(DEFAULT_IGNORE_SCHEMAS).toContain('information_schema')
    })

    it('should NOT include the public schema', () => {
      expect(DEFAULT_IGNORE_SCHEMAS).not.toContain('public')
    })
  })

  describe('INIT_HINTS', () => {
    it('should have hints for all four init prompts', () => {
      expect(INIT_HINTS.DB_URL).toBeDefined()
      expect(INIT_HINTS.PROJECT_URL).toBeDefined()
      expect(INIT_HINTS.ACCESS_TOKEN).toBeDefined()
      expect(INIT_HINTS.DATA_TABLES).toBeDefined()
    })

    it('should contain array of string hints', () => {
      for (const key of Object.keys(INIT_HINTS) as (keyof typeof INIT_HINTS)[]) {
        expect(Array.isArray(INIT_HINTS[key])).toBe(true)
        for (const line of INIT_HINTS[key]) {
          expect(typeof line).toBe('string')
        }
      }
    })
  })

  describe('RELATION_NOT_FOUND', () => {
    it('should be a non-empty string', () => {
      expect(typeof RELATION_NOT_FOUND).toBe('string')
      expect(RELATION_NOT_FOUND.length).toBeGreaterThan(0)
    })
  })
})
