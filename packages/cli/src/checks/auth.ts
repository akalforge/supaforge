import type { DriftIssue, SyncAction } from '../types/drift'
import { Check, type CheckContext } from './base'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Supabase Management API base URL */
const MGMT_API = 'https://api.supabase.com/v1/projects'

const CRITICAL_KEYS = [
  'EXTERNAL_EMAIL_ENABLED',
  'EXTERNAL_PHONE_ENABLED',
  'JWT_EXP',
  'SECURITY_CAPTCHA_ENABLED',
  'MFA_ENABLED',
  'SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION',
]

export class AuthCheck extends Check {
  readonly name = 'auth' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const { projectRef: sourceRef, apiKey: sourceKey } = ctx.source
    const { projectRef: targetRef, apiKey: targetKey } = ctx.target

    if (!sourceRef || !targetRef || !sourceKey || !targetKey) {
      return []
    }

    const [source, target] = await Promise.all([
      this.fetchAuthConfig(sourceRef, sourceKey),
      this.fetchAuthConfig(targetRef, targetKey),
    ])

    return diffAuthConfig(source, target, targetRef, targetKey)
  }

  private async fetchAuthConfig(projectRef: string, apiKey: string): Promise<Record<string, unknown>> {
    const url = `${MGMT_API}/${encodeURIComponent(projectRef)}/config/auth`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth config for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<Record<string, unknown>>
  }
}

function diffAuthConfig(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  targetRef: string,
  targetKey: string,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const allKeys = new Set([...Object.keys(source), ...Object.keys(target)])

  for (const key of allKeys) {
    const sv = source[key]
    const tv = target[key]

    if (JSON.stringify(sv) !== JSON.stringify(tv)) {
      const isCritical = CRITICAL_KEYS.includes(key)

      // Build a PATCH action to sync this specific key to the target
      const action: SyncAction = {
        method: 'PATCH',
        url: `${MGMT_API}/${encodeURIComponent(targetRef)}/config/auth`,
        headers: { Authorization: `Bearer ${targetKey}` },
        body: { [key]: sv },
        label: `Set auth config "${key}" to ${JSON.stringify(sv)} in target`,
      }

      issues.push({
        id: `auth-${key.toLowerCase()}`,
        check: 'auth',
        severity: isCritical ? 'critical' : 'info',
        title: `Auth config mismatch: ${key}`,
        description: `"${key}" differs between source (${JSON.stringify(sv)}) and target (${JSON.stringify(tv)}).`,
        sourceValue: sv,
        targetValue: tv,
        action,
      })
    }
  }

  return issues
}
