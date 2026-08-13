import { describe, it, expect } from 'vitest'
import { friendlyDbError, DiagnosticError, isDiagnosticError } from '../src/utils/error.js'

// ── Regression: issue #29 ─────────────────────────────────────────────────
// "Layer 1 (Schema): error: Connection to localhost:5433 timed out — verify
// the host and port are correct" was shown for a host the preflight had just
// confirmed reachable. scanner.ts wraps every check error in friendlyDbError,
// whose /ETIMEDOUT|timeout/i pattern matched the accurate message's own
// remediation text ("set SUPAFORGE_DBDIFF_TIMEOUT=600"), rewriting it.

const TIMEOUT_MESSAGE =
  'Schema diff timed out after 300s — the schema is very large or the database connection is slow.\n' +
  '  Remediations:\n' +
  '    • Raise the limit: set SUPAFORGE_DBDIFF_TIMEOUT=600 (seconds) and re-run.\n' +
  '    • Narrow the scan: diff one layer at a time with --check=schema.'

describe('friendlyDbError preserves diagnosed messages (issue #29)', () => {
  it('does not rewrite a DiagnosticError, even when it mentions a timeout', () => {
    const out = friendlyDbError(new DiagnosticError(TIMEOUT_MESSAGE), 'postgres://u:p@localhost:5433/db')
    expect(out).toContain('Schema diff timed out after 300s')
    expect(out).toContain('SUPAFORGE_DBDIFF_TIMEOUT=600')
    expect(out).not.toContain('verify the host and port')
  })

  it('no longer matches a bare mention of the timeout env var', () => {
    // Defence in depth: even undecorated, this text is not a connection error.
    const out = friendlyDbError(new Error('Set SUPAFORGE_DBDIFF_TIMEOUT=600 and retry'), 'postgres://h:5432/d')
    expect(out).not.toContain('verify the host and port')
  })

  it('still translates genuine driver connection errors', () => {
    const url = 'postgres://u:p@db.example.com:5432/postgres'
    expect(friendlyDbError(new Error('connect ECONNREFUSED 10.0.0.1:5432'), url))
      .toContain('does not appear to be running')
    expect(friendlyDbError(new Error('connect ETIMEDOUT 10.0.0.1:5432'), url))
      .toContain('timed out')
    expect(friendlyDbError(new Error('getaddrinfo ENOTFOUND db.example.com'), url))
      .toContain('Cannot resolve hostname')
    expect(friendlyDbError(new Error('password authentication failed for user "u"'), url))
      .toContain('Authentication failed')
  })

  it('passes an unrecognised error through unchanged', () => {
    expect(friendlyDbError(new Error('something else entirely'))).toBe('something else entirely')
  })

  it('handles non-Error values and a missing dbUrl without throwing', () => {
    expect(() => friendlyDbError('a string')).not.toThrow()
    expect(() => friendlyDbError(undefined)).not.toThrow()
    expect(() => friendlyDbError(null, 'not-a-url')).not.toThrow()
    expect(() => friendlyDbError(new Error('connect ECONNREFUSED'), 'not-a-url')).not.toThrow()
  })
})

describe('isDiagnosticError', () => {
  it('recognises a DiagnosticError', () => {
    expect(isDiagnosticError(new DiagnosticError('x'))).toBe(true)
  })

  it('recognises one crossing a module boundary, where instanceof fails', () => {
    // src vs dist, or ESM/CJS interop, yields two class identities.
    const impostor = new Error('x')
    impostor.name = 'DiagnosticError'
    expect(isDiagnosticError(impostor)).toBe(true)
  })

  it('does not treat an ordinary error or a non-error as diagnosed', () => {
    expect(isDiagnosticError(new Error('x'))).toBe(false)
    expect(isDiagnosticError('x')).toBe(false)
    expect(isDiagnosticError(null)).toBe(false)
    expect(isDiagnosticError(undefined)).toBe(false)
  })
})
