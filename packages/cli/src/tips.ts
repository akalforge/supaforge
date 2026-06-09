import { dim, cmd } from './ui.js'
import type { CheckName } from './types/drift.js'

// ─── Context ──────────────────────────────────────────────────────────────────

export interface TipContext {
  /** Which top-level command just ran. */
  command: 'diff' | 'clone' | 'snapshot' | 'restore'
  /** diff: total drift issues found. */
  driftTotal?: number
  /** diff: checks that had drift, in order of severity. */
  driftedChecks?: CheckName[]
  /** diff: checks that were skipped (via --skip or config). */
  skippedChecks?: CheckName[]
  /** diff: whether --detail was used. */
  detail?: boolean
  /** diff: whether --apply was used. */
  apply?: boolean
  /** diff: whether --check narrowed to a single check. */
  singleCheck?: CheckName
  /** clone: whether --apply completed successfully (not dry-run). */
  cloneApplied?: boolean
  /** clone: whether --schema-only was used. */
  schemaOnly?: boolean
  /** snapshot: whether --migration was used. */
  snapshotMigration?: boolean
  /** snapshot: whether --list was used. */
  snapshotList?: boolean
}

// ─── Tip type ─────────────────────────────────────────────────────────────────

interface Tip {
  text: string
}

// ─── Contextual tip pools ─────────────────────────────────────────────────────

function diffTips(ctx: TipContext): Tip[] {
  const tips: Tip[] = []
  const { driftTotal = 0, driftedChecks = [], detail, apply, singleCheck, skippedChecks = [] } = ctx

  if (apply) {
    // Post-apply tips
    if (driftTotal > 0) {
      tips.push({ text: `Re-run ${cmd('supaforge diff')} to verify everything is clean.` })
      tips.push({ text: `Take a snapshot after a successful sync: ${cmd('supaforge snapshot')}.` })
    } else {
      tips.push({ text: `No drift to apply — run ${cmd('supaforge snapshot')} to lock in this clean state.` })
    }
    return tips
  }

  if (driftTotal > 0 && !detail) {
    // Summary mode with drift
    tips.push({ text: `Add ${cmd('--detail')} to see the full SQL for each issue.` })
    tips.push({ text: `Add ${cmd('--apply')} to push all fixes to the target in one shot.` })
    if (driftedChecks.length > 1) {
      tips.push({ text: `Focus on one layer: ${cmd(`--check=${driftedChecks[0]}`)} to see just that check.` })
    }
    if (skippedChecks.length === 0) {
      tips.push({ text: `Post-clone? Use ${cmd('--skip=storage --skip=auth --skip=vault')} to suppress Supabase-only noise.` })
    }
  } else if (driftTotal > 0 && detail) {
    // Detail mode with drift
    tips.push({ text: `Run ${cmd('supaforge diff --apply')} to execute all the SQL fixes above.` })
    if (driftedChecks.length > 1) {
      tips.push({ text: `Fix one layer at a time: ${cmd(`--check=${driftedChecks[0]} --apply`)}.` })
    }
  } else if (driftTotal === 0) {
    // Clean
    tips.push({ text: `Environments are in sync — run ${cmd('supaforge snapshot')} to capture this state.` })
    tips.push({ text: `Wire this into CI: ${cmd('supaforge diff')} exits 1 on critical drift.` })
    if (!singleCheck) {
      tips.push({ text: `Deep-dive a specific layer: ${cmd('supaforge diff --check=rls --detail')}.` })
    }
  }

  return tips
}

function cloneTips(ctx: TipContext): Tip[] {
  if (!ctx.cloneApplied) {
    // Dry-run — hint to add --apply
    return [{ text: `Looks good? Add ${cmd('--apply')} to execute the clone.` }]
  }

  // Post-clone: most important tip is about skipping non-Postgres checks
  return [
    {
      text: `Diff against this clone with: ${cmd('supaforge diff --skip=storage --skip=auth --skip=edge-functions --skip=vault --skip=realtime')} — or add ${cmd('"checks": { "exclude": [...] }')} to config to make it permanent.`,
    },
    { text: `Restore from a snapshot any time: ${cmd('supaforge restore --env=local --from-snapshot=latest --apply')}.` },
    { text: `Run ${cmd('supaforge snapshot')} on the remote after a deploy to track incremental drift.` },
  ]
}

