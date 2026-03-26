import { describe, it, expect } from 'vitest'
import { StorageLayer } from '../../src/layers/storage.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { FetchFn } from '../../src/layers/storage.js'

function mockContext(): LayerContext {
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

const makeBucket = (overrides: Record<string, unknown> = {}) => ({
  id: 'avatars',
  name: 'avatars',
  public: false,
  file_size_limit: 5242880,
  allowed_mime_types: ['image/png', 'image/jpeg'],
  ...overrides,
})

function makeFetchFn(sourceBuckets: unknown[], targetBuckets: unknown[]): FetchFn {
  return async (url: string) => {
    const body = url.includes('src-ref') ? sourceBuckets : targetBuckets
    return { ok: true, json: async () => body } as Response
  }
}

describe('StorageLayer', () => {
  it('returns no issues when buckets match', async () => {
    const bucket = makeBucket()
    const layer = new StorageLayer(makeFetchFn([bucket], [bucket]))
    const issues = await layer.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing bucket in target', async () => {
    const layer = new StorageLayer(makeFetchFn(
      [makeBucket()],
      [],
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('storage-missing-avatars')
    expect(issues[0].title).toContain('Missing bucket')
    expect(issues[0].title).toContain('avatars')
  })

  it('detects extra bucket in target', async () => {
    const layer = new StorageLayer(makeFetchFn(
      [],
      [makeBucket({ id: 'uploads', name: 'uploads' })],
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('storage-extra-uploads')
    expect(issues[0].title).toContain('Extra bucket')
  })

  it('detects critical visibility mismatch (private in source, public in target)', async () => {
    const layer = new StorageLayer(makeFetchFn(
      [makeBucket({ public: false })],
      [makeBucket({ public: true })],
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('storage-visibility-avatars')
    expect(issues[0].title).toContain('visibility mismatch')
    expect(issues[0].description).toContain('private')
    expect(issues[0].description).toContain('public')
  })

  it('detects warning visibility mismatch (public in source, private in target)', async () => {
    const layer = new StorageLayer(makeFetchFn(
      [makeBucket({ public: true })],
      [makeBucket({ public: false })],
    ))
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
  })

  it('detects multiple issues at once', async () => {
    const layer = new StorageLayer(makeFetchFn(
      [makeBucket(), makeBucket({ id: 'docs', name: 'docs', public: true })],
      [makeBucket({ public: true }), makeBucket({ id: 'temp', name: 'temp' })],
    ))
    const issues = await layer.scan(mockContext())

    // missing docs, extra temp, visibility mismatch on avatars
    expect(issues.length).toBeGreaterThanOrEqual(3)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('storage-missing-docs')
    expect(ids).toContain('storage-extra-temp')
    expect(ids).toContain('storage-visibility-avatars')
  })

  it('returns empty when projectRef or apiKey is missing', async () => {
    const ctx: LayerContext = {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
      },
    }
    const layer = new StorageLayer(makeFetchFn([], []))
    const issues = await layer.scan(ctx)
    expect(issues).toHaveLength(0)
  })

  it('calls correct Storage API URL with auth headers', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, json: async () => [] } as Response
    }

    const layer = new StorageLayer(fetchFn)
    await layer.scan(mockContext())

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('src-ref.supabase.co/storage/v1/bucket')
    expect(calls[0].headers.Authorization).toBe('Bearer src-key')
    expect(calls[0].headers.apikey).toBe('src-key')
  })

  it('throws on API error', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: false, statusText: 'Not Found' } as Response
    }

    const layer = new StorageLayer(fetchFn)
    await expect(layer.scan(mockContext())).rejects.toThrow('Not Found')
  })
})
