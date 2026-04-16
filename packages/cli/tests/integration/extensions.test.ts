/**
 * Integration tests for the extensions drift check against real Postgres containers.
 *
 * Drift: source has `pg_trgm` extension installed, target does not.
 * Both share `uuid-ossp` and `plpgsql` (no drift for those).
 */
import { describe, it, expect } from 'vitest'
import { ExtensionsCheck } from '../../src/checks/extensions.js'
import { SOURCE_URL, skipIfNoContainers, makeConfig } from './helpers.js'

describe('integration: extensions check', () => {
  const config = makeConfig()

  it.skipIf(skipIfNoContainers())('should detect missing pg_trgm extension', async () => {
    const check = new ExtensionsCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    const missing = issues.find(i => i.id === 'ext-missing-pg_trgm')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('pg_trgm')
    expect(missing!.sql?.up).toContain('CREATE EXTENSION')
    expect(missing!.sql?.up).toContain('pg_trgm')
    expect(missing!.sql?.down).toContain('DROP EXTENSION')
  })

  it.skipIf(skipIfNoContainers())('should not flag shared extensions', async () => {
    const check = new ExtensionsCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // uuid-ossp and plpgsql are in both — should not be flagged as missing
    const uuidMissing = issues.find(i => i.id === 'ext-missing-uuid-ossp')
    expect(uuidMissing).toBeUndefined()

    const plpgsqlMissing = issues.find(i => i.id === 'ext-missing-plpgsql')
    expect(plpgsqlMissing).toBeUndefined()
  })

  it.skipIf(skipIfNoContainers())('should return no issues for source-vs-self', async () => {
    const selfConfig = makeConfig({
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: SOURCE_URL! },
      },
    })
    const check = new ExtensionsCheck()
    const issues = await check.scan({
      source: selfConfig.environments.source,
      target: selfConfig.environments.target,
      config: selfConfig,
    })

    expect(issues).toHaveLength(0)
  })
})
