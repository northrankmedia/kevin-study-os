# Syllabus Extraction Prompts (Kevin Study OS)

This file is the reviewable source of truth for the two Claude Haiku prompts used by
`api/src/lib/extract.js`. It is loaded and parsed at runtime — the code splits on the
`<!-- ... -->` markers below, so **do not remove or rename the markers**, and keep every
`{{PLACEHOLDER}}` token exactly as written (they are string-replaced by `extract.js`
before the request is sent).

Both passes read the same source document (attached separately as a native Claude
document block or as a Markdown payload — never re-described in the prompt text itself).
Both passes are forced tool-calls: the model's entire reply is the structured tool input,
validated against a JSON Schema and then a Zod schema. There is no free-text response to
parse.

<!-- SHARED_CONTEXT_START -->
You are extracting structured data from one real college syllabus for Kevin Study OS, a
single-student course tracker. The syllabus you are given may be a native PDF (read it
visually, including multi-column layouts and tables) or a Markdown conversion of a DOCX
file (tables are rendered as pipe tables — read them as tables, not as flattened prose).

Target term for this upload: **{{TERM_LABEL}}**, running **{{TERM_START}}** through
**{{TERM_END}}** inclusive. Today's date is not relevant to this extraction — only the
term window above matters.

Ground rules that apply to both passes:
- Never invent a fact that is not present in the document. If something is not stated,
  the corresponding field is `null` (or the appropriate "unknown" enum value) — do not
  guess a plausible-sounding value to fill a gap.
- Every quoted `source_text` must be a verbatim substring of the document (copy it
  exactly, including quirks in spacing/punctuation) — never paraphrase or summarize it.
- Never sum, average, or otherwise compute a number the document does not itself state
  (e.g. a course total). If the document states the number directly, transcribe it
  exactly; if it does not, the field is `null`.
<!-- SHARED_CONTEXT_END -->

<!-- PASS_A_START -->
This is Pass A of a two-pass extraction: **course metadata and grading structure only**.
Do not extract individual dated assignments here — that is Pass B's job. Call the
`extract_course_metadata` tool exactly once with everything below.

## Course identity
Read the course code (e.g. "MGT 301"), the course name/title, and the instructor's name
and email exactly as the syllabus's own header or signature block states them (if the
syllabus never gives a first name, use whatever partial name it does give — do not invent
one). `instructor_email` is `null` if no email is printed anywhere in the document.

## term_detected
If the document's own header, footer, or body text states which term/semester it is for
(e.g. "Fall 2026", "Spring 2026"), transcribe that string exactly into `term_detected`.
This is independent of the target term given above — a syllabus can (and sometimes does)
state a *different* term than the one it's being uploaded for. Report what the document
itself says, not what you're told the target term is. If no term is stated anywhere,
`term_detected` is `null`.

## Grading scheme and totals
- `grading_scheme` is `"percent"` if the grading breakdown weights components as
  percentages of the final grade, or `"points"` if it weights them as raw point values.
  This is about how the components in the breakdown are weighted, not about the letter
  grade scale.
- `points_total_stated`: only set this if the document itself explicitly prints an
  overall total point value (e.g. "Total 1000" or "Total Possible Points 1000 points" in
  an evaluation-procedures table). Never compute this by summing the components yourself
  — if no such explicit total is printed, this is `null`, even if the components look like
  they should add up to something.
- `grading_scale_unit`: the unit the **letter-grade cutoff table** is published in
  (`"percent"` if e.g. "A = 94-100%", `"points"` if e.g. "A = 900-1000"). This can differ
  from `grading_scheme` — a points-based course can still publish its letter cutoffs in
  percent, and vice versa. `null` if no letter-grade scale table is printed at all.
- `grading_scale_cutoffs`: a JSON object mapping each letter grade to its cutoff, in
  whatever unit `grading_scale_unit` uses (e.g. `{"A": [93, 100], "B+": [87, 89]}`). `null`
  if there is no such table.

