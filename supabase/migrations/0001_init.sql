-- Kevin Study OS — initial schema
-- Single-user college course tracker: syllabus parsing, task board, daily notes,
-- AI course-summary pipeline.
--
-- Safe to re-run against the same database: uses `if not exists` / `drop ... if
-- exists` guards throughout. Re-running does NOT silently swallow real errors —
-- e.g. a genuinely conflicting column type change would still fail loudly.
--
-- See ../README.md for the reasoning behind every non-obvious decision below.

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

-- gen_random_uuid() ships in pgcrypto. Supabase projects normally have this
-- enabled already, but we assert it explicitly so this migration also works
-- against a bare Postgres instance.
create extension if not exists pgcrypto;

-- ============================================================================
-- SHARED TRIGGER FUNCTION
-- ============================================================================

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- app_user
-- Single-row table by design. This app is single-user (Kevin); do not add
-- multi-tenant / org tables on top of this.
-- ============================================================================

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table app_user enable row level security;
drop policy if exists app_user_deny_all on app_user;
create policy app_user_deny_all on app_user for all using (false) with check (false);

-- ============================================================================
-- terms
-- Exists so "is this extracted date even in the right semester" is a
-- DB-checkable fact against term_start/term_end, not parser vibes.
-- ============================================================================

create table if not exists terms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  term_start date not null,
  term_end date not null,
  created_at timestamptz not null default now()
);

alter table terms enable row level security;
drop policy if exists terms_deny_all on terms;
create policy terms_deny_all on terms for all using (false) with check (false);

-- ============================================================================
-- courses
-- ============================================================================

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null references terms (id),
  code text not null,
  name text not null,
  instructor_name text,
  instructor_email text,

  -- Disambiguates "by-design percent course" from "by-omission missing data".
  grading_scheme text not null,

  -- The syllabus's OWN stated points total, if points-based. Never
  -- auto-derive this from summing grading_components — see README.
  points_total_stated numeric,

  -- The letter-grade scale's unit. Deliberately independent of
  -- grading_scheme: a course can grade components in points but publish its
  -- letter-grade cutoffs in percent (confirmed in real data). See README.
  grading_scale_unit text,
  grading_scale_cutoffs jsonb,

  needs_review boolean not null default false,
  review_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint courses_grading_scheme_check
    check (grading_scheme in ('percent', 'points')),
  constraint courses_grading_scale_unit_check
    check (grading_scale_unit in ('percent', 'points'))
);

drop trigger if exists trg_courses_updated_at on courses;
create trigger trg_courses_updated_at
  before update on courses
  for each row execute function set_updated_at();

alter table courses enable row level security;
drop policy if exists courses_deny_all on courses;
create policy courses_deny_all on courses for all using (false) with check (false);

-- ============================================================================
-- syllabus_uploads
-- ============================================================================

create table if not exists syllabus_uploads (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses (id),

  -- Private-bucket path. See storage section below for why the bucket is
  -- private (instructor personal contact info can appear on these documents).
  storage_path text not null,

  -- Re-upload of a byte-identical file is a no-op at the app layer (SELECT by
  -- (course_id, checksum) before INSERT). Intentionally NOT a DB unique
  -- constraint — see README.
  checksum text not null,

  term_detected text,

  -- Belongs on the WHOLE document, not per-item — a wrong-semester syllabus
  -- is a property of the file (e.g. QMX 210's own page-1 header says
  -- "Spring 2026" while enrolled in a Fall 2026 course). See README.
  term_mismatch boolean not null default false,

  status text not null default 'pending',

  created_at timestamptz not null default now(),

  constraint syllabus_uploads_status_check
    check (status in ('pending', 'parsed', 'quarantined', 'accepted'))
);

alter table syllabus_uploads enable row level security;
drop policy if exists syllabus_uploads_deny_all on syllabus_uploads;
create policy syllabus_uploads_deny_all on syllabus_uploads for all using (false) with check (false);

-- ============================================================================
-- grading_components
-- ============================================================================

