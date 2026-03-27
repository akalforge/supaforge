-- SupaForge E2E test: SOURCE (dev) database seed
-- Runs against a REAL Supabase local instance (has auth.uid(), pg_cron, pg_net, storage schema).
--
-- Layers exercised: RLS, Cron, Webhooks, Storage policies.
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
  DROP TRIGGER IF EXISTS on_user_created    ON public.users;
  DROP TRIGGER IF EXISTS on_payment_received ON public.payments;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$
BEGIN
  DELETE FROM supabase_functions.hooks
    WHERE hook_name IN ('on_user_created', 'on_payment_received');
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

-- Noop trigger function for webhook testing
CREATE OR REPLACE FUNCTION supabase_functions.webhook_dispatch()
RETURNS TRIGGER AS $$
BEGIN
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- on_user_created webhook
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (1, 'on_user_created');
CREATE TRIGGER on_user_created
    AFTER INSERT ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.webhook_dispatch();

-- on_payment_received webhook
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES (3, 'on_payment_received');
CREATE TRIGGER on_payment_received
    AFTER INSERT ON public.payments
    FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.webhook_dispatch();

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
