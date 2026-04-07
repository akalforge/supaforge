import { describe, it, expect } from 'vitest'
import { EdgeFunctionsCheck } from '../../src/checks/edge-functions.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { FetchFn } from '../../src/checks/edge-functions.js'

function mockContext(): CheckContext {
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
  }
}

const makeFunction = (overrides: Record<string, unknown> = {}) => ({
  slug: 'send-email',
  name: 'send-email',
  version: 3,
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
  ...overrides,
})

function makeFetchFn(sourceFns: unknown[], targetFns: unknown[]): FetchFn {
  return async (url: string) => {
    const body = url.includes('src-ref') ? sourceFns : targetFns
    return { ok: true, json: async () => body } as Response
  }
}

describe('EdgeFunctionsCheck', () => {
  it('returns no issues when functions match', async () => {
    const fn = makeFunction()
    const check = new EdgeFunctionsCheck(makeFetchFn([fn], [fn]))
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing function in target', async () => {
    const check = new EdgeFunctionsCheck(makeFetchFn(
      [makeFunction()],
      [],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('edge-fn-missing-send-email')
    expect(issues[0].title).toContain('Missing Edge Function')
    expect(issues[0].title).toContain('send-email')
    // Missing functions have no action (can't auto-deploy)
    expect(issues[0].action).toBeUndefined()
    expect(issues[0].description).toContain('supabase functions deploy send-email')
  })

  it('detects extra function in target', async () => {
    const check = new EdgeFunctionsCheck(makeFetchFn(
      [],
      [makeFunction({ slug: 'extra-fn', name: 'extra-fn' })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('edge-fn-extra-extra-fn')
    expect(issues[0].title).toContain('Extra Edge Function')
    // Extra functions have DELETE action
    expect(issues[0].action).toBeDefined()
    expect(issues[0].action!.method).toBe('DELETE')
    expect(issues[0].action!.url).toContain('/v1/projects/tgt-ref/functions/extra-fn')
  })

  it('detects version mismatch', async () => {
    const check = new EdgeFunctionsCheck(makeFetchFn(
      [makeFunction({ version: 3 })],
      [makeFunction({ version: 1 })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('edge-fn-version-send-email')
    expect(issues[0].title).toContain('Version mismatch')
    expect(issues[0].description).toContain('version 3')
    expect(issues[0].description).toContain('version 1')
    // Version mismatch has no action (can't auto-deploy)
    expect(issues[0].action).toBeUndefined()
    expect(issues[0].description).toContain('supabase functions deploy send-email')
  })

  it('detects multiple issues at once', async () => {
    const check = new EdgeFunctionsCheck(makeFetchFn(
      [makeFunction(), makeFunction({ slug: 'process-payments', name: 'process-payments' })],
      [makeFunction({ version: 1 }), makeFunction({ slug: 'old-fn', name: 'old-fn' })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues.length).toBeGreaterThanOrEqual(3) // missing, extra, version
    const ids = issues.map(i => i.id)
    expect(ids).toContain('edge-fn-missing-process-payments')
    expect(ids).toContain('edge-fn-extra-old-fn')
    expect(ids).toContain('edge-fn-version-send-email')
  })

  it('returns empty when projectRef or apiKey is missing', async () => {
    const ctx: CheckContext = {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
      },
    }
    const check = new EdgeFunctionsCheck(makeFetchFn([], []))
    const issues = await check.scan(ctx)
    expect(issues).toHaveLength(0)
  })

  it('calls correct API URL with auth header', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, json: async () => [] } as Response
    }

    const check = new EdgeFunctionsCheck(fetchFn)
    await check.scan(mockContext())

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/v1/projects/src-ref/functions')
    expect(calls[0].headers.Authorization).toBe('Bearer src-key')
  })

  it('throws on API error', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: false, statusText: 'Unauthorized' } as Response
    }

    const check = new EdgeFunctionsCheck(fetchFn)
    await expect(check.scan(mockContext())).rejects.toThrow('Unauthorized')
  })
})
