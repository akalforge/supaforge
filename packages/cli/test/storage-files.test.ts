import { describe, it, expect } from 'vitest'
import {
  diffFileInventories,
  fileDiffsToIssues,
  type StorageFileInfo,
} from '../src/storage-files.js'

function makeFile(overrides: Partial<StorageFileInfo> = {}): StorageFileInfo {
  return {
    bucket: 'assets',
    path: 'config.json',
    name: 'config.json',
    size: 1024,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mimeType: 'application/json',
    checksum: 'abc123def456',
    ...overrides,
  }
}

describe('diffFileInventories', () => {
  it('returns empty when both inventories are identical', () => {
    const source = [makeFile()]
    const target = [makeFile()]
    expect(diffFileInventories(source, target)).toEqual([])
  })

  it('detects missing files (in source but not target)', () => {
    const source = [makeFile({ path: 'a.json', name: 'a.json' })]
    const target: StorageFileInfo[] = []
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].type).toBe('missing')
    expect(diffs[0].path).toBe('a.json')
  })

  it('detects extra files (in target but not source)', () => {
    const source: StorageFileInfo[] = []
    const target = [makeFile({ path: 'extra.json', name: 'extra.json' })]
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].type).toBe('extra')
    expect(diffs[0].path).toBe('extra.json')
  })

  it('detects changed JSON files by checksum', () => {
    const source = [makeFile({ checksum: 'aaa' })]
    const target = [makeFile({ checksum: 'bbb' })]
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].type).toBe('changed')
    expect(diffs[0].details).toContain('content differs')
  })

  it('detects unchanged when checksums match', () => {
    const source = [makeFile({ checksum: 'same' })]
    const target = [makeFile({ checksum: 'same' })]
    expect(diffFileInventories(source, target)).toEqual([])
  })

  it('falls back to size comparison when no checksums', () => {
    const source = [makeFile({ checksum: null, size: 1000 })]
    const target = [makeFile({ checksum: null, size: 2000 })]
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].details).toContain('size differs')
  })

  it('falls back to modified-date comparison for non-JSON files', () => {
    const source = [makeFile({
      checksum: null,
      size: 1024,
      updatedAt: '2026-01-01T00:00:00Z',
    })]
    const target = [makeFile({
      checksum: null,
      size: 1024,
      updatedAt: '2026-06-15T12:00:00Z',
    })]
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].details).toContain('last modified differs')
  })

  it('handles files in different buckets as separate entries', () => {
    const source = [makeFile({ bucket: 'b1', path: 'x.json' })]
    const target = [makeFile({ bucket: 'b2', path: 'x.json' })]
    const diffs = diffFileInventories(source, target)
    // b1/x.json is missing, b2/x.json is extra
    expect(diffs).toHaveLength(2)
    expect(diffs.find(d => d.type === 'missing')).toBeDefined()
    expect(diffs.find(d => d.type === 'extra')).toBeDefined()
  })

  it('handles mixed scenario: missing + extra + changed', () => {
    const source = [
      makeFile({ path: 'only-source.json', name: 'only-source.json', checksum: 'a' }),
      makeFile({ path: 'shared.json', name: 'shared.json', checksum: 'old' }),
    ]
    const target = [
      makeFile({ path: 'shared.json', name: 'shared.json', checksum: 'new' }),
      makeFile({ path: 'only-target.json', name: 'only-target.json', checksum: 'b' }),
    ]
    const diffs = diffFileInventories(source, target)
    expect(diffs).toHaveLength(3)
    expect(diffs.filter(d => d.type === 'missing')).toHaveLength(1)
    expect(diffs.filter(d => d.type === 'extra')).toHaveLength(1)
    expect(diffs.filter(d => d.type === 'changed')).toHaveLength(1)
  })
})

describe('fileDiffsToIssues', () => {
  it('converts diffs to DriftIssues with correct severity', () => {
    const diffs = [
      { bucket: 'b', path: 'missing.json', type: 'missing' as const, details: 'gone' },
      { bucket: 'b', path: 'extra.json', type: 'extra' as const, details: 'extra' },
      { bucket: 'b', path: 'changed.json', type: 'changed' as const, details: 'diff' },
    ]
    const issues = fileDiffsToIssues(diffs)
    expect(issues).toHaveLength(3)
    expect(issues[0].severity).toBe('warning')  // missing
    expect(issues[0].check).toBe('storage')
    expect(issues[1].severity).toBe('info')      // extra
    expect(issues[2].severity).toBe('warning')    // changed
  })

  it('generates unique ids', () => {
    const diffs = [
      { bucket: 'b', path: 'a.json', type: 'missing' as const, details: '' },
      { bucket: 'b', path: 'b.json', type: 'extra' as const, details: '' },
    ]
    const issues = fileDiffsToIssues(diffs)
    const ids = issues.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns empty array for no diffs', () => {
    expect(fileDiffsToIssues([])).toEqual([])
  })
})
