/**
 * Regex matching database connection URL schemes (postgres, mysql, etc.).
 * Captures the scheme + `://` and the rest of the URL up to the next whitespace.
 */
const DB_URL_RE = /\b((?:postgres(?:ql)?|mysql|mariadb):\/\/)(\S+)/g

/**
 * Redact passwords from database connection URLs in a string.
 *
 * Replaces `://user:PASSWORD@host` with `://user:***@host` to prevent
 * credentials from leaking into logs, error messages, or terminal output.
 * Handles passwords containing special characters including `@`.
 */
export function redactUrls(message: string): string {
  return message.replace(DB_URL_RE, (_, scheme: string, rest: string) => {
    const lastAt = rest.lastIndexOf('@')
    if (lastAt === -1) return scheme + rest
    const creds = rest.slice(0, lastAt)
    const hostPart = rest.slice(lastAt)
    const colonIdx = creds.indexOf(':')
    if (colonIdx === -1) return scheme + rest
    return scheme + creds.slice(0, colonIdx) + ':***' + hostPart
  })
}

/**
 * Extract a concise error message from an unknown caught value.
 *
 * Safely handles Error instances, strings, and other thrown types.
 * Used across the codebase in catch blocks to normalise error output.
 * Automatically redacts database credentials from the message.
 */
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactUrls(raw)
}

/**
 * An error whose message is already written for the user — it has been
 * diagnosed, and usually carries remediation steps.
 *
 * friendlyDbError() passes these through untouched instead of pattern-matching
 * them into a generic connection error. Without this, any accurate message that
 * happens to mention a timeout (including one telling the user which timeout
 * env var to raise) got rewritten into advice to check their host and port.
 */
export class DiagnosticError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagnosticError'
  }
}

/**
 * Structural check rather than `instanceof`.
 *
 * The CLI and its tests can load a module through more than one path (src vs
 * dist, ESM vs CJS interop), which yields two distinct class identities and
 * makes `instanceof` silently false. Matching on the name keeps the guard
 * working across those boundaries.
 */
export function isDiagnosticError(err: unknown): boolean {
  return err instanceof DiagnosticError || (err instanceof Error && err.name === 'DiagnosticError')
}

// ─── Connection Error Patterns ───────────────────────────────────────────────

/** Known patterns matched against error messages, checked in order. */
const CONNECTION_ERROR_PATTERNS: Array<{ test: (msg: string) => boolean; build: (host: string) => string }> = [
  {
    test: (m) => /ECONNREFUSED|Connection refused/i.test(m),
    build: (host) => `Cannot connect to PostgreSQL at ${host} — the server does not appear to be running. Start it and try again.`,
  },
  {
    test: (m) => /ENOTFOUND|getaddrinfo/i.test(m),
    build: (host) => `Cannot resolve hostname ${host} — check the database URL in your config.`,
  },
  {
    // Deliberately narrow. A bare /timeout/i also matches our own remediation
    // text — "set SUPAFORGE_DBDIFF_TIMEOUT=600" contains "TIMEOUT" — which is
    // how an accurate "Schema diff timed out after Ns" message was being
    // rewritten into a wrong "check the host and port" one (issue #29).
    // DiagnosticError below is the primary guard; this is defence in depth.
    test: (m) => /ETIMEDOUT|connection timed out|timeout expired|statement timeout/i.test(m),
    build: (host) => `Connection to ${host} timed out — verify the host and port are correct and that the server is reachable.`,
  },
  {
    test: (m) => /password authentication failed/i.test(m),
    build: (host) => `Authentication failed for ${host} — check the username and password in your database URL.`,
  },
  {
    test: (m) => /does not exist|database .* does not exist/i.test(m),
    build: (host) => `Database does not exist on ${host} — verify the database name in your config.`,
  },
  {
    test: (m) => /SSL.*required|no pg_hba.conf entry/i.test(m),
    build: (host) => `Connection rejected by ${host} — the server requires SSL or your IP is not allowed. Check pg_hba.conf and SSL settings.`,
  },
]

/**
 * Extract host:port from a PostgreSQL connection URL.
 * Returns just the host portion with the port for display.
 */
function extractHost(dbUrl: string): string {
  try {
    const url = new URL(dbUrl)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return 'the configured host'
  }
}

/**
 * Translate a raw database error into a user-friendly message.
 *
 * Matches known pg error patterns and returns an actionable message
 * with the host identified. Returns the original (redacted) message
 * if no pattern matches.
 */
export function friendlyDbError(err: unknown, dbUrl?: string): string {
  const raw = errMsg(err)

  // Already a message written for the user, with its own diagnosis and
  // remediation — translating it again can only make it worse, and did:
  // the schema-diff timeout message was being replaced by a connection
  // error naming a host that was demonstrably reachable (issue #29).
  if (isDiagnosticError(err)) return raw

  const host = dbUrl ? extractHost(dbUrl) : 'the configured host'

  for (const pattern of CONNECTION_ERROR_PATTERNS) {
    try {
      if (pattern.test(raw)) {
        return pattern.build(host)
      }
    } catch {
      // A malformed host or an unexpected pattern failure must never turn a
      // reportable error into a crash — fall through to the raw message.
    }
  }

  return raw
}
