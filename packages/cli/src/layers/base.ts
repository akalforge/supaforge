import type { EnvironmentConfig, SupaForgeConfig } from '../types/config'
import type { DriftIssue, LayerName } from '../types/drift'

export interface LayerContext {
  source: EnvironmentConfig
  target: EnvironmentConfig
  config: SupaForgeConfig
}

export abstract class Layer {
  abstract readonly name: LayerName
  abstract scan(ctx: LayerContext): Promise<DriftIssue[]>
}
