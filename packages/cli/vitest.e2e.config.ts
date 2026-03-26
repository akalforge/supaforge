import { defineConfig } from 'vitest/config'

/**
 * Test files are listed explicitly in required execution order:
 *   1. 00-scan-all  — detects initial drift (must run before any promotes)
 *   2. individual layer tests — each promotes its own fixes
 *   3. zz-verify-clean — confirms all drift has been resolved
 *
 * Do NOT replace with a glob: fileParallelism=false does not guarantee
 * alphabetical ordering across CI environments/filesystems.
 */
const E2E_FILES = [
  'tests/e2e/supabase/00-scan-all.test.ts',
  'tests/e2e/supabase/cron.test.ts',
  'tests/e2e/supabase/rls.test.ts',
  'tests/e2e/supabase/storage.test.ts',
  'tests/e2e/supabase/webhooks.test.ts',
  'tests/e2e/supabase/zz-verify-clean.test.ts',
]

export default defineConfig({
  test: {
    globals: true,
    include: E2E_FILES,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
