import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { quoteLiteral } from '../utils/sql'
import { Check, readOrAbsent, type CheckContext } from './base'

/**
 * Vault secret metadata from vault.decrypted_secrets.
 *
 * We diff ALL attributes: id, name, description, secret (encrypted value),
 * unique_name, nonce, key_id, created_at, updated_at.
 *
 * Note: `secret` is the encrypted column; `decrypted_secret` is the view-only
 * plaintext. We compare encrypted values — environment-specific keys mean
 * identical plaintext will produce different ciphertext, so secret value
 * differences are flagged as INFO (not actionable) while structural differences
 * (name, description, key_id) are WARNING.
 */
interface VaultSecret {
  id: string
  name: string
  description: string | null
  secret: string
  unique_name: string | null
  nonce: string | null
  key_id: string | null
  created_at: string
  updated_at: string
}

/** Attributes that indicate structural drift (actionable). */
const STRUCTURAL_ATTRS: (keyof VaultSecret)[] = ['name', 'description', 'unique_name']

/** Attributes that are environment-specific (informational only). */
const ENV_SPECIFIC_ATTRS: (keyof VaultSecret)[] = ['secret', 'nonce', 'key_id']

export class VaultCheck extends Check {
  readonly name = 'vault' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchSecrets(ctx.source.dbUrl),
      this.fetchSecrets(ctx.target.dbUrl),
    ])
    return diffVaultSecrets(source, target)
  }

  private async fetchSecrets(dbUrl: string): Promise<VaultSecret[]> {
    // supabase_vault may not be installed; any other failure is an error.
    return readOrAbsent(async () => {
      try {
        return await this.queryFn(dbUrl, VAULT_SQL) as unknown as VaultSecret[]
      } catch (err) {
        // unique_name does not exist in older supabase_vault versions (42703).
        if ((err as { code?: string }).code !== '42703') throw err
        const rows = await this.queryFn(dbUrl, VAULT_SQL_FALLBACK) as unknown as VaultSecret[]
        return rows.map(r => ({ ...r, unique_name: null }))
      }
    }, [])
  }
}

const VAULT_SQL = `
  SELECT id, name, description, secret, unique_name, nonce, key_id,
         created_at::text, updated_at::text
  FROM vault.secrets
  ORDER BY name, id
`

const VAULT_SQL_FALLBACK = `
  SELECT id, name, description, secret, nonce, key_id,
         created_at::text, updated_at::text
  FROM vault.secrets
  ORDER BY name, id
`

function secretKey(s: VaultSecret): string {
  return s.unique_name ?? s.name ?? s.id
}

export function diffVaultSecrets(source: VaultSecret[], target: VaultSecret[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(s => [secretKey(s), s]))
  const targetMap = new Map(target.map(s => [secretKey(s), s]))

  // Missing in target
  for (const [key, s] of sourceMap) {
    if (!targetMap.has(key)) {
      issues.push({
        id: `vault-missing-${key}`,
        check: 'vault',
        severity: 'warning',
        title: `Missing vault secret: ${key}`,
        description: `Secret "${key}" exists in source but not in target. The secret value cannot be auto-synced — it must be recreated manually in the target environment.`,
        sourceValue: { name: s.name, description: s.description, unique_name: s.unique_name },
        // No `sql`. The value exists only in the source and Vault will not give
        // it up, so there is nothing to generate — and what was generated was
        // `vault.create_secret('PLACEHOLDER_VALUE', …)`, which `--apply` ran.
        // The target then held a live secret with a bogus value, so anything
        // reading it failed at runtime instead of failing loudly as absent; and
        // because the secret now existed, the next diff stopped asking for the
        // manual step at all (issue #91).
        manualOnly:
          'the secret value exists only in the source and cannot be read out of Vault. '
          + `Create it in the target with the real value:  SELECT vault.create_secret('<value>', `
          + `${quoteLiteral(s.unique_name ?? s.name)}`
          + `${s.description ? `, ${quoteLiteral(s.description)}` : ''});`,
      })
    }
  }

  // Extra in target
  for (const [key] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `vault-extra-${key}`,
        check: 'vault',
        severity: 'info',
        title: `Extra vault secret: ${key}`,
        description: `Secret "${key}" exists in target but not in source.`,
      })
    }
  }

  // Modified secrets — diff all attributes
  for (const [key, ss] of sourceMap) {
    const ts = targetMap.get(key)
    if (!ts) continue

    const diffs: string[] = []

    for (const attr of STRUCTURAL_ATTRS) {
      if (String(ss[attr] ?? '') !== String(ts[attr] ?? '')) {
        diffs.push(`${attr}: "${ss[attr] ?? ''}" → "${ts[attr] ?? ''}"`)
      }
    }

    for (const attr of ENV_SPECIFIC_ATTRS) {
      if (String(ss[attr] ?? '') !== String(ts[attr] ?? '')) {
        diffs.push(`${attr}: differs (environment-specific)`)
      }
    }

    if (diffs.length > 0) {
      const hasStructuralDiff = STRUCTURAL_ATTRS.some(
        attr => String(ss[attr] ?? '') !== String(ts[attr] ?? ''),
      )

      issues.push({
        id: `vault-modified-${key}`,
        check: 'vault',
        severity: hasStructuralDiff ? 'warning' : 'info',
        title: `Modified vault secret: ${key}`,
        description: `Secret "${key}" differs between environments:\n${diffs.join('\n')}`,
        sourceValue: { name: ss.name, description: ss.description, unique_name: ss.unique_name },
        targetValue: { name: ts.name, description: ts.description, unique_name: ts.unique_name },
        sql: hasStructuralDiff
          ? {
              up: `SELECT vault.update_secret('${ts.id}'${ss.unique_name !== ts.unique_name ? `, NULL, ${quoteLiteral(ss.unique_name ?? '')}` : ''}${ss.description !== ts.description ? `, NULL, NULL, ${quoteLiteral(ss.description ?? '')}` : ''});`,
              down: `SELECT vault.update_secret('${ts.id}'${ts.unique_name !== ss.unique_name ? `, NULL, ${quoteLiteral(ts.unique_name ?? '')}` : ''}${ts.description !== ss.description ? `, NULL, NULL, ${quoteLiteral(ts.description ?? '')}` : ''});`,
            }
          : undefined,
      })
    }
  }

  return issues
}

