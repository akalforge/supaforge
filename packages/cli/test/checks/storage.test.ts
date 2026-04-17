import { describe, it, expect } from 'vitest'
import { StorageCheck } from '../../src/checks/storage.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source', projectRef: 'src-ref', accessToken: 'src-token' },
    target: { dbUrl: 'postgres://target', projectRef: 'tgt-ref', accessToken: 'tgt-token' },
    config: {
      environments: {
        dev: { dbUrl: '', projectRef: 'src-ref', accessToken: 'src-token' },
        prod: { dbUrl: '', projectRef: 'tgt-ref', accessToken: 'tgt-token' },
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

/** QueryFn mock that returns buckets for source/target based on connection URL, and policies separately. */
function makeQueryFn(
  sourceBuckets: unknown[],
  targetBuckets: unknown[],
  sourcePolicies: unknown[] = [],
  targetPolicies: unknown[] = [],
): QueryFn {
  return async (dbUrl: string, sql: string) => {
    const isSource = dbUrl.includes('source')
    if (sql.includes('storage.buckets')) {
      return (isSource ? sourceBuckets : targetBuckets) as never
    }
    return (isSource ? sourcePolicies : targetPolicies) as never
  }
}

/** No-op queryFn that returns empty results. */
const emptyQueryFn: QueryFn = async () => [] as never

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

/** QueryFn mock for policy-only tests (no buckets). */
function makePolicyQueryFn(sourcePolicies: unknown[], targetPolicies: unknown[]): QueryFn {
  return async (dbUrl: string, sql: string) => {
    const isSource = dbUrl.includes('source')
    if (sql.includes('storage.buckets')) return [] as never
    return (isSource ? sourcePolicies : targetPolicies) as never
  }
}

describe('StorageCheck', () => {
  it('returns no issues when buckets match', async () => {
    const bucket = makeBucket()
    const check = new StorageCheck(makeQueryFn([bucket], [bucket]))
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing bucket in target', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket()],
      [],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('storage-missing-avatars')
    expect(issues[0].title).toContain('Missing bucket')
    expect(issues[0].title).toContain('avatars')
    // Sync action: SQL INSERT
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('INSERT INTO storage.buckets')
    expect(issues[0].sql!.down).toContain('DELETE FROM storage.buckets')
  })

  it('detects extra bucket in target', async () => {
    const check = new StorageCheck(makeQueryFn(
      [],
      [makeBucket({ id: 'uploads', name: 'uploads' })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('storage-extra-uploads')
    expect(issues[0].title).toContain('Extra bucket')
    // Sync action: SQL DELETE
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('DELETE FROM storage.buckets')
  })

  it('detects critical visibility mismatch (private in source, public in target)', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ public: false })],
      [makeBucket({ public: true })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('storage-visibility-avatars')
    expect(issues[0].title).toContain('visibility mismatch')
    expect(issues[0].description).toContain('private')
    expect(issues[0].description).toContain('public')
    // Sync action: SQL UPDATE
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('UPDATE storage.buckets SET')
    expect(issues[0].sql!.up).toContain('public')
  })

  it('detects warning visibility mismatch (public in source, private in target)', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ public: true })],
      [makeBucket({ public: false })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
  })

  it('detects multiple issues at once', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket(), makeBucket({ id: 'docs', name: 'docs', public: true })],
      [makeBucket({ public: true }), makeBucket({ id: 'temp', name: 'temp' })],
    ))
    const issues = await check.scan(mockContext())

    // missing docs, extra temp, visibility mismatch on avatars
    expect(issues.length).toBeGreaterThanOrEqual(3)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('storage-missing-docs')
    expect(ids).toContain('storage-extra-temp')
    expect(ids).toContain('storage-visibility-avatars')
  })

  // ── Bucket config field tests ──────────────────────────────────────────

  it('detects file_size_limit mismatch', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ file_size_limit: 5242880 })],
      [makeBucket({ file_size_limit: 10485760 })],
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-sizelimit-avatars')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('file size limit')
  })

  it('detects file_size_limit set vs null', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ file_size_limit: 5242880 })],
      [makeBucket({ file_size_limit: null })],
    ))
    const issues = await check.scan(mockContext())

    const sizeIssue = issues.find(i => i.id === 'storage-sizelimit-avatars')
    expect(sizeIssue).toBeDefined()
    expect(sizeIssue!.description).toContain('unlimited')
  })

  it('detects allowed_mime_types mismatch', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ allowed_mime_types: ['image/png'] })],
      [makeBucket({ allowed_mime_types: ['image/png', 'image/gif'] })],
    ))
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeDefined()
    expect(mimeIssue!.severity).toBe('warning')
    expect(mimeIssue!.title).toContain('MIME types')
  })

  it('treats matching mime types in different order as equal', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ allowed_mime_types: ['image/jpeg', 'image/png'] })],
      [makeBucket({ allowed_mime_types: ['image/png', 'image/jpeg'] })],
    ))
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeUndefined()
  })

  it('detects allowed_mime_types set vs null', async () => {
    const check = new StorageCheck(makeQueryFn(
      [makeBucket({ allowed_mime_types: ['image/png'] })],
      [makeBucket({ allowed_mime_types: null })],
    ))
    const issues = await check.scan(mockContext())

    const mimeIssue = issues.find(i => i.id === 'storage-mimetypes-avatars')
    expect(mimeIssue).toBeDefined()
  })

  // ── Storage policy tests ───────────────────────────────────────────────

  it('detects missing storage policy', async () => {
    const check = new StorageCheck(
      makePolicyQueryFn([makePolicy()], []),
    )
    const issues = await check.scan(mockContext())

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
      makePolicyQueryFn([], [makePolicy()]),
    )
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-policy-extra-objects.allow_read')
    expect(issues[0].severity).toBe('info')
  })

  it('detects changed storage policy', async () => {
    const check = new StorageCheck(
      makePolicyQueryFn(
        [makePolicy({ qual: '(auth.uid() = owner)' })],
        [makePolicy({ qual: '(true)' })],
      ),
    )
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('storage-policy-changed-objects.allow_read')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('Storage policy changed')
  })

  it('returns no policy issues when policies match', async () => {
    const policy = makePolicy()
    const check = new StorageCheck(
      makePolicyQueryFn([policy], [policy]),
    )
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('combines bucket and policy issues', async () => {
    const check = new StorageCheck(
      makeQueryFn([makeBucket()], [], [makePolicy()], []),
    )
    const issues = await check.scan(mockContext())

    // 1 missing bucket + 1 missing policy
    expect(issues).toHaveLength(2)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('storage-missing-avatars')
    expect(ids).toContain('storage-policy-missing-objects.allow_read')
  })
})
