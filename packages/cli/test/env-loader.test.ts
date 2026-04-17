import { describe, it, expect } from 'vitest'
import {
  buildEnvFilePriority,
  parseEnvContent,
} from '../src/env-loader.js'

describe('buildEnvFilePriority', () => {
  it('returns base pair when no NODE_ENV', () => {
    expect(buildEnvFilePriority()).toEqual(['.env.local', '.env'])
  })

  it('inserts NODE_ENV-specific files in correct order', () => {
    const result = buildEnvFilePriority('production')
    expect(result).toEqual([
      '.env.production.local',
      '.env.local',
      '.env.production',
      '.env',
    ])
  })

  it('handles staging environment', () => {
    const result = buildEnvFilePriority('staging')
    expect(result).toEqual([
      '.env.staging.local',
      '.env.local',
      '.env.staging',
      '.env',
    ])
  })
})

describe('parseEnvContent', () => {
  it('parses simple key=value pairs', () => {
    const map = parseEnvContent('A=hello\nB=world')
    expect(map.get('A')).toBe('hello')
    expect(map.get('B')).toBe('world')
  })

  it('strips double quotes', () => {
    const map = parseEnvContent('KEY="value"')
    expect(map.get('KEY')).toBe('value')
  })

  it('strips single quotes', () => {
    const map = parseEnvContent("KEY='value'")
    expect(map.get('KEY')).toBe('value')
  })

  it('handles equals signs in values', () => {
    const map = parseEnvContent('KEY=a=b=c')
    expect(map.get('KEY')).toBe('a=b=c')
  })

  it('skips blank lines and comments', () => {
    const map = parseEnvContent('# comment\n\nKEY=ok\n  # another\nKEY2=yes')
    expect(map.size).toBe(2)
    expect(map.get('KEY')).toBe('ok')
    expect(map.get('KEY2')).toBe('yes')
  })

  it('ignores lines without equals', () => {
    const map = parseEnvContent('NOEQUALS\nKEY=ok')
    expect(map.size).toBe(1)
    expect(map.get('KEY')).toBe('ok')
  })

  it('handles empty string values', () => {
    const map = parseEnvContent('EMPTY=\nQUOTED=""')
    expect(map.get('EMPTY')).toBe('')
    expect(map.get('QUOTED')).toBe('')
  })
})
