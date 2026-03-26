import { describe, it, expect } from 'vitest'
import { promote } from '../src/promote.js'
import type { ScanResult, SyncAction } from '../src/types/drift.js'
import type { FetchFn } from '../src/promote.js'

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    source: 'dev',
    target: 'prod',
    layers: [],
    score: 100,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    ...overrides,
  }
}

const mockAction: SyncAction = {
  method: 'POST',
  url: 'https://example.supabase.co/storage/v1/bucket',
  headers: { Authorization: 'Bearer test-key' },
  body: { id: 'avatars', name: 'avatars', public: false },
  label: 'Create bucket "avatars" in target',
}

describe('promote: SyncAction support', () => {
  it('collects API actions in dry-run mode', async () => {
    const scanResult = makeScanResult({
      layers: [{
        layer: 'storage',
        status: 'drifted',
        issues: [{
          id: 'storage-missing-avatars',
          layer: 'storage',
          severity: 'warning',
          title: 'Missing bucket: avatars',
          description: 'Bucket "avatars" exists in source but not in target.',
          action: mockAction,
        }],
        durationMs: 50,
      }],
      summary: { total: 1, critical: 0, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].action).toBe('Create bucket "avatars" in target')
    expect(result.applied[0].sql).toBeUndefined()
    expect(result.skipped).toHaveLength(0)
  })

  it('prefers sql over action when both are present', async () => {
    const scanResult = makeScanResult({
      layers: [{
        layer: 'storage',
        status: 'drifted',
        issues: [{
          id: 'storage-policy-missing-objects.allow_read',
          layer: 'storage',
          severity: 'critical',
          title: 'Missing storage policy',
          description: 'Storage RLS policy missing.',
          sql: {
            up: 'CREATE POLICY "allow_read" ON "storage"."objects" AS PERMISSIVE FOR SELECT TO authenticated USING (true);',
            down: 'DROP POLICY IF EXISTS "allow_read" ON "storage"."objects";',
          },
          action: mockAction,
        }],
        durationMs: 10,
      }],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].sql).toContain('CREATE POLICY')
    expect(result.applied[0].action).toBeUndefined()
  })

  it('skips issues with neither sql nor action', async () => {
    const scanResult = makeScanResult({
      layers: [{
        layer: 'edge-functions',
        status: 'drifted',
        issues: [{
          id: 'edge-fn-missing-send-email',
          layer: 'edge-functions',
          severity: 'warning',
          title: 'Missing Edge Function: send-email',
          description: 'Function not in target. Deploy manually.',
        }],
        durationMs: 10,
      }],
      summary: { total: 1, critical: 0, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('No SQL fix or API action available')
  })

  it('executes API action with correct method and body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init: init! })
      return { ok: true, text: async () => '{}' } as Response
    }

    const scanResult = makeScanResult({
      layers: [{
        layer: 'storage',
        status: 'drifted',
        issues: [{
          id: 'storage-missing-avatars',
          layer: 'storage',
          severity: 'warning',
          title: 'Missing bucket',
          description: 'desc',
          action: mockAction,
        }],
        durationMs: 10,
      }],
      summary: { total: 1, critical: 0, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: false,
      fetchFn,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].action).toBe(mockAction.label)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(mockAction.url)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual(mockAction.body)
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('records error when API action fails', async () => {
    const fetchFn: FetchFn = async () => {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Access denied',
      } as Response
    }

    const scanResult = makeScanResult({
      layers: [{
        layer: 'auth',
        status: 'drifted',
        issues: [{
          id: 'auth-jwt_exp',
          layer: 'auth',
          severity: 'critical',
          title: 'Auth config mismatch: JWT_EXP',
          description: 'JWT_EXP differs',
          action: {
            method: 'PATCH',
            url: 'https://api.supabase.com/v1/projects/tgt-ref/config/auth',
            headers: { Authorization: 'Bearer tgt-key' },
            body: { JWT_EXP: 3600 },
            label: 'Set auth config "JWT_EXP" to 3600 in target',
          },
        }],
        durationMs: 10,
      }],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: false,
      fetchFn,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toContain('403')
    expect(result.errors[0].error).toContain('Access denied')
  })

  it('handles mixed SQL and API issues in single promote', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: true, text: async () => '{}' } as Response
    }

    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'rls',
          status: 'drifted',
          issues: [{
            id: 'rls-missing-public.users.read',
            layer: 'rls',
            severity: 'critical',
            title: 'Missing RLS',
            description: 'desc',
            sql: { up: 'CREATE POLICY ...;', down: 'DROP POLICY ...;' },
          }],
          durationMs: 10,
        },
        {
          layer: 'storage',
          status: 'drifted',
          issues: [{
            id: 'storage-missing-avatars',
            layer: 'storage',
            severity: 'warning',
            title: 'Missing bucket',
            description: 'desc',
            action: mockAction,
          }],
          durationMs: 10,
        },
        {
          layer: 'edge-functions',
          status: 'drifted',
          issues: [{
            id: 'edge-fn-missing-deploy-me',
            layer: 'edge-functions',
            severity: 'warning',
            title: 'Missing Edge Function',
            description: 'Deploy manually',
            // No sql, no action
          }],
          durationMs: 10,
        },
      ],
      summary: { total: 3, critical: 1, warning: 2, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
      fetchFn,
    })

    // SQL fix for RLS + API action for storage
    expect(result.applied).toHaveLength(2)
    expect(result.applied[0].sql).toContain('CREATE POLICY')
    expect(result.applied[1].action).toBe(mockAction.label)
    // Edge function skipped (no fix available)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].issueId).toBe('edge-fn-missing-deploy-me')
  })

  it('sends DELETE action without body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init: init! })
      return { ok: true, text: async () => '{}' } as Response
    }

    const deleteAction: SyncAction = {
      method: 'DELETE',
      url: 'https://api.supabase.com/v1/projects/tgt-ref/functions/old-fn',
      headers: { Authorization: 'Bearer tgt-key' },
      label: 'Delete Edge Function "old-fn" from target',
    }

    const scanResult = makeScanResult({
      layers: [{
        layer: 'edge-functions',
        status: 'drifted',
        issues: [{
          id: 'edge-fn-extra-old-fn',
          layer: 'edge-functions',
          severity: 'info',
          title: 'Extra Edge Function: old-fn',
          description: 'desc',
          action: deleteAction,
        }],
        durationMs: 10,
      }],
      summary: { total: 1, critical: 0, warning: 0, info: 1 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: false,
      fetchFn,
    })

    expect(result.applied).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.body).toBeUndefined()
  })

  it('filters API actions by layer', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: true, text: async () => '{}' } as Response
    }

    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'storage',
          status: 'drifted',
          issues: [{
            id: 'storage-missing-avatars',
            layer: 'storage',
            severity: 'warning',
            title: 'Missing bucket',
            description: 'desc',
            action: mockAction,
          }],
          durationMs: 10,
        },
        {
          layer: 'auth',
          status: 'drifted',
          issues: [{
            id: 'auth-jwt_exp',
            layer: 'auth',
            severity: 'critical',
            title: 'Auth config mismatch',
            description: 'desc',
            action: {
              method: 'PATCH',
              url: 'https://api.supabase.com/v1/projects/tgt-ref/config/auth',
              headers: { Authorization: 'Bearer tgt-key' },
              body: { JWT_EXP: 3600 },
              label: 'Set JWT_EXP',
            },
          }],
          durationMs: 10,
        },
      ],
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      layers: ['auth'],
      dryRun: true,
      fetchFn,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].layer).toBe('auth')
  })
})
