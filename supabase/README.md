# Kevin Study OS — Supabase schema

This is Task 1 of a larger build: schema/migrations only, no application code.

- `migrations/0001_init.sql` — the full schema (8 tables, RLS, triggers, private storage bucket)
- `seed.sql` — Fall 2026 term + 5 course stub rows, sourced from the real syllabi reviewed while designing this schema
- This file — every non-obvious decision, so later engineers don't relitigate it

## How this was verified

No local Postgres/Supabase instance was available to run the migration against directly (no `psql`, no `docker`). Verification performed instead:

1. **Syntax**: both `migrations/0001_init.sql` and `seed.sql` were parsed with `pglast` (a Python binding to the real `libpg_query` Postgres parser used by tools like `pgFormatter`/`pg_query`). Both parse cleanly with zero errors.
2. **Semantic manual review**: table creation order was checked against every foreign key so no table references one that doesn't exist yet (`terms` → `courses` → `syllabus_uploads`/`grading_components` → `syllabus_items` → `notes` → `course_profiles`); every `check` constraint was re-read against the acceptance criteria; every index's `where` clause was checked to reference only columns of its own table.
3. Not verified against a live engine: whether `storage.buckets` actually has columns `(id, name, public)` in the exact Supabase version you deploy to. This is standard current Supabase schema, but the `insert into storage.buckets` statement will only succeed inside an actual Supabase project (or local Supabase CLI stack), never against bare vanilla Postgres — the `storage` schema doesn't exist there. Everything else in `0001_init.sql` applies cleanly to bare Postgres 14+ as well as Supabase.

Run this yourself before trusting it in production: `supabase db reset` (applies migrations + seed against the local Supabase CLI stack) or `psql -f migrations/0001_init.sql -f seed.sql` against a scratch database.

## Design decisions

### 1. Grading rework: `grading_scheme` + `grading_scale_unit` + component hierarchy + drop-rules

Two independent axes exist on every course, and they are **not the same axis**:

- `grading_scheme` (`percent` | `points`) — how the *grading components* are weighted. This disambiguates "by design" (course really is percent-based) from "by omission" (parser just failed to find points). All 5 real syllabi split cleanly: MGT 301 and QMX 210 are percent; ACCT 201, PHIL 104, and MKT 301 are points.
- `grading_scale_unit` (`percent` | `points`) — what unit the **letter-grade cutoffs table** is published in. This is independently variable from `grading_scheme`. Confirmed in real data: PHIL 104 and MKT 301 are both `points`-scheme courses whose published grading scale is nonetheless in **percent** ("A = 94-100%"), while ACCT 201's grading scale is in **raw points** ("A = 900-1000"). A schema that assumed scale-unit always equals scheme-unit would misrender every one of PHIL 104 and MKT 301's grade cutoffs.

`points_total_stated` stores the syllabus's own stated total (e.g. ACCT 201's "Total 1000", MKT 301's "Total Possible Points 1000 points") and is **never auto-derived** by summing `grading_components`. Real evidence for why: ACCT 201 lists 11 individual homework line items in its schedule table (Chapter 1 Homework 30pt, Chapter 2 40pt, Chapter 3 40pt, Chapter 4 20pt, Chapter 5 20pt, Chapter 6 20pt, Chapter 7 10pt, Chapter 8 10pt, Chapter 9 10pt, Chapter 10 10pt, Chapter 12 10pt) which **sum to 220 points**, against a stated Homework *component* total of 200 points in the grading breakdown. The syllabus separately states a drop rule ("I will drop either one 20 pt homework assignment or two 10 pt homework assignments") that would reconcile this — but that reconciliation is a runtime/app-layer judgment call (which assignment gets dropped, whether the drop is even correctly stated), not something this migration should silently compute and bake in as truth. Store what's stated (`points_total_stated`), compute the derived sum separately in the app, and surface any delta to Kevin rather than "fixing" it in the data layer.

