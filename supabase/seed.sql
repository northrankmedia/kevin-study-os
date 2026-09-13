-- Kevin Study OS — seed data
-- Fall 2026 term + 5 course stub rows, matching the real Fall 2026 syllabi
-- (MGT 301, ACCT 201, PHIL 104, MKT 301, QMX 210) reviewed while designing
-- this schema. grading_components and syllabus_items are intentionally left
-- empty — they get populated by the extraction pipeline (a later task), not
-- seeded here.
--
-- Deterministic ids are used (not gen_random_uuid()) purely so this seed is
-- re-runnable and human-diffable; there is no significance to the literal
-- UUID values themselves.
--
-- Note: app_user is NOT seeded here. Seeding a real account requires a
-- properly generated password hash, which is not something to hardcode into
-- a seed file. Provision app_user via the app's own setup flow (or a manual
-- insert with a real bcrypt/argon2 hash) after this migration + seed run.

insert into terms (id, name, term_start, term_end)
values (
  '11111111-1111-1111-1111-111111111111',
  'Fall 2026',
  '2026-08-31',
  '2026-12-18'
)
on conflict (id) do nothing;

-- MGT 301 — Management & Organizational Behavior — percent scheme.
-- Grading breakdown in the real syllabus sums to a clean 100%.
insert into courses (
  id, term_id, code, name, instructor_name, instructor_email,
  grading_scheme, points_total_stated, grading_scale_unit, grading_scale_cutoffs
)
values (
  '22222222-2222-2222-2222-222222222201',
  '11111111-1111-1111-1111-111111111111',
  'MGT 301',
  'Management & Organizational Behavior',
  'John B. Stevens',
  'jstevens@sbu.edu',
  'percent',
  null,
  'percent',
  '[
    {"grade": "A",  "min": 93, "max": 100},
    {"grade": "A-", "min": 90, "max": 92},
    {"grade": "B+", "min": 87, "max": 89},
    {"grade": "B",  "min": 83, "max": 86},
    {"grade": "B-", "min": 80, "max": 82},
    {"grade": "C+", "min": 77, "max": 79},
    {"grade": "C",  "min": 73, "max": 76},
    {"grade": "C-", "min": 70, "max": 72},
    {"grade": "D+", "min": 67, "max": 69},
    {"grade": "D",  "min": 63, "max": 66},
    {"grade": "D-", "min": 60, "max": 62},
    {"grade": "F",  "min": 0,  "max": 59}
  ]'::jsonb
)
on conflict (id) do nothing;

-- ACCT 201 — Introduction to Financial Accounting — points scheme.
-- Stated total is 1000 points. Grading scale cutoffs are in RAW POINTS
-- (e.g. "A = 900-1000"), not percent — grading_scale_unit reflects that.
-- Real syllabus also lists no minus grades (no A-/B-/C-/D-) — stored as-is,
-- not filled in.
insert into courses (
  id, term_id, code, name, instructor_name, instructor_email,
  grading_scheme, points_total_stated, grading_scale_unit, grading_scale_cutoffs
)
values (
  '22222222-2222-2222-2222-222222222202',
  '11111111-1111-1111-1111-111111111111',
  'ACCT 201',
  'Introduction to Financial Accounting',
  'Dr. Samantha Schachner',
  'sschachn@sbu.edu',
  'points',
  1000,
  'points',
  '[
    {"grade": "A",  "min": 900, "max": 1000},
    {"grade": "B+", "min": 870, "max": 899},
    {"grade": "B",  "min": 800, "max": 869},
    {"grade": "C+", "min": 770, "max": 799},
    {"grade": "C",  "min": 700, "max": 769},
    {"grade": "D+", "min": 670, "max": 699},
    {"grade": "D",  "min": 600, "max": 669},
    {"grade": "F",  "min": 0,   "max": 599}
  ]'::jsonb
)
on conflict (id) do nothing;

