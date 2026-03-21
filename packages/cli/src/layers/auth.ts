import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const CRITICAL_KEYS = [
  'EXTERNAL_EMAIL_ENABLED',
  'EXTERNAL_PHONE_ENABLED',
  'JWT_EXP',
  'SECURITY_CAPTCHA_ENABLED',
  'MFA_ENABLED',
  'SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION',
]

export class AuthLayer extends Layer {
  readonly name = 'auth' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const { projectRef: sourceRef, apiKey: sourceKey } = ctx.source
    const { projectRef: targetRef, apiKey: targetKey } = ctx.target

    if (!sourceRef || !targetRef || !sourceKey || !targetKey) {
      return []
    }

    const [source, target] = await Promise.all([
      this.fetchAuthConfig(sourceRef, sourceKey),
      this.fetchAuthConfig(targetRef, targetKey),
    ])

    return diffAuthConfig(source, target)
  }

  private async fetchAuthConfig(projectRef: string, apiKey: string): Promise<Record<string, unknown>> {
    const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth config for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<Record<string, unknown>>
  }
}

function diffAuthConfig(source: Record<string, unknown>, target: Record<string, unknown>): DriftIssue[] {
  const issues: DriftIssue[] = []
  const allKeys = new Set([...Object.keys(source), ...Object.keys(target)])

  for (const key of allKeys) {
    const sv = source[key]
    const tv = target[key]

    if (JSON.stringify(sv) !== JSON.stringify(tv)) {
      const isCritical = CRITICAL_KEYS.includes(key)
      issues.push({
        id: `auth-${key.toLowerCase()}`,
        layer: 'auth',
        severity: isCritical ? 'critical' : 'info',
        title: `Auth config mismatch: ${key}`,
        description: `"${key}" differs between source (${JSON.stringify(sv)}) and target (${JSON.stringify(tv)}).`,
        sourceValue: sv,
        targetValue: tv,
      })
    }
  }

  return issues
}
