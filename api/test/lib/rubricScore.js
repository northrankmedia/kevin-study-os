'use strict';

/**
 * Implements the scoring method defined in `fixtures/rubric.md`, exactly:
 * normalization (Step 0), greedy bipartite title+date matching (Step 1),
 * and the three scores plus the two extra diagnostics the rubric calls out
 * (`window_accuracy`, "hallucinated item count"). This is test-only
 * infrastructure consumed by `extract.golden.test.js` — not part of the
 * application's own runtime code.
 */

const { titleSimilarity } = require('../../src/lib/extract');

const TITLE_SIMILARITY_THRESHOLD = 0.6;
const NON_DATED_PRECISIONS = new Set(['tba', 'external_ref', 'none']);
const NY_TIME_ZONE = 'America/New_York';

function normalizeItem(item) {
  return {
    ...item,
    title: item.title.trim().toLowerCase().replace(/\s+/g, ' '),
    source_text: (item.source_text || '').trim().replace(/\s+/g, ' '),
    due_start: item.due_start || null,
    due_end: item.due_end || null,
    due_time: item.due_time || null,
    available_from: item.available_from || null,
    available_until: item.available_until || null,
  };
}

/** Rubric Step 1, condition 2: both non-dated, or candidate's date falls within the fixture's span. */
function dateCompatible(actual, expected) {
  const bothNonDated = NON_DATED_PRECISIONS.has(actual.date_precision) && NON_DATED_PRECISIONS.has(expected.date_precision);
  if (bothNonDated) return true;

  const candidateDate = actual.due_start || actual.due_end;
  if (!candidateDate) return false;

  const expectedStart = expected.due_start || expected.due_end;
  const expectedEnd = expected.due_end || expected.due_start;
  if (!expectedStart) return false;

  return candidateDate >= expectedStart && candidateDate <= expectedEnd;
}

/**
 * Greedy bipartite matching: every (actual, expected) pair clearing both
 * thresholds is a candidate; highest title-similarity pairs are accepted
 * first, and accepting a pair removes both sides from the pool.
 */
function matchItems(actualItems, expectedItems) {
  const actual = actualItems.map(normalizeItem);
  const expected = expectedItems.map(normalizeItem);

  const candidates = [];
  for (let ei = 0; ei < expected.length; ei += 1) {
    for (let ai = 0; ai < actual.length; ai += 1) {
      const sim = titleSimilarity(actual[ai].title, expected[ei].title);
      if (sim >= TITLE_SIMILARITY_THRESHOLD && dateCompatible(actual[ai], expected[ei])) {
        candidates.push({ ai, ei, sim });
      }
    }
  }
  candidates.sort((a, b) => b.sim - a.sim);

  const usedActual = new Set();
  const usedExpected = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedActual.has(candidate.ai) || usedExpected.has(candidate.ei)) continue; // eslint-disable-line no-continue
    usedActual.add(candidate.ai);
    usedExpected.add(candidate.ei);
    pairs.push(candidate);
  }

  return { actual, expected, pairs };
}

/** Inverse of extract.js's `nyLocalToUtcIso` — used only to compare a
 * candidate's real UTC `available_from`/`available_until` against the
 * fixture pack's naive-local-time convention for the same fields (see
 * fixtures/expected/mkt301.json, e.g. "2026-09-25T08:00:00" with no `Z`). */
function utcIsoToNyLocal(iso) {
  if (!iso) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIME_ZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(iso));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`;
}

/**
 * @returns per-course scores plus the raw counts behind them, so the golden
 *   test can print a readable report instead of just pass/fail booleans.
 */
function scoreCourse(actualItems, expectedItems) {
  const { actual, expected, pairs } = matchItems(actualItems, expectedItems);

  const item_recall = expected.length === 0 ? 1 : pairs.length / expected.length;

  const dateSubset = pairs.filter((p) => ['exact', 'range'].includes(expected[p.ei].date_precision));
  const dateCorrect = dateSubset.filter((p) => {
    const a = actual[p.ai];
    const e = expected[p.ei];
    if (a.due_start !== e.due_start || a.due_end !== e.due_end) return false;
    if (e.due_time != null && a.due_time !== e.due_time) return false;
    return true;
  });
  const date_accuracy = dateSubset.length === 0 ? null : dateCorrect.length / dateSubset.length;

  const typePrecisionDenominator = pairs.length;
  const typeCorrect = pairs.filter((p) => actual[p.ai].item_kind === expected[p.ei].item_kind);
  const type_precision = typePrecisionDenominator === 0 ? null : typeCorrect.length / typePrecisionDenominator;

  const windowSubset = pairs.filter((p) => expected[p.ei].available_from != null);
  const windowCorrect = windowSubset.filter((p) => {
    const a = actual[p.ai];
    const e = expected[p.ei];
    return utcIsoToNyLocal(a.available_from) === e.available_from && utcIsoToNyLocal(a.available_until) === e.available_until;
  });
  const window_accuracy = windowSubset.length === 0 ? null : windowCorrect.length / windowSubset.length;

  const hallucinatedItemCount = actual.length - pairs.length;

  return {
    item_recall,
    date_accuracy,
    type_precision,
    window_accuracy,
    hallucinatedItemCount,
    matchedCount: pairs.length,
    totalExpected: expected.length,
    totalActual: actual.length,
    dateSubsetSize: dateSubset.length,
    windowSubsetSize: windowSubset.length,
  };
}

function macroAverage(values) {
  const defined = values.filter((v) => v != null);
  if (defined.length === 0) return null;
  return defined.reduce((sum, v) => sum + v, 0) / defined.length;
}

module.exports = { matchItems, scoreCourse, macroAverage, utcIsoToNyLocal };
