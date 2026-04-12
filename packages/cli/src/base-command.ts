import { Command } from '@oclif/core'
import { loadConfig, validateConfig, validateSingleEnvConfig } from './config.js'
import type { SupaForgeConfig, EnvironmentConfig } from './types/config.js'

/**
 * Shared base for all supaforge commands.
 * Extracts config loading, env resolution, and URL redaction.
 */
export abstract class BaseCommand extends Command {

  /** Load config or exit with a helpful error. */
  protected async loadConfigOrFail(): Promise<SupaForgeConfig> {
    try {
      return await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run "supaforge init" first.',
      )
    }
  }

  /**
   * Resolve a single environment by name.
   * Accepts an explicit flag value or falls back to config.source.
   */
  protected resolveEnv(
    config: SupaForgeConfig,
    envFlag?: string,
  ): { envName: string; env: EnvironmentConfig } {
    const envName = envFlag ?? config.source
    if (!envName) {
      this.error('No environment specified. Use --env=<name> or set "source" in your config.')
    }

    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    return { envName, env: config.environments[envName] }
  }

  /**
   * Validate a two-env (source + target) config.
   * Applies flag overrides before validation.
   */
  protected validateDualEnvConfig(
    config: SupaForgeConfig,
    sourceFlag?: string,
    targetFlag?: string,
  ): void {
    if (sourceFlag) config.source = sourceFlag
    if (targetFlag) config.target = targetFlag

    const errors = validateConfig(config)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }
  }

  /** Redact password from a database URL for display. */
  protected redactUrl(url: string): string {
    return url.replace(/:([^@/]{1,})@/, ':***@')
  }
}
