# Scoring Rubric — Comparing a Pipeline's Output Against These Fixtures

This document defines three numeric scores, computed **per course fixture**, that an automated
comparison function should produce when comparing a candidate extraction (the "actual" output of
the AI pipeline) against the corresponding hand-built fixture in `expected/*.json` (the
"expected" output). It is written precisely enough to implement directly, without needing to ask
a clarifying question.

All three scores are computed only over `syllabus_items`. `grading_components` and `course` are
not scored by this rubric (they're small, low-cardinality, and better checked with a simple exact-
or near-exact-match diff — see "Non-scored fields" at the end of this document for a suggested
lightweight check).

---

## Step 0 — Normalization (apply before matching)

Before comparing anything, normalize both the expected item list and the actual item list:

1. Lowercase `title` and strip leading/trailing whitespace.
2. Collapse internal whitespace runs to a single space in `title` and `source_text`.
3. Treat `due_start`/`due_end`/`due_time`/`available_from`/`available_until` as `null` if the
   pipeline outputs an empty string `""` instead of `null` — normalize both to `null` before
   comparing.
4. Do **not** normalize `item_kind` — it must match one of the fixed enum values exactly
   (case-insensitive is fine, but no fuzzy mapping between kinds, e.g. `"homework"` must not be
   treated as equivalent to `"reading"`).

---

## Step 1 — Matching (required before any of the three scores can be computed)

A candidate item `A` (from the actual/pipeline output) is considered **matched** to a fixture item
`E` (from `expected/*.json`) if and only if **both** of the following hold:

1. **Title similarity ≥ 0.6**, using normalized Levenshtein similarity:
   `similarity = 1 - (levenshtein_distance(A.title, E.title) / max(len(A.title), len(E.title)))`
   (Any standard string-similarity library producing a 0–1 score from edit distance is
   acceptable; token-set / Jaccard similarity on whitespace-split words is an acceptable
   substitute if it produces comparable results — the 0.6 threshold assumes a normalized edit-
   distance-based score specifically; if using token-overlap instead, use a 0.5 Jaccard
   threshold, since token overlap is a coarser signal.)
2. **Date compatibility**: either
   - both `A` and `E` have `date_precision` in `{"tba", "external_ref", "none"}` (i.e., neither
     claims a real date — these are compatible with each other regardless of which non-dated
     bucket each falls into, but see the `date_accuracy` scoring below, which treats these
     buckets as distinct for accuracy purposes), **or**
   - `A.due_start` (or, if null, `A.due_end`) falls within `[E.due_start, E.due_end]` inclusive
     (if `E.due_start`/`E.due_end` are equal, this degenerates to an exact-date check).

If a candidate item matches more than one fixture item under these rules (or vice versa), resolve
by taking the pairing with the highest title-similarity score and removing both from the pool
before continuing (greedy bipartite matching, highest similarity first). Each fixture item may be
matched to at most one candidate item, and vice versa.

An **unmatched fixture item** (no candidate reached the threshold) counts as a miss for
`item_recall`. An **unmatched candidate item** (extra item not in the fixture) does not penalize
any of the three scores below, but should be reported separately by the comparison tool as a
"hallucinated item count" for visibility — a pipeline that invents plausible-sounding extra items
is a real quality problem even though it isn't captured by these three ratios.

---

## Step 2 — The three scores