function snapshotTips(ctx: TipContext): Tip[] {
  if (ctx.snapshotList) {
    return [
      { text: `Clean up old snapshots with ${cmd('supaforge snapshot --prune')} (keeps last 7 by default).` },
      { text: `Restore into an environment: ${cmd('supaforge restore --env=local --from-snapshot=latest --apply')}.` },
    ]
  }
  if (ctx.snapshotMigration) {
    return [
      { text: `Migration files live in ${cmd('.supaforge/migrations/')} — commit them to version-control.` },
      { text: `Replay all migrations: ${cmd('supaforge restore --env=local --from-migrations --apply')}.` },
    ]
  }
  return [
    { text: `Add ${cmd('--migration')} to also generate an incremental diff against the previous snapshot.` },
    { text: `List all snapshots: ${cmd('supaforge snapshot --list')}.` },
    { text: `Restore this snapshot: ${cmd('supaforge restore --env=local --from-snapshot=latest --apply')}.` },
  ]
}

function restoreTips(_ctx: TipContext): Tip[] {
  return [
    { text: `After a restore, run ${cmd('supaforge diff')} to confirm the environment matches the source.` },
    { text: `Take a new snapshot to lock in the restored state: ${cmd('supaforge snapshot')}.` },
  ]
}

// ─── General tips pool (fallback) ────────────────────────────────────────────

const GENERAL_TIPS: Tip[] = [
  { text: `${cmd('supaforge hukam')} is an alias for ${cmd('diff')} — same flags, different vibe 🙏` },
  { text: `Use ${cmd('--source=X --target=Y')} to compare any two environments without editing config.` },
  { text: `Store credentials in ${cmd('.env')} — SupaForge auto-loads it. Config supports ${cmd('$VAR')} references.` },
  { text: `Add ${cmd('"checks": { "exclude": ["storage","vault"] }')} to config to permanently skip noisy checks.` },
  { text: `Run ${cmd('supaforge diff --json')} for machine-readable output — useful in scripts and CI.` },
  { text: `Connect AI agents: add ${cmd('supaforge mcp')} to your Claude Desktop / Cursor MCP config.` },
  { text: `Enable row-level data drift: add ${cmd('"checks": { "data": { "tables": ["plans","flags"] } }')} to config.` },
  { text: `${cmd('supaforge diff --include-files')} also checks file-level storage drift (checksums).` },
  { text: `${cmd('supaforge sync')} is shorthand for ${cmd('diff --apply')} — detects and fixes drift in one step.` },
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Pick the most relevant tip for the current context.
 * Returns null when no tip applies (e.g. --json mode — caller should gate on that).
 */
export function pickTip(ctx: TipContext, seed?: number): string | null {
  let pool: Tip[]

  switch (ctx.command) {
    case 'diff':     pool = diffTips(ctx);     break
    case 'clone':    pool = cloneTips(ctx);    break
    case 'snapshot': pool = snapshotTips(ctx); break
    case 'restore':  pool = restoreTips(ctx);  break
    default:         pool = []
  }

  // Fall back to general pool if contextual pool is empty
  if (pool.length === 0) pool = GENERAL_TIPS

  // Mix in a general tip occasionally (every ~3 runs) when the contextual pool
  // is smaller than 3, so users see variety over time.
  if (pool.length < 3 && GENERAL_TIPS.length > 0) {
    const generalIdx = (seed ?? Date.now()) % GENERAL_TIPS.length
    pool = [...pool, GENERAL_TIPS[generalIdx]]
  }

  const idx = (seed ?? Date.now()) % pool.length
  const tip = pool[idx]
  return `\n${dim('tip:')} ${tip.text}`
}

/** Format and return a tip line ready to log, or empty string if none. */
export function renderTip(ctx: TipContext): string {
  return pickTip(ctx) ?? ''
}
