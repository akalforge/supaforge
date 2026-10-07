/**
 * Replaying a snapshot's rows: reference data (`data/*.json`) and storage
 * buckets (`storage-buckets.json`).
 *
 * Both were captured and never restored — the data loop looked for `.sql`
 * files the snapshot does not write, and buckets were left to the Storage API.
 * Rows go in through `json_populate_recordset`, so PostgreSQL converts each
 * value to its column's type itself, exactly as it rendered it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { quoteIdent, quoteName } from './utils/sql'

/** The tables a snapshot holds rows for, by file name. */
export async function dataTablesIn(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(dataDir)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort()
  } catch {
    return []
  }
}

/** The snapshot's data tables, parents before children so foreign keys hold. */
export async function dataTablesInOrder(client: pg.Client, dataDir: string): Promise<string[]> {
  return inDependencyOrder(client, await dataTablesIn(dataDir))
}

/**
 * Insert one table's rows, and move each serial or identity sequence past the
 * ids restored.
 *
 * A row already there is kept (`ON CONFLICT DO NOTHING`), so a restore can be
 * run twice. Generated columns are left to compute; identity columns keep
 * their captured values.
 */
export async function restoreTableRows(client: pg.Client, dataDir: string, table: string): Promise<number> {
  const rows = await readFile(join(dataDir, `${table}.json`), 'utf-8')
  const inserted = await insertRows(client, quoteIdent(table), rows)
  await resetSequences(client, quoteIdent(table))
  return inserted
}

/**
 * Create the buckets the target does not have. A bucket is a row in
 * `storage.buckets` — the Storage API writes the same row — so the target
 * needs that table, and nothing else; objects are never transferred.
 */
export async function restoreBuckets(client: pg.Client, file: string): Promise<number | undefined> {
  const { rows: [present] } = await client.query<{ ok: boolean }>(`SELECT to_regclass('storage.buckets') IS NOT NULL AS ok`)
  if (!present?.ok) return undefined
  return insertRows(client, 'storage.buckets', await readFile(file, 'utf-8'))
}

/**
 * `rows` is the file's JSON as written, handed to the server untouched:
 * parsed and serialised again here, a bigint past 2^53 or a long numeric
 * came back rounded.
 */
async function insertRows(client: pg.Client, table: string, rows: string): Promise<number> {
  const { rows: keys } = await client.query<{ key: string }>(
    `SELECT DISTINCT jsonb_object_keys(e) AS key FROM jsonb_array_elements($1::jsonb) e`, [rows])
  if (keys.length === 0) return 0
  const { rows: columns } = await client.query<{ name: string; identity: string; generated: string }>(
    `SELECT attname AS name, attidentity AS identity, attgenerated AS generated
       FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [table])
  // The columns both the rows and the table have: a column added since the
  // snapshot takes its default, one dropped since is left behind.
  const captured = new Set(keys.map(k => k.key))
  const usable = columns.filter(c => c.generated === '' && captured.has(c.name))
  const list = usable.map(c => quoteName(c.name)).join(', ')
  const overriding = usable.some(c => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : ''
  const { rowCount } = await client.query(
    `INSERT INTO ${table} (${list})${overriding}
     SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json) ON CONFLICT DO NOTHING`,
    [rows])
  return rowCount ?? 0
}

async function resetSequences(client: pg.Client, table: string): Promise<void> {
  const { rows } = await client.query<{ seq: string; col: string }>(
    `SELECT pg_get_serial_sequence($1, attname) AS seq, attname AS col
       FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
        AND pg_get_serial_sequence($1, attname) IS NOT NULL`,
    [table])
  for (const { seq, col } of rows) {
    await client.query(
      `SELECT setval($1, coalesce((SELECT max(${quoteName(col)}) FROM ${table}), 1),
                     (SELECT max(${quoteName(col)}) FROM ${table}) IS NOT NULL)`,
      [seq])
  }
}

/**
 * Parents first, by the foreign keys between the tables being restored. A
 * cycle cannot be ordered and keeps the order the files came in; a table the
 * target lacks is left for the insert to report.
 */
async function inDependencyOrder(client: pg.Client, tables: string[]): Promise<string[]> {
  const { rows: oids } = await client.query<{ name: string; oid: string | null }>(
    `SELECT t AS name, to_regclass(q)::oid::text AS oid FROM unnest($1::text[], $2::text[]) AS u(t, q)`,
    [tables, tables.map(quoteIdent)])
  const byOid = new Map(oids.filter(r => r.oid).map(r => [r.oid as string, r.name]))
  const { rows: keys } = await client.query<{ child: string; parent: string }>(
    `SELECT conrelid::text AS child, confrelid::text AS parent FROM pg_constraint
      WHERE contype = 'f' AND conrelid::text = ANY($1) AND confrelid::text = ANY($1) AND conrelid <> confrelid`,
    [[...byOid.keys()]])
  const parents = new Map<string, Set<string>>(tables.map(t => [t, new Set()]))
  for (const { child, parent } of keys) parents.get(byOid.get(child)!)?.add(byOid.get(parent)!)

  const ordered: string[] = []
  const placed = new Set<string>()
  while (ordered.length < tables.length) {
    const ready = tables.filter(t => !placed.has(t) && [...parents.get(t)!].every(p => placed.has(p)))
    // A cycle: take the rest as they are.
    for (const t of ready.length > 0 ? ready : tables.filter(t => !placed.has(t))) {
      ordered.push(t)
      placed.add(t)
    }
  }
  return ordered
}
