import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

/**
 * Layer 7: Reference Data Drift — powered by @dbdiff/cli --type=data.
 *
 * @dbdiff/cli is not yet published to npm. This layer is a placeholder
 * that will shell out to @dbdiff/cli with --type=data when available.
 */
export class DataLayer extends Layer {
  readonly name = 'data' as const

  async scan(_ctx: LayerContext): Promise<DriftIssue[]> {
    // TODO: Shell out to @dbdiff/cli when published
    // npx @dbdiff/cli --supabase \
    //   "${source.dbUrl}" "${target.dbUrl}" \
    //   --type=data --include=all \
    //   --tables=${config.layers?.data?.tables?.join(',')}
    return []
  }
}
