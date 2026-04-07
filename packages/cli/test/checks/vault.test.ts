import { describe, it, expect } from 'vitest'
import { VaultCheck } from '../../src/checks/vault.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

const makeSecret = (overrides: Record<string, unknown> = {}) => ({
  id: 'uuid-1',
  name: 'my_api_key',
  description: 'API key for service',
  secret: 'encrypted-value-abc',
  unique_name: 'api_key',
  nonce: 'nonce-123',
  key_id: 'key-456',
  created_at: '2024-01-01 00:00:00',
  updated_at: '2024-01-01 00:00:00',
  ...overrides,
})

describe('VaultCheck', () => {
  it('detects missing secret in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeSecret()]
      return []
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('api_key')
    expect(issues[0].sql?.up).toContain('vault.create_secret')
  })

  it('detects extra secret in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makeSecret({ unique_name: 'extra_key', name: 'extra' })]
      return []
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('extra_key')
  })

  it('detects modified structural attributes', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeSecret({ description: 'New description' })]
      return [makeSecret()]
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('Modified vault secret')
  })

  it('detects environment-specific differences as info', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeSecret({ secret: 'different-encrypted', nonce: 'other-nonce' })]
      return [makeSecret()]
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].description).toContain('environment-specific')
  })

  it('returns no issues when secrets match', async () => {
    const secret = makeSecret()
    const queryFn: QueryFn = async () => [secret]

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('handles vault extension not installed gracefully', async () => {
    const queryFn: QueryFn = async () => {
      throw new Error('schema "vault" does not exist')
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('uses unique_name as key when available', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeSecret()]
      return []
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].id).toBe('vault-missing-api_key')
  })

  it('falls back to name as key when unique_name is null', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeSecret({ unique_name: null })]
      return []
    }

    const check = new VaultCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].id).toBe('vault-missing-my_api_key')
  })
})
