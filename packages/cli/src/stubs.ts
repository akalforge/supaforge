/**
 * Minimal Supabase schema stubs for local development.
 *
 * When cloning a Supabase-hosted database to local PostgreSQL,
 * internal schemas (auth, storage, extensions, etc.) are excluded
 * from pg_dump because they contain Supabase-managed objects.
 *
 * However, public schema objects often _reference_ those schemas:
 *   - FK constraints  → auth.users(id)
 *   - RLS policies    → auth.uid(), auth.role(), auth.jwt()
 *   - Storage queries → storage.buckets
 *
 * These stubs provide minimal table/function definitions so that
 * pg_restore can successfully create dependent objects.
 */

/**
 * Minimal auth schema stub.
 *
 * Provides:
 *   - auth.users table  (just `id uuid PK`) — for FK constraints
 *   - auth.uid()        — for RLS policies
 *   - auth.role()       — for RLS policies
 *   - auth.jwt()        — for RLS policies
 *   - auth.email()      — for RLS policies
 */
export const AUTH_STUBS_SQL = `
-- Minimal auth schema for FK constraints and RLS policies
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub',
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::uuid $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  )::text $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(
    nullif(current_setting('request.jwt.claims', true), ''),
    nullif(current_setting('request.jwt.claim', true), ''),
    '{}'
  )::jsonb $$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email',
    nullif(current_setting('request.jwt.claim.email', true), '')
  )::text $$;
`

/**
 * Minimal storage schema stub.
 *
 * Provides storage.buckets so the storage check can query it
 * without crashing with "relation does not exist".
 */
export const STORAGE_STUBS_SQL = `
-- Minimal storage schema for storage check compatibility
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb
);
`

/**
 * Combined stubs to run on a freshly created local database
 * BEFORE pg_restore, so auth-dependent objects can be restored.
 */
export const CLONE_STUBS_SQL = [AUTH_STUBS_SQL, STORAGE_STUBS_SQL].join('\n')
