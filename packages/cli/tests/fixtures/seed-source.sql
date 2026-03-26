-- SupaForge integration test: SOURCE database seed
-- This creates a Supabase-style schema with RLS, cron, and webhook fixtures.

-- === Extensions ===
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA extensions;

-- === Schema: tables ===
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
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.plans (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN DEFAULT true
);

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
-- pg_cron may not be available in base Postgres; we create the schema manually
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
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
CREATE SCHEMA IF NOT EXISTS supabase_functions;
CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
    id              BIGSERIAL PRIMARY KEY,
    hook_table_id   INTEGER NOT NULL DEFAULT 0,
    hook_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id      BIGINT
);

INSERT INTO supabase_functions.hooks (hook_table_id, hook_name) VALUES
    (1, 'on_user_created'),
    (2, 'on_post_published'),
    (3, 'on_payment_received');

-- === Reference data (plans) ===
INSERT INTO public.plans (name, price, active) VALUES
    ('Free', 0, true),
    ('Pro', 2900, true),
    ('Enterprise', 9900, true);
