-- SupaForge E2E test: TARGET (prod) database seed
-- Intentionally DRIFTED from source to create detectable issues.
--
-- Drift summary:
--   RLS:      Missing "posts_insert_own" (CVE-2025-48757), modified "users_select_own" USING
--   Cron:     Missing "weekly_digest", modified "cleanup_sessions" schedule (0 6 vs 0 3)
--   Webhooks: Missing "on_payment_received", extra "on_invoice_sent", pg_net NOT installed
--   Storage:  Missing "avatars_insert" policy, bucket visibility + missing bucket via API

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
