import type { Reporter, TestModule } from 'vitest/node'

/**
 * Fails the run when any scenario was skipped.
 *
 * No scenario has a reason to: a case needing a newer server returns early
 * and passes. A skip means something stopped it running — a hook that threw,
 * a stray `.skip` — and a suite that skips its way to green has tested
 * nothing. The run already fails when a hook throws; this also covers every
 * other way a test can end up not run.
 */
export default class NoSkipsReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const skipped: string[] = []
    for (const mod of modules) {
      for (const test of mod.children.allTests()) {
        if (test.result().state === 'skipped') skipped.push(test.fullName)
      }
    }
    if (skipped.length === 0) return
    process.stderr.write(`\n${skipped.length} scenario(s) did not run:\n${skipped.slice(0, 20).map(n => `  ${n}`).join('\n')}\n`)
    process.exitCode = 1
  }
}
