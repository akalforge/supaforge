import { Command, Flags } from '@oclif/core'
import { createInterface } from 'node:readline'
import { writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateConfig, validateSingleEnvConfig, expandEnvVars, parseProjectRef } from '../config'
import type { SupaForgeConfig, EnvironmentConfig } from '../types/config'

const CONFIG_FILENAME = 'supaforge.config.json'

export type AskFn = ((question: string) => Promise<string>) & { close: () => void }

/**
 * Convert an environment name to an uppercase env var prefix.
 * e.g. "staging" → "STAGING", "my-prod" → "MY_PROD"
 */
export function envPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export function createPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AskFn {
  const rl = createInterface({ input, output })
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())))
  ask.close = () => rl.close()
  return ask as AskFn
}

/**
 * Interactively collect config from the user.
 * Extracted so it can be tested without oclif scaffolding.
 */
export async function collectConfig(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void = console.log,
): Promise<{ config: SupaForgeConfig; envVars: Record<string, string> }> {
  const environments: Record<string, EnvironmentConfig> = {}
  const envVars: Record<string, string> = {}

  const mode = await ask('Setup mode — compare two environments or single database? [multi/single]: ')
  const singleEnv = mode.toLowerCase().startsWith('s')

  if (singleEnv) {
    log('Set up your Supabase database.')
    log('Sensitive values (DB URL, API key) will be stored as $ENV_VAR references.\n')
  } else {
    log('Add your Supabase environments (at least 2).')
    log('Sensitive values (DB URL, API key) will be stored as $ENV_VAR references.\n')
  }

  if (singleEnv) {
    const defaultName = 'prod'
    let name = await ask(`Environment name [${defaultName}]: `)
    if (!name) name = defaultName

    const prefix = envPrefix(name)
    const dbUrlVar = `${prefix}_DATABASE_URL`

    const dbUrl = await ask(`  Database URL for "${name}": `)
    if (!dbUrl) {
      log('  ⚠ Database URL is required.')
      // Re-ask once
      const retry = await ask(`  Database URL for "${name}": `)
      if (!retry) {
        log('  ✗ Cannot continue without a database URL.')
        return { config: { environments }, envVars }
      }
      envVars[dbUrlVar] = retry
    } else {
      envVars[dbUrlVar] = dbUrl
    }

    const projectUrl = await ask(`  Supabase Project URL for "${name}" (e.g. https://xyz.supabase.co, optional): `)
    const projectRef = projectUrl ? parseProjectRef(projectUrl) : ''

    let apiKey = ''
    if (projectRef) {
      apiKey = await ask(`  Supabase service-role key for "${name}" (Settings → API, optional): `)
    }

    const apiKeyVar = `${prefix}_API_KEY`
    if (apiKey) {
      envVars[apiKeyVar] = apiKey
    }

    const env: EnvironmentConfig = { dbUrl: `$${dbUrlVar}` }
    if (projectRef) env.projectRef = projectRef
    if (apiKey) env.apiKey = `$${apiKeyVar}`

    environments[name] = env

    const dataTables = await ask('\nReference-data tables to track (comma-separated, or Enter to skip): ')
    const checks = dataTables
      ? { data: { tables: dataTables.split(',').map((t) => t.trim()).filter(Boolean) } }
      : undefined

    const config: SupaForgeConfig = { environments }
    if (checks) config.checks = checks

    return { config, envVars }
  }

  let envCount = 0
  const defaults = ['staging', 'production']

  while (envCount < 2 || await confirm(ask, 'Add another environment?', false)) {
    const defaultName = defaults[envCount] ?? ''
    const prompt = defaultName
      ? `Environment name [${defaultName}]: `
      : 'Environment name: '

    let name = await ask(prompt)
    if (!name && defaultName) name = defaultName

    if (!name) {
      log('  ⚠ Name cannot be empty, try again.')
      continue
    }

    if (environments[name]) {
      log(`  ⚠ "${name}" already exists, try again.`)
      continue
    }

    const prefix = envPrefix(name)
    const dbUrlVar = `${prefix}_DATABASE_URL`

    const dbUrl = await ask(`  Database URL for "${name}": `)
    if (!dbUrl) {
      log('  ⚠ Database URL is required, try again.')
      continue
    }

    envVars[dbUrlVar] = dbUrl

    const projectUrl = await ask(`  Supabase Project URL for "${name}" (e.g. https://xyz.supabase.co, optional): `)
    const projectRef = projectUrl ? parseProjectRef(projectUrl) : ''

    let apiKey = ''
    if (projectRef) {
      apiKey = await ask(`  Supabase service-role key for "${name}" (Settings → API, optional): `)
    }

    const apiKeyVar = `${prefix}_API_KEY`
    if (apiKey) {
      envVars[apiKeyVar] = apiKey
    }

    const env: EnvironmentConfig = { dbUrl: `$${dbUrlVar}` }
    if (projectRef) env.projectRef = projectRef
    if (apiKey) env.apiKey = `$${apiKeyVar}`

    environments[name] = env
    envCount++
    log('')
  }

  const envNames = Object.keys(environments)

  const source = await selectOne(ask, log, 'Source environment (truth)', envNames, envNames[0])
  const remaining = envNames.filter((n) => n !== source)
  const target = await selectOne(ask, log, 'Target environment (to sync)', remaining, remaining[0])

  const dataTables = await ask('\nReference-data tables to track (comma-separated, or Enter to skip): ')
  const checks = dataTables
    ? { data: { tables: dataTables.split(',').map((t) => t.trim()).filter(Boolean) } }
    : undefined

  const config: SupaForgeConfig = { environments, source, target }
  if (checks) config.checks = checks

  return { config, envVars }
}

