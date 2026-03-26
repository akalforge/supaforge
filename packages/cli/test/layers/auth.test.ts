import { describe, it, expect } from 'vitest'
import { AuthLayer } from '../../src/layers/auth.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { FetchFn } from '../../src/layers/auth.js'

function mockContext(overrides: Partial<LayerContext> = {}): LayerContext {
  return {
    source: { dbUrl: 'postgres://source', projectRef: 'src-ref', apiKey: 'src-key' },
    target: { dbUrl: 'postgres://target', projectRef: 'tgt-ref', apiKey: 'tgt-key' },
    config: {
      environments: {
        dev: { dbUrl: '', projectRef: 'src-ref', apiKey: 'src-key' },
        prod: { dbUrl: '', projectRef: 'tgt-ref', apiKey: 'tgt-key' },
      },
      source: 'dev',
      target: 'prod',
    },
    ...overrides,
  }
}

function makeFetchFn(sourceConfig: Record<string, unknown>, targetConfig: Record<string, unknown>): FetchFn {
  return async (url: string) => {
    const body = url.includes('src-ref') ? sourceConfig : targetConfig
    return { ok: true, json: async () => body } as Response
  }
}

describe('AuthLayer', () => {
  it('returns no issues when configs match', async () => {
    const config = { JWT_EXP: 3600, MFA_ENABLED: true, SITE_URL: 'https://example.com' }
    const layer = new AuthLayer(makeFetchFn(config, config))
    const issues = await layer.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects critical auth config mismatch (MFA_ENABLED)', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { MFA_ENABLED: true },
      { MFA_ENABLED: false },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('auth-mfa_enabled')
    expect(issues[0].title).toContain('MFA_ENABLED')
    expect(issues[0].sourceValue).toBe(true)
    expect(issues[0].targetValue).toBe(false)
  })

  it('detects critical auth config mismatch (JWT_EXP)', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { JWT_EXP: 3600 },
      { JWT_EXP: 86400 },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('JWT_EXP')
  })

  it('detects critical mismatch for SECURITY_CAPTCHA_ENABLED', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { SECURITY_CAPTCHA_ENABLED: true },
      { SECURITY_CAPTCHA_ENABLED: false },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('detects info-level mismatch for non-critical keys', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { SITE_URL: 'https://dev.example.com' },
      { SITE_URL: 'https://prod.example.com' },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('SITE_URL')
  })

  it('detects multiple mismatches at once', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { JWT_EXP: 3600, SITE_URL: 'https://dev.example.com', EXTERNAL_EMAIL_ENABLED: true },
      { JWT_EXP: 7200, SITE_URL: 'https://prod.example.com', EXTERNAL_EMAIL_ENABLED: false },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(3)
    const severities = issues.map(i => i.severity)
    expect(severities).toContain('critical')
    expect(severities).toContain('info')
  })

  it('detects keys present in source but missing in target', async () => {
    const layer = new AuthLayer(makeFetchFn(
      { MFA_ENABLED: true, CUSTOM_KEY: 'value' },
      { MFA_ENABLED: true },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('CUSTOM_KEY')
  })

  it('detects keys present in target but missing in source', async () => {
    const layer = new AuthLayer(makeFetchFn(
      {},
      { NEW_FEATURE: 'enabled' },
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('NEW_FEATURE')
  })

  it('returns empty when projectRef or apiKey is missing', async () => {
    const ctx = mockContext({
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
    })
    const layer = new AuthLayer(makeFetchFn({}, {}))
    const issues = await layer.scan(ctx)
    expect(issues).toHaveLength(0)
  })

  it('calls correct API URL with auth header', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, json: async () => ({}) } as Response
    }

    const layer = new AuthLayer(fetchFn)
    await layer.scan(mockContext())

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/v1/projects/src-ref/config/auth')
    expect(calls[0].headers.Authorization).toBe('Bearer src-key')
    expect(calls[1].url).toContain('/v1/projects/tgt-ref/config/auth')
    expect(calls[1].headers.Authorization).toBe('Bearer tgt-key')
  })

  it('throws on API error', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: false, statusText: 'Forbidden' } as Response
    }

    const layer = new AuthLayer(fetchFn)
    await expect(layer.scan(mockContext())).rejects.toThrow('Forbidden')
  })
})
