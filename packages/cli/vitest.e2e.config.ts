import { defineConfig } from 'vitest/config'
import { BaseSequencer } from 'vitest/node'

/**
 * Custom sequencer: sorts test files alphabetically by filename.
 *
 * The file naming convention guarantees the required execution order:
 *   00-scan-all → cron → rls → storage → webhooks → zz-verify-clean
 *
 * WHY: Vitest's BaseSequencer sorts by cached run duration; on a cold cache
 * (every fresh CI run) it falls back to filesystem inode order, which is
 * non-deterministic across environments. fileParallelism=false only
 * guarantees sequential execution — NOT alphabetical ordering.
 */
class AlphaByFilenameSequencer extends BaseSequencer {
  override async sort(
    files: Parameters<BaseSequencer['sort']>[0],
  ): ReturnType<BaseSequencer['sort']> {
    return [...files].sort((a, b) =>
      (a.moduleId.split('/').pop() ?? '').localeCompare(
        b.moduleId.split('/').pop() ?? '',
      ),
    )
  }
}

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/supabase/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: {
      sequencer: AlphaByFilenameSequencer,
    },
  },
})
