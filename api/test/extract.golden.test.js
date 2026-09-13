'use strict';

/**
 * Golden test — scores the syllabus extraction pipeline against the
 * hand-built fixture pack (`fixtures/expected/*.json`) using the exact
 * method defined in `fixtures/rubric.md` (see `test/lib/rubricScore.js`).
 *
 * ── No live Anthropic API access in this environment ──
 * There is no `ANTHROPIC_API_KEY` available here (see the task's own note:
 * "No live Supabase/Anthropic credentials are provisioned yet"). Per the
 * task's explicit instruction for this situation, this suite runs against
 * **recorded/replayed** Claude tool-call output rather than a live model:
 * `test/recorded/<course>.json` holds, per course, the raw Pass A
 * (`extract_course_metadata`) and Pass B (`extract_schedule_items`) tool
 * inputs a real Claude Haiku call would have produced. `createFakeClient`
 * below is a drop-in stand-in for the Anthropic SDK client — same
 * `messages.create(...)` call shape as `extract.js` uses, resolving with a
 * `tool_use` content block carrying the recorded input for whichever tool
 * was requested — so `extractSyllabus` runs its real, unmodified code path
 * end to end (Pass A/B assembly, the dedup safety net, the term-mismatch
 * guard, content-hash computation, NY-local -> UTC conversion) against
 * fixed input.
 *
 * How the recorded fixtures were authored (honesty about their provenance,
 * since this matters for what this suite does and doesn't prove): they were
 * hand-built from the same source syllabi used to build
 * `fixtures/expected/*.json` (`fixtures/syllabi/`, `fixtures/_dump/`), not
 * copy-pasted 1:1 from the expected fixtures. Two courses deliberately
 * preserve realistic *pre-post-processing* imperfections so this suite
 * exercises real code paths instead of an identity round-trip:
 *   - MGT 301: the "Tariff PowerPoint" and "Research Presentation Topic
 *     Selection" deadlines are each recorded as TWO raw candidate items
 *     (one from the schedule table, one from body prose — both verbatim
 *     substrings of the real source document), exactly the dedup anchor
 *     described in the task. `dedupItems` must collapse each pair to one.
 *   - QMX 210: "Examination 1"/"Examination 2" are recorded with their raw,
 *     un-suppressed Spring-2026 dates (resolved from "2/18"/"3/30" using the
 *     target term's own calendar year, per the prompt's bare-date rule) —
 *     genuinely outside the Fall 2026 window. `computeTermMismatch` +
 *     `suppressDatesForMismatch` must detect the majority-outside-window
 *     condition and null every date field back down to the fixture's
 *     expected shape, not the recorded fixture pretending that already
 *     happened.
 *
 * This proves the deterministic pipeline logic is correct end to end. It
 * does NOT prove Claude Haiku itself will read a brand-new syllabus this
 * well in production — that requires a live API key and is a
 * deployment-time validation step (see the task's own instructions and the
 * completion report for this task).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  extractSyllabus,
  dedupItems,
  computeTermMismatch,
  suppressDatesForMismatch,
  computeContentHash,
  normalizeTitle,
  reconcileItems,
  nyLocalToUtcIso,
  PASS_A_TOOL,
  PASS_B_TOOL,
} from '../src/lib/extract.js';
import { scoreCourse, macroAverage } from './lib/rubricScore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECORDED_DIR = path.join(__dirname, 'recorded');
const EXPECTED_DIR = path.join(__dirname, '..', '..', 'fixtures', 'expected');

const COURSES = [
  { key: 'mgt301', file: 'mgt301.json', expectAcceptanceGate: true },
  { key: 'acct201', file: 'acct201.json', expectAcceptanceGate: true },
  { key: 'phil104', file: 'phil104.json', expectAcceptanceGate: true },
  { key: 'mkt301', file: 'mkt301.json', expectAcceptanceGate: true },
  { key: 'qmx210', file: 'qmx210.json', expectAcceptanceGate: false },
];

function loadJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

/** Same call shape as the real Anthropic SDK client's `messages.create`,
 * replaying the recorded tool input for whichever tool was requested. */
function createFakeClient(recorded) {
  return {
    messages: {
      async create({ tools }) {
        const toolName = tools[0].name;
        const input = toolName === PASS_A_TOOL.name ? recorded.passA : recorded.passB;
        return { content: [{ type: 'tool_use', id: 'toolu_recorded', name: toolName, input }] };
      },
    },
  };
}

const results = {};

