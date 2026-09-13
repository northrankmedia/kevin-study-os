'use strict';

import crypto from 'crypto';
import { createRequire } from 'module';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { todayNY } from '../src/lib/nyDate.js';

// See api/test/notes.test.js for why this file uses `require` (via
// `createRequire`) instead of `import` for anything reaching the shared
// Supabase client / app singleton.
const require = createRequire(import.meta.url);
const { getSupabaseClient } = require('../src/lib/supabaseClient.js');
const app = require('../src/index.js');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

let sessionCookie;

beforeAll(async () => {
  const supabase = getSupabaseClient();
  await supabase
    .from('app_user')
    .insert({ email: 'kevin-board-test@example.com', password_hash: await argon2.hash('test-password-fixture') })
    .select()
    .single();

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'kevin-board-test@example.com', password: 'test-password-fixture' });

  sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
});

function makeItem(overrides) {
  return {
    course_id: crypto.randomUUID(),
    upload_id: crypto.randomUUID(),
    grading_component_id: null,
    points_possible: null,
    title: 'Untitled item',
    item_kind: 'homework',
    due_start: null,
    due_end: null,
    due_time: null,
    available_from: null,
    available_until: null,
    date_precision: 'exact',
    source_text: 'source text fixture',
    source_section: null,
    content_hash: crypto.randomUUID(),
    is_recurring: false,
    expected_count: null,
    completed_count: null,
    confidence: null,
    needs_review: false,
    is_user_edited: false,
    term_mismatch: false,
    origin: 'syllabus',
    completed_at: null,
    deleted_at: null,
    superseded_by_upload_id: null,
    ...overrides,
  };
}

async function insertItem(overrides) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('syllabus_items').insert(makeItem(overrides)).select().single();
  if (error) throw new Error(error.message);
  return data;
}

function getBoard(query) {
  return request(app).get('/api/board').query(query || {}).set('Cookie', sessionCookie);
}

