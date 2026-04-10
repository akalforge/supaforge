import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveConfig, validateConfig, expandEnvVars, parseProjectRef } from '../src/config.js'
import { DEFAULT_IGNORE_SCHEMAS } from '../src/defaults.js'
import type { SupaForgeConfig } from '../src/types/config.js'

const validConfig: SupaForgeConfig = {
  environments: {
    dev: { dbUrl: 'postgres://localhost:5432/dev' },
    prod: { dbUrl: 'postgres://localhost:5432/prod' },
  },
  source: 'dev',
  target: 'prod',
}

describe('resolveConfig', () => {
  it('adds default ignore schemas when none specified', () => {
    const resolved = resolveConfig(validConfig)
    expect(resolved.ignoreSchemas).toEqual(DEFAULT_IGNORE_SCHEMAS)
  })

  it('preserves custom ignore schemas', () => {
    const custom = { ...validConfig, ignoreSchemas: ['custom'] }
    const resolved = resolveConfig(custom)
    expect(resolved.ignoreSchemas).toEqual(['custom'])
  })
})

describe('validateConfig', () => {
  it('returns no errors for valid config', () => {
    expect(validateConfig(validConfig)).toEqual([])
  })

  it('requires at least two environments', () => {
    const errors = validateConfig({
      ...validConfig,
      environments: { dev: { dbUrl: 'postgres://localhost/dev' } },
    })
    expect(errors).toContain('At least two environments are required')
  })

  it('requires source', () => {
    const errors = validateConfig({ ...validConfig, source: '' })
    expect(errors.some(e => e.includes('source'))).toBe(true)
  })

  it('requires target', () => {
    const errors = validateConfig({ ...validConfig, target: '' })
    expect(errors.some(e => e.includes('target'))).toBe(true)
  })

  it('validates source exists in environments', () => {
    const errors = validateConfig({ ...validConfig, source: 'staging' })
    expect(errors.some(e => e.includes('staging'))).toBe(true)
  })

  it('validates target exists in environments', () => {
    const errors = validateConfig({ ...validConfig, target: 'staging' })
    expect(errors.some(e => e.includes('staging'))).toBe(true)
  })

  it('rejects same source and target', () => {
    const errors = validateConfig({ ...validConfig, target: 'dev' })
    expect(errors.some(e => e.includes('different'))).toBe(true)
  })

  it('requires dbUrl for each environment', () => {
    const config: SupaForgeConfig = {
      ...validConfig,
      environments: {
        dev: { dbUrl: '' },
        prod: { dbUrl: 'postgres://localhost/prod' },
      },
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('dbUrl'))).toBe(true)
  })

  it('rejects missing environments object', () => {
    const config = { source: 'dev', target: 'prod' } as SupaForgeConfig
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('environments'))).toBe(true)
  })
})

describe('expandEnvVars', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.TEST_DB_URL = process.env.TEST_DB_URL
    saved.TEST_API_KEY = process.env.TEST_API_KEY
    process.env.TEST_DB_URL = 'postgres://user:secret@host:5432/db'
    process.env.TEST_API_KEY = 'my-service-role-key'
  })

  afterEach(() => {
    if (saved.TEST_DB_URL === undefined) delete process.env.TEST_DB_URL
    else process.env.TEST_DB_URL = saved.TEST_DB_URL
    if (saved.TEST_API_KEY === undefined) delete process.env.TEST_API_KEY
    else process.env.TEST_API_KEY = saved.TEST_API_KEY
  })

  it('expands $VAR syntax', () => {
    expect(expandEnvVars('$TEST_DB_URL')).toBe('postgres://user:secret@host:5432/db')
  })

  it('expands ${VAR} syntax', () => {
    expect(expandEnvVars('${TEST_DB_URL}')).toBe('postgres://user:secret@host:5432/db')
  })

  it('leaves unknown vars unchanged', () => {
    expect(expandEnvVars('$NONEXISTENT_VAR_12345')).toBe('$NONEXISTENT_VAR_12345')
  })

  it('expands vars embedded in a string', () => {
    expect(expandEnvVars('prefix_${TEST_API_KEY}_suffix')).toBe('prefix_my-service-role-key_suffix')
  })

  it('returns plain strings unchanged', () => {
    expect(expandEnvVars('postgres://localhost:5432/db')).toBe('postgres://localhost:5432/db')
  })
})

describe('resolveConfig with env vars', () => {
  beforeEach(() => {
    process.env.DEV_DATABASE_URL = 'postgres://localhost:5432/dev'
    process.env.PROD_DATABASE_URL = 'postgres://localhost:5432/prod'
    process.env.PROD_API_KEY = 'secret-key'
  })

  afterEach(() => {
    delete process.env.DEV_DATABASE_URL
    delete process.env.PROD_DATABASE_URL
    delete process.env.PROD_API_KEY
  })

  it('expands env vars in dbUrl and apiKey during resolve', () => {
    const config: SupaForgeConfig = {
      environments: {
        dev: { dbUrl: '$DEV_DATABASE_URL' },
        prod: { dbUrl: '$PROD_DATABASE_URL', apiKey: '$PROD_API_KEY' },
      },
      source: 'dev',
      target: 'prod',
    }

    const resolved = resolveConfig(config)

    expect(resolved.environments.dev.dbUrl).toBe('postgres://localhost:5432/dev')
    expect(resolved.environments.prod.dbUrl).toBe('postgres://localhost:5432/prod')
    expect(resolved.environments.prod.apiKey).toBe('secret-key')
  })
})

describe('parseProjectRef', () => {
  it('extracts ref from full Project URL', () => {
    expect(parseProjectRef('https://zfjldiglmcwojzdtxbky.supabase.co')).toBe('zfjldiglmcwojzdtxbky')
  })

  it('extracts ref from Project URL with trailing slash', () => {
    expect(parseProjectRef('https://abcdef123456.supabase.co/')).toBe('abcdef123456')
  })

  it('returns bare ref unchanged', () => {
    expect(parseProjectRef('abcdef123456')).toBe('abcdef123456')
  })

  it('trims whitespace', () => {
    expect(parseProjectRef('  abcdef123456  ')).toBe('abcdef123456')
  })

  it('handles non-supabase URLs by returning full hostname', () => {
    // Not a supabase.co URL — returns trimmed input as-is
    expect(parseProjectRef('https://example.com')).toBe('https://example.com')
  })
})

describe('resolveConfig normalises projectRef', () => {
  it('extracts ref from full Project URL in config', () => {
    const config: SupaForgeConfig = {
      environments: {
        dev: { dbUrl: 'postgres://localhost/dev', projectRef: 'https://abc123.supabase.co' },
        prod: { dbUrl: 'postgres://localhost/prod', projectRef: 'xyz789' },
      },
      source: 'dev',
      target: 'prod',
    }

    const resolved = resolveConfig(config)

    expect(resolved.environments.dev.projectRef).toBe('abc123')
    expect(resolved.environments.prod.projectRef).toBe('xyz789')
  })
})
