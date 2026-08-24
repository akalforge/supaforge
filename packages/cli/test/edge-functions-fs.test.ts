import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventoryFunctions } from '../src/edge-functions-fs'

let root: string

async function fn(slug: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(root, slug), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, slug, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, body)
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sf-fns-'))
  await fn('hello', { 'index.ts': 'export default () => new Response("hi")' })
  await fn('nested', { 'index.ts': 'a', 'lib/util.ts': 'b' })
  await fn('noisy', { 'index.ts': 'c', '.DS_Store': 'junk' })
  await fn('main', { 'index.ts': 'router' })
  await fn('_shared', { 'util.ts': 'helper' })
  await mkdir(join(root, '.hidden'), { recursive: true })
  await mkdir(join(root, 'empty'), { recursive: true })
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('inventoryFunctions', () => {
  it('lists one entry per function directory', async () => {
    const inv = await inventoryFunctions(root)
    expect(inv.map(f => f.slug)).toEqual(['hello', 'nested', 'noisy'])
  })

  it('excludes the runtime router and shared code', async () => {
    // `main` is edge-runtime's --main-service router, present on every
    // self-hosted instance and deployed by nobody; Studio's API excludes it.
    // Including it reported "Missing Edge Function: main" when comparing a
    // directory against Studio on byte-identical content.
    const slugs = (await inventoryFunctions(root)).map(f => f.slug)
    expect(slugs).not.toContain('main')
    // _shared is the Supabase convention for code imported by functions.
    expect(slugs).not.toContain('_shared')
  })

  it('skips hidden and empty directories', async () => {
    const slugs = (await inventoryFunctions(root)).map(f => f.slug)
    expect(slugs).not.toContain('.hidden')
    // An empty directory is not a function; reporting it as one would show as
    // drift on any machine that happened to have a stray folder.
    expect(slugs).not.toContain('empty')
  })

  it('counts nested files', async () => {
    const nested = (await inventoryFunctions(root)).find(f => f.slug === 'nested')
    expect(nested?.fileCount).toBe(2)
  })

  it('ignores editor and OS noise', async () => {
    const noisy = (await inventoryFunctions(root)).find(f => f.slug === 'noisy')
    expect(noisy?.fileCount).toBe(1)
  })

  it('returns an empty inventory for a missing directory, not an error', async () => {
    // An environment may legitimately have no functions. That is drift to
    // report, not a reason to fail the whole layer.
    await expect(inventoryFunctions(join(root, 'does-not-exist'))).resolves.toEqual([])
  })

  it('hashes content, so an edit changes the hash and a re-read does not', async () => {
    const before = (await inventoryFunctions(root)).find(f => f.slug === 'hello')!
    const again = (await inventoryFunctions(root)).find(f => f.slug === 'hello')!
    expect(again.hash).toBe(before.hash)

    await writeFile(join(root, 'hello', 'index.ts'), 'export default () => new Response("bye")')
    const after = (await inventoryFunctions(root)).find(f => f.slug === 'hello')!
    expect(after.hash).not.toBe(before.hash)
  })

  it('hashes the path too, so renaming a file is drift', async () => {
    await fn('renamed', { 'index.ts': 'same-bytes' })
    const before = (await inventoryFunctions(root)).find(f => f.slug === 'renamed')!
    await rm(join(root, 'renamed', 'index.ts'))
    await writeFile(join(root, 'renamed', 'handler.ts'), 'same-bytes')
    const after = (await inventoryFunctions(root)).find(f => f.slug === 'renamed')!
    expect(after.hash).not.toBe(before.hash)
  })
})
