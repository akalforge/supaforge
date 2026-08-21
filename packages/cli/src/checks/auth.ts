import type { EnvironmentConfig } from '../types/config'
import type { DriftIssue, SyncAction } from '../types/drift'
import { Check, CheckSkipped, type CheckContext } from './base'
import { SUPABASE_MGMT_API } from '../constants'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Where an environment's auth config is read from.
 *
 * A self-hosted deployment has no project on api.supabase.com, so the hosted
 * Management API can only ever answer Unauthorized for it (issue #41). GoTrue
 * exposes the equivalent data on the gateway itself, authenticated with the
 * service-role key rather than a personal access token.
 */
export type AuthSource =
  | { kind: 'hosted'; ref: string; token: string }
  | { kind: 'self-hosted'; apiUrl: string; key: string }

/**
 * Pick the endpoint for an environment, preferring the self-hosted gateway.
 *
 * `apiUrl` wins when present: it is the documented override, and an
 * environment that sets it is by definition not on api.supabase.com. Note that
 * `projectRef` is not required in that case — it was only ever a path segment
 * on a hosted URL that will not be called (issue #41, point 4).
 */
export function resolveAuthSource(env: EnvironmentConfig): AuthSource | null {
  if (env.apiUrl && env.accessToken) {
    return { kind: 'self-hosted', apiUrl: stripTrailingSlashes(env.apiUrl), key: env.accessToken }
  }
  if (env.projectRef && env.accessToken) {
    return { kind: 'hosted', ref: env.projectRef, token: env.accessToken }
  }
  return null
}

/**
 * Trim trailing slashes so the path is not doubled.
 *
 * Scanned rather than matched with /\/+$/, whose repeated group backtracks
 * super-linearly on a long run of slashes. The value comes from user config,
 * so it is worth not having the sharp edge at all.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

/**
 * Flatten GoTrue's `/auth/v1/settings` into the shape the Management API's
 * `/config/auth` returns, so the two can be compared key by key.
 *
 * GoTrue nests provider flags under `external` and uses lowercase names;
 * the Management API uses flat SCREAMING_SNAKE. Neither is a superset of the
 * other, which is why the comparison is only ever run between two
 * environments of the same kind.
 */
export function normalizeGoTrueSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const external = raw.external
  if (external && typeof external === 'object' && !Array.isArray(external)) {
    for (const [provider, enabled] of Object.entries(external as Record<string, unknown>)) {
      out[`EXTERNAL_${provider.toUpperCase()}_ENABLED`] = enabled
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'external') continue
    out[key.toUpperCase()] = value
  }

  return out
}

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
    const sourceSrc = resolveAuthSource(ctx.source)
    const targetSrc = resolveAuthSource(ctx.target)

    if (!sourceSrc || !targetSrc) {
      // Returning [] here rendered as a green zero-issue pass, identical to a
      // layer that was compared and found clean (issue #42).
      throw new CheckSkipped('no apiUrl/projectRef or accessToken configured')
    }

    // The two endpoints do not expose the same keys — GoTrue's /settings is a
    // subset of the Management API's /config/auth. Comparing across them would
    // report every key one side lacks as drift, which is worse than not
    // comparing at all (issue #41).
    if (sourceSrc.kind !== targetSrc.kind) {
      throw new CheckSkipped(
        'source and target are different deployment kinds (one self-hosted, one hosted) — auth config is not comparable',
      )
    }

    const [source, target] = await Promise.all([
      this.fetchAuthConfig(sourceSrc),
      this.fetchAuthConfig(targetSrc),
    ])

    return diffAuthConfig(source, target, targetSrc)
  }

  private async fetchAuthConfig(src: AuthSource): Promise<Record<string, unknown>> {
    return src.kind === 'hosted'
      ? this.fetchHostedAuthConfig(src.ref, src.token)
      : this.fetchSelfHostedAuthConfig(src.apiUrl, src.key)
  }

  private async fetchHostedAuthConfig(projectRef: string, accessToken: string): Promise<Record<string, unknown>> {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(projectRef)}/config/auth`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth config for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<Record<string, unknown>>
  }

  /**
   * GoTrue wants the service-role key in both `apikey` and `Authorization`.
   * The gateway routes on the former and GoTrue authorises on the latter.
   */
  private async fetchSelfHostedAuthConfig(apiUrl: string, serviceKey: string): Promise<Record<string, unknown>> {
    const url = `${apiUrl}/auth/v1/settings`
    const res = await this.fetchFn(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth settings from ${apiUrl}: ${res.statusText}`)
    const raw = await res.json() as Record<string, unknown>
    return normalizeGoTrueSettings(raw)
  }
}

function diffAuthConfig(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  targetSrc: AuthSource,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const allKeys = new Set([...Object.keys(source), ...Object.keys(target)])

  for (const key of allKeys) {
    const sv = source[key]
    const tv = target[key]

    if (JSON.stringify(sv) !== JSON.stringify(tv)) {
      const isCritical = CRITICAL_KEYS.includes(key)

      // Only the hosted Management API can be written to. Self-hosted GoTrue
      // takes its configuration from the environment it was started with and
      // exposes no write endpoint, so attaching a PATCH action there would
      // hand --apply a request that cannot succeed (issue #41).
      const action: SyncAction | undefined = targetSrc.kind === 'hosted'
        ? {
            method: 'PATCH',
            url: `${SUPABASE_MGMT_API}/${encodeURIComponent(targetSrc.ref)}/config/auth`,
            headers: { Authorization: `Bearer ${targetSrc.token}` },
            body: { [key]: sv },
            label: `Set auth config "${key}" to ${JSON.stringify(sv)} in target`,
          }
        : undefined

      const remediation = action
        ? ''
        : ' Self-hosted GoTrue is configured through its environment — update the target deployment and restart it.'

      issues.push({
        id: `auth-${key.toLowerCase()}`,
        check: 'auth',
        severity: isCritical ? 'critical' : 'info',
        title: `Auth config mismatch: ${key}`,
        description: `"${key}" differs between source (${JSON.stringify(sv)}) and target (${JSON.stringify(tv)}).${remediation}`,
        sourceValue: sv,
        targetValue: tv,
        ...(action ? { action } : {}),
      })
    }
  }

  return issues
}
