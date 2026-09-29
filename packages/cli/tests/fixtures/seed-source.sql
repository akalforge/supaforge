-- SupaForge integration test: SOURCE database seed
-- Creates a Supabase-style schema with RLS, cron, webhook, and storage fixtures.
-- Uses plain Postgres with Supabase-compatibility stubs.
--
-- IDEMPOTENT: Safe to re-run — drops and recreates all objects.

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
CREATE EXTENSION IF NOT EXISTS "pg_trgm" SCHEMA public;

-- === Enum types (source has enums that target lacks) ===
CREATE TYPE public.mood AS ENUM ('happy', 'sad', 'neutral');
CREATE TYPE public.post_status AS ENUM ('draft', 'published', 'archived');

-- === Supabase-compatibility stubs (plain Postgres) ===
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT '00000000-0000-0000-0000-000000000000'::uuid;
$$ LANGUAGE sql STABLE;

DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- === Schema: tables ===
CREATE TABLE public.users (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    full_name   TEXT,
    bio         TEXT,
    avatar_url  TEXT,
    current_mood public.mood DEFAULT 'neutral',
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

-- === Indexes (source has a partial index that target lacks) ===
CREATE INDEX idx_posts_published ON public.posts (created_at) WHERE published = true;

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

-- === Cron Jobs ===
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

INSERT INTO cron.job (schedule, command, jobname) VALUES
    ('0 3 * * *', 'SELECT cleanup_old_sessions()', 'cleanup_sessions'),
    ('*/15 * * * *', 'SELECT refresh_materialized_views()', 'refresh_views'),
    ('0 0 * * 0', 'SELECT weekly_digest()', 'weekly_digest');

-- === Webhooks ===
CREATE SCHEMA supabase_functions;
CREATE TABLE supabase_functions.hooks (
    id              BIGSERIAL PRIMARY KEY,
    hook_table_id   INTEGER NOT NULL DEFAULT 0,
    hook_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id      BIGINT
);

-- Invocation history. `on_legacy_deleted` is the case that matters: its
-- webhook was deleted, but the log of what it once did outlives it. Reading
-- this table reported it as missing from the target, with no usable fix.
INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES
    (1, 'on_user_created'),
    (2, 'on_post_published'),
    (3, 'on_payment_received'),
    (9, 'on_legacy_deleted');

-- Supabase's own webhook trigger function. A stub here: the check identifies a
-- webhook by the trigger calling supabase_functions.http_request, and never
-- needs it to run.
CREATE OR REPLACE FUNCTION supabase_functions.http_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RETURN NEW;
END;
$$;

-- Webhooks are triggers, and their configuration — URL, method, headers,
-- params, timeout — lives in the trigger's arguments. The check used to read
-- the hooks table above, which is the log of invocations and carries none of
-- that (issue #77). The log rows are kept deliberately: they must not affect
-- the result.
CREATE TRIGGER on_user_created AFTER INSERT ON public.users FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/users', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
CREATE TRIGGER on_post_published AFTER INSERT ON public.posts FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/posts', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
CREATE TRIGGER on_payment_received AFTER INSERT ON public.plans FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/payments', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
CREATE TRIGGER on_row_touched AFTER UPDATE ON public.users FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/touch/users', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
CREATE TRIGGER on_row_touched AFTER UPDATE ON public.posts FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request(
        'https://example.invalid/touch/posts', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');

-- === Storage (RLS-testable without Supabase API) ===
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

CREATE POLICY "storage_objects_select_own"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (auth.uid() = owner);

CREATE POLICY "storage_objects_insert_own"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = owner);

-- === Reference data (plans) ===
INSERT INTO public.plans (name, price, active) VALUES
    ('Free', 0, true),
    ('Pro', 2900, true),
    ('Enterprise', 9900, true);

-- === Realtime Publications ===
DROP PUBLICATION IF EXISTS supaforge_live;
CREATE PUBLICATION supaforge_live FOR TABLE public.users, public.posts;

-- === Vault Secrets ===
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
    ('smtp_password', 'SMTP credentials', 'encrypted_smtp_src', 'smtp_password'),
    ('api_key', 'Main API key', 'encrypted_api_key_src', 'api_key');

COMMIT;
