-- SupaForge integration test: TARGET database seed
-- This intentionally DIFFERS from the source to create detectable drift.
--
-- IDEMPOTENT: Safe to re-run — drops and recreates all objects.
--
-- Differences from source:
-- 1. Schema: Missing "bio" column on users table (detected by @dbdiff/cli)
-- 2. Schema: Missing "current_mood" column on users table (enum-typed column)
-- 3. Schema: Missing idx_posts_published partial index (detected by @dbdiff/cli)
-- 4. Enum: Missing "mood" enum type entirely
-- 5. Enum: "post_status" missing 'archived' value (ALTER TYPE ... ADD VALUE)
-- 6. RLS: Missing "posts_insert_own" policy (CVE-2025-48757 pattern)
-- 7. RLS: Modified "users_select_own" USING expression (auth.uid()=id → true)
-- 8. Cron: Missing "weekly_digest" job, modified "cleanup_sessions" schedule
-- 9. Webhooks: Missing "on_payment_received", extra "on_invoice_sent"
-- 10. Reference data: Missing "Enterprise" plan, different "Pro" price
-- 11. Storage: Missing "storage_objects_insert_own" policy, modified select policy

BEGIN;

-- === Reset (idempotent) ===
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO PUBLIC;

DROP SCHEMA IF EXISTS cron CASCADE;
DROP SCHEMA IF EXISTS supabase_functions CASCADE;
DROP SCHEMA IF EXISTS storage CASCADE;
DROP SCHEMA IF EXISTS vault CASCADE;

-- === Extensions ===
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;
-- NOTE: pg_trgm intentionally NOT installed in target (drift)

-- === Enum types (DRIFTED) ===
-- DRIFT: "mood" enum is MISSING entirely
-- DRIFT: "post_status" exists but is missing the 'archived' value
CREATE TYPE public.post_status AS ENUM ('draft', 'published');

-- === Supabase-compatibility stubs (plain Postgres) ===
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT '00000000-0000-0000-0000-000000000000'::uuid;
$$ LANGUAGE sql STABLE;

DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- === Schema: same tables as source (but missing bio column + index) ===
CREATE TABLE public.users (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    full_name   TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.posts (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    body        TEXT,
    published   BOOLEAN DEFAULT false,
    status      public.post_status DEFAULT 'draft',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.plans (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN DEFAULT true
);

-- NOTE: idx_posts_published partial index intentionally MISSING (drift #2)

-- === Trigger: auto-update updated_at ===
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_posts_updated_at
    BEFORE UPDATE ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

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

-- DRIFT: "posts_insert_own" policy is MISSING (CVE-2025-48757 pattern)

-- === Cron Jobs (DRIFTED) ===
CREATE SCHEMA cron;
CREATE TABLE cron.job (
    jobid       BIGSERIAL PRIMARY KEY,
    schedule    TEXT NOT NULL,
    command     TEXT NOT NULL,
    nodename    TEXT NOT NULL DEFAULT 'localhost',
    nodeport    INTEGER NOT NULL DEFAULT 5432,
    database    TEXT NOT NULL DEFAULT 'postgres',
    username    TEXT NOT NULL DEFAULT 'postgres',
    active      BOOLEAN NOT NULL DEFAULT true,
    jobname     TEXT
);

-- DRIFT: "cleanup_sessions" has different schedule (0 6 instead of 0 3)
-- DRIFT: "weekly_digest" is MISSING
INSERT INTO cron.job (schedule, command, jobname) VALUES
    ('0 6 * * *', 'SELECT cleanup_old_sessions()', 'cleanup_sessions'),
    ('*/15 * * * *', 'SELECT refresh_materialized_views()', 'refresh_views');

-- === Webhooks (DRIFTED) ===
CREATE SCHEMA supabase_functions;
CREATE TABLE supabase_functions.hooks (
    id              BIGSERIAL PRIMARY KEY,
    hook_table_id   INTEGER NOT NULL DEFAULT 0,
    hook_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id      BIGINT
);

-- DRIFT: "on_payment_received" is MISSING, "on_invoice_sent" is EXTRA
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES
    (1, 'on_user_created'),
    (2, 'on_post_published'),
    (4, 'on_invoice_sent');

-- === Storage (DRIFTED) ===
CREATE SCHEMA storage;
CREATE TABLE storage.objects (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    bucket_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    owner       UUID,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE storage.buckets (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    public              BOOLEAN DEFAULT false,
    file_size_limit     BIGINT,
    allowed_mime_types  TEXT[],
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- DRIFT: Modified — uses 'true' instead of auth.uid() = owner
CREATE POLICY "storage_objects_select_own"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (true);

-- DRIFT: "storage_objects_insert_own" policy is MISSING

-- === Reference data (DRIFTED) ===
-- DRIFT: Missing "Enterprise" plan, "Pro" has different price
INSERT INTO public.plans (name, price, active) VALUES
    ('Free', 0, true),
    ('Pro', 1900, true);

-- NOTE: supaforge_live publication intentionally NOT created (drift)

-- === Vault (DRIFTED) ===
-- DRIFT: smtp_password secret is MISSING; api_key exists (with different encrypted value)
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name        TEXT,
    description TEXT,
    secret      TEXT NOT NULL,
    unique_name TEXT,
    nonce       TEXT,
    key_id      UUID,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO vault.secrets (name, description, secret, unique_name) VALUES
    ('api_key', 'Main API key', 'encrypted_api_key_tgt', 'api_key');

COMMIT;
