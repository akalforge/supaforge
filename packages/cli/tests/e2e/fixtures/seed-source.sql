-- SupaForge E2E test: SOURCE (dev) database seed
-- Runs against a REAL Supabase local instance (has auth.uid(), pg_cron, pg_net, storage schema).
--
-- Layers exercised: Schema, RLS, Cron, Webhooks, Storage policies, Realtime, Vault, Extensions, Data.
--
-- Idempotent: safe to run multiple times on an existing instance.

-- === Extensions ===
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- === Tables ===
CREATE TABLE IF NOT EXISTS public.users (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    full_name   TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.posts (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    body        TEXT,
    published   BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES public.users(id),
    amount      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plans (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN DEFAULT true
);

-- === Idempotent teardown: drop re-created objects from any prior run =========
DO $$
BEGIN
  DROP POLICY IF EXISTS "users_select_own"      ON public.users;
  DROP POLICY IF EXISTS "users_update_own"      ON public.users;
  DROP POLICY IF EXISTS "posts_select_published" ON public.posts;
  DROP POLICY IF EXISTS "posts_select_own"      ON public.posts;
  DROP POLICY IF EXISTS "posts_insert_own"      ON public.posts;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS on_user_created     ON public.users;
  DROP TRIGGER IF EXISTS on_profile_updated  ON public.users;
  DROP TRIGGER IF EXISTS on_payment_received ON public.payments;
  DROP TRIGGER IF EXISTS on_order_shipped    ON public.payments;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DELETE FROM supabase_functions.hooks
    WHERE hook_name IN ('on_user_created', 'on_payment_received',
                        'on_order_shipped', 'on_legacy_deleted');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "avatars_select" ON storage.objects;
  DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
-- ===========================================================================

-- === RLS Policies ===
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own"
    ON public.users FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "users_update_own"
    ON public.users FOR UPDATE
    TO authenticated
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

CREATE POLICY "posts_select_published"
    ON public.posts FOR SELECT
    TO anon
    USING (published = true);

CREATE POLICY "posts_select_own"
    ON public.posts FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY "posts_insert_own"
    ON public.posts FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- === Cron Jobs (real pg_cron) ===
SELECT cron.schedule('cleanup_sessions', '0 3 * * *', $$SELECT 1$$);
SELECT cron.schedule('weekly_digest', '0 0 * * 0', $$SELECT 1$$);

-- === Webhooks ===
-- Ensure schema and table exist (they should in real Supabase, but be safe)
CREATE SCHEMA IF NOT EXISTS supabase_functions;
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
    id              BIGSERIAL PRIMARY KEY,
    hook_table_id   INTEGER NOT NULL DEFAULT 0,
    hook_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id      BIGINT
);

-- Supabase's own webhook function, which a real stack already has as a C
-- function. The name matters: a database webhook *is* a trigger calling
-- supabase_functions.http_request, and that is how the check identifies one
-- (issue #77). The arguments the triggers pass below are the webhook's
-- configuration.
--
-- Created only when absent, so a real stack keeps its own. Replacing it is
-- what the old fix did as a side effect of syncing a webhook, and is exactly
-- what must not happen.
DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'supabase_functions'
          AND p.proname = 'http_request'
    ) THEN
        EXECUTE $fn$
            CREATE FUNCTION supabase_functions.http_request()
            RETURNS TRIGGER AS $body$
            BEGIN
                RETURN COALESCE(NEW, OLD);
            END;
            $body$ LANGUAGE plpgsql
        $fn$;
    END IF;
END
$do$;

-- on_user_created webhook
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (1, 'on_user_created');
CREATE TRIGGER on_user_created
    AFTER INSERT ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/users', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');

-- on_payment_received webhook
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (3, 'on_payment_received');
CREATE TRIGGER on_payment_received
    AFTER INSERT ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/payments', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');

-- The three cases that separate reading the triggers from reading the log
-- (issue #77). Each was silently wrong before, and none is visible to a check
-- that derives webhooks from supabase_functions.hooks.

-- 1. A webhook that has never fired: no log rows at all, so it was invisible.
--    Deliberately no INSERT into supabase_functions.hooks here.
CREATE TRIGGER on_profile_updated
    AFTER UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/profiles', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');

-- 2. A webhook that was deleted: its log rows outlive it, so it was reported
--    as missing from the target and offered with no usable fix. Log row only,
--    deliberately no trigger.
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (9, 'on_legacy_deleted');

-- 3. A webhook repointed at a different URL. Same name, same table, same
--    events as the target's — only the arguments differ, which the log does
--    not carry, so the two were called identical.
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (5, 'on_order_shipped');
CREATE TRIGGER on_order_shipped
    AFTER INSERT ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/orders/v2', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');

