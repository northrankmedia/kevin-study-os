-- Kevin Study OS — login rate-limit storage
--
-- Backs the login endpoint's rate limiter (api/src/lib/auth.js: 5 failed
-- attempts / 15 minutes / IP) with a real table instead of an in-memory Map.
-- A plain process-local Map cannot be relied on once this API runs as
-- Vercel serverless functions: separate requests for the same IP can be
-- handled by different, memory-isolated function instances, so a Map would
-- silently under-count (or lose track of) attempts across requests.
--
-- Append-only, same spirit as `course_profiles`: a failed login attempt is a
-- fact that happened and is never mutated in place, just recorded and later
-- deleted (never updated). One row per failed attempt; "rate limited" is
-- "5+ rows for this IP within the last 15 minutes" — see auth.js for the
-- exact query.
--
-- Safe to re-run against the same database: `if not exists` guards
-- throughout, same convention as 0001_init.sql / 0002_voice_notes.sql.

create table if not exists login_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempted_at timestamptz not null default now()
);

-- Every query auth.js makes against this table filters by ip and orders/
-- bounds by attempted_at — a per-IP recency index covers both the count
-- ("how many rows for this IP in the last 15 minutes") and the prune
-- ("delete this IP's rows older than the window") queries.
create index if not exists login_attempts_ip_attempted_at_idx
  on login_attempts (ip, attempted_at desc);

alter table login_attempts enable row level security;
drop policy if exists login_attempts_deny_all on login_attempts;
create policy login_attempts_deny_all on login_attempts for all using (false) with check (false);
