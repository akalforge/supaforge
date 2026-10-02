# supaforge

> Diff and sync your Supabase environments.

Built by [Akal](https://github.com/akalforge).

## Quick Start

```bash
npm install -g @akalforge/supaforge

# Interactive setup — creates supaforge.config.json
supaforge init

# Check for drift
supaforge diff

# See detailed SQL diffs
supaforge diff --detail

# Fix the drift
supaforge diff --apply
```

## Single Database

Working with one Supabase project? Choose "single" mode during `supaforge init` to set up snapshot, clone, and restore workflows without needing a second environment.

```bash
supaforge init                                       # Choose "single" mode
supaforge snapshot --env=prod --apply                # Capture current state
supaforge clone --env=prod --apply                   # Clone remote to local
supaforge snapshot --env=prod --migration --apply    # Capture + incremental migration
```

`snapshot` previews by default like everything else here, so leaving `--apply`
off prints what it *would* capture and writes no snapshot.

## Comprehensive Checks

| Check | Source | Detection | Fix |
|-------|--------|-----------|-----|
| Schema | `@dbdiff/cli` | ✅ Tables, columns, indexes, constraints, views, triggers, functions, standalone sequences, enum and composite types, domains, materialized views | SQL (up/down) |
| Data | `@dbdiff/cli --type=data` | ✅ Row-level diff for all public tables (configurable). A content digest per table (`md5` of every row, order-independent) decides which tables to skip — a row count alone read an edited row as unchanged | SQL (up/down) |
| RLS Policies | `pg_policies` view | ✅ Compared by what PostgreSQL makes of each expression, not its text — a policy restored from a dump renders differently and is still the same policy. Also applies to storage and Realtime Authorization policies | SQL (up/down) |
| Edge Functions | Management API (hosted), Studio's `/api/v1/projects/{ref}/functions` (self-hosted), or the functions directory | ✅ Hosted and **self-hosted**, comparing module contents | DELETE extras via API (hosted); otherwise guidance to `supabase functions deploy` |
| Storage | Storage API + `pg_policies` | ✅ Buckets (`public`, `type`, `file_size_limit`, `allowed_mime_types`, `avif_autodetection`; `owner_id` reported only), analytics and vector buckets, policies. Skipped when either side has no `storage` schema. `--include-files` adds file-level drift detection (checksums for JSON, size/date for binary) — **detection only, files are never transferred**. | Buckets via API (POST/PUT/DELETE); Policies via SQL |
| Auth Config | Management API, or GoTrue `/auth/v1/settings` when `apiUrl` is set | ✅ Self-hosted covers provider flags and signup settings, not `JWT_EXP` / `MFA_ENABLED` | PATCH via API (hosted only) |
| Cron Jobs | `cron.job` table | ✅ | SQL (up/down) |
| Webhooks | `pg_trigger` + `pg_net` | ✅ Every trigger calling `supabase_functions.http_request`, compared on its full definition — so the URL, method, headers, params and timeout count, not just the table and events | SQL (up/down) |
| Realtime | `pg_publication` + `pg_publication_tables`, and `pg_policies` on `realtime` | ✅ Publications, plus **Realtime Authorization** policies on `realtime.messages` (who may join which channel) | SQL (CREATE/ALTER PUBLICATION; CREATE/DROP POLICY) |
| Vault Secrets | `vault.secrets` | ✅ | A *modified* secret's name or description: SQL (`vault.update_secret`). A **missing** secret: none — reported with the `vault.create_secret` call to run by hand |
| Postgres Extensions | `pg_extension` | ✅ | SQL (CREATE/DROP EXTENSION) |
| Postgres Roles & Grants | `pg_roles` + `information_schema` grants | ✅ Custom role attributes and table grants. Supabase's platform roles (`postgres`, `supabase_admin`, `authenticator`, `supabase_*_admin`, `dashboard_user`, `pgbouncer`, `supavisor`, `pg_*`) are excluded throughout. The Data API roles (`anon`, `authenticated`, `service_role`) are excluded from *attribute* comparison — their attributes are the platform's — but their **grants are compared**, because revoking `anon`'s access to a table is exactly the drift worth catching | SQL (CREATE/ALTER ROLE, GRANT/REVOKE) |
| RLS Coverage | `pg_class.relrowsecurity` | ✅ Tables with RLS disabled — **reads the target only** | SQL, held back unless `--apply-posture` |
| Migration History | `supabase_migrations.schema_migrations` | ✅ Local migration files with no tracking row — **reads the target only** | SQL (records the file as applied without running it), held back unless `--apply-posture` |

The last two compare nothing: they judge the target on its own and fire
identically whichever pair you diff, so they are scored apart and their fixes
are not applied by default. See
[Drift score vs posture score](#drift-score-vs-posture-score).

### Scoping a diff to specific tables

`--check` / `--skip` select whole layers. `--tables` / `--exclude-tables` scope
*within* the schema and data layers, which is what makes it possible to promote
a reviewed subset between environments rather than applying everything a layer
found:

```bash
supaforge diff --tables=orders,order_items          # only these two
supaforge diff --tables='billing_*' --exclude-tables='*_audit'
supaforge diff --tables=orders --apply              # promote just this table
```

Both flags are repeatable and comma-separated, and take the same `*` / `?`
globs `@dbdiff/cli` supports. The scope is enforced inside the diff itself —
dbdiff is told what to compare — rather than by generating everything and
discarding findings afterwards.

The equivalent config keys make a scope repeatable:

```json
{
  "checks": {
    "tables": ["orders", "order_items"],
    "excludeTables": ["*_audit", "*_log"]
  }
}
```

**Precedence.** `--tables` *overrides* `checks.tables` — asking for one table on
the command line must not be widened by a broader list in config.
`--exclude-tables` is *unioned* with `checks.excludeTables`, the same way
`--skip` merges with `checks.exclude`: an exclusion is a safety rail, so both
sources excluding more is never the surprising direction.

**Which layers it reaches.** A table is a concept the schema and data checks
have and the others do not, so `diff --tables=orders` still compares every RLS
policy, storage bucket and cron job. A scoped run says so before it starts:

```
  Scoped to only orders — applies to the schema and data checks; other layers are unfiltered.
```

**Dependants of an excluded table.** dbdiff's `--tables` covers *tables*, so a
scoped fix set still arrives carrying the views, triggers and indexes hanging
off the tables it excluded. With `--apply`, those are skipped with a reason
naming the table rather than attempted and failed:

```
○ [schema] schema-create-view-2: Depends on table 'orders', excluded by --tables
```

**Scoping to something other than a table.** `--tables` has no way to express
"these two tables and these three functions". `--only` does, by taking the
issue ids `--json` already reports:

```bash
supaforge diff --check=schema --json > plan.json
supaforge diff --apply --only=schema-create-function-7,schema-create-trigger-6
supaforge diff --apply --only='schema-create-*'
```

Combine with `--check=schema` when you want the run itself narrowed too.

### Drift score vs posture score

Twelve of the fourteen checks compare source against target. Two do not:

- **RLS Coverage** reads only the target, listing tables with RLS disabled.
- **Migration History** compares local migration *files* against the target's
  tracking table.

Both fire identically whichever pair you diff, so they are scored separately.
Counting them as drift meant a diff of an environment *against itself* could
never reach 100, and any project with a long-standing RLS gap scored 0 no
matter how well synchronised its environments were:

```
SupaForge scan complete: no drift detected. ✓
9 posture findings (RLS coverage / migration history) — present regardless of which pair you diff.

  ✓ Layer 1 (Schema):                   0 issues
  ● Layer 3 (RLS Coverage):             8 issues[CRITICAL]
  ● Layer 13 (Migration History):       1 issue[INFO]

Drift score: 100/100
Posture score: 0/100 (target only — RLS coverage, migration history)
```

The findings are not discarded or downgraded — they keep their severity and
appear in `--detail`, in `--ci`'s `criticalIssues`, and in the GitHub
annotations. Only the drift score changes, so `no drift detected` becomes a
trustworthy synchronisation signal. `--ci` output carries `postureScore`
alongside `score`.

#### They do not decide the exit code

The scope that keeps them out of the drift score keeps them out of the exit code
too. Gating on the combined critical count meant a diff of an environment
against *itself* exited 1 forever: these checks fire identically whichever pair
you diff, so a long-standing RLS gap failed every sync check while the report
directly above it said `no drift detected`. `--fail-on` could not express the
difference, because the difference is one of scope, not severity.

```bash
supaforge diff                      # exits 0: environments agree
supaforge diff --fail-on-posture    # exits 1: gate on posture findings too
```

`--fail-on-posture` works in `--ci` as well, and the `--fail-on` threshold
applies within that scope — `--fail-on=warning --fail-on-posture` fails on a
posture warning, plain `--fail-on-posture` only on a critical one.

A run that would have exited 1 before and now exits 0 says so, once:

```
  Posture findings do not affect the exit code — they describe the target,
  not drift from the source. Add --fail-on-posture to gate on them.
```

#### Their fixes are held back too

`--apply` skips posture fixes, for the same reason they are scored apart: they
change the target without reference to the source, so applying one *creates*
drift. Enabling RLS on a target whose source has it disabled means the next
diff reports schema drift and the next sync turns it back off — the pair
oscillates and never converges.

```
Skipped 2 issue(s):
  ○ [rls-coverage] rls-coverage-public.customers: Posture finding about the target,
    not drift from the source — applying it would create drift.
    Use --apply-posture to apply anyway.
```

```bash
supaforge sync --apply-posture              # enable RLS, record migrations, deliberately
supaforge diff --check=rls-coverage --apply # naming the check counts as asking
```

Asking for the check by name is treated as intent, so an RLS rollout does not
need the extra flag. What `--apply-posture` prevents is a *general* sync quietly
reaching for fixes that undo themselves.

### Self-hosted Supabase

Set `apiUrl` on an environment and every API-backed check targets that gateway
instead of `api.supabase.com`, authenticating with the service-role key in
`accessToken`. `projectRef` is not required when `apiUrl` is set — it is only a
path segment on a hosted URL that will not be called.

```json
{
  "environments": {
    "self-hosted-a": {
      "dbUrl": "$DB_URL_A",
      "apiUrl": "https://supabase.example.com",
      "accessToken": "$SUPABASE_SERVICE_KEY"
    }
  }
}
```

All fourteen checks run against self-hosted. Edge Functions needs one extra
piece of config: self-hosted Supabase exposes no "list functions" *management*
endpoint, so point `studioUrl` at Studio (which serves the same shape) or
`functionsPath` at the mounted directory — see
[Edge Functions on self-hosted](#edge-functions-on-self-hosted). With neither
set, the check reports

```
  ○ Layer 4 (Edge Functions):           skipped — Edge Functions comparison needs a source to read from on self-hosted. Set "studioUrl" on both environments…
```

rather than attempting a call that can only return `Unauthorized`. Add it to
`checks.exclude` if you would rather not see the line at all.

Auth Config reads GoTrue's `/auth/v1/settings` on self-hosted, which exposes
fewer keys than the hosted Management API's `/config/auth` — provider flags and
signup settings, but not `JWT_EXP` or `MFA_ENABLED`. Because the two shapes are
not comparable, a self-hosted source and a hosted target are reported as
skipped rather than diffed against each other. Self-hosted GoTrue also has no
config write endpoint, so its findings carry no `--apply` action: change the
target deployment's environment and restart it.

### Skipped checks

A check that cannot run — no credentials configured, an extension absent, no
tables listed to compare — is reported as **skipped with the reason**, never as
a clean pass:

```
  ✓ Layer 1 (Schema):                   0 issues
  ○ Layer 4 (Edge Functions):           skipped — no projectRef or accessToken configured
  ○ Layer 6 (Auth Config):              skipped — no projectRef or accessToken configured
  ✓ Layer 7 (Cron Jobs):                0 issues
  ○ Layer 8 (Reference Data):           skipped — no tables configured in checks.data.tables

Drift score: 100/100 (2 of 5 checks compared)
```

The closing line says `N checks were skipped — coverage is partial`, and the
score carries the denominator it was computed over, so a perfect number across
a partial run cannot be read as a full comparison.

A skip is not drift and does not reduce the score or fail CI — penalising it
would give every self-hosted project a permanently depressed score for layers
it deliberately cannot run. `--ci` output carries a `skipped` array and a
`coverage` object alongside the existing `errors` array, so a pipeline can gate
on coverage explicitly if it wants to:

```json
{
  "score": 100,
  "coverage": { "compared": 2, "total": 5 },
  "skipped": [
    { "check": "auth", "reason": "no projectRef or accessToken configured" }
  ],
  "errors": []
}
```

## Commands

```
supaforge init                          Create supaforge.config.json interactively
supaforge init --force                  Overwrite existing config file

supaforge diff                          Summary: what's drifted? (score + pass/fail)
supaforge diff --detail                 Show detailed SQL diffs
supaforge diff --apply                  Apply SQL + API fixes to the target environment
supaforge diff --dry-run                Print the fixes in execution order, run nothing
supaforge diff --apply --allow-destructive  Also apply fixes that drop tables/columns
supaforge diff --apply --no-transaction Apply statement by statement, keeping partial progress
supaforge diff --apply --only=<id,...>  Apply only these issue ids (globs allowed)
supaforge diff --check=rls              Limit to a specific check
supaforge diff --check=rls --apply      Fix only one check
supaforge diff --skip=storage           Skip a specific check
supaforge diff --skip=auth --skip=vault Skip multiple checks (flag is repeatable)
supaforge diff --tables=orders,items    Scope the schema and data checks to these tables
supaforge diff --exclude-tables='*_log' Exclude tables from those checks (repeatable)
supaforge diff --include-files          Include file-level storage drift detection
supaforge diff --apply --prove          Replay on a throwaway clone before applying
supaforge diff --apply --apply-posture  Also apply target-only (posture) fixes
supaforge diff --ci                     CI mode: annotations + semantic exit codes
supaforge diff --ci --fail-on=warning   Fail on WARNING as well as CRITICAL
supaforge diff --fail-on-posture        Let target-only findings set the exit code
supaforge diff --json                   Output as JSON
supaforge sync                          Alias for diff --apply
supaforge hukam                         Alias for diff 🙏

supaforge snapshot                      Preview what a 12-layer snapshot would capture
supaforge snapshot --apply              Capture it
supaforge snapshot --env=prod --apply   Snapshot a specific environment
supaforge snapshot --migration --apply  Capture + generate incremental migration diff
supaforge snapshot --list               List all snapshots
supaforge snapshot --prune              Preview old snapshot cleanup (keeps last 7)
supaforge snapshot --prune --apply      Delete old snapshots
supaforge snapshot --prune --keep=5     Keep last 5 instead of 7
supaforge snapshot --output=<dir>       Write snapshots somewhere other than .supaforge

supaforge clone --env=prod              Preflight checks (validates connectivity)
supaforge clone --env=prod --apply      Clone remote to local (snapshot + baseline)
supaforge clone --env=prod --force      Force re-clone (drop existing DB)
supaforge clone --env=prod --start-local  Auto-start a local PostgreSQL container
supaforge clone --schema-only --apply   Clone schema only, no data
supaforge clone --local-url=<url>       Point at a local server other than :5432
supaforge clone --local-db=<name>       Name the local database (default supaforge_local)
supaforge clone --list                  List existing clones
supaforge clone --delete=<name>         Preview clone deletion
supaforge clone --delete=<name> --apply Drop database and remove tracking

supaforge restore --env=local --from-snapshot=latest          Preview snapshot restore
supaforge restore --env=local --from-snapshot=latest --apply  Rebuild the target from a snapshot
supaforge restore --env=local --from-migrations --apply       Replay migration history
supaforge restore --env=local --from-snapshot=latest --force  Allow a non-empty target
supaforge restore --env=local --from-snapshot=latest --no-transaction  Keep whatever succeeds
supaforge restore --env=local --from-migrations --from=<ver> --to=<ver>  Replay a version range

supaforge migrate create --name=add_orders  Generate a migration from schema drift
supaforge migrate list                  List local migrations, applied and pending
supaforge migrate list --offline        List without querying the target
supaforge migrate run --dry-run         Preview which migrations would run
supaforge migrate run                   Execute pending migrations
supaforge migrate run --up-to=003       Stop after a given migration
supaforge migrate run --allow-destructive  Permit migrations that drop, delete or truncate
supaforge migrate baseline              Mark local migrations applied without running them

supaforge report                        Recent command history from the local run log
supaforge report --last=20              Show more entries
supaforge report --send                 Choose entries to send as anonymous bug reports

supaforge mcp                           Start the MCP stdio server for AI agents
supaforge mcp --allow-config-path       Let a client choose which config to load (off by default)

supaforge help                          The command list
supaforge help <command>                Help for one command, e.g. `help migrate create`
```

Two notes on the shape of that list. `migrate run` and `migrate baseline` are
the only state-changing commands that do **not** take `--apply`: `run` executes
unless given `--dry-run`, and `baseline` writes tracking rows only, so it has no
preview mode. And `report` is local — it reads `~/.supaforge/run-log.jsonl` and
prints it. Only `report --send` leaves the machine, only for the entries you
select, and it shows exactly what would be transmitted before asking. No SQL,
table names or schema content is ever included.

### Safe by Default

Commands that modify databases preview what they would do first — the `migrate`
family noted above being the exception. Add `--apply` to execute:

```bash
# Preview only (default)
supaforge diff
supaforge clone --env=prod

# Actually execute
supaforge diff --apply
supaforge clone --env=prod --apply
```

**Destructive fixes need a second opt-in.** Drift that would destroy data, or
widen access, is always *reported*, but `--apply` skips it unless you also pass
`--allow-destructive`. Six shapes are gated, and each says which it is rather
than all printing "drops data":

| Statement | Reported as |
| --- | --- |
| `DROP SCHEMA` | drops a schema and everything in it |
| `DROP TABLE` | drops a table and its rows |
| `TRUNCATE` | deletes every row in a table |
| `DROP COLUMN` | drops a column and its values |
| `DELETE FROM` | deletes rows |
| `DROP POLICY` | removes the policy …, which may widen access |

A dropped policy is the one that is not about data at all: nothing is lost from
a table, and calling it "drops data" hid the part that matters — removing a
RESTRICTIVE policy opens access up.

```
$ supaforge diff --apply

Applied 1 fix(es):
  ✓ [schema] schema-alter-1

Skipped 2 issue(s):
  ○ [schema] 2 issues: Destructive — drops a table and its rows; re-run with --allow-destructive to apply
      drop-1, drop-2
```

```bash
# Also apply those
supaforge diff --apply --allow-destructive
```

The same gate applies to `migrate run`, which used to execute a `DROP TABLE` in
a migration file without asking:

```bash
supaforge migrate run --allow-destructive
```

Dropping a view, trigger, function, index or type is not gated — those lose a
definition the migration can recreate, not data.

**Fixes run in dependency order.** A function is created before the trigger
that executes it, a column before the index and view that read it, tables
before their foreign keys, and dependants are dropped before what they depend
on. `@dbdiff/cli` emits statements in the order it walks the catalogue, and
applying that order directly failed on sets that were perfectly valid. Preview
the order without running anything:

```bash
supaforge diff --dry-run
```

```
Would apply 3 fix(es), in this order:
  1. [schema] schema-alter-2
     ALTER TABLE "orders" ADD COLUMN "status" text DEFAULT 'pending'::text;
  2. [schema] schema-create-function-7
     CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger ...
  3. [schema] schema-create-trigger-6
     CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders ...

  Nothing was executed. Drop --dry-run to apply.
```

**Replacing an object is one fix, not two.** Sending drops to the end would be
the wrong call when a drop and a create are two halves of replacing *the same
object*. An enum whose values changed arrives from `@dbdiff/cli` as `DROP TYPE`
+ `CREATE TYPE`, and ordering the create first failed with
`type … already exists`, rolling the whole transaction back
([#81](https://github.com/akalforge/supaforge/issues/81)). Such a pair is
recognised and merged into a single fix that drops and recreates in that order,
so it is never split across the ordering — functions, procedures, types, domains
and sequences alike. It reports as `Type modified: public.order_status` rather
than as an unrelated drop and create.

`--dry-run` needs no `--apply`: previewing should not require typing the flag
that writes. The flags that shape *what* would be applied — `--only`,
`--allow-destructive`, `--apply-posture` — take effect under it, so a scoped plan
can be reviewed before it is run:

```bash
supaforge diff --dry-run --only='schema-create-*'
```

The flags that only mean something while executing — `--prove`,
`--no-transaction` — say so rather than doing nothing quietly:

```
  --prove has no effect without --apply. Add --apply for it to take effect.
```

That warning goes to stderr, so `--json` and `--ci` stdout stay parseable.

**An apply is all-or-nothing.** PostgreSQL supports transactional DDL, so the
SQL fix set runs in one transaction: if any statement fails, every statement is
rolled back and the target is left exactly as it was. A partial apply would
leave a shared environment matching neither the source nor its own previous
state.

```
Rolled back 5 fix(es) — the target is unchanged:
  ↩ [schema] schema-alter-3
  ...
1 error(s):
  ✗ [schema] schema-create-view-6: relation "active_orders" already exists

  Nothing was written. Re-run with --no-transaction to apply the fixes that do work.
```

Pass `--no-transaction` (or its alias `--continue-on-error`) to run each fix on
its own and keep whatever succeeds. API-based fixes — storage buckets, auth
config — are not transactional, so they are not attempted at all when the SQL
batch rolls back.

### Snapshot & Clone

```bash
# Capture a full snapshot of your remote Supabase (12 layers)
supaforge snapshot --env=prod --apply

# With incremental migration diff (compares against previous snapshot)
supaforge snapshot --env=prod --migration --description="before-deploy" --apply

# Clone remote to local for development
supaforge clone --env=prod --apply

# Manage clones
supaforge clone --list
supaforge clone --delete=my-clone --apply

# Restore into a local database
supaforge restore --env=local --from-snapshot=latest --apply

# Replay migration history
supaforge restore --env=local --from-migrations --apply
```

**Snapshots capture 12 layers**: schema, RLS policies, cron jobs, webhooks,
extensions, storage (buckets + policies), auth config, edge functions,
reference data, Realtime publications, Vault secret names, and role grants.

The schema layer is written twice, for two different jobs: `schema.json` is an
introspection document for diffing, and `schema.sql` — a `pg_dump
--schema-only` per schema — is what a restore replays.

#### What `restore --from-snapshot` puts back

These are replayed as SQL, in dependency order:

| Replayed | From | Notes |
| --- | --- | --- |
| Extensions | `extensions.sql` | The schema each one wants is created first — `WITH SCHEMA "extensions"` has nothing to land in on plain PostgreSQL |
| Schema | `schema.sql` | Tables, columns, indexes, constraints, views, functions, triggers, types |
| RLS policies | `rls.sql` | |
| Cron jobs | `cron.sql` | |
| Webhooks | `webhooks.sql` | Triggers the schema dump already created are skipped rather than attempted twice |
| Storage policies | `storage-policies.sql` | |
| Realtime publications | `realtime.sql` | Membership is added conditionally, so restoring twice is not an error |
| Role grants | `roles.sql` | A grantee the target has never heard of is created as `NOLOGIN` first |
| Reference data | `data/*.sql` | The tables listed in `checks.data.tables` |

Four things cannot be put back, and are **named in the output** with what to do
instead — a restore that lists what it did and says nothing about the rest reads
as complete when it is not:

| Not replayed | What to do |
| --- | --- |
| Auth config | Pass `--project-ref` and `--api-key` to restore it via the Management API |
| Edge Functions | `supabase functions deploy` from your functions directory |
| Storage **buckets** | The bucket rows are created over the Storage API. The policies *on* them are restored; objects are never transferred |
| Vault secrets | `vault.sql` lists the names only. A secret's value cannot be read out of Vault, so each is recreated by hand with `vault.create_secret` — deliberately not runnable SQL, so a restore cannot invent a value |

Preview it first, as with everything else — the preview lists each layer and
the statements it would run:

```
Restore preview (dry-run) -- from snapshot

  Layer: extensions (1 statements)
    CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

  Layer: schema (18 statements)
    SET statement_timeout = 0;
    ... and 15 more

  Layer: realtime (2 statements)
    ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."orders";

  Layer: roles (1 statements)
    GRANT SELECT ON "public"."orders" TO "anon";

  → Add --apply to execute the restore.
```

**A restore is one transaction.** A failure rolls the whole thing back and
leaves the target exactly as it was, rather than half-rebuilt with the errors
reported at the end. `--no-transaction` keeps whatever succeeded.

**It expects an empty database** and refuses otherwise, because replaying a
schema over existing tables fails on the first one. `--force` replaces instead:
it clears the objects in the snapshot's own schemas, never a Supabase schema,
and keeps the schemas so their grants and default privileges survive. Triggers
and policies elsewhere that depend on what it clears (the `auth.users` trigger
calling `public.handle_new_user()` is the usual one) are recreated afterwards;
if anything else outside would be lost, it refuses and changes nothing.

Objects the platform owns — `pgbouncer.get_auth`, pg_cron's own policies on
`cron.job` — are skipped with a reason, since no ordinary role can recreate
them. Into plain PostgreSQL, statements that only attach to something and need
a Supabase schema the target lacks — a foreign key to `auth.users`, a Database
Webhook, a grant on `storage.objects`, a policy calling `auth.uid()` — are
skipped and listed, as is an extension the server does not ship. A table that
cannot be created still fails the restore.

Grants come back exactly as captured. The schema is dumped without privileges,
so a recreated table or view first gets whatever the target's default
privileges give (on Supabase, everything to `anon`); those are cleared before
the captured grants are replayed, so a view that had been revoked from `anon`
stays revoked.

**Snapshot pruning**: Use `--prune` to delete old snapshots, keeping the most
recent 7 (configurable with `--keep`). Preview mode by default — add `--apply`
to execute. A snapshot an incremental migration was generated against is
retained regardless of age: deleting it would leave that migration unable to
say what it was a diff *from*.

**Migrations are incremental**: `--migration` diffs against the previous
snapshot and writes a migration file to `.supaforge/migrations/`, with both
directions filled in. `up` is what changed; `down` is the inverse of each
statement — `cron.unschedule` for a scheduled job, `DROP POLICY` for a created
policy, `DROP TRIGGER` for a webhook, `DROP EXTENSION` for an extension. A
statement with no safe inverse is left out of `down` rather than guessed at: a
wrong inverse looks like a revert and is not.

The schema layer contributes comments rather than DDL, naming what moved:

```sql
-- The schema changed. This migration carries no DDL for it: deriving one
-- from two introspection documents is what @dbdiff/cli does, and it needs
-- two live databases. Generate it with `supaforge migrate create`.
--   tables added:   public.order_items
--   tables removed: public.legacy_orders
--   views added:   public.order_summary
```

It used to be the single line "Schema changed. Use @dbdiff/cli to generate
migration SQL." — true, and useless, because it named nothing that had changed.

**Clone preflight checks**: Before cloning, `supaforge clone` validates that the remote database is reachable, pg_dump is compatible, and the local PostgreSQL server is running. If port 54322 is unreachable, it hints to run `supabase start`.

**What clone writes to your config.** It adds a `local` environment for the
clone and points `source` at the environment it cloned *from* and `target` at
`local` — so the obvious next step, comparing the clone against its origin,
works without editing anything, and a bare `diff --apply` writes into the clone
rather than into the environment you just copied. It prints both moves, naming
what each was before:

```
      ✓ Config updated: /path/to/supaforge.config.json
      source: dev → prod
      target: prod → local (the clone)
      A bare supaforge diff --apply now writes into the clone, not into "prod".
```

Overwriting those silently was the other half of the problem: whatever the
project pointed at before was gone with no record of it in the output.

## Configuration

The fastest way to get started:

```bash
supaforge init          # Interactive wizard — creates config + .env
```

Or copy the annotated example files and fill in your values:

```bash
cp supaforge.config.example.jsonc supaforge.config.json
cp .env.example .env
```

**Key fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `dbUrl` | Yes | PostgreSQL connection string. Use `$VAR` references for secrets. |
| `projectRef` | No | Supabase Project URL (e.g. `https://xyz.supabase.co`) or bare ref. Enables API-based checks (auth, edge functions). |
| `accessToken` | No | Supabase personal access token. Required when `projectRef` is set for Management API checks (auth config, edge functions). |
| `apiUrl` | No | Base URL for self-hosted Supabase API gateway. Use instead of `projectRef` for local/self-hosted. |
| `source` / `target` | Yes | Environment names to compare. Source = truth, target = to be synced. |
| `checks.data.tables` | No | Tables to include in row-level data drift detection. |
| `checks.exclude` | No | Checks to always skip (e.g. `["storage","auth","vault"]`). Useful for clone environments where these checks produce noise. Can also be overridden per-run with `--skip`. |
| `checks.migrations.dir` | No | Directory holding migration files. Defaults to `supabase/migrations`. |
| `checks.migrations.mode` | No | How to report local migration files with no row in `schema_migrations` — `auto` (default), `warn`, or `ignore`. See [Migration history](#migration-history). |

### Migration history

Layer 13 compares migration files in `supabase/migrations/` against the
`supabase_migrations.schema_migrations` table on the target.

That table is a Supabase CLI convention, not a database requirement. A project
that applies migrations another way — `psql`, the SQL editor, another migration
tool — never populates it, so every local file looks unapplied. Reporting each
one individually is noise, not drift.

`checks.migrations.mode` controls this:

| Mode | Behaviour |
| --- | --- |
| `auto` *(default)* | If the tracking table is **empty** but local files exist, report a single INFO noting an untracked migration workflow. Otherwise warn per file. |
| `warn` | Always warn per unrecorded file, even when nothing is tracked. |
| `ignore` | Report nothing from this check. No migration directory read, no query. |

```json
{
  "checks": {
    "migrations": { "mode": "ignore" }
  }
}
```

The collapse in `auto` only applies when *nothing at all* is tracked. A project
that records some migrations and missed others has genuine drift, and still gets
one actionable warning per missing file.

To adopt the tracking table rather than silence the check, `supaforge migrate
baseline` records existing files as applied without executing them.

Sensitive values (`dbUrl`, `accessToken`) support `$VAR` and `${VAR}` syntax — expanded from environment variables at runtime. Store actual credentials in `.env` (already in `.gitignore`).

**`.env` auto-detection**: SupaForge automatically loads `.env` files following the Next.js / Vite / CRA convention:

1. `.env.{NODE_ENV}.local`
2. `.env.local`
3. `.env.{NODE_ENV}`
4. `.env`

Higher-priority files win for duplicate keys. Existing `process.env` values are never overwritten.

See [`supaforge.config.example.jsonc`](supaforge.config.example.jsonc) and [`.env.example`](.env.example) for fully commented examples.

## What Storage Compares

Bucket **metadata**, not the objects inside them:

| Property | Reported as | Synced |
|---|---|---|
| `public` | critical if private→public, else warning | ✅ |
| `type` (`STANDARD`/`ANALYTICS`/`VECTOR`) | **critical** — a different storage backend, not a setting | ✅ |
| `file_size_limit`, `allowed_mime_types` | warning | ✅ |
| `avif_autodetection` | warning | ✅ |
| `owner_id` | info | ❌ — the owner is an identity local to its own project |

Columns are resolved per connection, so an older Supabase without `type` or
`owner_id` is compared on what it does have rather than failing.

**Analytics and vector buckets** live in their own tables — `storage.buckets_analytics`
and `storage.buckets_vectors` — not in `storage.buckets`, so they are compared
separately. Analytics buckets are matched on `name` rather than `id`: that `id`
is a `gen_random_uuid()` default and differs between any two projects, so
keying on it would report every bucket as both missing and extra on every run.
Soft-deleted analytics buckets (`deleted_at`) are excluded. Both tables are
probed first, so a Supabase predating them is unaffected.

`created_at` and `updated_at` are ignored: they differ between any two
environments and mean nothing.

> **Files are never transferred.** `--include-files` lists objects and downloads
> them to compute checksums so it can *report* drift. There is no upload, copy,
> move or delete path for storage objects anywhere in SupaForge — syncing a
> bucket row is cheap and reversible, overwriting user uploads is not.

### Policies inside ignored schemas

Supabase's own schemas are excluded from the RLS layer because their tables are
product-managed — a difference there means the two projects run different
Supabase versions, not that anyone changed anything.

Two of them hold policies **you** write, so those are compared anyway, by the
check that owns them:

| Policy location | Compared by | What it controls |
|---|---|---|
| `storage.objects` | Storage | who may read or write which files |
| `realtime.messages` | Realtime | who may join which channel (Realtime Authorization) |

A missing or altered policy is **critical** — for these schemas it is an access
rule. An extra policy is **info**: it may be deliberate, and removing it is a
judgement call rather than a fix to apply blindly.

### Ignored schemas

Supabase-managed schemas are excluded by default, so findings are limited to
things you can actually change:

`auth`, `storage`, `realtime`, `_realtime`, `vault`, `net`, `graphql_public`,
`supabase_migrations`, `pgsodium`, `pgtle`, `supabase_functions`, `extensions`

Note `_realtime` (underscore) is a *different* schema from `realtime` — its
tables are owned by `supabase_admin`, so RLS findings on them are not
actionable. Override with `ignoreSchemas` in your config.

## Edge Functions on self-hosted

Hosted Supabase lists functions over the Management API. Self-hosted Studio
serves **the same shape** at `/api/v1/projects/{ref}/functions`, so point
`studioUrl` at it:

```jsonc
{
  "environments": {
    "staging": { "dbUrl": "$STAGING_DATABASE_URL", "studioUrl": "http://staging-host:3000" },
    "prod":    { "dbUrl": "$PROD_DATABASE_URL",    "studioUrl": "http://prod-host:3000" }
  }
}
```

Note this is **Studio's** port, not the Kong gateway `apiUrl` points at — Kong
returns 401 for that path even with a service-role key. The project ref is
`default` on self-hosted unless you set `projectRef`.

> **Studio's functions API has no authentication** on the versions tested — a
> publicly reachable Studio exposes function *source* via the `/body` endpoint
> to anyone who asks. Worth checking before you expose one.

### Falling back to the directory

When Studio is not reachable, point `functionsPath` at the directory the
functions are mounted from instead — one subdirectory per function:

```jsonc
{ "environments": { "local": { "dbUrl": "…", "functionsPath": "./supabase/functions" } } }
```

Each environment resolves independently, so the two can be **mixed**: compare a
local checkout against a live instance by giving one `functionsPath` and the
other `studioUrl`. Both hash modules identically — sorted by filename, hashing
filename then contents — so the results are directly comparable.

`main` is excluded: it is edge-runtime's router (`--main-service`), present on
every self-hosted instance and deployed by nobody. Studio's API omits it too,
so including it reported a phantom "Missing Edge Function: main". Underscore
directories (`_shared`) are excluded for the same reason, along with
`.DS_Store`, `Thumbs.db` and `.gitkeep`.

Only hashes are reported, never source: what matters is that they differ, and
function code can contain secrets that have no business in a drift report.

Nothing is applied automatically — deploying needs the Supabase CLI and, on
self-hosted, an edge-runtime restart. Each issue carries the command to run
instead, because reporting a fix that cannot be applied is worse than admitting
there is not one.

## Proving a migration before you run it

A migration that executes without error can still leave the database in a state
that is not the source. A partitioned table rebuilt as an ordinary one, an enum
column that lost its type, an index that never reached its partitions — all
apply cleanly and all produce the wrong database. No comparison of the generated
SQL can catch that, because the SQL is valid.

`--prove` replays the migration on a throwaway clone of the target and compares
the result against the source:

```bash
supaforge sync --prove          # sync already implies --apply
supaforge diff --apply --prove  # same thing, spelled out
```

```
Proving convergence on a throwaway clone…
Migration does not reproduce the source. Nothing was applied.

  missing: idx public.sales_2026_d_idx CREATE INDEX sales_2026_d_idx ON public.sales_2026 …

These objects would still differ after applying.
```

The target is never touched when the proof fails — it exits 1 having applied
nothing. On success it reports `Converged` and proceeds.

When the clone and the source differ, the source is copied onto the same
server the way the clone was and compared again, so both sides have been
through the same dump and restore. PostgreSQL does not render every expression
the same way twice — `status IN ('draft', 'active')` on a `varchar` column
comes back as an equivalent but differently written `ARRAY` expression — and
compared with the source as written, every correct migration creating such a
CHECK, partial index or policy was refused.

The clone also gets the structure of any schema the proved ones lean on — a
table referencing `auth.users`, a policy calling `auth.uid()` — so a real
Supabase project can be proved at all; before, those failed with `schema
"auth" does not exist`. Only the proved schemas are compared.

The clone is created on the target's own server (no extra credentials), holds
structure only (no data is copied), and is dropped even if the proof throws. It
receives only the schemas being compared — `public` unless you say otherwise —
so it costs seconds rather than minutes, and the extensions those schemas
reference are installed first, since a column default calling
`extensions.uuid_generate_v4()` cannot be created without them.

**A client newer than the server is fine.** `pg_dump` writes its preamble for
its own version, so a PostgreSQL 17+ client dumping a 15 or 16 server emits
`SET transaction_timeout = 0;`, which that server rejects. The preamble is
filtered against the destination's own `pg_settings` before replay, which makes
the common pairing — a Homebrew or distro client on 17/18, Supabase on 15 —
work without installing anything. Nothing else about the replay is relaxed:
`ON_ERROR_STOP` stays on, so a genuine failure still fails the proof rather than
being skipped past.

If the proof cannot run at all — no `pg_dump`, or the role lacks `CREATEDB` —
that is reported as *not proven* and the apply continues. Not being able to
check is a different thing from checking and failing, and conflating them would
either block legitimate work or hide real failures. A clone that *can* be made
but cannot be built — the structure would not replay — is neither: it blocks the
apply, because what the migration would do is then unknown.

> Order matters more than it looks. `CREATE INDEX … ON ONLY parent` is correct
> when the index is created *before* partitions attach, because PostgreSQL
> propagates it to partitions added later — and wrong when they already exist.
> Nothing in the SQL text distinguishes the two. This is exactly the class of
> problem that only replaying can decide.

## Exit Codes

Every command follows the same contract, so a pipeline can branch on the exit
code without parsing output:

| Code | Meaning |
|------|---------|
| `0` | Did what was asked — including when there was nothing to do |
| `1` | Ran, but declined to act, found drift above the threshold, or an operation failed |
| `2` | Could not run: a usage error, or (in `--ci`) a check that could not complete |

The distinction that matters is between **0** and **1**. A command that refuses
to act is not a success:

```bash
# Refused because the target is not empty — exits 1, so this does NOT deploy
supaforge restore --env=prod --from-snapshot=latest --apply && ./deploy.sh
```

`--ci` gives `diff`, `sync` and `hukam` a stricter contract, with the drift
threshold under your control:

```bash
supaforge diff --ci                      # 1 only on CRITICAL drift (default)
supaforge diff --ci --fail-on=warning    # 1 on CRITICAL or WARNING
supaforge diff --ci --fail-on=any        # 1 on any issue at all
supaforge diff --ci --fail-on-posture    # also gate on the target-only checks
```

**Drift, not posture.** The threshold applies to the twelve checks that compare
the two environments. RLS Coverage and Migration History report on the target
alone, so they are reported but do not set the exit code unless
`--fail-on-posture` asks them to — see
[Drift score vs posture score](#drift-score-vs-posture-score).

In `--ci` mode a check that **could not complete** exits `2` rather than `0`,
because unmeasured is not the same as clean. Outside `--ci` those commands
report the problem in their output but keep their exit code, so existing
non-CI callers are unaffected — use `--ci` when a script depends on the result.

## Workflows

### Multi-DB: Compare Two Environments (Remote ↔ Remote)

The primary use case — detect drift between `dev` and `prod` (or `staging` and `prod`, or any two environments):

```bash
# 1. Set up config with source + target
supaforge init            # Choose "multi" mode, enter two environment URLs

# 2. Check for drift (summary)
supaforge diff
# Output:
#   ✗ DRIFTED (Score: 42/100)
#   ● Schema: 2 issues [CRITICAL]
#   ● RLS:    3 issues [CRITICAL]
#   ● Cron:   1 issue  [WARNING]
#   → Run with --detail to see SQL · --apply to fix

# 3. See the full SQL
supaforge diff --detail

# 4. Apply fixes to the target
supaforge diff --apply

# 5. Verify
supaforge diff
#   ✓ SYNCED (Score: 100/100)
```

**Config** (`supaforge.config.json`):
```json
{
  "environments": {
    "dev": {
      "dbUrl": "$DEV_DATABASE_URL",
      "projectRef": "dev-abc123",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    },
    "prod": {
      "dbUrl": "$PROD_DATABASE_URL",
      "projectRef": "prod-xyz789",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    }
  },
  "source": "dev",
  "target": "prod",
  "checks": {
    "data": { "tables": ["plans", "feature_flags"] }
  }
}
```

### Diffing a Clone (Suppressing Expected Noise)

After `supaforge clone`, the local copy has no Supabase-managed services
(`storage`, `auth`, `edge-functions`, `vault`, `realtime`) — and, because it is
vanilla PostgreSQL, none of Supabase's service roles either, so **Postgres Roles
& Grants** (`roles`) reports every grant referencing one as drift. On a real
clone → remote diff that was 227 findings, the second-largest source of clone
noise after schema; a remote-to-remote diff of the same pair reports zero,
confirming all of them are clone artefacts.

Running `diff` against a clone will always report drift on those six checks. Use
`--skip` to suppress them:

```bash
supaforge diff --skip=storage --skip=auth --skip=edge-functions --skip=vault --skip=realtime --skip=roles
```

Or lock the exclusions in config so you never have to repeat them:

```json
{
  "checks": {
    "exclude": ["storage", "auth", "edge-functions", "vault", "realtime", "roles"]
  }
}
```

Both mechanisms merge — `--skip` on the CLI is unioned with `checks.exclude` from config.

**Which way you are diffing changes what `--apply` means.** From a clone, it
reshapes the remote to match a vanilla-PostgreSQL copy — dropping the roles,
grants and policies the clone never had. So in that direction the closing advice
is a warning rather than a suggestion:

```
  → --apply would push this clone's shape onto the target, absences included —
    preview it first with --apply --dry-run
```

This no longer depends on the clone being one SupaForge recorded: the local
clone manifest is per-directory and keyed by exact database name, so a clone
diffed from elsewhere used to read as an ordinary environment. SupaForge now
also asks the databases directly — a target carrying Supabase's schemas against
a source carrying none is the situation the warning is about, however that
source came to exist.

### Single-DB: Snapshot, Clone, Restore (Local ↔ Remote)

Working with a single Supabase environment — no source/target pair needed:

```bash
# 1. Set up config with one environment
supaforge init            # Choose "single" mode

# 2. Capture a full 12-layer snapshot
supaforge snapshot --env=prod --apply

# 3. Track changes over time with incremental migrations
supaforge snapshot --env=prod --migration --description="before-deploy" --apply

# 4. Clone remote to local for development (requires supabase start)
supaforge clone --env=prod --apply

# 5. Restore from a previous snapshot
supaforge restore --env=local --from-snapshot=latest --apply
```

**Config** (`supaforge.config.json`):
```json
{
  "environments": {
    "prod": {
      "dbUrl": "$PROD_DATABASE_URL",
      "projectRef": "prod-xyz789",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    }
  }
}
```

**Available commands by config mode:**

| Command | Multi-DB | Single-DB |
|---------|----------|-----------|
| `diff` | ✅ Compares source → target | ✗ Requires two environments |
| `snapshot` | ✅ Any environment | ✅ |
| `clone` | ✅ Any environment → local | ✅ |
| `restore` | ✅ | ✅ |
| `hukam` | ✅ Alias for diff | ✗ |

### CI/CD Integration

```yaml
# .github/workflows/drift-check.yml
- name: Check for drift
  env:
    DEV_DATABASE_URL: ${{ secrets.DEV_DATABASE_URL }}
    PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  run: npx supaforge diff --ci
```

`--ci` emits GitHub Actions annotations and exits 1 on CRITICAL drift, failing
the pipeline. Raise or lower the bar with `--fail-on=warning` / `--fail-on=any`,
and see [Exit Codes](#exit-codes) for the full contract — notably that a check
which could not complete exits 2 rather than passing quietly, and that the
target-only checks are reported but do not fail the build unless you add
`--fail-on-posture`. That last part is what keeps a long-standing RLS gap from
failing every drift check you run.

Note `--check` is a different flag: it takes a check *name* (`--check=rls`) and
limits the run to that layer.

## Extending with Hooks

SupaForge includes a lightweight hook bus for extensibility:

```typescript
import { HookBus, scan, createDefaultRegistry, loadConfig } from '@akalforge/supaforge'

const bus = new HookBus()

bus.on('supaforge.scan.before', (ctx) => {
  console.log(`Scanning ${ctx.config.source} → ${ctx.config.target}`)
})

bus.on('supaforge.check.after', ({ check, result }) => {
  if (result.status === 'drifted') {
    console.log(`⚠ Drift detected in ${check}`)
  }
})

const config = await loadConfig()
const registry = createDefaultRegistry()
const result = await scan(registry, { config }, bus)
```

## Development

```bash
cd packages/cli
npm install
npm test

# Run in dev mode
./bin/dev.js diff
```

### Integration Tests (Docker / Podman)

Integration tests run against real Supabase Postgres containers. The test script auto-detects Docker or Podman:

```bash
# Full flow: start containers → seed → test → teardown
npm run test:integration

# Keep containers running for debugging
./scripts/test-integration.sh --no-teardown

# Force a specific compose command
COMPOSE_CMD="podman-compose" npm run test:integration
```

You can also start the containers manually and run the tests separately:

```bash
# Start containers (works with Docker Compose v2, docker-compose, or podman-compose)
docker compose -f tests/docker-compose.test.yml up -d

# Wait for Postgres to be ready
until psql postgresql://postgres:source-test-pass@localhost:15432/postgres -c 'SELECT 1' 2>/dev/null; do sleep 1; done
until psql postgresql://postgres:target-test-pass@localhost:15433/postgres -c 'SELECT 1' 2>/dev/null; do sleep 1; done

# Seed
psql postgresql://postgres:source-test-pass@localhost:15432/postgres -f tests/fixtures/seed-source.sql
psql postgresql://postgres:target-test-pass@localhost:15433/postgres -f tests/fixtures/seed-target.sql

# Run integration tests
SUPAFORGE_TEST_SOURCE_URL=postgresql://postgres:source-test-pass@localhost:15432/postgres \
SUPAFORGE_TEST_TARGET_URL=postgresql://postgres:target-test-pass@localhost:15433/postgres \
npx vitest run --config vitest.integration.config.ts

# Teardown
docker compose -f tests/docker-compose.test.yml down -v
```

### CLI e2e Tests

```bash
npm run test:e2e
```

### E2E Tests (Supabase)

Full end-to-end tests against two real Supabase local instances (source = dev, target = prod). Tests the
complete scan → promote → re-scan roundtrip for RLS, Cron, Webhooks, and Storage checks.

**Requirements**: Supabase CLI, Docker (or Podman with docker compat), psql, curl.

```bash
# Full flow: start instances → seed → test → teardown
npm run test:e2e:supabase

# Keep instances running for debugging
./scripts/test-e2e.sh --no-teardown

# Reuse already-running instances
./scripts/test-e2e.sh --skip-start
```

Port allocation:
- Source: API 54321, DB 54322
- Target: API 55321, DB 55322

### @dbdiff/cli Integration

The Schema and Data checks are powered by [`@dbdiff/cli`](https://github.com/DBDiff/DBDiff). It is included as a dependency and installed automatically — no separate install needed. The native binary runs without PHP.

```bash
supaforge diff                # schema + data checks active out of the box
```

The adapter (`src/dbdiff.ts`) resolves the local `@dbdiff/cli` binary, invokes it directly (no `npx`), and parses the UP/DOWN marker output into `DriftIssue` objects.

**What the schema layer reaches.** `3.0.0-rc.18`, the pinned version, models
composite types, domains, materialized views (and their indexes), standalone
sequences and RLS policies — five kinds that earlier releases did not read at
all, and therefore reported as no drift whether they matched or not. A schema
that SupaForge has synced can now be diffed again and come back clean, which is
what makes `--prove` meaningful.

**Objects an extension owns are no longer compared.** An extension brings its
own functions, tables and types — `CREATE EXTENSION pg_trgm` alone installs 31
functions and a type into `public` — and those belong to the extension's
version, not to anything you wrote. Read as ordinary user objects, an extension
present on one side only produced a `CREATE OR REPLACE FUNCTION` for every
member, C-language ones included, which no managed-database role can run.
Since rc.14 they are excluded via `pg_depend.deptype = 'e'`, the catalogue's own record of
that ownership, so what is left in the report is yours.

**Migrations that run (rc.15–rc.18).** A column type change under a view, policy or
trigger condition now comes as one bracket — drop what reads the column, retype
it, put everything back with its options, grants and comments — and SupaForge
keeps that bracket as one finding so it applies as a unit. An added enum label
is `ALTER TYPE ... ADD VALUE` instead of replacing the type, and SupaForge
commits it ahead of the rest of an apply so the same apply can use it.
`UNLOGGED` and storage parameters are compared, and a materialized view's
population state no longer reads as drift between a project and a restored
copy. Since rc.16, a partitioned or inherited column is retyped once, through
its parent; a stored generated column reading a retyped column is recomputed
rather than blocking the change; and an expression PostgreSQL renders
differently after a round trip — `status IN ('draft', 'active')` on a
`varchar` column, in a CHECK, partial index, view or trigger condition — is no
longer reported as a change. Since rc.17, removing or reordering an enum's labels
moves its columns to a new type, keeping the rows and everything reading them;
identity changes are made in place, so the sequence carries on; a `serial`
column can become an identity and back; column storage and compression are
compared; and types and functions are created before, and dropped after,
whatever uses them, in both directions. Since rc.18, a foreign key onto
another schema's table is rendered with its schema and a multi-column key with
all its columns; both used to produce SQL PostgreSQL rejected. So a key from
your schema onto an ignored one — a table referencing `auth.users` — is now
synced when the target has the table it references; until now such keys were
filtered out, because the SQL for them could not run.

**One finding per change (rc.17).** Some changes are several statements that
only work together and in order — an enum whose labels are removed is moved to
a new type, a column type change stands its views aside, a generated column is
dropped and re-added, a `serial` column becomes an identity. SupaForge asks
dbdiff to mark each change (`--units`), so such a change is one finding that
applies whole, and its DOWN is the same change's rather than whatever sat at
the same position. A column dropped and re-added in one change is not held
back as destructive: it is recomputed, not lost. And when a table or column
*is* held back, so is the drop of a type, domain, function or sequence it
still uses, and in turn what that keeps — otherwise that drop failed and took
the whole apply with it. Functions the source no longer has are dropped after
the defaults, constraints, indexes and tables that call them. An enum change
dbdiff cannot carry out on its own (a function takes the type, a domain is
built on it) is reported as a manual step naming what is in the way, rather
than run and refused. With a dbdiff that predates
the markers, SupaForge reads the SQL statement by statement as before.

One consequence: a policy that differs is found by both the schema layer and the
RLS layer. It is reported once, by the RLS layer — the finding that names the
policy's risk — and the schema layer's line says how many it left there:

```
  ● Layer 1 (Schema):                   0 issues  (+2 reported under RLS Policies)
```

Only a schema finding that is nothing but policy statements is folded; one that
also creates the table the policy sits on is kept whole. Should both still reach
an apply — with `--check=schema,rls`, say — the second `CREATE POLICY` is
dropped rather than failing the transaction:

```
○ [rls] rls-missing-public.invoices.read_own: Already created by the schema fix for the same policy
```

**Overloaded functions.** Postgres lets several functions share a name with
different argument types. Each overload is compared and reported separately, and
is identified by its signature — `Function modified: public.dist(text,text)` —
so two overloads of one name are distinguishable in the output and the generated
migration touches only the one that actually drifted. This needs
`@dbdiff/cli` 3.0.0-rc.7 or newer; earlier versions saw only one overload per
name and missed drift in the rest.

**Schema diff performance.** DBDiff compares table schemas in a constant number
of round-trips rather than one set per table: it first hashes every table's
schema in a single query per side and skips the ones that match, then loads the
remainder in a fixed 7 queries per side. On a Supabase project where most tables
are unchanged, this is the difference between thousands of round-trips and a
couple of dozen. Nothing to configure — it is on for Postgres automatically.

rc.14 removed two more sources of latency, which matters most over a remote
link: every catalogue query cost three round trips under PDO's default named
prepares, and the internal `pg_dump` dumped the whole database — a query per
function, in every schema — when only `public` was being read. Measured over a
100 ms link against 20 tables plus 300 functions in a non-public schema:

| scenario | before | after |
| --- | --- | --- |
| two identical databases | 9.55 s, 90 round trips | 3.85 s, 34 |
| one added table | 48.86 s, 477 round trips | 11.32 s, 107 |

The generated migration is byte-identical either way, comment headers aside.

If a diff still struggles on a very large schema, raise the ceilings rather than
narrowing the scan:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPAFORGE_DBDIFF_TIMEOUT` | `600` | Seconds before a diff is abandoned. Overrides `checks.schema.timeout` |
| `SUPAFORGE_DBDIFF_MEMORY` | dbdiff's own `1G` | Passed to `--memory-limit`; takes `512M`, `2G`, or `-1` for unlimited |
| `SUPAFORGE_CONNECT_TIMEOUT` | `15` | Seconds before a database connection attempt is abandoned. Applies to every connection, including the preflight reachability check |
| `SUPAFORGE_CHECK_CONCURRENCY` | `4` | How many checks run at once. `1` restores running them one after another |

```bash
SUPAFORGE_DBDIFF_TIMEOUT=600 SUPAFORGE_DBDIFF_MEMORY=2G supaforge diff
```

**Connections and concurrency.** Queries share one connection pool per database
rather than opening a connection per query, and the checks — which are
independent of one another — run four at a time, so a scan spends its latency in
parallel rather than end to end. The concurrency limit is deliberate rather than
unbounded: the schema and data checks each spawn `@dbdiff/cli`, and a Supabase
pooler counts every connection against your limit. Lower
`SUPAFORGE_CHECK_CONCURRENCY` when diffing through a pooler with little
headroom; `=1` makes a run strictly sequential, which is occasionally easier to
follow when debugging one check.

The report is assembled by position, not by completion order, so it reads in
check order however the checks happen to finish. Two paths still hold a
connection of their own by design: the preflight reachability probes, which have
their own timeout, and an `--apply`, which is one connection for one transaction.

**Per-environment overrides.** `checks.exclude` and `checks.schema.timeout` can
be set on an individual environment, applying when it is the diff target and
unioned with the top-level config. Timeout precedence is
`SUPAFORGE_DBDIFF_TIMEOUT` → `checks.schema.timeout` → the 600s default.

**Progress.** On a TTY the schema check reports a live table counter while it
runs, so a long diff reads as working rather than hung. Suppressed under
`--json`, `--ci`, and when output is piped.

**Destructive changes.** DBDiff refuses by default to generate a migration that
drops a table or column. SupaForge passes `--allow-destructive` when invoking it,
because detecting an extra table on the target is the whole point of a drift
check — reporting it must not be a hard failure. The safety gate is applied at
*apply* time instead, in `promote()`, which skips those statements unless you
pass `--allow-destructive` to SupaForge itself. See
[Safe by Default](#safe-by-default).

## License

MIT