async function confirm(
  ask: (question: string) => Promise<string>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${question} ${hint}: `)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function selectOne(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void,
  label: string,
  options: string[],
  defaultOption: string,
): Promise<string> {
  const optList = options.map((o) => (o === defaultOption ? `[${o}]` : o)).join(' / ')
  while (true) {
    const answer = await ask(`${label} (${optList}): `)
    const value = answer || defaultOption
    if (options.includes(value)) return value
    log(`  ⚠ Must be one of: ${options.join(', ')}`)
  }
}

export default class Init extends Command {
  static override description = 'Create a supaforge.config.json file interactively'

  static override examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init --force',
  ]

  static override flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Overwrite existing config file',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    const configPath = resolve(process.cwd(), CONFIG_FILENAME)

    if (!flags.force) {
      try {
        await access(configPath)
        this.error(
          `${CONFIG_FILENAME} already exists. Use --force to overwrite.`,
        )
      } catch {
        // File does not exist — proceed
      }
    }

    this.log('\n🔧 SupaForge Init — create your config file\n')

    const ask = createPrompt()

    try {
      const { config, envVars } = await collectConfig(ask, (msg) => this.log(msg))

      const isSingleEnv = !config.source

      // Validate with env vars expanded (to catch structural issues)
      // but write the unexpanded $VAR references to the config file
      const expandedConfig = {
        ...config,
        environments: Object.fromEntries(
          Object.entries(config.environments).map(([name, env]) => [
            name,
            {
              ...env,
              dbUrl: expandEnvVars(env.dbUrl),
              ...(env.apiKey ? { apiKey: expandEnvVars(env.apiKey) } : {}),
            },
          ]),
        ),
      }

      if (isSingleEnv) {
        const envName = Object.keys(expandedConfig.environments)[0]
        const errors = validateSingleEnvConfig(expandedConfig, envName)
        if (errors.length > 0) {
          this.error(`Generated config is invalid:\n  ${errors.join('\n  ')}`)
        }
      } else {
        const errors = validateConfig(expandedConfig)
        if (errors.length > 0) {
          this.error(`Generated config is invalid:\n  ${errors.join('\n  ')}`)
        }
      }

      const json = JSON.stringify(config, null, 2) + '\n'
      await writeFile(configPath, json, 'utf-8')
      this.log(`\n✅ Wrote ${CONFIG_FILENAME}`)

      // Write .env file with the actual secrets
      if (Object.keys(envVars).length > 0) {
        const envPath = resolve(process.cwd(), '.env')
        const envContent = Object.entries(envVars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + '\n'

        let shouldWrite = true
        try {
          await access(envPath)
          // .env exists — append instead of overwrite
          const { appendFile } = await import('node:fs/promises')
          await appendFile(envPath, '\n# Added by supaforge init\n' + envContent)
          this.log(`📎 Appended env vars to .env`)
        } catch {
          await writeFile(envPath, envContent, 'utf-8')
          this.log(`📎 Wrote .env with database credentials`)
        }

        this.log('\n⚠️  Add .env to .gitignore — never commit secrets to git.')
      }

      this.log('\nNext steps:')
      if (isSingleEnv) {
        const envName = Object.keys(config.environments)[0]
        this.log(`  supaforge snapshot --env=${envName} --apply   — capture current state`)
        this.log(`  supaforge clone --env=${envName} --apply      — clone to local`)
        this.log(`  supaforge backup --env=${envName} --apply     — incremental backup\n`)
      } else {
        this.log('  supaforge scan     — check for drift')
        this.log('  supaforge diff     — see detailed differences\n')
      }
    } finally {
      ask.close()
    }
  }
}