`grading_components` supports a parent/child hierarchy (`parent_id`) for lines like "Exams (2 @ 20% each) 40%" that are one parent row with two child rows, plus `expected_count` (explicitly approximate — "approximately 5 quizzes" is not a promise of exactly 5), `count_best_n` (e.g. QMX 210's "best 4 quiz grades used"), and `drop_lowest_n` (e.g. ACCT 201's SmartBook "I will drop the assignment on which you score the lowest"). These are separate, composable knobs because real syllabi mix them independently per component — they are not alternate phrasings of the same rule.

### 2. `term_mismatch` belongs on `syllabus_uploads`, not on individual `syllabus_items`

A wrong-semester syllabus is a property of the **document**, not of any one extracted date. Confirmed in real data: QMX 210's own page-1 header literally reads "Spring 2026" (not just its schedule table happening to contain Spring dates) while the course is being taught in the Fall 2026 term window (2026-08-31 to 2026-12-18). Every date in that document is suspect once the header itself is wrong — flagging item-by-item would require re-deriving the same conclusion N times and could disagree with itself if some individual dates happened to coincidentally fall inside the term window.

`syllabus_uploads.term_mismatch` is set once, at the document level, when the majority of extracted dates fall outside `courses.term_id`'s `[term_start, term_end]` window (an app-layer check against the `terms` table — this is exactly why `terms` exists as a real table instead of a hardcoded constant). `syllabus_items.term_mismatch` is a **denormalized copy** of that same flag, propagated onto every item from that upload, purely so the hot task-board query (`WHERE term_mismatch is false`) can filter with a plain column / partial index instead of joining out to `syllabus_uploads` on every board load. The source of truth is still the upload; the item-level column is a read-optimization, not a second independent judgment.

### 3. `course_profiles.notes_through_at` is `timestamptz`, not `date`

`notes` has **no unique constraint on `(course_id, note_date)`** by design (see §5) — Kevin can and will add multiple notes to the same course on the same day. If the AI-summary watermark were a plain `date`, it would only ever say "summarized through Sept 6th" — the moment a second note lands on Sept 6th *after* a profile was generated from the first one, the watermark can't distinguish "already covered" from "not yet covered" because both notes share the same date. The regeneration trigger would either silently skip the second same-day note forever, or re-summarize the first note's content redundantly forever — either way, a bug that never throws an error and never gets noticed. `timestamptz` (backed by `notes_through_note_id` pointing at the actual last-seen note) gives sub-day precision, so a debounced regeneration correctly knows exactly which notes it has and hasn't seen yet, regardless of how many land on the same calendar day.

### 4. `course_profiles`: `UNIQUE(course_id, version)` + partial unique index on `(course_id) WHERE is_current` — both required, not either alone

These two constraints protect two different invariants, and dropping either one reopens a race:

- `UNIQUE(course_id, version)` guarantees no two rows for the same course can ever claim the same version number. Without it, a race between two debounced regenerations (two notes landing close together, each independently triggering a regen) could produce two rows both claiming version 7, corrupting the version history.
- The partial unique index `on course_profiles (course_id) where is_current` guarantees **exactly one** current row per course at all times — not zero, not two. Without it, two concurrent regenerations could each successfully flip their own new row to `is_current = true` without ever colliding, leaving two "current" profiles (which one does the app show?), or a buggy update path could flip the old row off without ever successfully flipping a new row on, leaving zero.

Together, they make concurrent regeneration safe purely through row-level constraint checks, without needing any additional application-side locking to be *correct* (though locking is still needed to be *efficient* — see below). Neither constraint alone is sufficient: version-uniqueness alone doesn't stop two "current" rows; current-uniqueness alone doesn't stop a version collision.

