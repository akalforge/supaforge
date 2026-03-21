import { describe, it, expect } from 'vitest'
import { resolveConfig, validateConfig } from '../src/config.js'
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
