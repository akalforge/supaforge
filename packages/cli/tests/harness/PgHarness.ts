/**
 * PgHarness — configurable container harness for realistic SupaForge e2e tests.
 *
 * Spins up a pair of throwaway Postgres instances (a "remote"/source and a
 * "local"/target), lets a test build schema up in stages, then exercises the
 * real CLI against them and asserts the diff/sync behaviour.
 *
 * Design notes:
 *  - Podman is preferred over Docker (lighter); the runtime is auto-detected and
 *    can be forced. We use plain `run`/`exec` rather than compose so there is no
 *    podman-compose dependency.
 *  - Containers use --network=host with an explicit PGPORT. Podman 4.9's bridge
 *    networking needs netavark, which is broken on some hosts; host networking
 *    avoids that entirely and is fine for ephemeral test databases.
 *  - Every instance is namespaced by a run id and torn down in `down()`, so
 *    parallel runs and crashed runs don't collide.
 *  - NOTHING here ever touches a non-local database: `assertLocal()` refuses any
 *    connection string that isn't loopback, so a misconfigured test can't point
 *    destructive operations at a real Supabase project.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const exec = promisify(execFile);

export type Runtime = 'podman' | 'docker';
export type Role = 'source' | 'target';

export interface PgHarnessOptions {
  /** Force a runtime; default auto-detect, preferring podman. */
  runtime?: Runtime;
  /** Postgres image. */
  image?: string;
  /** Host ports for each role. */
  ports?: { source: number; target: number };
  /** Leave containers running after down() — useful when debugging a failure. */
  keep?: boolean;
  /** Superuser password. */
  password?: string;
  /** Database name created in each instance. */
  database?: string;
  /** Seconds to wait for readiness. */
  readyTimeoutSec?: number;
  /** Log container lifecycle to stderr. */
  verbose?: boolean;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class PgHarness {
  readonly runtime: Runtime;
  readonly image: string;
  readonly ports: { source: number; target: number };
  readonly password: string;
  readonly database: string;
  private readonly keep: boolean;
  private readonly readyTimeoutSec: number;
  private readonly verbose: boolean;
  private readonly runId: string;
  private started: Role[] = [];

  constructor(opts: PgHarnessOptions = {}) {
    this.runtime = opts.runtime ?? PgHarness.detectRuntime();
    this.image = opts.image ?? 'docker.io/library/postgres:16-alpine';
    // Default to high, unusual ports so we never collide with a real service.
    this.ports = opts.ports ?? { source: 55432, target: 55433 };
    this.password = opts.password ?? 'supaforge-test';
    this.database = opts.database ?? 'postgres';
    this.keep = opts.keep ?? false;
    this.readyTimeoutSec = opts.readyTimeoutSec ?? 60;
    this.verbose = opts.verbose ?? false;
    this.runId = `sf-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  }

  static detectRuntime(): Runtime {
    for (const rt of ['podman', 'docker'] as Runtime[]) {
      try {
        execFileSync(rt, ['--version'], { stdio: 'ignore' });
        return rt;
      } catch { /* try next */ }
    }
    throw new Error('Neither podman nor docker is available');
  }

  private log(msg: string): void {
    if (this.verbose) process.stderr.write(`[PgHarness] ${msg}\n`);
  }

  private name(role: Role): string {
    return `${this.runId}-${role}`;
  }

  port(role: Role): number {
    return this.ports[role];
  }

  /** libpq connection string for a role. Always loopback. */
  connectionString(role: Role): string {
    return `postgresql://postgres:${this.password}@127.0.0.1:${this.port(role)}/${this.database}`;
  }

  /**
   * Guard against a test ever pointing destructive operations at a real
   * database. Only loopback is permitted.
   */
  static assertLocal(conn: string): void {
    const host = /@([^:/]+)/.exec(conn)?.[1] ?? '';
    const ok = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
    if (!ok) {
      throw new Error(
        `Refusing to operate on non-local database host "${host}". ` +
        'The harness only ever runs destructive operations against loopback.',
      );
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  async up(roles: Role[] = ['source', 'target']): Promise<void> {
    for (const role of roles) {
      await this.startOne(role);
      this.started.push(role);
    }
    await Promise.all(roles.map((r) => this.waitReady(r)));
  }

  private async startOne(role: Role): Promise<void> {
    const name = this.name(role);
    await this.rt(['rm', '-f', name]).catch(() => undefined);
    this.log(`starting ${name} on :${this.port(role)} (${this.runtime})`);
    await this.rt([
      'run', '-d', '--name', name,
      // Host networking: avoids podman's bridge/netavark dependency entirely.
      '--network=host',
      '-e', `POSTGRES_PASSWORD=${this.password}`,
      '-e', `PGPORT=${this.port(role)}`,
      // Test databases are disposable — trade durability for speed.
      this.image, '-c', 'fsync=off', '-c', 'full_page_writes=off',
    ]);
  }

  private async waitReady(role: Role): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutSec * 1000;
    while (Date.now() < deadline) {
      try {
        await this.rt(['exec', this.name(role), 'pg_isready', '-U', 'postgres', '-p', String(this.port(role))]);
        this.log(`${role} ready`);
        return;
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    const logs = await this.rt(['logs', '--tail', '20', this.name(role)]).catch(() => ({ stdout: '', stderr: '' }));
    throw new Error(`${role} not ready after ${this.readyTimeoutSec}s. Logs:\n${logs.stdout}${logs.stderr}`);
  }

  async down(): Promise<void> {
    if (this.keep) { this.log('keep=true, leaving containers up'); return; }
    for (const role of this.started) {
      await this.rt(['rm', '-f', this.name(role)]).catch(() => undefined);
    }
    this.started = [];
  }

  // ---- sql ---------------------------------------------------------------

  /** Run SQL and return stdout (tuples-only, unaligned). */
  async sql(role: Role, statement: string): Promise<string> {
    const { stdout } = await this.rt([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', this.database,
      '-v', 'ON_ERROR_STOP=1', '-tAc', statement,
    ]);
    return stdout.trim();
  }

  /** Apply a multi-statement SQL script (a fixture stage). */
  async applySql(role: Role, script: string): Promise<void> {
    // Fed over stdin so nothing needs mounting into the container.
    await this.rtStdin([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', this.database,
      '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ], script);
  }

  /** Structural fingerprint used to assert two databases match. */
  async schemaFingerprint(role: Role, schemas = ['public']): Promise<string> {
    const list = schemas.map((s) => `'${s}'`).join(',');
    return this.sql(role, `
      SELECT string_agg(line, E'\\n' ORDER BY line) FROM (
        SELECT format('col %s.%s.%s %s %s %s', table_schema, table_name, column_name,
                      data_type, is_nullable, coalesce(column_default,'-')) AS line
          FROM information_schema.columns WHERE table_schema IN (${list})
        UNION ALL
        SELECT format('con %s.%s %s', n.nspname, c.conname, pg_get_constraintdef(c.oid))
          FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN (${list})
        UNION ALL
        SELECT format('idx %s.%s %s', schemaname, indexname, indexdef)
          FROM pg_indexes WHERE schemaname IN (${list})
        UNION ALL
        SELECT format('fn %s.%s %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN (${list})
        UNION ALL
        SELECT format('pol %s.%s.%s %s', schemaname, tablename, policyname, coalesce(qual,'-'))
          FROM pg_policies WHERE schemaname IN (${list})
      ) t`);
  }

  // ---- cli ---------------------------------------------------------------

  /** Invoke the real SupaForge CLI with the harness connection strings. */
  async cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
    // ESM: derive the package root from this module's URL.
    const here = fileURLToPath(new URL('.', import.meta.url));
    const cliEntry = join(here, '..', '..', 'dist', 'index.js');
    try {
      const { stdout, stderr } = await exec('node', [cliEntry, ...args], {
        env: {
          ...process.env,
          SUPAFORGE_SOURCE_URL: this.connectionString('source'),
          SUPAFORGE_TARGET_URL: this.connectionString('target'),
          NO_COLOR: '1',
          ...env,
        },
        timeout: 180_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
    }
  }

  // ---- runtime plumbing ---------------------------------------------------

  private rt(args: string[]) {
    return exec(this.runtime, args, { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  }

  private rtStdin(args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.runtime, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
      p.on('error', reject);
      p.stdin.write(input);
      p.stdin.end();
    });
  }
}
