-- SupaForge E2E test: TARGET (prod) database seed
-- Intentionally DRIFTED from source to create detectable issues.
--
-- Drift summary:
--   Schema:    Source has plans table, target has it too but may lack bio column (for schema check)
--   RLS:       Missing "posts_insert_own" (CVE-2025-48757), modified "users_select_own" USING
--   Cron:      Missing "weekly_digest", modified "cleanup_sessions" schedule (0 6 vs 0 3)
--   Webhooks:  Missing "on_payment_received", extra "on_invoice_sent", pg_net NOT installed
--   Storage:   Missing "avatars_insert" policy, bucket visibility + missing bucket via API
--   Realtime:  Missing supaforge_live publication (source publishes posts + payments)
--   Vault:     Missing "smtp_password" secret (source has api_key + smtp_password)
--   Extensions: pg_net NOT installed (source has it)
--   Data:      Missing "Enterprise" plan, different "Pro" price
--
-- Idempotent: safe to run multiple times on an existing instance.

-- === Extensions ===
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- DRIFT: pg_net intentionally NOT enabled (source has it)
DROP EXTENSION IF EXISTS pg_net;

-- === Tables (same as source) ===
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
  -- RLS: drop all policies that will be recreated (including any promoted ones)
  DROP POLICY IF EXISTS "users_select_own"       ON public.users;
  DROP POLICY IF EXISTS "users_update_own"       ON public.users;
  DROP POLICY IF EXISTS "posts_select_published" ON public.posts;
  DROP POLICY IF EXISTS "posts_select_own"       ON public.posts;
  DROP POLICY IF EXISTS "posts_insert_own"       ON public.posts;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS on_user_created   ON public.users;
  DROP TRIGGER IF EXISTS on_payment_received ON public.payments;
  DROP TRIGGER IF EXISTS on_invoice_sent   ON public.payments;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DELETE FROM supabase_functions.hooks
    WHERE hook_name IN ('on_user_created', 'on_payment_received', 'on_invoice_sent');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "avatars_select" ON storage.objects;
  DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Truncate plans so drifted data can be re-inserted cleanly
TRUNCATE public.plans RESTART IDENTITY CASCADE;

-- Remove any cron jobs that may have been promoted in a previous run,
-- restoring the drifted state (weekly_digest is MISSING in target).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'weekly_digest';

-- Remove any realtime publications that may have been promoted in a previous run
DO $$
BEGIN
  DROP PUBLICATION IF EXISTS supaforge_live;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Remove any vault secrets that may have been promoted (keep only api_key)
DO $$
BEGIN
  DELETE FROM vault.secrets WHERE name <> 'api_key';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
-- ===========================================================================

-- === RLS Policies (DRIFTED) ===
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- DRIFT: Modified USING expression (uses 'true' instead of auth.uid() = id)
CREATE POLICY "users_select_own"
    ON public.users FOR SELECT
    TO authenticated
    USING (true);

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

-- DRIFT: "posts_insert_own" is MISSING (CVE-2025-48757 pattern)

-- === Cron Jobs (DRIFTED) ===
-- DRIFT: cleanup_sessions at "0 6" instead of "0 3"
SELECT cron.schedule('cleanup_sessions', '0 6 * * *', $$SELECT 1$$);
-- DRIFT: "weekly_digest" is MISSING

-- === Webhooks (DRIFTED) ===
CREATE SCHEMA IF NOT EXISTS supabase_functions;
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
    id              BIGSERIAL PRIMARY KEY,
    hook_table_id   INTEGER NOT NULL DEFAULT 0,
    hook_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id      BIGINT
);

CREATE OR REPLACE FUNCTION supabase_functions.webhook_dispatch()
RETURNS TRIGGER AS $$
BEGIN
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- on_user_created (same as source)
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (1, 'on_user_created');
CREATE TRIGGER on_user_created
    AFTER INSERT ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.webhook_dispatch();

-- DRIFT: "on_payment_received" is MISSING

-- DRIFT: "on_invoice_sent" is EXTRA (not in source)
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (4, 'on_invoice_sent');
CREATE TRIGGER on_invoice_sent
    AFTER INSERT ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.webhook_dispatch();

-- === Storage Policies (DRIFTED) ===
CREATE POLICY "avatars_select"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'avatars');

-- DRIFT: "avatars_insert" policy is MISSING

-- === Reference Data (DRIFTED) ===
-- DRIFT: Missing "Enterprise" plan, "Pro" has different price (1900 vs 2900)
INSERT INTO public.plans (name, price, active) VALUES
    ('Free', 0, true),
    ('Pro', 1900, true)
ON CONFLICT DO NOTHING;

-- === Realtime Publications (DRIFTED) ===
-- DRIFT: supaforge_live publication is MISSING (source publishes posts + payments)

-- === Vault Secrets (DRIFTED) ===
-- DRIFT: Only api_key exists in target, smtp_password is MISSING
DO $$
BEGIN
  PERFORM vault.create_secret('test-api-key-123', 'api_key', 'External API key for integrations');
EXCEPTION
  WHEN undefined_function THEN NULL;     -- vault not available
  WHEN unique_violation THEN NULL;       -- already exists
  WHEN OTHERS THEN NULL;
END $$;
-- DRIFT: smtp_password secret intentionally NOT created
