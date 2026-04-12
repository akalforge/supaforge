import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { collectConfig, createPrompt, envPrefix, fuzzySelect, askRequired, ensureGitignore } from '../src/commands/init.js'
import { UserCancelledError, isUserCancelled } from '../src/errors.js'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a fake ask function that returns answers in order.
 */
function fakeAsk(answers: string[]): ((q: string) => Promise<string>) {
  let i = 0
  return async () => answers[i++] ?? ''
}

/**
 * Create a fake ask that returns answers then throws UserCancelledError.
 */
function fakeAskThenCancel(answers: string[]): ((q: string) => Promise<string>) {
  let i = 0
  return async () => {
    if (i >= answers.length) throw new UserCancelledError()
    return answers[i++] ?? ''
  }
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
  it('multi-env: stores env var references in config, actual values in envVars', async () => {
    const answers = [
      'multi',                                // mode
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

  it('multi-env: includes data tables when specified', async () => {
    const answers = [
      'multi',                             // mode
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

  it('multi-env: stores accessToken as env var reference and extracts projectRef from URL', async () => {
    const answers = [
      'multi',                                       // mode
      'dev',                                         // env name
      'postgres://localhost:5432/dev',                // dbUrl
      'https://abcdef123456.supabase.co',            // Project URL → extracted to ref
      'sbp_dev_token_123',                           // accessToken
      'prod',                                         // env name
      'postgres://localhost:5432/prod',               // dbUrl
      'xyz789',                                       // bare ref (also accepted)
      'sbp_prod_token_456',                          // accessToken
      'n',                                            // don't add another
      '',                                             // source → dev (default)
      '',                                             // target → prod (default)
      '',                                             // data tables → skip
    ]

    const { config, envVars } = await collectConfig(fakeAsk(answers), noop)

    // Config stores references
    expect(config.environments.dev.dbUrl).toBe('$DEV_DATABASE_URL')
    expect(config.environments.dev.accessToken).toBe('$DEV_ACCESS_TOKEN')
    // Project URL extracted to bare ref
    expect(config.environments.dev.projectRef).toBe('abcdef123456')

    expect(config.environments.prod.dbUrl).toBe('$PROD_DATABASE_URL')
    expect(config.environments.prod.accessToken).toBe('$PROD_ACCESS_TOKEN')
    // Bare ref kept as-is
    expect(config.environments.prod.projectRef).toBe('xyz789')

    // envVars stores actual values
    expect(envVars.DEV_DATABASE_URL).toBe('postgres://localhost:5432/dev')
    expect(envVars.DEV_ACCESS_TOKEN).toBe('sbp_dev_token_123')
    expect(envVars.PROD_DATABASE_URL).toBe('postgres://localhost:5432/prod')
    expect(envVars.PROD_ACCESS_TOKEN).toBe('sbp_prod_token_456')
  })

  it('multi-env: supports three environments with custom source/target', async () => {
    const answers = [
      'multi',                              // mode
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

  it('single-env: creates config with one environment and no source/target', async () => {
    const answers = [
      'single',                              // mode
      '',                                    // env name → prod (default)
      'postgres://db.abc.supabase.co:5432/postgres', // dbUrl
      'https://abc123.supabase.co',          // Project URL
      'sbp_secret_token_xyz',               // accessToken
      '',                                    // data tables → skip
    ]

    const { config, envVars } = await collectConfig(fakeAsk(answers), noop)

    expect(Object.keys(config.environments)).toEqual(['prod'])
    expect(config.environments.prod.dbUrl).toBe('$PROD_DATABASE_URL')
    expect(config.environments.prod.projectRef).toBe('abc123')
    expect(config.environments.prod.accessToken).toBe('$PROD_ACCESS_TOKEN')

    expect(config.source).toBeUndefined()
    expect(config.target).toBeUndefined()

    expect(envVars.PROD_DATABASE_URL).toBe('postgres://db.abc.supabase.co:5432/postgres')
    expect(envVars.PROD_ACCESS_TOKEN).toBe('sbp_secret_token_xyz')
  })

  it('single-env: works with custom env name and no projectRef', async () => {
    const answers = [
      'single',                              // mode
      'staging',                             // env name
      'postgres://localhost:5432/staging',    // dbUrl
      '',                                    // projectRef → skip
      'feature_flags, plans',                // data tables
    ]

    const { config, envVars } = await collectConfig(fakeAsk(answers), noop)

    expect(Object.keys(config.environments)).toEqual(['staging'])
    expect(config.environments.staging.dbUrl).toBe('$STAGING_DATABASE_URL')
    expect(config.environments.staging.projectRef).toBeUndefined()
    expect(config.environments.staging.accessToken).toBeUndefined()

    expect(config.source).toBeUndefined()
    expect(config.target).toBeUndefined()

    expect(envVars.STAGING_DATABASE_URL).toBe('postgres://localhost:5432/staging')
    expect(config.checks!.data!.tables).toEqual(['feature_flags', 'plans'])
  })
})

describe('UserCancelledError', () => {
  it('is identified by isUserCancelled guard', () => {
    expect(isUserCancelled(new UserCancelledError())).toBe(true)
    expect(isUserCancelled(new Error('other'))).toBe(false)
    expect(isUserCancelled('string')).toBe(false)
  })
})

describe('createPrompt', () => {
  it('rejects with UserCancelledError when input stream ends', async () => {
    const input = new Readable({ read() {} })
    const output = new Writable({ write(_, __, cb) { cb() } })

    const ask = createPrompt(input, output)
    const promise = ask('Question: ')

    // Simulate EOF (Ctrl+D / stream end) which triggers readline 'close'
    input.push(null)

    await expect(promise).rejects.toThrow(UserCancelledError)
    ask.close()
  })

  it('rejects subsequent calls after close', async () => {
    const input = new Readable({ read() {} })
    const output = new Writable({ write(_, __, cb) { cb() } })

    const ask = createPrompt(input, output)
    ask.close()

    await expect(ask('Question: ')).rejects.toThrow(UserCancelledError)
  })
})

describe('askRequired', () => {
  it('returns first non-empty value', async () => {
    const ask = fakeAsk(['hello'])
    const result = await askRequired(ask, noop, 'Name: ', 'Name')
    expect(result).toBe('hello')
  })

  it('re-prompts on empty input until non-empty', async () => {
    const messages: string[] = []
    const log = (msg: string) => messages.push(msg)
    const ask = fakeAsk(['', '', 'valid'])

    const result = await askRequired(ask, log, 'Name: ', 'Name')
    expect(result).toBe('valid')
    expect(messages.filter((m) => m.includes('required'))).toHaveLength(2)
  })

  it('propagates UserCancelledError', async () => {
    const ask = fakeAskThenCancel([])
    await expect(askRequired(ask, noop, 'Name: ', 'Name')).rejects.toThrow(UserCancelledError)
  })
})

describe('fuzzySelect cancellation', () => {
  it('propagates UserCancelledError from ask', async () => {
    const ask = fakeAskThenCancel([])
    await expect(
      fuzzySelect(ask, noop, 'Pick: ', ['a', 'b']),
    ).rejects.toThrow(UserCancelledError)
  })
})

describe('collectConfig cancellation', () => {
  it('propagates UserCancelledError when cancelled mid-flow', async () => {
    // Cancel after the mode selection
    const ask = fakeAskThenCancel(['multi'])
    await expect(collectConfig(ask, noop)).rejects.toThrow(UserCancelledError)
  })
})

describe('ensureGitignore', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'supaforge-gitignore-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates .gitignore when it does not exist', async () => {
    const added = await ensureGitignore(['supaforge.config.json', '.supaforge/'], tmpDir)
    expect(added).toEqual(['supaforge.config.json', '.supaforge/'])

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('supaforge.config.json')
    expect(content).toContain('.supaforge/')
  })

  it('appends only missing entries to existing .gitignore', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'node_modules/\nsupaforge.config.json\n')

    const added = await ensureGitignore(['supaforge.config.json', '.supaforge/'], tmpDir)
    expect(added).toEqual(['.supaforge/'])

    const content = await readFile(join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('.supaforge/')
    // Original content preserved
    expect(content).toContain('node_modules/')
  })

  it('returns empty array when all entries already present', async () => {
    await writeFile(join(tmpDir, '.gitignore'), 'supaforge.config.json\n.supaforge/\n')

    const added = await ensureGitignore(['supaforge.config.json', '.supaforge/'], tmpDir)
    expect(added).toEqual([])
  })
})
