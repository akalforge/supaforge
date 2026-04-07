import { describe, it, expect } from 'vitest'
import { StorageCheck } from '../../src/checks/storage.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { FetchFn } from '../../src/checks/storage.js'
import type { QueryFn } from '../../src/db.js'

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

const makePolicy = (overrides: Record<string, unknown> = {}) => ({
  tablename: 'objects',
  policyname: 'allow_read',
  permissive: 'PERMISSIVE',
  roles: ['{authenticated}'],
  cmd: 'SELECT',
  qual: '(auth.uid() = owner)',
  with_check: null,
  ...overrides,
})

/** QueryFn mock that returns policies for source and target based on connection URL. */
function makeQueryFn(sourcePolicies: unknown[], targetPolicies: unknown[]): QueryFn {
  return async (dbUrl: string) => {
    return (dbUrl.includes('source') ? sourcePolicies : targetPolicies) as never
  }
}

/** No-op queryFn that returns empty results (for bucket-only tests). */
const emptyQueryFn: QueryFn = async () => [] as never

describe('StorageCheck', () => {
  it('returns no issues when buckets match', async () => {
    const bucket = makeBucket()
    const check = new StorageCheck(makeFetchFn([bucket], [bucket]), emptyQueryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing bucket in target', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket()],
      [],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('storage-missing-avatars')
    expect(issues[0].title).toContain('Missing bucket')
    expect(issues[0].title).toContain('avatars')
    // Sync action: POST to create bucket
    expect(issues[0].action).toBeDefined()
    expect(issues[0].action!.method).toBe('POST')
    expect(issues[0].action!.url).toContain('tgt-ref.supabase.co/storage/v1/bucket')
    expect(issues[0].action!.body).toEqual(expect.objectContaining({ id: 'avatars', name: 'avatars' }))
  })

  it('detects extra bucket in target', async () => {
    const check = new StorageCheck(makeFetchFn(
      [],
      [makeBucket({ id: 'uploads', name: 'uploads' })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('storage-extra-uploads')
    expect(issues[0].title).toContain('Extra bucket')
    // Sync action: DELETE to remove bucket
    expect(issues[0].action).toBeDefined()
    expect(issues[0].action!.method).toBe('DELETE')
    expect(issues[0].action!.url).toContain('tgt-ref.supabase.co/storage/v1/bucket/uploads')
  })

  it('detects critical visibility mismatch (private in source, public in target)', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ public: false })],
      [makeBucket({ public: true })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('storage-visibility-avatars')
    expect(issues[0].title).toContain('visibility mismatch')
    expect(issues[0].description).toContain('private')
    expect(issues[0].description).toContain('public')
    // Sync action: PUT to update bucket visibility
    expect(issues[0].action).toBeDefined()
    expect(issues[0].action!.method).toBe('PUT')
    expect(issues[0].action!.url).toContain('tgt-ref.supabase.co/storage/v1/bucket/avatars')
    expect(issues[0].action!.body).toEqual(expect.objectContaining({ public: false }))
  })

  it('detects warning visibility mismatch (public in source, private in target)', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ public: true })],
      [makeBucket({ public: false })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
  })

  it('detects multiple issues at once', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket(), makeBucket({ id: 'docs', name: 'docs', public: true })],
      [makeBucket({ public: true }), makeBucket({ id: 'temp', name: 'temp' })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    // missing docs, extra temp, visibility mismatch on avatars
    expect(issues.length).toBeGreaterThanOrEqual(3)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('storage-missing-docs')
    expect(ids).toContain('storage-extra-temp')
    expect(ids).toContain('storage-visibility-avatars')
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
    const check = new StorageCheck(makeFetchFn([], []), emptyQueryFn)
    const issues = await check.scan(ctx)
    expect(issues).toHaveLength(0)
  })

  it('calls correct Storage API URL with auth headers', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, json: async () => [] } as Response
    }

    const check = new StorageCheck(fetchFn, emptyQueryFn)
    await check.scan(mockContext())

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('src-ref.supabase.co/storage/v1/bucket')
    expect(calls[0].headers.Authorization).toBe('Bearer src-key')
    expect(calls[0].headers.apikey).toBe('src-key')
  })

  it('throws on API error', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: false, statusText: 'Not Found' } as Response
    }

    const check = new StorageCheck(fetchFn, emptyQueryFn)
    await expect(check.scan(mockContext())).rejects.toThrow('Not Found')
  })

  // ── Bucket config field tests ──────────────────────────────────────────

  it('detects file_size_limit mismatch', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ file_size_limit: 5242880 })],
      [makeBucket({ file_size_limit: 10485760 })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-sizelimit-avatars')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('file size limit')
  })

  it('detects file_size_limit set vs null', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ file_size_limit: 5242880 })],
      [makeBucket({ file_size_limit: null })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    const sizeIssue = issues.find(i => i.id === 'storage-sizelimit-avatars')
    expect(sizeIssue).toBeDefined()
    expect(sizeIssue!.description).toContain('unlimited')
  })

  it('detects allowed_mime_types mismatch', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ allowed_mime_types: ['image/png'] })],
      [makeBucket({ allowed_mime_types: ['image/png', 'image/gif'] })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeDefined()
    expect(mimeIssue!.severity).toBe('warning')
    expect(mimeIssue!.title).toContain('MIME types')
  })

  it('treats matching mime types in different order as equal', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ allowed_mime_types: ['image/jpeg', 'image/png'] })],
      [makeBucket({ allowed_mime_types: ['image/png', 'image/jpeg'] })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeUndefined()
  })

  it('detects allowed_mime_types set vs null', async () => {
    const check = new StorageCheck(makeFetchFn(
      [makeBucket({ allowed_mime_types: ['image/png'] })],
      [makeBucket({ allowed_mime_types: null })],
    ), emptyQueryFn)
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeDefined()
  })

  // ── Storage policy tests ───────────────────────────────────────────────

  it('detects missing storage policy', async () => {
    const check = new StorageCheck(
      makeFetchFn([], []),
      makeQueryFn([makePolicy()], []),
    )
    const ctx = mockContext()
    // Skip bucket scan by clearing API credentials
    ctx.source.projectRef = undefined
    ctx.target.projectRef = undefined
    const issues = await check.scan(ctx)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-policy-missing-objects.allow_read')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('Missing storage policy')
    // Storage policies have SQL sync
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('CREATE POLICY')
    expect(issues[0].sql!.up).toContain('allow_read')
    expect(issues[0].sql!.up).toContain('storage')
    expect(issues[0].sql!.down).toContain('DROP POLICY')
  })

  it('detects extra storage policy', async () => {
    const check = new StorageCheck(
      makeFetchFn([], []),
      makeQueryFn([], [makePolicy()]),
    )
    const ctx = mockContext()
    ctx.source.projectRef = undefined
    ctx.target.projectRef = undefined
    const issues = await check.scan(ctx)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-policy-extra-objects.allow_read')
    expect(issues[0].severity).toBe('info')
  })

  it('detects changed storage policy', async () => {
    const check = new StorageCheck(
      makeFetchFn([], []),
      makeQueryFn(
        [makePolicy({ qual: '(auth.uid() = owner)' })],
        [makePolicy({ qual: '(true)' })],
      ),
    )
    const ctx = mockContext()
    ctx.source.projectRef = undefined
    ctx.target.projectRef = undefined
    const issues = await check.scan(ctx)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-policy-changed-objects.allow_read')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('Storage policy changed')
  })

  it('returns no policy issues when policies match', async () => {
    const policy = makePolicy()
    const check = new StorageCheck(
      makeFetchFn([], []),
      makeQueryFn([policy], [policy]),
    )
    const ctx = mockContext()
    ctx.source.projectRef = undefined
    ctx.target.projectRef = undefined
    const issues = await check.scan(ctx)
    expect(issues).toHaveLength(0)
  })

  it('combines bucket and policy issues', async () => {
    const check = new StorageCheck(
      makeFetchFn([makeBucket()], []),
      makeQueryFn([makePolicy()], []),
    )
    const issues = await check.scan(mockContext())

    // 1 missing bucket + 1 missing policy
    expect(issues).toHaveLength(2)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('storage-missing-avatars')
    expect(ids).toContain('storage-policy-missing-objects.allow_read')
  })
})
