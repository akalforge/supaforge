import type { EnvironmentConfig, SupaForgeConfig } from '../types/config'
import type { DriftIssue, CheckName } from '../types/drift'

export interface CheckContext {
  source: EnvironmentConfig
  target: EnvironmentConfig
  config: SupaForgeConfig
}

export abstract class Check {
  abstract readonly name: CheckName
  abstract scan(ctx: CheckContext): Promise<DriftIssue[]>
}
