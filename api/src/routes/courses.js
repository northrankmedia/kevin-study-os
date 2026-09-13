'use strict';

const express = require('express');
const { CourseSchema, ErrorResponseSchema } = require('../../../shared/contract.js');
const { getSupabaseClient } = require('../lib/supabaseClient');

const router = express.Router();

// `grading_scale_cutoffs` is a `jsonb` column with no shape enforced at the
// DB level. Every consumer of it — the extraction Zod schema and prompt in
// api/src/lib/extract.js, the frozen CourseSchema below, and the frontend's
// courseFormat.js — agrees on one shape: an object keyed by letter grade,
// each value a `[low, high]` tuple (e.g. `{ A: [93, 100], B: [83, 92.99] }`).
// The real rows currently in `courses` (seeded through some path other than
// this app's own extraction pipeline) instead hold an array of
// `{ grade, min, max }` objects — CourseSchema.parse rejects that shape
// outright ("Expected object, received array"), which is what turned every
// real course row into a 500 here. Normalized on read rather than migrating
// the data or loosening the schema, since every real consumer already
// agrees on the object-keyed shape and this keeps that contract intact
// regardless of which shape a given row happens to hold in the DB.
function normalizeGradingScaleCutoffs(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return raw; // already object-keyed (or malformed — let CourseSchema catch it)

  const out = {};
  for (const entry of raw) {
    if (!entry || typeof entry.grade !== 'string') continue;
    out[entry.grade] = [entry.min, entry.max];
  }
  return out;
}

// Was hardcoded stub data (two fixture rows, "no Supabase client wired up
// yet") left over from Task 2's runnable-skeleton pass — every other
// course-touching route (syllabus.js, notes.js, profile.js) was wired to
// the real `courses` table in later tasks, but this list endpoint never
// was. That meant the Board (and every "view course" link on it) showed
// the same two fixture courses under fixture ids forever, regardless of
// what was actually in the database — any page reached through one of
// those links could never load real data, since the ids never existed.
// Same `deleted_at IS NULL` + ordering convention as the course lookup in
// syllabus.js.
router.get('/courses', async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .is('deleted_at', null)
      .order('code', { ascending: true });

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    res.status(200).json(
      data.map((course) =>
        CourseSchema.parse({
          ...course,
          grading_scale_cutoffs: normalizeGradingScaleCutoffs(course.grading_scale_cutoffs),
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
