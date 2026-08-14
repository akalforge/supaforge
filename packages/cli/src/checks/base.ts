import type { EnvironmentConfig, SupaForgeConfig } from '../types/config'
import type { DriftIssue, CheckName } from '../types/drift'

export interface CheckContext {
  /**
   * Optional sink for sub-check progress, e.g. the table counter emitted
   * during a long schema diff (issue #29). Checks that have nothing
   * fine-grained to report simply ignore it.
   */
  onDetail?: (detail: string) => void
  source: EnvironmentConfig
  target: EnvironmentConfig
  config: SupaForgeConfig
}

export abstract class Check {
  abstract readonly name: CheckName
  abstract scan(ctx: CheckContext): Promise<DriftIssue[]>
}