create table if not exists grading_components (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses (id),

  -- Supports hierarchy, e.g. "Exams (2 @ 20% each) 40%" as a parent row with
  -- two child rows.
  parent_id uuid references grading_components (id),

  title text not null,
  weight_percent numeric,
  points_possible numeric,

  -- Explicitly approximate ("approximately 5 quizzes") — never treat as an
  -- exact count to validate against.
  expected_count integer,
  count_best_n integer,
  drop_lowest_n integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint grading_components_weight_or_points_check
    check (weight_percent is not null or points_possible is not null)
);

create index if not exists grading_components_course_id_idx
  on grading_components (course_id);
create index if not exists grading_components_parent_id_idx
  on grading_components (parent_id);

drop trigger if exists trg_grading_components_updated_at on grading_components;
create trigger trg_grading_components_updated_at
  before update on grading_components
  for each row execute function set_updated_at();

alter table grading_components enable row level security;
drop policy if exists grading_components_deny_all on grading_components;
create policy grading_components_deny_all on grading_components for all using (false) with check (false);

-- ============================================================================
-- syllabus_items
-- ============================================================================

create table if not exists syllabus_items (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses (id),
  upload_id uuid not null references syllabus_uploads (id),

  -- Required for the app to ever answer "what is this worth" — do not skip.
  grading_component_id uuid references grading_components (id),

  -- Item-level override when the syllabus states points directly on the item
  -- itself (e.g. "Chapter 1 Homework (30 pt)").
  points_possible numeric,

  title text not null,
  item_kind text not null,

  due_start date,
  due_end date,
  due_time time, -- plain TIME, not TIMETZ — no DST offset baggage

  -- For items with a distinct open/close window with DIFFERENT times on each
  -- end (e.g. "Test 1 Opens 9/25 8am, Closes 9/27 8pm"). due_time alone
  -- cannot hold both; the real deadline is available_until.
  available_from timestamptz,
  available_until timestamptz,

  date_precision text not null,

  -- Verbatim snippet the item was extracted from. Non-negotiable, never null.
  source_text text not null,

  -- Which part of the doc (schedule table vs. body prose). The SAME deadline
  -- can appear twice in different sections with different precision; used
  -- for dedup, not just content matching.
  source_section text,

  -- Hash of STABLE IDENTITY ONLY (course_id + normalized title +
  -- source_section). Must NOT include due dates — see README.
  content_hash text not null,

  -- For undated recurring items (e.g. "ten random pop quizzes") that can't be
  -- exploded into N rows because the count is approximate.
  is_recurring boolean not null default false,
  expected_count integer,
  completed_count integer,

  confidence numeric,
  needs_review boolean not null default false,
  is_user_edited boolean not null default false,

  -- Denormalized from the parent upload so the hot task-board query can
  -- filter via a plain column / partial-index predicate instead of a join.
  term_mismatch boolean not null default false,

  origin text not null default 'syllabus',

  -- Timestamp of completion, NOT a boolean. IS NULL means Upcoming.
  completed_at timestamptz,

  -- Single sortable value across mixed precision. Sorts range items at
  -- their EARLIEST possible date so Kevin prepares early rather than gets
  -- surprised. NULL (tba / external_ref / none) sorts last.
  sort_date date generated always as (coalesce(due_start, due_end)) stored,

  -- Soft-delete only. NEVER hard-delete a user-edited row on re-parse; if an
  -- item disappears from a new upload, mark it deleted/superseded so it
  -- surfaces in a "these items disappeared" review state.
  deleted_at timestamptz,
  superseded_by_upload_id uuid references syllabus_uploads (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint syllabus_items_item_kind_check check (item_kind in (
    'exam', 'final_exam', 'quiz', 'pop_quiz', 'homework', 'reading', 'project',
    'presentation', 'discussion', 'writing_lab', 'participation', 'course_eval',
    'lab_session', 'admin', 'break', 'other'
  )),

  constraint syllabus_items_date_precision_check check (date_precision in (
    'exact', 'range', 'tba', 'external_ref', 'none'
  )),

  constraint syllabus_items_origin_check
    check (origin in ('syllabus', 'manual')),

  -- The highest-value constraint in this schema: ties date_precision to
  -- which date columns must (or must not) be populated, so a bad extraction
  -- fails loud at INSERT instead of quietly showing Kevin a wrong date.
  constraint syllabus_items_precision_dates_check check (
    (date_precision = 'exact' and due_start is not null)
    or (date_precision = 'range' and due_start is not null and due_end is not null)
    or (date_precision in ('tba', 'external_ref', 'none') and due_start is null and due_end is null)
  ),

  constraint syllabus_items_date_order_check check (
    due_end is null or due_start is null or due_end >= due_start
  )
);

-- Combined all-courses Upcoming board.
create index if not exists syllabus_items_board_all_idx
  on syllabus_items (sort_date nulls last)
  where completed_at is null and deleted_at is null and term_mismatch is false;

-- Per-course filtered board.
create index if not exists syllabus_items_board_course_idx
  on syllabus_items (course_id, sort_date nulls last)
  where completed_at is null and deleted_at is null and term_mismatch is false;

-- Completed partition.
create index if not exists syllabus_items_completed_idx
  on syllabus_items (course_id, completed_at desc)
  where completed_at is not null;

create index if not exists syllabus_items_upload_id_idx
  on syllabus_items (upload_id);
create index if not exists syllabus_items_grading_component_id_idx
  on syllabus_items (grading_component_id);

drop trigger if exists trg_syllabus_items_updated_at on syllabus_items;
create trigger trg_syllabus_items_updated_at
  before update on syllabus_items
  for each row execute function set_updated_at();

alter table syllabus_items enable row level security;
drop policy if exists syllabus_items_deny_all on syllabus_items;
create policy syllabus_items_deny_all on syllabus_items for all using (false) with check (false);

-- ============================================================================
-- notes
-- ============================================================================

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses (id),

  -- The NY-local study date. Must be supplied by a server-side helper, never
  -- derived from client or VPS local time (server is UTC, Kevin is
  -- America/New_York, dev is IST). See README.
  note_date date not null,

  title text,
  body_md text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- No unique constraint on (course_id, note_date) — many notes per course per
-- day is intentional. Notes are a journal, not a slot.
create index if not exists notes_course_date_idx
  on notes (course_id, note_date desc, created_at desc);

drop trigger if exists trg_notes_updated_at on notes;
create trigger trg_notes_updated_at
  before update on notes
  for each row execute function set_updated_at();

alter table notes enable row level security;
drop policy if exists notes_deny_all on notes;
create policy notes_deny_all on notes for all using (false) with check (false);

-- ============================================================================
-- course_profiles
-- Immutable, versioned snapshots — a new row is written per regeneration
-- rather than an existing row being updated, so there is no updated_at here.
-- ============================================================================

create table if not exists course_profiles (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses (id),
  version integer not null,
  summary_md text not null,
  exam_topics jsonb not null,

  -- NOT a plain date — see README for why DATE would be a silent bug here.
  notes_through_at timestamptz not null,
  notes_through_note_id uuid references notes (id),

  model text not null,
  is_current boolean not null default false,

  created_at timestamptz not null default now(),

  constraint course_profiles_exam_topics_array_check
    check (jsonb_typeof(exam_topics) = 'array'),

  -- Required TOGETHER with the partial unique index below — see README for
  -- why both are needed, not either alone.
  constraint course_profiles_course_version_unique unique (course_id, version)
);

-- Enforces exactly one current version per course. Required together with
-- the UNIQUE(course_id, version) constraint above — see README.
create unique index if not exists course_profiles_one_current_idx
  on course_profiles (course_id)
  where is_current;

-- App-layer note (cannot be enforced in SQL): before starting a
-- regeneration, application code must take
-- pg_try_advisory_xact_lock(hashtext(course_id::text)) and skip the
-- regeneration if the lock isn't acquired — an in-flight regen will
-- supersede it. See README.

alter table course_profiles enable row level security;
drop policy if exists course_profiles_deny_all on course_profiles;
create policy course_profiles_deny_all on course_profiles for all using (false) with check (false);

-- ============================================================================
-- STORAGE: private "syllabi" bucket
-- Private because uploaded syllabi can contain instructors' personal contact
-- info (confirmed: one real syllabus in this project lists an instructor's
-- personal cell phone number). Express must issue signed URLs; never expose
-- a public bucket URL. See README.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('syllabi', 'syllabi', false)
on conflict (id) do nothing;
