import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SupaForgeConfig } from './types/config'
import { DEFAULT_IGNORE_SCHEMAS } from './defaults'

const CONFIG_FILENAME = 'supaforge.config.json'

export async function loadConfig(cwd = process.cwd()): Promise<SupaForgeConfig> {
  const configPath = resolve(cwd, CONFIG_FILENAME)
  const raw = await readFile(configPath, 'utf-8')
  const config = JSON.parse(raw) as SupaForgeConfig
  return resolveConfig(config)
}

export function resolveConfig(config: SupaForgeConfig): SupaForgeConfig {
  return {
    ...config,
    ignoreSchemas: config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS,
  }
}

export function validateConfig(config: SupaForgeConfig): string[] {
  const errors: string[] = []

  if (!config.environments || typeof config.environments !== 'object') {
    errors.push('environments is required and must be an object')
    return errors
  }

  if (Object.keys(config.environments).length < 2) {
    errors.push('At least two environments are required')
  }

  if (!config.source) errors.push('"source" environment name is required')
  if (!config.target) errors.push('"target" environment name is required')

  if (config.source && !config.environments[config.source]) {
    errors.push(`Source environment "${config.source}" not found in environments`)
  }
  if (config.target && !config.environments[config.target]) {
    errors.push(`Target environment "${config.target}" not found in environments`)
  }

  if (config.source && config.target && config.source === config.target) {
    errors.push('Source and target must be different environments')
  }

  for (const [name, env] of Object.entries(config.environments)) {
    if (!env.dbUrl) errors.push(`Environment "${name}" is missing dbUrl`)
  }

  return errors
}
