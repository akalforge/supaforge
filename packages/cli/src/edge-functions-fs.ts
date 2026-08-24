/**
 * Edge Function inventory from the filesystem.
 *
 * Hosted Supabase lists functions over the Management API. Self-hosted exposes
 * no equivalent, so the only thing that can be compared is the directory the
 * functions live in — one subdirectory per function, which is both what
 * `supabase functions new` produces and what self-hosted edge-runtime mounts.
 *
 * Content is hashed rather than compared byte for byte so the diff can say
 * "this function changed" without holding two copies of every function in
 * memory, and without leaking source into issue output.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export interface FunctionInventory {
  /** Directory name, which is the function slug. */
  slug: string
  /** Hash over every file's path and contents, so a rename or edit both show. */
  hash: string
  /** File count, purely so the description can be specific. */
  fileCount: number
}

/** Files that say nothing about behaviour and differ for uninteresting reasons. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep'])

async function hashDirectory(dir: string): Promise<{ hash: string; fileCount: number }> {
  const files: string[] = []

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(dir)

  // Sort by the path relative to the function root: absolute paths differ
  // between machines, and readdir order is not guaranteed stable.
  const relative_ = files.map(f => ({ abs: f, rel: relative(dir, f).split(sep).join('/') }))
  relative_.sort((a, b) => a.rel.localeCompare(b.rel))

  const hash = createHash('sha256')
  for (const f of relative_) {
    hash.update(f.rel)
    hash.update('\0')
    hash.update(await readFile(f.abs))
    hash.update('\0')
  }
  return { hash: hash.digest('hex'), fileCount: relative_.length }
}

/**
 * One entry per subdirectory of `root`. A missing root yields an empty
 * inventory rather than throwing: an environment legitimately may have no
 * functions, and that is drift to report, not an error to fail on.
 */
export async function inventoryFunctions(root: string): Promise<FunctionInventory[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out: FunctionInventory[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    try {
      await stat(dir)
      const { hash, fileCount } = await hashDirectory(dir)
      if (fileCount === 0) continue
      out.push({ slug: entry.name, hash, fileCount })
    } catch {
      // Unreadable directory — skip rather than fail the whole layer.
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