-- PHIL 104 — Introduction to Ethics — points scheme.
-- Real syllabus never states a total points value anywhere (assignments sum
-- to 229 across Attendance/Participation/Lingering Questions/Quizzes/Writing
-- Labs/Course Eval/Midterm/Final, plus ~5% extra credit, with no "Total"
-- line) — points_total_stated is left null, not back-computed.
-- Grading scale is published in PERCENT even though components are
-- points-based — grading_scale_unit intentionally differs from
-- grading_scheme here.
insert into courses (
  id, term_id, code, name, instructor_name, instructor_email,
  grading_scheme, points_total_stated, grading_scale_unit, grading_scale_cutoffs
)
values (
  '22222222-2222-2222-2222-222222222203',
  '11111111-1111-1111-1111-111111111111',
  'PHIL 104',
  'Introduction to Ethics',
  'Dr. Gillham',
  'agillham@sbu.edu',
  'points',
  null,
  'percent',
  '[
    {"grade": "A",  "min": 94, "max": 100},
    {"grade": "A-", "min": 90, "max": 93},
    {"grade": "B+", "min": 87, "max": 89},
    {"grade": "B",  "min": 84, "max": 86},
    {"grade": "B-", "min": 80, "max": 83},
    {"grade": "C+", "min": 77, "max": 79},
    {"grade": "C",  "min": 74, "max": 76},
    {"grade": "C-", "min": 70, "max": 73},
    {"grade": "D+", "min": 67, "max": 69},
    {"grade": "D",  "min": 64, "max": 66},
    {"grade": "D-", "min": 60, "max": 63},
    {"grade": "F",  "min": 0,  "max": 59}
  ]'::jsonb
)
on conflict (id) do nothing;

-- MKT 301 — Principles of Marketing — points scheme.
-- Stated total is 1000 points ("Total Possible Points 1000 points"), and,
-- like PHIL 104, the published letter-grade scale is in PERCENT rather than
-- points.
insert into courses (
  id, term_id, code, name, instructor_name, instructor_email,
  grading_scheme, points_total_stated, grading_scale_unit, grading_scale_cutoffs
)
values (
  '22222222-2222-2222-2222-222222222204',
  '11111111-1111-1111-1111-111111111111',
  'MKT 301',
  'Principles of Marketing',
  'Kristen Ryan',
  'ksryan@sbu.edu',
  'points',
  1000,
  'percent',
  '[
    {"grade": "A",  "min": 94, "max": 100},
    {"grade": "A-", "min": 90, "max": 93},
    {"grade": "B+", "min": 87, "max": 89},
    {"grade": "B",  "min": 83, "max": 86},
    {"grade": "B-", "min": 80, "max": 82},
    {"grade": "C+", "min": 77, "max": 79},
    {"grade": "C",  "min": 73, "max": 76},
    {"grade": "C-", "min": 70, "max": 72},
    {"grade": "D+", "min": 67, "max": 69},
    {"grade": "D",  "min": 63, "max": 66},
    {"grade": "D-", "min": 60, "max": 62},
    {"grade": "F",  "min": 0,  "max": 59}
  ]'::jsonb
)
on conflict (id) do nothing;

-- QMX 210 — Quantitative Applications for Business Students — percent scheme.
-- This is the real syllabus whose own page-1 header says "Spring 2026" and
-- whose entire schedule table runs Jan-May, despite being taught this Fall
-- 2026 term. The course stub itself is not flagged here — term_mismatch is
-- a property of a specific syllabus_uploads row (set when that document is
-- actually parsed), not of the course. See README.
insert into courses (
  id, term_id, code, name, instructor_name, instructor_email,
  grading_scheme, points_total_stated, grading_scale_unit, grading_scale_cutoffs
)
values (
  '22222222-2222-2222-2222-222222222205',
  '11111111-1111-1111-1111-111111111111',
  'QMX 210',
  'Quantitative Applications for Business Students',
  'Professor Evelyn Bysiek',
  'eabysiek@sbu.edu',
  'percent',
  null,
  'percent',
  '[
    {"grade": "A",  "min": 93,  "max": 100},
    {"grade": "A-", "min": 90,  "max": 92.9},
    {"grade": "B+", "min": 87,  "max": 89.9},
    {"grade": "B",  "min": 83,  "max": 86.9},
    {"grade": "B-", "min": 80,  "max": 82.9},
    {"grade": "C+", "min": 76,  "max": 79.9},
    {"grade": "C",  "min": 73,  "max": 75.9},
    {"grade": "C-", "min": 70,  "max": 72.9},
    {"grade": "D+", "min": 67,  "max": 69.9},
    {"grade": "D",  "min": 63,  "max": 66.9},
    {"grade": "D-", "min": 60,  "max": 62.9},
    {"grade": "F",  "min": 0,   "max": 59.9}
  ]'::jsonb
)
on conflict (id) do nothing;