describe('golden extraction — scored against fixtures/rubric.md', () => {
  beforeAll(async () => {
    for (const course of COURSES) {
      const recorded = loadJson(RECORDED_DIR, course.file);
      const expected = loadJson(EXPECTED_DIR, course.file);

      const extraction = await extractSyllabus({
        prepared: { kind: 'markdown', payload: '(replayed from recorded fixture — not sent anywhere)' },
        termLabel: recorded.termLabel,
        termStart: recorded.termStart,
        termEnd: recorded.termEnd,
        client: createFakeClient(recorded),
        model: 'recorded-fixture-replay',
      });

      const scores = scoreCourse(extraction.items, expected.syllabus_items);
      results[course.key] = { extraction, expected, scores };
    }

    // eslint-disable-next-line no-console
    console.log('\n=== Golden extraction scores (fixtures/rubric.md method) ===');
    for (const course of COURSES) {
      const { scores } = results[course.key];
      // eslint-disable-next-line no-console
      console.log(
        `${course.key.padEnd(8)} item_recall=${fmt(scores.item_recall)} ` +
          `date_accuracy=${fmt(scores.date_accuracy)} type_precision=${fmt(scores.type_precision)} ` +
          `window_accuracy=${fmt(scores.window_accuracy)} hallucinated=${scores.hallucinatedItemCount} ` +
          `(matched ${scores.matchedCount}/${scores.totalExpected})`
      );
    }
    const macro = {
      item_recall: macroAverage(COURSES.map((c) => results[c.key].scores.item_recall)),
      date_accuracy: macroAverage(COURSES.map((c) => results[c.key].scores.date_accuracy)),
      type_precision: macroAverage(COURSES.map((c) => results[c.key].scores.type_precision)),
    };
    // eslint-disable-next-line no-console
    console.log(
      `macro-avg item_recall=${fmt(macro.item_recall)} date_accuracy=${fmt(macro.date_accuracy)} ` +
        `type_precision=${fmt(macro.type_precision)}`
    );
    const mismatchedCourses = COURSES.filter((c) => results[c.key].extraction.termMismatch).map((c) => c.key);
    // eslint-disable-next-line no-console
    console.log(`courses flagged term_mismatch (need Kevin's manual date entry): ${mismatchedCourses.join(', ')}`);
  });

  function fmt(n) {
    return n == null ? 'n/a' : n.toFixed(3);
  }

  for (const course of COURSES.filter((c) => c.expectAcceptanceGate)) {
    describe(course.key, () => {
      it('item_recall >= 0.90', () => {
        expect(results[course.key].scores.item_recall).toBeGreaterThanOrEqual(0.9);
      });

      it('date_accuracy >= 0.90 (and, per acceptance, zero silently-wrong dates -> exactly 1.0)', () => {
        const { date_accuracy } = results[course.key].scores;
        expect(date_accuracy).not.toBeNull();
        expect(date_accuracy).toBeGreaterThanOrEqual(0.9);
        expect(date_accuracy).toBe(1);
      });

      it('term_mismatch is correctly false', () => {
        expect(results[course.key].extraction.termMismatch).toBe(false);
      });
    });
  }

  describe('qmx210 — the required term-mismatch anchor', () => {
    it('term_mismatch is correctly detected (hard pass/fail gate per rubric.md)', () => {
      expect(results.qmx210.extraction.termMismatch).toBe(true);
    });

    it('publishes zero calendar items — every date field is null on every item', () => {
      for (const item of results.qmx210.extraction.items) {
        expect(item.due_start).toBeNull();
        expect(item.due_end).toBeNull();
        expect(item.due_time).toBeNull();
        expect(item.available_from).toBeNull();
        expect(item.available_until).toBeNull();
        expect(item.term_mismatch).toBe(true);
      }
    });

    it('still recalls the fixture items (as null-dated rows, not omitted)', () => {
      expect(results.qmx210.scores.item_recall).toBeGreaterThanOrEqual(0.9);
    });
  });

  it('net result across all 5 courses: exactly 1 of 5 (QMX 210) needs manual date entry', () => {
    const mismatched = COURSES.filter((c) => results[c.key].extraction.termMismatch);
    expect(mismatched.map((c) => c.key)).toEqual(['qmx210']);
  });

  it("MGT 301's Tariff PowerPoint appears exactly once, not twice (dedup anchor)", () => {
    const tariffItems = results.mgt301.extraction.items.filter(
      (item) => normalizeTitle(item.title) === 'tariff powerpoint'
    );
    expect(tariffItems).toHaveLength(1);
    // The more complete mention (states the 8:00am time) is the one kept.
    expect(tariffItems[0].due_time).toBe('08:00');
    expect(tariffItems[0].source_section).toBe('body_prose');
  });
});

// ============================================================================
// Focused unit coverage for the deterministic post-processing logic that
// the rubric's course-level scores don't individually isolate.
// ============================================================================

describe('dedupItems', () => {
  it('collapses two raw mentions of the same deadline (same title, same resolved date) into one, preferring the one with a due_time', () => {
    const raw = [
      { title: 'Tariff PowerPoint', due_start: '2026-09-20', due_time: null, source_text: 'short mention', item_kind: 'project' },
      { title: 'Tariff PowerPoint', due_start: '2026-09-20', due_time: '08:00', source_text: 'Power point due Sept 20th 8:00 am.', item_kind: 'project' },
    ];
    const deduped = dedupItems(raw);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].due_time).toBe('08:00');
  });

  it('does not merge two genuinely different items that merely share a due date', () => {
    const raw = [
      { title: 'Exam 1', due_start: '2026-10-05', due_time: null, source_text: 'Exam 1 on this date', item_kind: 'exam' },
      { title: 'Chapter 3 Homework', due_start: '2026-10-05', due_time: null, source_text: 'Homework due same day', item_kind: 'homework' },
    ];
    expect(dedupItems(raw)).toHaveLength(2);
  });
});

