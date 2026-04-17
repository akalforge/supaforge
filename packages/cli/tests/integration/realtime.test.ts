/**
 * Integration tests for the realtime drift check against real Postgres containers.
 *
 * Drift: source has `supaforge_live` publication (for users + posts),
 * target has no publications.
 */
import { describe, it, expect } from 'vitest'
import { RealtimeCheck } from '../../src/checks/realtime.js'
import { SOURCE_URL, skipIfNoContainers, makeConfig } from './helpers.js'

describe('integration: realtime check', () => {
  const config = makeConfig()

  it.skipIf(skipIfNoContainers())('should detect missing publication', async () => {
    const check = new RealtimeCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    const missing = issues.find(i => i.id === 'realtime-missing-pub-supaforge_live')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('Missing publication')
    expect(missing!.title).toContain('supaforge_live')
  })

  it.skipIf(skipIfNoContainers())('should include table list in SQL fix', async () => {
    const check = new RealtimeCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    const missing = issues.find(i => i.id === 'realtime-missing-pub-supaforge_live')
    expect(missing).toBeDefined()
    expect(missing!.sql?.up).toContain('CREATE PUBLICATION')
    expect(missing!.sql?.up).toContain('users')
    expect(missing!.sql?.up).toContain('posts')
    expect(missing!.sql?.down).toContain('DROP PUBLICATION')
  })

  it.skipIf(skipIfNoContainers())('should return no issues for source-vs-self', async () => {
    const selfConfig = makeConfig({
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: SOURCE_URL! },
      },
    })
    const check = new RealtimeCheck()
    const issues = await check.scan({
      source: selfConfig.environments.source,
      target: selfConfig.environments.target,
      config: selfConfig,
    })

    expect(issues).toHaveLength(0)
  })
})
