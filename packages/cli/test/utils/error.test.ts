import { describe, it, expect } from 'vitest'
import { errMsg, redactUrls, friendlyDbError, describeFailure, UNDESCRIBED_ERROR } from '../../src/utils/error.js'

describe('redactUrls', () => {
  it('redacts password from postgres URL', () => {
    expect(redactUrls('postgres://user:secret@localhost:5432/db'))
      .toBe('postgres://user:***@localhost:5432/db')
  })

  it('redacts password from postgresql URL', () => {
    expect(redactUrls('postgresql://admin:p@ssw0rd@db.host.co:5432/mydb'))
      .toBe('postgresql://admin:***@db.host.co:5432/mydb')
  })

  it('redacts multiple URLs in one string', () => {
    const input = 'source=postgres://a:x@h1/db target=postgres://b:y@h2/db'
    expect(redactUrls(input)).toBe('source=postgres://a:***@h1/db target=postgres://b:***@h2/db')
  })

  it('leaves URL without password unchanged', () => {
    expect(redactUrls('postgres://localhost/db')).toBe('postgres://localhost/db')
  })

  it('leaves non-URL strings unchanged', () => {
    expect(redactUrls('no URLs here')).toBe('no URLs here')
  })

  it('handles empty string', () => {
    expect(redactUrls('')).toBe('')
  })

  it('redacts password with special characters', () => {
    expect(redactUrls('postgres://user:p%40ss!#word@host/db'))
      .toBe('postgres://user:***@host/db')
  })
})

describe('errMsg', () => {
  it('extracts message from Error instance', () => {
    expect(errMsg(new Error('something broke'))).toBe('something broke')
  })

  it('converts string to itself', () => {
    expect(errMsg('plain string')).toBe('plain string')
  })

  it('converts number to string', () => {
    expect(errMsg(42)).toBe('42')
  })

  // These three used to render "null", "undefined" and "[object Object]".
  // All three are strings a user cannot act on, and the last is exactly what
  // reached the renderer as a bare "not reachable:" in issue #47.
  it('names an unreportable null as such rather than printing "null"', () => {
    expect(errMsg(null)).toBe(UNDESCRIBED_ERROR)
  })

  it('names an unreportable undefined as such', () => {
    expect(errMsg(undefined)).toBe(UNDESCRIBED_ERROR)
  })

  it('falls back to the error code rather than "[object Object]"', () => {
    expect(errMsg({ code: 'ENOENT' })).toBe('ENOENT (no further detail reported)')
  })

  it('extracts message from TypeError', () => {
    expect(errMsg(new TypeError('bad type'))).toBe('bad type')
  })

  it('redacts credentials from Error messages containing DB URLs', () => {
    const err = new Error('Command failed: --server1-url=postgres://user:secret@host/db')
    expect(errMsg(err)).toBe('Command failed: --server1-url=postgres://user:***@host/db')
  })

  it('redacts credentials from string errors containing DB URLs', () => {
    expect(errMsg('connect to postgres://admin:pass123@localhost/db failed'))
      .toBe('connect to postgres://admin:***@localhost/db failed')
  })
})

describe('friendlyDbError', () => {
  const dbUrl = 'postgres://postgres:secret@localhost:5432/mydb'

  it('translates ECONNREFUSED to connection refused message', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('Cannot connect to PostgreSQL at localhost:5432')
    expect(msg).toContain('does not appear to be running')
  })

  it('translates "Connection refused" text', () => {
    const err = new Error('connection to server at "localhost", port 5432 failed: Connection refused')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('Cannot connect to PostgreSQL at localhost:5432')
  })

  it('translates ENOTFOUND to hostname resolution error', () => {
    const err = new Error('getaddrinfo ENOTFOUND badhost.example.com')
    const msg = friendlyDbError(err, 'postgres://user:pass@badhost.example.com:5432/db')
    expect(msg).toContain('Cannot resolve hostname badhost.example.com:5432')
  })

  it('translates ETIMEDOUT to timeout message', () => {
    const err = new Error('connect ETIMEDOUT 10.0.0.1:5432')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('timed out')
    expect(msg).toContain('localhost:5432')
  })

  it('translates authentication failure', () => {
    const err = new Error('password authentication failed for user "postgres"')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('Authentication failed')
    expect(msg).toContain('localhost:5432')
  })

  it('translates database not found', () => {
    const err = new Error('database "mydb" does not exist')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('Database does not exist')
    expect(msg).toContain('localhost:5432')
  })

  it('translates SSL/pg_hba errors', () => {
    const err = new Error('no pg_hba.conf entry for host "1.2.3.4"')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('requires SSL')
    expect(msg).toContain('localhost:5432')
  })

  it('returns redacted message for unknown errors', () => {
    const err = new Error('something unexpected with postgres://user:secret@host/db')
    const msg = friendlyDbError(err, dbUrl)
    expect(msg).toContain('something unexpected')
    expect(msg).not.toContain('secret')
    expect(msg).toContain('***')
  })

  it('falls back to generic host when no URL provided', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const msg = friendlyDbError(err)
    expect(msg).toContain('Cannot connect to PostgreSQL at the configured host')
  })

  it('does not leak credentials in friendly messages', () => {
    const err = new Error('Connection refused to postgres://admin:supersecret@prod.host:5432/db')
    const msg = friendlyDbError(err, 'postgres://admin:supersecret@prod.host:5432/db')
    expect(msg).not.toContain('supersecret')
  })
})

/**
 * Issue #47 (3): one connection-failure path produced nothing after the colon —
 * `✗ Source database not reachable:` — because the thrown value reached the
 * renderer with no `message`. Whatever arrives, something printable comes out.
 */
describe('describeFailure', () => {
  it('prefers the message when there is one', () => {
    expect(describeFailure(new Error('connect ECONNREFUSED 127.0.0.1:5434'))).toBe('connect ECONNREFUSED 127.0.0.1:5434')
    expect(describeFailure('plain string failure')).toBe('plain string failure')
  })

  it('falls back to the error code when the message is empty', () => {
    const err = Object.assign(new Error(''), { code: 'ECONNRESET' })
    expect(describeFailure(err)).toBe('ECONNRESET (no further detail reported)')
  })

  it('falls back to the error type when there is no message or code', () => {
    const err = new TypeError('')
    expect(describeFailure(err)).toBe('TypeError (no further detail reported)')
  })

  it('never returns an empty string, whatever it is handed', () => {
    const cases: unknown[] = [
      new Error(''),
      new Error('   '),
      '',
      '   ',
      null,
      undefined,
      {},
      Object.assign(new Error(''), { code: '' }),
    ]
    for (const value of cases) {
      const described = describeFailure(value)
      expect(described.trim().length, `empty for ${JSON.stringify(value)}`).toBeGreaterThan(0)
    }
  })

  it('trims, so whitespace alone can never read as a message', () => {
    expect(describeFailure(new Error('  spaced  '))).toBe('spaced')
    expect(describeFailure(new Error('   '))).toBe(UNDESCRIBED_ERROR)
  })

  it('keeps errMsg redacting credentials through the fallback', () => {
    const err = new Error('failed for postgresql://user:hunter2@db.example.com:5432/postgres')
    expect(errMsg(err)).toContain(':***@')
    expect(errMsg(err)).not.toContain('hunter2')
  })
})
