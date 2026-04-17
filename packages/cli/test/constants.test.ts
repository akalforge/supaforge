import { describe, it, expect } from 'vitest'
import {
  SUPAFORGE_DIR,
  SNAPSHOTS_SUBDIR,
  MIGRATIONS_SUBDIR,
  SNAPSHOT_MANIFEST_FILE,
  BRANCHES_FILE,
  SUPABASE_MGMT_API,
  DBDIFF_EXEC_TIMEOUT_MS,
  DBDIFF_MAX_BUFFER,
  PG_PIPELINE_TIMEOUT_MS,
  CLONE_PROGRESS_INTERVAL_MS,
  RUNTIME_DETECT_TIMEOUT_MS,
  CONTAINER_RM_TIMEOUT_MS,
  CONTAINER_START_TIMEOUT_MS,
  SCORE_PENALTY_CRITICAL,
  SCORE_PENALTY_WARNING,
  SCORE_PENALTY_INFO,
  SCORE_PENALTY_ERROR,
  SCORE_MAX,
  CHECK_LINE_PADDING,
  CLONE_EXTRA_EXCLUDE_SCHEMAS,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE_NAME,
  MIGRATIONS_TABLE,
  STORAGE_LIST_LIMIT,
} from '../src/constants.js'

describe('constants', () => {
  describe('directory paths', () => {
    it('SUPAFORGE_DIR is .supaforge', () => {
      expect(SUPAFORGE_DIR).toBe('.supaforge')
    })

    it('BRANCHES_FILE is under SUPAFORGE_DIR', () => {
      expect(BRANCHES_FILE).toContain(SUPAFORGE_DIR)
      expect(BRANCHES_FILE).toBe('.supaforge/branches.json')
    })

    it('subdirectories are plain names', () => {
      expect(SNAPSHOTS_SUBDIR).toBe('snapshots')
      expect(MIGRATIONS_SUBDIR).toBe('migrations')
    })

    it('SNAPSHOT_MANIFEST_FILE is manifest.json', () => {
      expect(SNAPSHOT_MANIFEST_FILE).toBe('manifest.json')
    })
  })

  describe('Supabase API', () => {
    it('SUPABASE_MGMT_API is the v1 projects endpoint', () => {
      expect(SUPABASE_MGMT_API).toBe('https://api.supabase.com/v1/projects')
    })
  })

  describe('timeouts', () => {
    it('DBDIFF_EXEC_TIMEOUT_MS is 2 minutes', () => {
      expect(DBDIFF_EXEC_TIMEOUT_MS).toBe(120_000)
    })

    it('PG_PIPELINE_TIMEOUT_MS is 30 minutes', () => {
      expect(PG_PIPELINE_TIMEOUT_MS).toBe(1_800_000)
    })

    it('CLONE_PROGRESS_INTERVAL_MS is 1 second', () => {
      expect(CLONE_PROGRESS_INTERVAL_MS).toBe(1_000)
    })

    it('RUNTIME_DETECT_TIMEOUT_MS is 5 seconds', () => {
      expect(RUNTIME_DETECT_TIMEOUT_MS).toBe(5_000)
    })

    it('CONTAINER_RM_TIMEOUT_MS is 10 seconds', () => {
      expect(CONTAINER_RM_TIMEOUT_MS).toBe(10_000)
    })

    it('CONTAINER_START_TIMEOUT_MS is 60 seconds', () => {
      expect(CONTAINER_START_TIMEOUT_MS).toBe(60_000)
    })
  })

  describe('scoring', () => {
    it('penalty weights are ordered by severity', () => {
      expect(SCORE_PENALTY_CRITICAL).toBeGreaterThan(SCORE_PENALTY_WARNING)
      expect(SCORE_PENALTY_WARNING).toBeGreaterThan(SCORE_PENALTY_INFO)
    })

    it('SCORE_PENALTY_ERROR is a small positive penalty', () => {
      expect(SCORE_PENALTY_ERROR).toBeGreaterThan(0)
      expect(SCORE_PENALTY_ERROR).toBeLessThanOrEqual(SCORE_PENALTY_WARNING)
    })

    it('SCORE_MAX is 100', () => {
      expect(SCORE_MAX).toBe(100)
    })
  })

  describe('formatting', () => {
    it('CHECK_LINE_PADDING is a reasonable width', () => {
      expect(CHECK_LINE_PADDING).toBeGreaterThanOrEqual(30)
      expect(CHECK_LINE_PADDING).toBeLessThanOrEqual(60)
    })
  })

  describe('buffers', () => {
    it('DBDIFF_MAX_BUFFER is 10 MB', () => {
      expect(DBDIFF_MAX_BUFFER).toBe(10 * 1024 * 1024)
    })
  })

  describe('clone schemas', () => {
    it('CLONE_EXTRA_EXCLUDE_SCHEMAS includes Supabase-internal schemas', () => {
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).toContain('graphql')
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).toContain('_realtime')
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).toContain('_analytics')
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).toContain('pgsodium_masks')
    })

    it('does not overlap with DEFAULT_IGNORE_SCHEMAS', () => {
      // These are the "extra" schemas, not already in DEFAULT_IGNORE_SCHEMAS
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).not.toContain('auth')
      expect(CLONE_EXTRA_EXCLUDE_SCHEMAS).not.toContain('storage')
    })
  })

  describe('migration tracking', () => {
    it('MIGRATIONS_SCHEMA is supabase_migrations', () => {
      expect(MIGRATIONS_SCHEMA).toBe('supabase_migrations')
    })

    it('MIGRATIONS_TABLE_NAME is schema_migrations', () => {
      expect(MIGRATIONS_TABLE_NAME).toBe('schema_migrations')
    })

    it('MIGRATIONS_TABLE is fully qualified', () => {
      expect(MIGRATIONS_TABLE).toBe('supabase_migrations.schema_migrations')
      expect(MIGRATIONS_TABLE).toBe(`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE_NAME}`)
    })
  })

  describe('storage', () => {
    it('STORAGE_LIST_LIMIT is 1000', () => {
      expect(STORAGE_LIST_LIMIT).toBe(1000)
    })
  })
})
