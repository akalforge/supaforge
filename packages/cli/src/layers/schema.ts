import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

/**
 * Layer 1: Schema Drift — powered by @dbdiff/cli.
 *
 * @dbdiff/cli is not yet published to npm. This layer is a placeholder
 * that will shell out to `npx @dbdiff/cli --supabase` when available.
 */
export class SchemaLayer extends Layer {
  readonly name = 'schema' as const

  async scan(_ctx: LayerContext): Promise<DriftIssue[]> {
    // TODO: Shell out to @dbdiff/cli when published
    // npx @dbdiff/cli --supabase \
    //   "${source.dbUrl}" "${target.dbUrl}" \
    //   --type=schema --include=all \
    //   --ignore-schema=${config.ignoreSchemas.join(',')}
    return []
  }
}
