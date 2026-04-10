import { describe, it, expect } from 'vitest'
import { collectConfig, envPrefix } from '../src/commands/init.js'

/**
 * Create a fake ask function that returns answers in order.
 */
function fakeAsk(answers: string[]): ((q: string) => Promise<string>) {
  let i = 0
  return async () => answers[i++] ?? ''
}

const noop = () => {}

describe('envPrefix', () => {
  it('uppercases and replaces non-alphanumeric with underscore', () => {
    expect(envPrefix('staging')).toBe('STAGING')
    expect(envPrefix('my-prod')).toBe('MY_PROD')
    expect(envPrefix('local.dev')).toBe('LOCAL_DEV')
  })
})

describe('collectConfig', () => {
  it('stores env var references in config, actual values in envVars', async () => {
    const answers = [
      '',                                     // env name → staging (default)
      'postgres://localhost:5432/staging',     // dbUrl for staging
      '',                                     // projectRef → skip
      '',                                     // env name → production (default)
      'postgres://localhost:5432/production',  // dbUrl for production
      '',                                     // projectRef → skip
      'n',                                    // don't add another
      '',                                     // source → staging (default)
      '',                                     // target → production (default)
      '',                                     // data tables → skip
    ]

    const { config, envVars } = await collectConfig(fakeAsk(answers), noop)

    // Config stores $VAR references, not raw values
    expect(config.environments.staging.dbUrl).toBe('$STAGING_DATABASE_URL')
    expect(config.environments.production.dbUrl).toBe('$PRODUCTION_DATABASE_URL')

    // Actual secrets go into envVars
    expect(envVars.STAGING_DATABASE_URL).toBe('postgres://localhost:5432/staging')
    expect(envVars.PRODUCTION_DATABASE_URL).toBe('postgres://localhost:5432/production')

    expect(config.source).toBe('staging')
    expect(config.target).toBe('production')
    expect(config.checks).toBeUndefined()
  })

  it('includes data tables when specified', async () => {
    const answers = [
      'dev',                               // env name
      'postgres://localhost:5432/dev',      // dbUrl
      '',                                   // projectRef → skip
      'prod',                               // env name
      'postgres://localhost:5432/prod',     // dbUrl
      '',                                   // projectRef → skip
      'n',                                  // don't add another
      '',                                   // source → dev (default)
      '',                                   // target → prod (default)
      'countries, currencies',              // data tables
    ]

    const { config } = await collectConfig(fakeAsk(answers), noop)

    expect(config.checks).toBeDefined()
    expect(config.checks!.data!.tables).toEqual(['countries', 'currencies'])
  })

  it('stores apiKey as env var reference when provided', async () => {
    const answers = [
      'dev',                                // env name
      'postgres://localhost:5432/dev',       // dbUrl
      'abcdef123456',                        // projectRef
      'service-role-key-dev',                // apiKey
      'prod',                                // env name
      'postgres://localhost:5432/prod',      // dbUrl
      'xyz789',                              // projectRef
      'service-role-key-prod',               // apiKey
      'n',                                   // don't add another
      '',                                    // source → dev (default)
      '',                                    // target → prod (default)
      '',                                    // data tables → skip
    ]

    const { config, envVars } = await collectConfig(fakeAsk(answers), noop)

    // Config stores references
    expect(config.environments.dev.dbUrl).toBe('$DEV_DATABASE_URL')
    expect(config.environments.dev.apiKey).toBe('$DEV_API_KEY')
    expect(config.environments.dev.projectRef).toBe('abcdef123456')

    expect(config.environments.prod.dbUrl).toBe('$PROD_DATABASE_URL')
    expect(config.environments.prod.apiKey).toBe('$PROD_API_KEY')
    expect(config.environments.prod.projectRef).toBe('xyz789')

    // envVars stores actual values
    expect(envVars.DEV_DATABASE_URL).toBe('postgres://localhost:5432/dev')
    expect(envVars.DEV_API_KEY).toBe('service-role-key-dev')
    expect(envVars.PROD_DATABASE_URL).toBe('postgres://localhost:5432/prod')
    expect(envVars.PROD_API_KEY).toBe('service-role-key-prod')
  })

  it('supports three environments with custom source/target', async () => {
    const answers = [
      'dev',                                // env name
      'postgres://localhost:5432/dev',       // dbUrl
      '',                                   // projectRef → skip
      'staging',                            // env name
      'postgres://localhost:5432/staging',   // dbUrl
      '',                                   // projectRef → skip
      'y',                                  // add another
      'prod',                               // env name
      'postgres://localhost:5432/prod',      // dbUrl
      '',                                   // projectRef → skip
      'n',                                  // don't add another
      'dev',                                // source
      'prod',                               // target
      '',                                   // data tables → skip
    ]

    const { config } = await collectConfig(fakeAsk(answers), noop)

    expect(Object.keys(config.environments)).toEqual(['dev', 'staging', 'prod'])
    expect(config.source).toBe('dev')
    expect(config.target).toBe('prod')
  })
})
