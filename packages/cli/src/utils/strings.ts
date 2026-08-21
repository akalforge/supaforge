/**
 * Shared string manipulation utilities.
 */

/** Maximum length for generated slugs. */
const MAX_SLUG_LENGTH = 60

/**
 * Convert a human-readable string to a filename-safe slug.
 * Lowercases, replaces non-alphanumeric chars with separator, trims edges.
 */
export function slugify(name: string, separator = '_'): string {
  const pattern = new RegExp(`[^a-z0-9]+`, 'g')
  const edgePattern = new RegExp(`^${escapeRegex(separator)}|${escapeRegex(separator)}$`, 'g')
  return name
    .toLowerCase()
    .replace(pattern, separator)
    .replace(edgePattern, '')
    .slice(0, MAX_SLUG_LENGTH)
}

/** Escape every regex metacharacter, so a value can be matched literally. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split a repeatable CLI flag into individual values.
 *
 * `--x=a,b --x=c` and `--x=a --x=b --x=c` mean the same thing; oclif hands over
 * the raw strings, and a comma is the natural separator for the lists these
 * flags take — table names, issue ids — none of which can contain one.
 */
export function parseFlagList(values?: string[]): string[] {
  if (!Array.isArray(values)) return []
  return values
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(v => v.length > 0)
}

/**
 * Compile a `*`/`?` glob to an anchored regular expression.
 *
 * The same two wildcards `@dbdiff/cli` supports, so a pattern means one thing
 * whether it reaches dbdiff or is matched here. Every other character is
 * escaped, so a value containing regex metacharacters cannot turn a filter into
 * a different pattern. Both are linear: the pattern is anchored and has no
 * nested quantifiers.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += escapeRegex(ch)
  }
  return new RegExp(out + '$')
}

/** Does `value` match a `*`/`?` glob? Case-insensitive. */
export function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern.toLowerCase()).test(value.toLowerCase())
}

/**
 * Parse Postgres name[] which may arrive as a JS array or Postgres literal `{a,b}`.
 * Returns a sorted, deduplicated array of role names.
 */
export function normalizeRoles(roles: string[] | string): string[] {
  const arr = Array.isArray(roles) ? roles : [roles]
  return [...new Set(
    arr
      .map(r => r.replace(/^\{|\}$/g, ''))
      .flatMap(r => r.split(','))
      .map(r => r.trim())
      .filter(Boolean),
  )].sort()
}
