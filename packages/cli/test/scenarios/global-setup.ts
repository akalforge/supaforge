import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Build the CLI before any scenario runs. The scenarios drive bin/run.js,
 * which loads dist/, so a stale build would test some other code than the
 * checkout's — and pass or fail for reasons unrelated to it.
 */
export default function setup(): void {
  const cwd = fileURLToPath(new URL('../..', import.meta.url))
  execFileSync('npx', ['tsup'], { cwd, stdio: 'ignore' })
}