describe('computeTermMismatch + suppressDatesForMismatch', () => {
  it('flags mismatch when the majority of dated items fall outside the term window', () => {
    const items = [
      { due_start: '2026-02-18' },
      { due_start: '2026-03-30' },
      { due_start: null },
    ];
    expect(computeTermMismatch(items, '2026-08-31', '2026-12-18')).toBe(true);
  });

  it('does not flag mismatch when most dated items are in-window', () => {
    const items = [{ due_start: '2026-09-20' }, { due_start: '2026-10-05' }, { due_start: '2026-02-18' }];
    expect(computeTermMismatch(items, '2026-08-31', '2026-12-18')).toBe(false);
  });

  it('suppresses every date field but preserves tba/external_ref precision', () => {
    const items = [
      { date_precision: 'exact', due_start: '2026-02-18', due_end: '2026-02-18', due_time: '10:00', available_from: 'x', available_until: 'y' },
      { date_precision: 'tba', due_start: null, due_end: null, due_time: null, available_from: null, available_until: null },
    ];
    const suppressed = suppressDatesForMismatch(items);
    expect(suppressed[0].date_precision).toBe('none');
    expect(suppressed[0].due_start).toBeNull();
    expect(suppressed[0].available_from).toBeNull();
    expect(suppressed[1].date_precision).toBe('tba');
    expect(suppressed.every((item) => item.term_mismatch)).toBe(true);
  });
});

describe('computeContentHash — identity-only, never date-sensitive', () => {
  it('is stable across a changed due date for the same course/title/section', () => {
    const a = computeContentHash({ courseId: 'course-1', title: 'Midterm Exam', sourceSection: 'schedule_table' });
    const b = computeContentHash({ courseId: 'course-1', title: 'midterm   exam', sourceSection: 'schedule_table' });
    expect(a).toBe(b);
  });

  it('differs across courses or sections for the same title', () => {
    const base = computeContentHash({ courseId: 'course-1', title: 'Midterm Exam', sourceSection: 'schedule_table' });
    const otherCourse = computeContentHash({ courseId: 'course-2', title: 'Midterm Exam', sourceSection: 'schedule_table' });
    const otherSection = computeContentHash({ courseId: 'course-1', title: 'Midterm Exam', sourceSection: 'body_prose' });
    expect(otherCourse).not.toBe(base);
    expect(otherSection).not.toBe(base);
  });
});

describe('nyLocalToUtcIso — DST-aware NY-local -> UTC conversion', () => {
  it('converts an EDT (summer) local time correctly', () => {
    expect(nyLocalToUtcIso('2026-09-25T08:00:00')).toBe('2026-09-25T12:00:00.000Z');
  });

  it('converts an EST (winter) local time correctly', () => {
    expect(nyLocalToUtcIso('2026-12-14T08:00:00')).toBe('2026-12-14T13:00:00.000Z');
  });

  it('returns null for a null input', () => {
    expect(nyLocalToUtcIso(null)).toBeNull();
  });
});

describe('reconcileItems — re-upload semantics', () => {
  it('leaves a user-edited row untouched when its content_hash reappears', () => {
    const existing = [{ id: 'row-1', content_hash: 'hash-a', is_user_edited: true, due_start: '2026-01-01' }];
    const newItemRows = [{ content_hash: 'hash-a', due_start: '2026-09-20', title: 'Something' }];
    const { toInsert, toSoftDelete } = reconcileItems({ existingItems: existing, newItemRows, newUploadId: 'upload-2' });
    expect(toInsert).toHaveLength(0);
    expect(toSoftDelete).toHaveLength(0);
  });

  it('supersedes a non-edited row that reappears (soft-delete old, insert new)', () => {
    const existing = [{ id: 'row-1', content_hash: 'hash-a', is_user_edited: false }];
    const newItemRows = [{ content_hash: 'hash-a', due_start: '2026-09-21', title: 'Something' }];
    const { toInsert, toSoftDelete } = reconcileItems({ existingItems: existing, newItemRows, newUploadId: 'upload-2' });
    expect(toInsert).toHaveLength(1);
    expect(toSoftDelete).toEqual(['row-1']);
  });

  it('soft-deletes an item that disappeared from the new parse, even if user-edited', () => {
    const existing = [{ id: 'row-1', content_hash: 'hash-gone', is_user_edited: true }];
    const { toInsert, toSoftDelete } = reconcileItems({ existingItems: existing, newItemRows: [], newUploadId: 'upload-2' });
    expect(toInsert).toHaveLength(0);
    expect(toSoftDelete).toEqual(['row-1']);
  });

  it('inserts a genuinely new item untouched', () => {
    const { toInsert, toSoftDelete } = reconcileItems({
      existingItems: [],
      newItemRows: [{ content_hash: 'hash-new', title: 'New Item' }],
      newUploadId: 'upload-2',
    });
    expect(toInsert).toHaveLength(1);
    expect(toSoftDelete).toHaveLength(0);
  });
});
