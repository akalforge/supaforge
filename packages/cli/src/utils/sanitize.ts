import { redactUrls } from './error.js'

/**
 * Strip PII from a string at source — before it ever leaves the user's machine.
 *
 * Covers the realistic surface area without over-engineering:
 *   • DB credentials via redactUrls (postgres://user:PASSWORD@host)
 *   • Local file-system paths (/Users/alice/... or /home/alice/...)
 *   • Bare IPv4 addresses
 */
export function sanitizeForReport(text: string): string {
  return redactUrls(text)
    .replace(/\/(?:Users|home)\/[^/\s"'`]+/g, '~')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
}
