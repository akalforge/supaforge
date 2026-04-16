/**
 * Integration tests for the vault drift check against real Postgres containers.
 *
 * Uses a stub `vault.secrets` table (not the real supabase_vault extension).
 *
 * Drift:
 *   - source has `smtp_password` and `api_key` secrets
 *   - target has only `api_key` (with a different encrypted value)
 *   → missing `smtp_password`, modified `api_key` (env-specific INFO)
 */
import { describe, it, expect } from 'vitest'
import { VaultCheck } from '../../src/checks/vault.js'
import { SOURCE_URL, skipIfNoContainers, makeConfig } from './helpers.js'

describe('integration: vault check', () => {
  const config = makeConfig()

  it.skipIf(skipIfNoContainers())('should detect missing vault secret', async () => {
    const check = new VaultCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    const missing = issues.find(i => i.id === 'vault-missing-smtp_password')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('smtp_password')
    expect(missing!.sql?.up).toContain('vault.create_secret')
    expect(missing!.sql?.up).toContain('PLACEHOLDER_VALUE')
  })

  it.skipIf(skipIfNoContainers())('should detect environment-specific secret differences', async () => {
    const check = new VaultCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // api_key exists in both but has different encrypted values → INFO
    const modified = issues.find(i => i.id === 'vault-modified-api_key')
    expect(modified).toBeDefined()
    expect(modified!.severity).toBe('info')
    expect(modified!.title).toContain('api_key')
  })

  it.skipIf(skipIfNoContainers())('should not flag matching secrets as missing', async () => {
    const check = new VaultCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // api_key should NOT appear as missing — it exists in both
    const missingApiKey = issues.find(i => i.id === 'vault-missing-api_key')
    expect(missingApiKey).toBeUndefined()
  })

  it.skipIf(skipIfNoContainers())('should return no issues for source-vs-self', async () => {
    const selfConfig = makeConfig({
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: SOURCE_URL! },
      },
    })
    const check = new VaultCheck()
    const issues = await check.scan({
      source: selfConfig.environments.source,
      target: selfConfig.environments.target,
      config: selfConfig,
    })

    expect(issues).toHaveLength(0)
  })
})