### `item_recall`
```
item_recall = (number of matched fixture items) / (total number of fixture items in syllabus_items)
```
Straightforward recall: did the pipeline find the things a human found? This is computed over
*all* fixture items regardless of `date_precision` (a `tba`/`external_ref`/`none` item still
counts toward the denominator — the pipeline should still surface it as a real item, e.g. "Final
Exam: see Academic Calendar," even without a resolvable date).

### `date_accuracy`
Computed only over the **subset of matched items** whose fixture (`expected`) `date_precision` is
`"exact"` or `"range"` (i.e., items that have a real, resolvable date in the fixture — this
excludes `tba`, `external_ref`, and `none` items, since there is no "correct date" to check for
those).
```
date_accuracy = (matched items in that subset where the candidate's due_start, due_end, AND
                 due_time — if the fixture's due_time is non-null — all equal the fixture's
                 corresponding values exactly) / (size of that subset)
```
Precise equality rules:
- `due_start` and `due_end` must match exactly (same ISO date string). A candidate that reports a
  single exact date for a fixture `range` item (e.g., reports only `due_start = due_end =
  2026-10-26` for a fixture range of `2026-10-26`–`2026-10-30`) does **not** count as correct —
  the range's full span must be reproduced, since collapsing a range to one guessed day is exactly
  the kind of error this fixture set exists to catch.
- If the fixture's `due_time` is `null`, the candidate's `due_time` is not checked (any value or
  null is acceptable — the fixture is only asserting date-level precision).
- If the fixture's `due_time` is non-null, the candidate's `due_time` must match exactly (same
  `HH:MM`).
- `available_from`/`available_until` are checked as a secondary, separately-reported sub-metric
  (`window_accuracy`, computed the same way but only over matched items where the fixture has a
  non-null `available_from`) — do not fold this into `date_accuracy` itself, since most items in
  these fixtures do not have an open/close window (only the MKT 301 tests do), and folding it in
  would make `date_accuracy` misleadingly easy to pass for courses without windows and misleadingly
  hard for MKT 301 specifically.

### `type_precision`
Computed over all matched items (regardless of `date_precision`):
```
type_precision = (matched items where candidate.item_kind == expected.item_kind) / (total matched items)
```
`item_kind` must match the exact enum value from the schema (`exam`, `final_exam`, `quiz`,
`pop_quiz`, `homework`, `reading`, `project`, `presentation`, `discussion`, `writing_lab`,
`participation`, `course_eval`, `lab_session`, `admin`, `break`, `other`). No partial credit for
"close" kinds (e.g. `homework` vs `reading` on a matched SmartBook item is a miss, not a partial
match) — item_kind confusion of this sort is exactly the signal this metric is meant to surface.

---

## Worked example

Suppose the ACCT 201 fixture has 28 `syllabus_items`, of which 26 have `date_precision: "range"`
and 2 have `date_precision: "tba"` (the Final Exam). Suppose the pipeline's actual output is
matched against the fixture and:
- 25 of the 28 fixture items find a matching candidate (3 misses) → `item_recall = 25/28 ≈ 0.893`
- Of the 25 matched items, 24 have a fixture `date_precision` of `"range"` (the matched Final Exam
  item, being `"tba"`, is excluded from this subset) → subset size 24; suppose 20 of those 24
  have exactly correct `due_start`/`due_end` → `date_accuracy = 20/24 ≈ 0.833`
- Of the 25 matched items, 23 have the correct `item_kind` → `type_precision = 23/25 = 0.92`

---

## Aggregating across all 5 courses

Report all three scores per-course (5 rows), plus an unweighted macro-average across the 5
courses for each of the three scores (do not weight by item count — QMX 210 has far fewer items
than MGT 301 by design, since most of its items are intentionally undated; weighting by item
count would let strong performance on the larger fixtures mask weak performance on QMX 210's term-
mismatch handling specifically, which is the whole point of including that fixture).

Additionally report, per course, the **"hallucinated item count"** described in Step 1 (unmatched
candidate items) as a non-averaged diagnostic — a high hallucination count on a small fixture
(especially QMX 210, where the correct behavior for most schedule rows is to produce *no* item)
is a distinct failure mode from low recall/accuracy/precision and should not be hidden inside the
three ratios above.

## Non-scored fields (suggested lightweight check, not part of the three formal scores)

- `course.*`: exact string/boolean match on `code`, `grading_scheme`, `needs_review`,
  `review_reason`; fuzzy (≥0.8 similarity) match on `name`/`instructor_name`; exact match on
  `instructor_email` (or both `null`); exact match on `points_total_stated` (including both being
  `null` — a pipeline that computes and fills in a total the syllabus never stated should fail
  this check, per the task's explicit "never compute this yourself" rule for PHIL 104 and QMX 210).
- `grading_components`: match by `title` similarity (same threshold as item matching) plus
  `parent_title` equality (both `null`, or both naming the same matched parent), then check
  `weight_percent`/`points_possible`/`expected_count`/`count_best_n`/`drop_lowest_n` for exact
  equality (or both `null`) on each matched pair. Report as simple pass/fail per field, not a
  ratio — there are too few components per course (5–10) for a ratio to be statistically
  meaningful, and a single wrong percentage (e.g., ACCT 201's Homework total of 200, which does
  *not* equal the sum of its own line items — see README) is exactly the kind of thing that needs
  a human to see flagged directly rather than diluted into an average.
- `term_mismatch`: exact boolean match. This should be treated as a hard pass/fail gate for
  QMX 210 specifically — if a pipeline reports `term_mismatch: false` for QMX 210, that is a
  critical failure regardless of how well it scores on the three metrics above, since it means
  the pipeline would hand Kevin a set of confidently-wrong Spring dates for a Fall course.