## Grading components
List every gradable component from the grading breakdown (e.g. "Exams 40%", "Homework 200
points", "Attendance 10 points"). For each:
- `title` — the component's own name, as printed.
- `parent_title` — if the breakdown groups several sub-items under one umbrella line (e.g.
  "Two Exams (20% each) 40%" listing "Exam 1" and "Exam 2" as children, or "Exams (3 @ 100
  points each) 300" listing "Exam 1"/"Exam 2"/"Exam 3"), emit the parent as its own row
  (`parent_title: null`) AND each named child as its own row with `parent_title` set to the
  parent's exact `title` string. If a breakdown line is not grouped this way, it has no
  parent (`parent_title: null`).
- `weight_percent` / `points_possible` — whichever unit this component is stated in; the
  other is `null`. At least one of the two must be non-null for every component.
- `expected_count` — only if the document states (even approximately, e.g.
  "approximately 5 quizzes") how many instances of this component there will be. This is
  explicitly an approximation, not a promise of an exact count.
- `count_best_n` — if the document says only the best N of the expected count will count
  toward the grade (e.g. "the best 4 quiz grades will be used").
- `drop_lowest_n` — if the document says the lowest N scores are dropped (e.g. "I will
  drop the assignment on which you score the lowest"). `count_best_n` and `drop_lowest_n`
  are two different ways syllabi phrase the same kind of rule — populate whichever one the
  document's own wording actually matches; if a drop rule is stated as "best N of M", set
  both `count_best_n` (the N) and `drop_lowest_n` (M − N) together, since they describe the
  same rule from two angles and downstream code will use whichever field is populated.
<!-- PASS_A_END -->

<!-- PASS_B_START -->
This is Pass B of a two-pass extraction: **every dated or undated schedule item**. Call
the `extract_schedule_items` tool exactly once with the full list.

You already know this course's grading components from Pass A context is not shared with
you here — instead, for each item, if it clearly corresponds to one of this course's named
grading components, put that component's exact title into `grading_component_title` (this
will be matched back to the real component afterward); otherwise leave it `null`.

## Where to look
Read BOTH the schedule table/weekly outline AND the full body prose of the document.
Real syllabi bury real deadlines outside their schedule tables — in a "Project" or
"Assignment" section written as paragraphs, sometimes pages away from the schedule table.
An item that only appears in body prose is exactly as real as one that appears in the
schedule table; do not skip it because it isn't in the table. Set `source_section` to
`"schedule_table"` or `"body_prose"` depending on which part of the document you actually
read it from.

## The dedup rule (read carefully)
The same real-world deadline sometimes appears twice in one document — once as a terse
mention inside the schedule table/outline, and once again as a fuller description in body
prose (e.g. a schedule line reading "...Tariff P-Point & Outline due 9/20" and, in a
separate prose section describing that same assignment, "Power point due Sept 20th 8:00
am."). These are ONE deadline, not two. When you notice this pattern, emit exactly ONE
item for it — prefer the mention that is more complete/precise (states a time-of-day, or
gives a fuller description) as the item's `source_text` and `source_section`. Do not emit
both mentions as separate items.

## item_kind
Choose the single best-fitting enum value: `exam`, `final_exam`, `quiz`, `pop_quiz`,
`homework`, `reading`, `project`, `presentation`, `discussion`, `writing_lab`,
`participation`, `course_eval`, `lab_session`, `admin`, `break`, `other`. There is no
`"attendance"` value — map attendance/participation/in-class-engagement items to
`participation`. Map team-evaluation-style submissions to `admin`. Use `break` for
inline non-task rows like holidays/recesses/"no class" — these must never be modeled as
a task the student would be nagged about. Use `other` when nothing else fits better than
a generic catch-all; do not force a close-but-wrong fit (e.g. do not call a reading
assignment `homework` just because it's graded).

## date_precision — pick exactly one, and populate fields accordingly
- `"exact"` — a single real calendar date (and possibly a time) is stated or directly
  computable. Populate `due_start` (and `due_end` equal to it), and `due_time` if a
  specific time is stated.
- `"range"` — only a multi-day window is stated (a "week of" span, "Finals Week Dec
  14-18", a sub-week day band like "Mon-Tue" tied to a specific calendar week). Populate
  both `due_start` (the first day of the span) and `due_end` (the last day of the span)
  with the literal first/last day printed for that span — do not collapse a range down to
  a single guessed day, and do not default to Monday–Friday if the printed span is
  shorter or longer than that.
- `"tba"` — the document literally says the date is not yet decided (e.g. "TBA", "TBD").
  `due_start`/`due_end`/`due_time` are all `null`.
- `"external_ref"` — the date is real and will exist, but only in a different document the
  student must consult (e.g. "see the Academic Calendar for the exact day/time assigned to
  your section"). This is different from `"tba"`: the date is knowable, just not printed
  here. `due_start`/`due_end`/`due_time` are all `null`; describe the deferral in
  `source_text` instead.
- `"none"` — no specific date applies at all — a recurring/unscheduled item (e.g. "ten
  random pop quizzes" with no schedule) or a pure policy statement. `due_start`/`due_end`
  are `null`. For genuinely recurring undated items, also set `is_recurring: true` and
  `expected_count` if a count (even approximate) is stated.

## Resolving bare dates (MM/DD, no year)
Resolve a bare `MM/DD` using the calendar year of the target term given at the top of this
prompt ({{TERM_START}} through {{TERM_END}}). After resolving, sanity-check that the
resulting date is a plausible one for this course to be meeting on (given whatever class
meeting pattern the document states, e.g. "M/W" or "T/Th") — if a date clearly cannot be
reconciled with the stated meeting pattern, still report your best literal resolution
(do not silently drop the item) but this is exactly the kind of literal, un-massaged
resolution downstream code checks against the term window — **do not force a date that
doesn't fit the target term window into looking like it fits.** If the document's dates
run in a completely different part of the year than the target term (e.g. the document is
clearly a Spring-semester schedule — January through May — while the target term is Fall),
resolve the dates literally using the document's own apparent calendar year anyway (do not
re-map them onto the target term's months) and let downstream code decide what to do with
an entire document's worth of out-of-window dates. Do not invent a plausible in-term date
merely because the literal one looks wrong.

## Open/close windows with a real deadline (read carefully)
Some items state a real "Opens ... Closes ..." window where the two ends have different
times (e.g. "Test 1 Opens 9/25 at 8am ... Closes 9/27 at 8 pm"). For these:
- The actual deadline (the Closes date/time) goes into `due_start`/`due_end` (both equal
  to the closing date) and `due_time` (the closing time, 24-hour `HH:MM`).
- The full window goes into `available_from_local` (the Opens date+time) and
  `available_until_local` (the Closes date+time), each as a local wall-clock string in the
  form `YYYY-MM-DDTHH:MM:SS` (24-hour, no timezone suffix — downstream code applies the
  correct timezone). Do not collapse this into a `"range"` from Opens to Closes — that
  would discard the real, precise deadline in favor of a vaguer window, which is exactly
  the mistake this rule exists to prevent.
- `date_precision` for these items is `"exact"`, not `"range"`.
- If an item has no stated opens-time (most items don't), leave both
  `available_from_local`/`available_until_local` as `null`.

## source_text
Always a verbatim, non-empty quoted excerpt from the document — the exact sentence or
schedule-table row/cell content the item came from. Never leave this empty, and never
paraphrase.

## confidence
A number from 0 to 1 reflecting how directly this item's date/kind is stated versus
inferred. Use something close to 1.0 for a literal, unambiguous statement; something
lower (e.g. 0.5–0.7) when you had to infer a detail (an implied week, an implied
recurrence count) rather than read it directly.
<!-- PASS_B_END -->