-- === Storage Policies ===
-- storage.objects table exists in real Supabase
CREATE POLICY "avatars_select"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'avatars');

CREATE POLICY "avatars_insert"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'avatars');

-- === Reference Data (plans table for data check) ===
INSERT INTO public.plans (name, price, active) VALUES
    ('Free', 0, true),
    ('Pro', 2900, true),
    ('Enterprise', 9900, true)
ON CONFLICT DO NOTHING;

-- === Realtime Publications ===
-- Create a publication for real-time subscriptions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supaforge_live') THEN
    CREATE PUBLICATION supaforge_live FOR TABLE public.posts, public.payments;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- === Vault Secrets ===
-- supabase_vault extension should exist in a real local Supabase instance
DO $$
BEGIN
  PERFORM vault.create_secret('test-api-key-123', 'api_key', 'External API key for integrations');
EXCEPTION
  WHEN undefined_function THEN NULL;     -- vault not available
  WHEN unique_violation THEN NULL;       -- already exists
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM vault.create_secret('smtp-pass-456', 'smtp_password', 'SMTP credentials for email');
EXCEPTION
  WHEN undefined_function THEN NULL;
  WHEN unique_violation THEN NULL;
  WHEN OTHERS THEN NULL;
END $$;

-- === Schemas of the project's own ===
-- Compared like public: a table keyed to auth.users, an enum, comments and a
-- policy in `app`, and a view in a schema whose name needs quoting. The
-- target has an older `app` and a schema the source no longer has.
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS "Reporting" CASCADE;
DROP SCHEMA IF EXISTS old_stuff CASCADE;
CREATE SCHEMA app;
CREATE TYPE app.tier AS ENUM ('free', 'pro');
CREATE TABLE app.accounts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  owner uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  tier app.tier NOT NULL DEFAULT 'free',
  note text
);
COMMENT ON TABLE app.accounts IS 'customer accounts';
COMMENT ON COLUMN app.accounts.tier IS 'billing tier';
ALTER TABLE app.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_account ON app.accounts FOR ALL TO authenticated USING (owner = auth.uid());
GRANT USAGE ON SCHEMA app TO authenticated;
GRANT SELECT ON app.accounts TO authenticated;
CREATE FUNCTION app.tier_of(bigint) RETURNS app.tier LANGUAGE sql STABLE AS $$ SELECT tier FROM app.accounts WHERE id = $1 $$;
COMMENT ON FUNCTION app.tier_of(bigint) IS 'tier lookup';
CREATE SCHEMA "Reporting";
CREATE VIEW "Reporting"."Accounts By Tier" AS SELECT tier, count(*) AS n FROM app.accounts GROUP BY tier;
COMMENT ON VIEW "Reporting"."Accounts By Tier" IS 'rollup';

-- === Shapes a migration has to order with care ===
-- An exclusion constraint whose operator class comes from btree_gist in the
-- extensions schema, which only the source has: the extension must come first
-- even while DBDiff drops an index on the target later in its sequence. A
-- check added NOT VALID that the target's rows ('kept too') do not hold for, tables referencing
-- each other, a partition with an index and a check of its own, and comments
-- on a policy and a function.
DROP TABLE IF EXISTS public.bookings, public.members, public.teams, public.logs CASCADE;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
CREATE TABLE public.bookings (id int PRIMARY KEY, room int, during tsrange,
  CONSTRAINT no_overlap EXCLUDE USING gist (room WITH =, during WITH &&));
ALTER TABLE app.accounts ADD CONSTRAINT accounts_note_short CHECK (length(note) < 5) NOT VALID;
CREATE TABLE public.teams (id int PRIMARY KEY, lead_id int);
CREATE TABLE public.members (id int PRIMARY KEY, team_id int REFERENCES public.teams (id));
ALTER TABLE public.teams ADD CONSTRAINT teams_lead_fk FOREIGN KEY (lead_id) REFERENCES public.members (id);
CREATE TABLE public.logs (id bigint, at date, msg text) PARTITION BY RANGE (at);
CREATE INDEX logs_at ON public.logs (at);
CREATE TABLE public.logs_2025 PARTITION OF public.logs FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE INDEX logs_2025_msg ON public.logs_2025 (msg);
ALTER TABLE public.logs_2025 ADD CONSTRAINT logs_2025_msg_present CHECK (msg <> '');
COMMENT ON POLICY "posts_select_published" ON public.posts IS 'anyone reads what is published';
COMMENT ON FUNCTION app.tier_of(bigint) IS 'tier lookup, by account';

