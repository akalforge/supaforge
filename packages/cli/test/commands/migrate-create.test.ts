import { describe, it, expect } from 'vitest'
import { generateTimestamp, slugify } from '../../src/commands/migrate/create.js'

describe('generateTimestamp', () => {
  it('returns a 14-character numeric string', () => {
    const ts = generateTimestamp()
    expect(ts).toMatch(/^\d{14}$/)
  })

  it('is based on UTC time', () => {
    const ts = generateTimestamp()
    const year = new Date().getUTCFullYear().toString()
    expect(ts.startsWith(year)).toBe(true)
  })
})

describe('slugify', () => {
  it('converts spaces to underscores', () => {
    expect(slugify('add user roles')).toBe('add_user_roles')
  })

  it('lowercases', () => {
    expect(slugify('Add_User_Roles')).toBe('add_user_roles')
  })

  it('replaces special characters', () => {
    expect(slugify('update-RLS & policies!')).toBe('update_rls_policies')
  })

  it('trims leading/trailing underscores', () => {
    expect(slugify('__test__')).toBe('test')
  })

  it('collapses consecutive separators', () => {
    expect(slugify('one---two___three')).toBe('one_two_three')
  })

  it('handles single word', () => {
    expect(slugify('initial')).toBe('initial')
  })
})