**App-layer requirement (cannot be enforced in SQL, noted here so it isn't lost):** before starting a regeneration, application code must acquire `pg_try_advisory_xact_lock(hashtext(course_id::text))` and skip the regeneration entirely if the lock isn't acquired — an in-flight regen for that course will supersede it. This is purely a concurrency/efficiency optimization (avoids wasted duplicate LLM calls that would fail their unique-version insert anyway); the two SQL constraints above are what actually guarantees correctness even if this advisory lock is ever forgotten or buggy.

### 5. `notes`: no unique constraint on `(course_id, note_date)`

Notes are a journal, not a slot. Kevin adds notes throughout a day as he studies; there is no reason to cap him at one note per course per day, and doing so would force awkward append-to-existing-note logic in the app for no benefit. `note_date` exists purely as a grouping/sort key (indexed via `(course_id, note_date desc, created_at desc)`), not as a uniqueness key.

`note_date` must be computed server-side (Express), from a server-side "what day is it in America/New_York" helper — **never** from `new Date()` on the client (unknown timezone) or from the VPS's local clock (the VPS runs UTC; Kevin is in America/New_York; the dev machine is IST). A naive `CURRENT_DATE` default at the DB layer would be wrong too, since the DB's session timezone isn't guaranteed to be America/New_York either. This migration intentionally leaves `note_date` with no default — it must always be supplied explicitly by the caller.

### 6. Storage: private `syllabi` bucket

The bucket is created with `public = false`. Confirmed real evidence for why: QMX 210's syllabus lists the instructor's phone number explicitly marked "(cell)" — a personal cell phone, not an office line. Uploaded syllabi are the students' own copies of a real document that can contain an instructor's home/cell contact info, meeting locations, and other information the instructor did not necessarily intend for a public, unauthenticated CDN URL. Express (the only thing holding the service-role key) must issue **signed URLs** with a short expiry whenever the UI needs to display or re-parse a syllabus; the bucket itself must never be flipped to `public = true`, and no route should ever construct or return the bucket's public object URL directly.

### 7. Row-Level Security

- **Every table in this migration has `ENABLE ROW LEVEL SECURITY`, each with one explicit `FOR ALL USING (false) WITH CHECK (false)` deny-all policy.** RLS-enabled-with-zero-policies already denies `anon`/`authenticated` by default; the explicit deny-all policy is redundant on top of that, written anyway purely for self-documentation — so a future reader sees an explicit, visible "nothing is allowed here" instead of having to know the zero-policies-means-deny-all rule.
- **These policies do not protect the Express backend.** Express uses the Supabase **service-role key**, which carries the `BYPASSRLS` role attribute and ignores every RLS policy on every table unconditionally. The real thing these policies protect against is (a) the anon/publishable key leaking (e.g. into a client bundle) and someone hitting these tables directly over PostgREST, or (b) a future table being created and reachable via the auto-generated PostgREST API before anyone remembers to lock it down.
- **`FORCE ROW LEVEL SECURITY` is deliberately NOT used.** `FORCE RLS` only changes behavior for the table owner; it does not affect a role with `BYPASSRLS` (which `service_role` has). Adding it here would buy nothing and could create false confidence that it adds a layer of protection against the service-role path — it does not.
- **Checklist item for every future migration: "did you enable RLS on the new table?"** Nothing in Postgres enforces this automatically; a new table with no `ENABLE ROW LEVEL SECURITY` call is reachable through PostgREST with the anon key by default. This needs to be a manual review step on every migration going forward, not just this one.

### 8. General conventions

- `pgcrypto` is explicitly enabled (`CREATE EXTENSION IF NOT EXISTS pgcrypto`) so `gen_random_uuid()` is available even on bare Postgres, not just Supabase (which normally ships it enabled already).
- Every table has `created_at timestamptz not null default now()`. Every **mutable** table (`courses`, `grading_components`, `syllabus_items`, `notes`) additionally has `updated_at timestamptz not null default now()`, maintained by one shared trigger function `set_updated_at()` attached per-table via `BEFORE UPDATE` triggers — not reimplemented per table.
- `app_user`, `terms`, and `syllabus_uploads` intentionally have **no** `updated_at` — they match the ratified spec exactly, which does not list one for these tables (uploads are effectively write-once-then-status-transitions; a future task can add `updated_at` there if upload status transitions need to be timestamped, but that wasn't asked for here).
- `course_profiles` intentionally has **no** `updated_at` — see the table's own comment: it's an append-only, versioned log (`UNIQUE(course_id, version)`), not a row that gets mutated in place.
- All `id` columns are `uuid default gen_random_uuid()`.
- The migration is safe to re-run against the same database: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, and `ON CONFLICT (id) DO NOTHING` on the storage bucket insert. This does **not** silently swallow real errors — e.g. re-running after a genuinely incompatible manual schema edit (say, someone changed a column's type by hand) would still fail loudly on the next `CREATE TABLE IF NOT EXISTS` mismatch or constraint violation, exactly as it should.

### 9. Foreign key delete behavior

No FK in this migration specifies `ON DELETE CASCADE`/`SET NULL`/etc. — they all use Postgres's default (`NO ACTION`, i.e. block the delete if a dependent row exists). This is deliberate, not an oversight: every table with a `deleted_at` column (`courses`, `syllabus_items`, `notes`) is designed around **soft deletes**, so hard-deleting a parent row (a course, an upload) is not expected to be a normal code path at all in this task's scope. Choosing a cascade behavior for a code path the app isn't supposed to exercise would be guessing at a future requirement instead of building what was asked. If a real "permanently purge a course and everything under it" feature is ever built, that's the moment to deliberately choose delete behavior per-table — not now.

### 10. `syllabus_uploads.checksum` — no DB-level unique constraint

The ratified spec describes the checksum column's purpose ("re-upload of byte-identical file is a no-op") but does not list a unique constraint for it, unlike every other invariant in this schema (which got an explicit `CHECK` or index). This is treated as intentional: the no-op behavior is an **app-layer** lookup (`SELECT ... WHERE course_id = $1 AND checksum = $2` before `INSERT`), not a hard database invariant — a DB-level unique constraint would also block legitimate cases the spec doesn't rule out, such as deliberately re-processing the same file after a parser bug fix. No index was added here beyond what's specified, per "build exactly this."

## Example query: the combined Upcoming task board

Demonstrates `sort_date` correctly interleaving `exact`/`range` items by their earliest possible date, with `tba`/`external_ref`/`none` (all `sort_date IS NULL`) sorted last via `NULLS LAST`. This is the query the partial index `syllabus_items_board_all_idx` (`(sort_date nulls last) where completed_at is null and deleted_at is null and term_mismatch is false`) exists to serve — not benchmarked against a live database, since there is no dev DB to `EXPLAIN` against yet; documented here as intent, not a measured-fast query.

```sql
-- All-courses combined Upcoming board
select
  si.id,
  si.title,
  si.item_kind,
  si.date_precision,
  si.sort_date,       -- exact/range items: earliest possible date; tba/external_ref/none: NULL
  si.due_start,
  si.due_end,
  si.due_time,
  si.available_until,
  c.code as course_code,
  c.name as course_name
from syllabus_items si
join courses c on c.id = si.course_id
where si.completed_at is null
  and si.deleted_at is null
  and si.term_mismatch is false
order by si.sort_date asc nulls last, si.created_at asc;

-- Same, filtered to one course (served by syllabus_items_board_course_idx)
select
  si.id, si.title, si.item_kind, si.date_precision, si.sort_date,
  si.due_start, si.due_end, si.due_time, si.available_until
from syllabus_items si
where si.course_id = $1
  and si.completed_at is null
  and si.deleted_at is null
  and si.term_mismatch is false
order by si.sort_date asc nulls last, si.created_at asc;

-- Completed partition for one course (served by syllabus_items_completed_idx)
select id, title, item_kind, completed_at
from syllabus_items
where course_id = $1
  and completed_at is not null
order by completed_at desc;
```

## Out of scope (explicitly, per task boundaries)

No Express/API code, no React/UI code. No flashcards, no study-session scheduling tables, no voice transcription storage beyond what's already here, and no multi-user/org tables — `app_user` having exactly one row is intentional and correct for this app.
