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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
