'use strict';

const express = require('express');
const { BoardQuerySchema, BoardResponseSchema, ErrorResponseSchema } = require('../../../shared/contract.js');
const { getSupabaseClient } = require('../lib/supabaseClient');
const { todayNY } = require('../lib/nyDate');

const router = express.Router();

/**
 * `courseIds` accepts either form, per the task-9 brief's "your call,
 * document it": a comma-separated string (`?courseIds=a,b`) OR a
 * repeated-param list (`?courseIds=a&courseIds=b`, which Express already
 * turns into an array on `req.query`). Returns `null` when no filter was
 * requested (never an empty array — an empty array would mean "match
 * nothing", which is not what an absent filter means).
 */
function normalizeCourseIds(raw) {
  if (raw == null) return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const trimmed = list.map((value) => value.trim()).filter(Boolean);
  return trimmed.length ? trimmed : null;
}

// Ascending, `sort_date` NULLS LAST — mirrors the DB comment in
// 0001_init.sql ("sorts range items at their EARLIEST possible date ...
// NULL ... sorts last"). Within a day, items with an exact `due_time` sort
// before items with none; ties break on title for a deterministic, testable
// order.
function compareItemsWithinDay(a, b) {
  if (a.due_time !== b.due_time) {
    if (a.due_time == null) return 1;
    if (b.due_time == null) return -1;
    return a.due_time < b.due_time ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}

function compareNeedsReview(a, b) {
  if (a.course_id !== b.course_id) return a.course_id < b.course_id ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * Buckets already-filtered rows by `sort_date` into the `groups` shape
 * `BoardResponseSchema` expects: dated buckets ascending, then a single
 * trailing `date: null` bucket (the "date not set" tray for `tba` /
 * `external_ref` / `none` precision items — term_mismatch rows are handled
 * entirely separately, see `needsReview` below, and never reach this
 * function).
 */
function groupByDay(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const key = row.sort_date; // string "YYYY-MM-DD" or null
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(row);
  }

  const datedKeys = [...byDate.keys()].filter((key) => key !== null).sort();
  const groups = datedKeys.map((date) => ({
    date,
    items: byDate.get(date).sort(compareItemsWithinDay),
  }));

  if (byDate.has(null)) {
    groups.push({ date: null, items: byDate.get(null).sort(compareItemsWithinDay) });
  }

  return groups;
}

/**
 * A row's `sort_date` window check. Undated rows (`sort_date === null`) are
 * NEVER excluded by `from`/`to` — there's no date on them to compare, and
 * per the task-9 brief's "must not silently vanish" instruction the board
 * would rather show Kevin an undated item unasked-for than hide it because
 * it couldn't be placed in a window. Documented in the delivery report.
 */
function withinWindow(sortDate, from, to) {
  if (sortDate == null) return true;
  if (from && sortDate < from) return false;
  if (to && sortDate > to) return false;
  return true;
}

// GET /api/board?from&to&courseIds&state
//
// Real query against the shared Supabase client (or its in-memory fallback
// — see lib/supabaseClient.js). Two logical partitions are fetched:
//
//   1. Board-eligible rows: `deleted_at IS NULL`, `term_mismatch = false`,
//      optionally narrowed by `courseIds` and `state`. Grouped by day (see
//      `groupByDay`) and — only for rows with a real `sort_date` — narrowed
//      to the `from`/`to` window.
//   2. Needs-review rows: `deleted_at IS NULL`, `term_mismatch = true`,
//      optionally narrowed by `courseIds` only. These are never date- or
//      state-filtered: a wrong-semester syllabus (the QMX 210 case) needs
//      review regardless of which window or completion state Kevin is
//      currently looking at, and it has no real date to filter by anyway.
//
// Filtering by `state`/date-window happens in Node rather than as
// additional query-builder predicates. The in-memory fallback's query
// builder (see lib/inMemoryNotesStore.js) only supports the handful of
// filter primitives `notes.js` originally needed (`eq`/`is`/`in`); rather
// than growing it to also support "not null" and range comparisons just for
// this one route, both partitions do a single broad `eq`/`in`/`is` fetch and
// finish filtering/grouping here. For this single-user, one-semester
// dataset (5 courses, on the order of 100-200 items total) that is a
// deliberate, documented tradeoff, not an oversight — see the task's own
// "what's verified now" note in the delivery report for what a real
// Supabase project would let this route push down instead.
router.get('/board', async (req, res, next) => {
  const parsedQuery = BoardQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid query parameters' }));
  }

  const { from, to, state } = parsedQuery.data;
  const courseIdList = normalizeCourseIds(parsedQuery.data.courseIds);

  try {
    const supabase = getSupabaseClient();

    let boardQuery = supabase.from('syllabus_items').select('*').is('deleted_at', null);
    let reviewQuery = supabase.from('syllabus_items').select('*').is('deleted_at', null);
    if (courseIdList) {
      boardQuery = boardQuery.in('course_id', courseIdList);
      reviewQuery = reviewQuery.in('course_id', courseIdList);
    }

    const [{ data: allRows, error: boardErr }, { data: reviewRows, error: reviewErr }] = await Promise.all([
      boardQuery,
      reviewQuery,
    ]);

    if (boardErr || reviewErr) {
      const message = (boardErr || reviewErr).message;
      return next(Object.assign(new Error(message), { status: 500 }));
    }

    const boardEligible = (allRows || []).filter((row) => !row.term_mismatch);
    const needsReview = (reviewRows || []).filter((row) => row.term_mismatch);

    const stateFiltered = boardEligible.filter((row) => {
      if (state === 'upcoming') return row.completed_at == null;
      if (state === 'completed') return row.completed_at != null;
      return true; // state omitted — return both partitions together
    });

    const windowed = stateFiltered.filter((row) => withinWindow(row.sort_date, from, to));

    const body = BoardResponseSchema.parse({
      today: todayNY(),
      groups: groupByDay(windowed),
      needsReview: [...needsReview].sort(compareNeedsReview),
    });

    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
