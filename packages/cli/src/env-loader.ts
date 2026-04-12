import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Environment file candidates in descending priority order.
 * Follows the Next.js / Vite / CRA convention:
 *   .env.{NODE_ENV}.local → .env.local → .env.{NODE_ENV} → .env
 *
 * All matching files are loaded (earlier entries win for duplicate keys).
 * Files that don't exist are silently skipped.
 */
export const ENV_FILE_PRIORITY = [
  '.env.local',
  '.env',
] as const

/**
 * Build the prioritised .env file list, inserting NODE_ENV-specific
 * variants when NODE_ENV is set (e.g. production, staging, development).
 *
 * Returns paths in descending priority — first file wins per key.
 */
export function buildEnvFilePriority(nodeEnv?: string): readonly string[] {
  if (!nodeEnv) return ENV_FILE_PRIORITY

  // .env.{NODE_ENV}.local → .env.local → .env.{NODE_ENV} → .env
  return [
    `.env.${nodeEnv}.local`,
    '.env.local',
    `.env.${nodeEnv}`,
    '.env',
  ]
}

/**
 * Parse a single .env file into a key-value map.
 * Handles KEY=value, KEY="value", KEY='value', empty lines, and # comments.
 * Multi-line values are not supported.
 */
export function parseEnvContent(content: string): Map<string, string> {
  const result = new Map<string, string>()

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex < 1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    result.set(key, value)
  }

  return result
}

export interface EnvLoadResult {
  /** Files that were found and loaded, in priority order. */
  loaded: string[]
  /** Total number of env vars injected into process.env. */
  injected: number
}

/**
 * Auto-detect and load .env files into process.env.
 *
 * Standard priority (industry convention matching Next.js / Vite / CRA):
 *   .env.{NODE_ENV}.local → .env.local → .env.{NODE_ENV} → .env
 *
 * Never overwrites existing process.env values — system env always wins.
 * Returns metadata about which files were loaded.
 */
export async function loadEnvFiles(cwd = process.cwd()): Promise<EnvLoadResult> {
  const nodeEnv = process.env.NODE_ENV
  const candidates = buildEnvFilePriority(nodeEnv)
  const loaded: string[] = []
  let injected = 0

  // Track keys we've already set from higher-priority files
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate)
    if (!existsSync(fullPath)) continue

    let content: string
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      continue
    }

    loaded.push(candidate)
    const entries = parseEnvContent(content)

    for (const [key, value] of entries) {
      // System env always wins, then higher-priority files
      if (key in process.env || seen.has(key)) continue
      process.env[key] = value
      seen.add(key)
      injected++
    }
  }

  return { loaded, injected }
}