describe('GET /api/board', () => {
  it('groups exact/range items by sort_date ascending, puts undated items in the date:null tray, and excludes term_mismatch entirely from groups (but not from needsReview)', async () => {
    const courseA = crypto.randomUUID();
    const courseB = crypto.randomUUID();
    const courseC = crypto.randomUUID();

    const laterExact = await insertItem({
      course_id: courseA,
      title: 'Midterm Exam',
      item_kind: 'exam',
      date_precision: 'exact',
      due_start: '2026-10-26',
      due_time: '10:00',
    });
    const earlierRange = await insertItem({
      course_id: courseA,
      title: 'Group Project Week',
      item_kind: 'project',
      date_precision: 'range',
      due_start: '2026-10-05',
      due_end: '2026-10-09',
    });
    const tbaItem = await insertItem({
      course_id: courseB,
      title: 'Final Presentation',
      item_kind: 'presentation',
      date_precision: 'tba',
    });
    const externalRefItem = await insertItem({
      course_id: courseB,
      title: 'Final Exam',
      item_kind: 'final_exam',
      date_precision: 'external_ref',
    });
    const termMismatchItem = await insertItem({
      course_id: courseC,
      title: 'Chapter 3 Homework',
      item_kind: 'homework',
      date_precision: 'none',
      term_mismatch: true,
    });

    const res = await getBoard({ courseIds: [courseA, courseB, courseC].join(',') });
    expect(res.status).toBe(200);

    expect(res.body.today).toBe(todayNY());

    // Dated groups ascending: the range item's earliest date (Oct 5) sorts
    // before the exact item (Oct 26), even though it was inserted second.
    const datedGroups = res.body.groups.filter((g) => g.date !== null);
    expect(datedGroups.map((g) => g.date)).toEqual(['2026-10-05', '2026-10-26']);
    expect(datedGroups[0].items.map((i) => i.id)).toEqual([earlierRange.id]);
    expect(datedGroups[1].items.map((i) => i.id)).toEqual([laterExact.id]);

    // Undated (but non-term-mismatch) items land together in the trailing
    // date:null tray, last.
    const nullGroup = res.body.groups.find((g) => g.date === null);
    expect(nullGroup).toBeDefined();
    expect(res.body.groups[res.body.groups.length - 1].date).toBeNull();
    const nullIds = nullGroup.items.map((i) => i.id);
    expect(nullIds).toContain(tbaItem.id);
    expect(nullIds).toContain(externalRefItem.id);
    // Distinct precision, still visible in the response for the UI to
    // render differently.
    expect(nullGroup.items.find((i) => i.id === tbaItem.id).date_precision).toBe('tba');
    expect(nullGroup.items.find((i) => i.id === externalRefItem.id).date_precision).toBe('external_ref');

    // term_mismatch never appears in ANY group...
    const allGroupedIds = res.body.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(allGroupedIds).not.toContain(termMismatchItem.id);

    // ...but is also never silently dropped from the response entirely.
    expect(res.body.needsReview.map((i) => i.id)).toContain(termMismatchItem.id);
  });

  it('state=upcoming vs state=completed correctly partitions, and courseIds narrows to one course without affecting others', async () => {
    const courseA = crypto.randomUUID();
    const courseB = crypto.randomUUID();

    const upcomingA = await insertItem({ course_id: courseA, title: 'Quiz 1', due_start: '2026-09-10' });
    const completedA = await insertItem({
      course_id: courseA,
      title: 'Quiz 0 (done)',
      due_start: '2026-09-01',
      completed_at: '2026-09-02T12:00:00.000Z',
    });
    const upcomingB = await insertItem({ course_id: courseB, title: 'Reading', due_start: '2026-09-11' });

    const upcomingRes = await getBoard({ courseIds: `${courseA},${courseB}`, state: 'upcoming' });
    const upcomingIds = upcomingRes.body.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(upcomingIds).toContain(upcomingA.id);
    expect(upcomingIds).toContain(upcomingB.id);
    expect(upcomingIds).not.toContain(completedA.id);

    const completedRes = await getBoard({ courseIds: `${courseA},${courseB}`, state: 'completed' });
    const completedIds = completedRes.body.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(completedIds).toEqual([completedA.id]);

    // courseIds filter: course A only, upcoming state.
    const courseAOnly = await getBoard({ courseIds: courseA, state: 'upcoming' });
    const courseAOnlyIds = courseAOnly.body.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(courseAOnlyIds).toContain(upcomingA.id);
    expect(courseAOnlyIds).not.toContain(upcomingB.id);
  });

  it('PATCH /api/items/:id completing an item persists and moves it from upcoming to completed on the next GET', async () => {
    const courseId = crypto.randomUUID();
    const item = await insertItem({ course_id: courseId, title: 'Homework 4', due_start: '2026-09-20' });

    const beforeRes = await getBoard({ courseIds: courseId, state: 'upcoming' });
    expect(beforeRes.body.groups.flatMap((g) => g.items.map((i) => i.id))).toContain(item.id);

    const patchRes = await request(app)
      .patch(`/api/items/${item.id}`)
      .set('Cookie', sessionCookie)
      .send({ completed_at: '2026-09-19T18:00:00.000Z' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.completed_at).toBe('2026-09-19T18:00:00.000Z');

    const afterUpcoming = await getBoard({ courseIds: courseId, state: 'upcoming' });
    expect(afterUpcoming.body.groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain(item.id);

    const afterCompleted = await getBoard({ courseIds: courseId, state: 'completed' });
    expect(afterCompleted.body.groups.flatMap((g) => g.items.map((i) => i.id))).toContain(item.id);

    // Uncomplete round-trips too.
    const uncompleteRes = await request(app)
      .patch(`/api/items/${item.id}`)
      .set('Cookie', sessionCookie)
      .send({ completed_at: null });
    expect(uncompleteRes.status).toBe(200);
    expect(uncompleteRes.body.completed_at).toBeNull();
  });

  it('from/to windows dated items but never excludes an undated (tba) item', async () => {
    const courseId = crypto.randomUUID();
    const inWindow = await insertItem({ course_id: courseId, title: 'In window', due_start: '2026-11-05' });
    const outOfWindow = await insertItem({ course_id: courseId, title: 'Out of window', due_start: '2027-01-05' });
    const undated = await insertItem({ course_id: courseId, title: 'No date yet', date_precision: 'tba' });

    const res = await getBoard({ courseIds: courseId, from: '2026-11-01', to: '2026-11-30' });
    const ids = res.body.groups.flatMap((g) => g.items.map((i) => i.id));

    expect(ids).toContain(inWindow.id);
    expect(ids).not.toContain(outOfWindow.id);
    expect(ids).toContain(undated.id);
  });

  it('rejects an invalid state value with 400', async () => {
    const res = await getBoard({ state: 'not-a-real-state' });
    expect(res.status).toBe(400);
  });
});
