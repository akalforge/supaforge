/**
 * What `diff --apply` may copy from the source's auth config into the target's.
 *
 * The Management API returns its keys in lower case (`jwt_exp`,
 * `external_google_secret`), and every key that differed became a PATCH of the
 * source's value. So a sync from staging overwrote production's site URL,
 * redirect allow-list and OAuth client ids with staging's, and its secrets with
 * whatever the API returns in their place. Nothing on a hosted project was ever
 * critical either: the critical keys were matched in upper case only.
 */
import { describe, it, expect } from 'vitest'
import { AuthCheck } from '../../src/checks/auth.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { FetchFn } from '../../src/checks/auth.js'

const ctx = {
  source: { dbUrl: 'postgres://source', projectRef: 'src-ref', accessToken: 'src-key' },
  target: { dbUrl: 'postgres://target', projectRef: 'tgt-ref', accessToken: 'tgt-key' },
  config: { environments: {}, source: 'dev', target: 'prod' },
} as unknown as CheckContext

function scan(source: Record<string, unknown>, target: Record<string, unknown>) {
  const fetchFn: FetchFn = async (url: string) =>
    ({ ok: true, json: async () => (url.includes('src-ref') ? source : target) }) as Response
  return new AuthCheck(fetchFn).scan(ctx)
}

async function one(key: string, sv: unknown, tv: unknown) {
  const issues = await scan({ [key]: sv }, { [key]: tv })
  expect(issues, key).toHaveLength(1)
  return issues[0]
}

describe('auth drift on a hosted project', () => {
  it.each([
    'external_email_enabled', 'external_phone_enabled', 'jwt_exp', 'security_captcha_enabled',
    'security_update_password_require_reauthentication', 'disable_signup',
    'mfa_totp_enroll_enabled', 'mfa_phone_verify_enabled', 'mfa_web_authn_enroll_enabled',
  ])('reports %s as critical, whatever its case', async (key) => {
    expect((await one(key, true, false)).severity).toBe('critical')
    expect((await one(key.toUpperCase(), true, false)).severity).toBe('critical')
  })

  it.each([
    'external_google_secret', 'smtp_pass', 'security_captcha_secret', 'hook_send_email_secrets',
    'sms_twilio_auth_token', 'sms_vonage_api_key', 'sms_messagebird_access_key', 'nimbus_oauth_client_secret',
  ])('never shows or copies a secret: %s', async (key) => {
    const issue = await one(key, 'hash:source-value', 'hash:target-value')
    expect(issue.action).toBeUndefined()
    expect(issue.manualOnly).toMatch(/secret/i)
    expect(issue).not.toHaveProperty('sourceValue')
    expect(issue).not.toHaveProperty('targetValue')
    expect(JSON.stringify(issue)).not.toMatch(/source-value|target-value/)
  })

  it.each([
    ['site_url', 'https://staging.example.com', 'https://example.com'],
    ['uri_allow_list', 'https://staging.example.com/**', 'https://example.com/**'],
    ['external_google_client_id', 'staging-client', 'prod-client'],
    ['external_keycloak_url', 'https://sso-staging.example.com', 'https://sso.example.com'],
    ['hook_send_email_uri', 'https://staging.example.com/hook', 'https://example.com/hook'],
    ['smtp_host', 'smtp.staging.example.com', 'smtp.example.com'],
    ['smtp_admin_email', 'staging@example.com', 'hi@example.com'],
    ['sms_twilio_account_sid', 'AC-staging', 'AC-prod'],
    ['saml_external_url', 'https://staging.example.com/saml', 'https://example.com/saml'],
    ['webauthn_rp_origins', 'https://staging.example.com', 'https://example.com'],
  ])('reports %s, which belongs to each environment, without copying it', async (key, sv, tv) => {
    const issue = await one(key, sv, tv)
    expect(issue.action).toBeUndefined()
    expect(issue.manualOnly).toBeDefined()
    expect(issue.sourceValue).toBe(sv)
    expect(issue.targetValue).toBe(tv)
  })

  it('still copies behaviour that should match across environments', async () => {
    for (const [key, sv, tv] of [['jwt_exp', 3600, 86400], ['password_min_length', 10, 6], ['mailer_otp_exp', 600, 3600]] as const) {
      const issue = await one(key, sv, tv)
      expect(issue.action?.method, key).toBe('PATCH')
      expect(issue.action?.body).toEqual({ [key]: sv })
    }
  })
})
