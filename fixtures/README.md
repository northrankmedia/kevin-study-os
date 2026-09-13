# Kevin Study OS — Ground-Truth Extraction Fixtures

This directory is the **independent oracle** for Task 3: hand-built, human-verified
"correct extraction" fixtures for 5 real St. Bonaventure University Fall 2026 syllabi.
No AI/Anthropic API was used to produce any part of `expected/*.json` — every field
was read and transcribed by hand from the source documents in `syllabi/`.

```
fixtures/
  syllabi/                        <- copies of the 5 original source documents
    MGT301_syllabus.docx
    ACCT201_syllabus.docx
    PHIL104_syllabus.docx
    MKT301_syllabus.pdf
    QMX210_syllabus.pdf
  expected/
    mgt301.json
    acct201.json
    phil104.json
    mkt301.json
    qmx210.json
  README.md                       <- this file
  rubric.md                       <- scoring method for comparing a pipeline's output against these fixtures
```

Term window used for all "Fall 2026" date math: **2026-08-31 to 2026-12-18**.
All weekly schedule headers in MGT 301, ACCT 201, PHIL 104, and MKT 301 line up
on Mondays (Aug 31, Sept 7, Sept 14, … all fall on a Monday in 2026); this was
verified programmatically before computing any derived date.

---

## How to read `date_precision`

- `exact` — a real, specific calendar date (and often a time) is stated or directly derivable.
- `range` — only a "week of" / multi-day window is stated, no single day is specified in the source.
- `tba` — the source explicitly says the date is not yet determined (e.g. "FINAL EXAM TBD").
- `external_ref` — the date is knowable but only by consulting a document outside the syllabus
  itself (e.g. "see the Academic Calendar"). This is treated as fundamentally different from
  `tba`: the exam date **exists** and Kevin can look it up, it just isn't printed on this page.
- `none` — no date applies at all (e.g. a recurring, unscheduled pop quiz, or a policy statement
  with no due date).

---

## Judgment calls, by course

### MGT 301 (Management & Organizational Behavior — John B. Stevens)

1. **Tariff PowerPoint dedup (required anchor).** This deadline is stated twice in the source:
   once in the Week 4 schedule line ("Chapt. 2. History of Management / Tariff P-Point & Outline
   due 9/20") and once in the Tariff Project body-prose section ("Power point due Sept 20th
   8:00 am."). These are the same deadline, not two separate items. The fixture contains
   **exactly one** `"Tariff PowerPoint"` item. We chose the prose mention as the canonical
   `source_text` because it is the only one of the two that states a time (8:00 am); the fixture
   sets `source_section: "body_prose"` for this reason. This is a deliberate dedup, not an
   omission — do not double-count it and do not expect the pipeline to reproduce two items here.
2. **Same dedup pattern applied to "Research Presentation Topic Selection."** This deadline also
   appears twice (schedule line "Research topic due in Moodle Sept. 24th" and prose "SUBMIT your
   research topic into Moodle in a WORD document by Sept. 24th."). We again produced one item,
   using the prose version (more descriptive, same date) as `source_text`.
3. **Test with no explicit date.** The Week 7 schedule line reads: "Wed-Thur  Test # (chapts
   1,2,3,5,6,8,11, Orgb 9, tariffs) (no chapt 4,7, 9, 10)" — no calendar date is attached to this
   exam anywhere in the document, even though the grading structure's "Two Exams" component
   implies two dated exams exist. We did **not** guess a date. The item has
   `due_start/due_end: null`, `date_precision: "none"`. Per the task's own guidance, this does
   not need a course-level `needs_review` flag — we are simply documenting it here so a reviewer
   knows this null is intentional, not a missed extraction.
4. **Course-level `needs_review` left `false` for MGT 301** despite several real ambiguities
   (see #3 above, and #5 below), because the task explicitly said the missing-Test-date case
   "does not need a course-level field, just document it." We extended that same reasoning to
   the other MGT-specific ambiguities below rather than introduce an inconsistent standard.
5. **Multi-section day ambiguity.** MGT 301 sections meet on different weekdays (M/W for some
   sections, T/Th for others — see header: "MGT 301 – 01, 02, 03  Fall 2026 M/W" plus a separate
   T-Th class time listed). Several schedule entries are only given at "Mon-Tue" / "Wed-Thur"
   granularity without stating which specific calendar day applies to a given section. Where this
   affects a due date (the in-class "Test", and the "Final exam" in Week 15), we used
   `date_precision: "range"` spanning the plausible weekday pair (e.g. Final Exam: Dec 9–10)
   rather than picking one arbitrarily.
6. **Break rows.** "Mid Term Break" (Oct 10–13, no class Oct 12) and the Thanksgiving break
   (class resumes Nov 30, so "no class" applies to the Wed/Thu of that week, Nov 25–26) are
   modeled with `item_kind: "break"` so the app does not nag Kevin about them as tasks.
7. **Prose-only deadlines beyond Tariff, read on a full pass of the document:** Research Topic
   Selection (Sept 24), Travel Abroad Assignment Materials (Nov 20, 8:00am), Travel Abroad
   PowerPoint (Nov 22, 8:00am), Travel Abroad Team Presentations (Nov 30 & Dec 2 — modeled as a
   `range`), Travel Abroad Team Evaluation (Dec 4), Basketball Game Assessment Paper (Dec 7),
   Research Presentation PowerPoint (Dec 10), Research Presentation Peer Comments (Dec 15). All
   of these were found only in body prose, not in the schedule table, and are included per the
   task's explicit instruction to read the full document rather than just the schedule.
8. **Recurring, undated items included for completeness, `date_precision: "tba"` or `"none"`:**
   "Reading Quiz" (implied every class by "prepare for quiz", no dates ever given — `"none"`),
   "Case Presentation 2-Page Outline" and "Case Presentation PowerPoint" (each team's due date is
   "day prior to presentation," which varies by team and is never resolved to a calendar date in
   the syllabus — `"tba"`), and "Warming House Team Paper, Evaluation & Individual Reflection"
   (due "within one week of the Warming House visit," and each team picks its own visit date —
   `"tba"`).
9. **Scope exclusion:** we did **not** create a separate syllabus item for every individual
   team's in-class case presentation slot (16 teams, spread across ~10 different weeks) or for
   each team's assigned Warming House visit date, since (a) these are not stated as calendar
   dates in the syllabus itself — they're assigned per-team during the semester — and (b) Kevin
   Study OS is tracking one student's deadlines, not a full class roster. This is a deliberate
   scope boundary, not a missed extraction.
10. **Grading structure hierarchy.** "Two Exams (20% each) 40%" is modeled as a parent component
    ("Two Exams", 40%) with two named children ("Exam (Test)" and "Final Exam", 20% each),
    matching the anchor's example pattern of parent/child exam rows.

### ACCT 201 (Introduction to Financial Accounting — Dr. Samantha Schachner)

1. **Stated total verified from the document, not assumed.** The "Evaluation Procedures" table
   in the syllabus explicitly lists: Exams 300, Final Exam 200, Homework 200, SmartBook 100, Lab
   Attendance Option 100, Class Attendance 100, **Total 1000**. We transcribed this exact total
   (1000) into `points_total_stated`, not any other value — this was read directly off the
   document, not computed or assumed by us.
2. **Homework point mismatch — deliberately preserved, not "fixed."** Summing the individually
   stated homework point values from the schedule table (Ch1: 30, Ch2: 40, Ch3: 40, Ch4: 20, Ch5:
   20, Ch6: 20, Ch7: 10, Ch8: 10, Ch9: 10, Ch10: 10, Ch12: 10) totals **220**, not the 200 stated
   as the "Homework" component total in the Evaluation Procedures table. This is a real
   inconsistency in the source syllabus itself. We transcribed both numbers faithfully: each
   homework item carries its own stated `points_possible`, and the `"Homework"` grading component
   still shows `points_possible: 200` exactly as printed. We did not silently reconcile,
   average, or override either number. This mismatch is a fixture decision, not a defect in our
   work — a correct extraction pipeline should reproduce the same mismatch, not "fix" it.
3. **SmartBook drop rule.** The syllabus states 11 chapters have a SmartBook assignment (Ch 1–10,
   12; Ch 11's SmartBook is not listed in the schedule table and appears to be genuinely absent),
   each worth 10 points, with the lowest score dropped, for a stated total of 100. We modeled this
   as `expected_count: 11, count_best_n: 10, drop_lowest_n: 1, points_possible: 100` on the
   `"SmartBook"` grading component — this is the one case in this fixture set where the
   stated math cleanly resolves (11 × 10 = 110, minus the one drop = 100), unlike the Homework
   mismatch above.
4. **Weekly ranges, not exact days.** The schedule table gives each assignment a "week of" range
   (e.g., "Week 3 Sept 14 – Sept 18") without specifying which class day within that week the
   item is actually due. We used `date_precision: "range"` with `due_start`/`due_end` set to the
   literal first/last day printed for that week in the table, for every homework/SmartBook/exam
   row. We did not guess a specific weekday.
5. **Exams 1–3 and Final Exam.** "Exams (3 @ 100 points each) 300" is modeled as a parent
   component with three 100-point children (Exam 1/2/3), matching the same pattern used for
   MGT 301's exam hierarchy. Final Exam is `date_precision: "tba"` because the schedule literally
   states "FINALS WEEK | FINAL EXAM TBD" — an honest TBA, not an external-reference case (there is
   no pointer to an Academic Calendar the way PHIL 104's final exam has).
6. **Lab Attendance and Class Attendance** are included as recurring, undated items
   (`date_precision: "none"`) since they are graded components with no specific due date — they
   represent an ongoing policy, not a discrete deadline.

### PHIL 104 (Introduction to Ethics — Dr. Gillham)

1. **`points_total_stated` left `null`, per the required anchor.** The syllabus states individual
   component point values (Attendance 10, Participation 10, Lingering Questions 14, Pop Reading
   Quizzes 10, Unit Quizzes 50, Moral Theory Writing Labs 60, Applied Ethics Writing Lab 20,
   Course Evaluation 5, Midterm Exam 25, Final Exam 25 — these sum to 229, plus "~5% extra
   credit"), but the document never states an overall total point value anywhere. We did not sum
   these components ourselves into `points_total_stated`; it is `null` as instructed.
2. **"Lingering Questions (14 points)" — read literally, not per the task's paraphrase.** The
   task description mentioned "various point values" for the 14 Lingering Questions, but the
   source document's ASSIGNMENTS section states plainly: `"Lingering Questions (14 points): ...
   there are no half points."` Read together with "no half points" and 14 LQs across 14 weeks,
   this means each LQ is worth exactly 1 point (all-or-nothing), for a 14-point total — not
   "various" per-LQ values. We trusted the actual document text over the task's paraphrase, per
   the instruction to verify facts against the source rather than assume. Each `"Lingering
   Question N"` item has `points_possible: 1`.
3. **Two-stage LQ deadline collapsed to one date.** Each Lingering Question requires an initial
   question (due Friday 11:59pm) **and** a reply to a classmate (due Sunday 11:59pm) to receive
   any credit at all ("You must ask a question and answer a classmate to receive any credit;
   there are no half points."). The schema has one `due_start`/`due_end`/`due_time` per item, so
   we used the **later, binding deadline** (Sunday 11:59pm) as the item's due date, since that is
   the point at which the LQ is either fully earned or fully lost. The Friday sub-deadline is not
   separately modeled. LQ13 (week of 11/30) and LQ14 (week of 12/7) fall in weeks after the
   Thanksgiving week, which itself has no LQ (see #4).
4. **No LQ during Thanksgiving week.** The schedule row for the week of 11/23 lists "UQ 4" but no
   LQ — this was read directly off the schedule table (there is no "LQ" token in that row, unlike
   every other week), consistent with the Friday of that week (11/27) being Thanksgiving-adjacent.
   We did not invent an LQ for that week.
5. **Midterm Exam anchor.** Modeled as `date_precision: "range"`, `due_start: 2026-10-26`,
   `due_end: 2026-10-30` (the full "week of 10/26" span), per the required anchor treatment. The
   same "week of" → Monday–Friday range convention was applied consistently to Unit Quizzes,
   Writing Labs, and Course Evaluation, since none of these state an exact class day either.
   Exception: Unit Quiz 4's range is truncated to Mon–Thu (11/23–11/26) rather than extending
   through Friday, because the syllabus explicitly says "No class on 11/27."
6. **Final Exam anchor — `external_ref`, not `tba`.** The syllabus states: "see the final exam
   schedule on the Academic Calendar for specific day and time assigned to your section of the
   course." The date genuinely exists and is knowable, just not printed here — this is
   `date_precision: "external_ref"`, deliberately distinct from `"tba"` (used elsewhere in this
   fixture set for ACCT 201 and QMX 210, where the date is not merely unpublished on this page,
   but literally not yet determined/decided at all).
7. **Pop Reading Quizzes** modeled as a single recurring item (`expected_count: 10`,
   `date_precision: "none"`) rather than 10 individual dated items, because they are explicitly
   described as random/unannounced ("pop") — there is no schedule to transcribe.
8. **Attendance/Participation** mapped to `item_kind: "participation"` for both, since the schema
   enum has no distinct `"attendance"` kind — documented here as a deliberate mapping choice.

### MKT 301 (Principles of Marketing — Kristen Ryan, online/asynchronous section)

1. **Test open/close windows — required anchor.** The "Weekly Class Rhythm/Due Dates" table
   (last page of the PDF) gives each test a real Opens/Closes window with different times on each
   end, e.g. Test 1: "Opens 9/25 at 8am ... Closes 9/27 at 8 pm." We modeled `due_start`/`due_end`
   as the actual deadline (9/27, the Closes date), `available_from: 2026-09-25T08:00:00`,
   `available_until: 2026-09-27T20:00:00`, and `date_precision: "exact"` — deliberately **not**
   collapsed into a `"range"` from 9/25–9/27, since that would discard the real, precise deadline
   in favor of a vaguer window. Test 2 (Opens 11/6, Closes 11/8) and Test 3 (Opens 12/14, Closes
   12/16) follow the identical pattern. We cross-verified each Opens/Closes weekday against the
   computed 2026 calendar (e.g., 9/25 = Friday, 9/27 = Sunday) before finalizing the fixture.
2. **FG Project deadline — required anchor.** "FG projects due 11/22 at 11:55 pm" is transcribed
   exactly: `due_start`/`due_end: 2026-11-22`, `due_time: "23:55"`, `date_precision: "exact"`. No
   `available_from` is modeled for this item since the syllabus never states an opens-time for the
   FG project (unlike the tests).
3. **1000-point total verified from the document**, not assumed: "Total Possible Points 1000
   points" appears explicitly in the Evaluation Procedures table, alongside WEA 250 + WEA
   Discussion Boards 100 + Exams 300 + FG 250 + FG Presentation 100 = 1000.
4. **Weekly Engagement Activities (WEA) — modeled per-week, not as one summary item.** Unlike the
   PHIL 104 Pop Quizzes (genuinely unscheduled), each WEA in MKT 301 has a computed, derivable due
   date: the Weekly Class Rhythm table (page 12 of the PDF) shows, by column position, "WEA
   posted before 8am" under Monday and "WEA due in Moodle Dropbox before noon" under **Thursday**
   (verified via the PDF's word-level x-coordinates, not just reading-order text extraction, since
   the visual table columns do not survive naive text extraction). We therefore computed each
   named WEA's due date as the Thursday of its corresponding week (e.g., "Ansoff WEA," week of
   Sept 7, due Thursday Sept 10) and verified each computed date against Python's weekday
   calculation before finalizing. We produced 9 individually dated WEA items (weeks 2, 3, 4, 5, 6,
   7, 11, 14, 15); weeks where a Test or FG deadline replaces the usual WEA (weeks 4, 10, 12, 13)
   or where no WEA/assignment is listed at all (weeks 8, 9) were not given an invented WEA item.
   Week 1's "Franciscan Values Ice Breaker" is explicitly stated elsewhere as "not a graded WEA"
   and was excluded from `syllabus_items` entirely (it still counts toward the `expected_count: 10`
   on the WEA grading component, since 10 numbered WEA topics are listed separately in the
   syllabus's "WEA Topics" section, distinct from the icebreaker).
5. **Discussion Board responses** modeled as a single recurring item rather than one dated entry
   per week, because — unlike the WEA due date — the Discussion Board question itself is only
   posted after the WEA is submitted that week ("After WEAs are submitted for the week, I will
   post a discussion question related to the WEA"), meaning its Thursday-noon post time is
   contingent on the professor's action, not a hard published date; only the closing deadline
   (Sunday 11:55pm, from the Rhythm table) is truly fixed in the syllabus, and it recurs on the
   same weekly cadence as the WEAs above. We captured this as one recurring item
   (`expected_count: 10`) rather than duplicating 9 near-identical dated rows.
6. **Break rows** ("MIDTERM BREAK Monday/Tuesday October 12-13" and "Thanksgiving Break – No
   Classes ... Wed Nov 25- Sun Nov 29") are `item_kind: "break"`.

### QMX 210 (Quantitative Applications for Business Students — Evelyn Bysiek)

1. **Term mismatch — required anchor.** Page 1 of the PDF states "Spring 2026" directly under the
   course title, and every single schedule date in the "Tentative Schedule of Topics" runs
   1/21 through 5/6 (January–May), including an explicit "No Class – Winter Break" row (3/2–3/6)
   that has no equivalent in a Fall semester at all. This is unambiguously a Spring 2026 syllabus
   that was reused/relisted for a Fall 2026 course offering. Per the task's instruction, we set
   `course.needs_review: true`, `course.review_reason: "term_mismatch"`, and the top-level
   `"term_mismatch": true`. This is the only fixture of the 5 with `term_mismatch: true`.
2. **Grading components populated normally.** The 30/20/15/15/20% breakdown (Examinations,
   Homework, Quizzes, Attendance and Preparation, Final Exam — summing to 100%) is real,
   term-independent information and was transcribed as usual.
3. **Zero invented Fall-2026 dates — the core constraint.** For `syllabus_items`, every
   `due_start`/`due_end`/`due_time`/`available_from`/`available_until` field is `null`, and
   `date_precision` is `"none"` (or `"tba"` for the Final Exam, which is explicitly stated as TBA
   in the source regardless of the term mismatch). We deliberately chose **not** to copy the
   Spring 2026 dates (e.g., "2/18," "3/30") into any date field, even flagged, because a date
   field populated with a real-looking ISO date is exactly the kind of value a downstream
   consumer might trust or silently coerce — the only safe way to convey "this date exists in the
   source but must not be used" is to leave the structured date fields empty and preserve the
   original text only inside `source_text` (which a human reviewer reads, rather than a scheduler
   that might act on a date field). We chose to **include** the two named exams and the "TBA"
   final exam as items (with null dates) rather than omitting them entirely, since their
   existence and point-weighting are still useful signal for a reviewer auditing this fixture;
   we omitted the Spring-only "Winter Break" row entirely, since it is a school-calendar artifact
   with no Fall-term analog and no value even as a null-dated item.
4. **Quizzes drop-rule.** "There will be approximately 5 quizzes given throughout the semester.
   The best 4 quiz grades will be used" is modeled as a grading-component drop rule
   (`expected_count: 5, count_best_n: 4, drop_lowest_n: 1`) rather than as a syllabus item, since
   the component-level field already fully captures this policy and there is no calendar date to
   attach to a quiz item in the first place (quizzes are undated in the source, and doubly so
   given the term mismatch). This was our choice between the two options the task allowed for;
   we did not also add a redundant undated "Quizzes" syllabus item.
5. **Homework** is included as a single recurring, undated item ("At the end of almost every
   class, a homework assignment will be given") since it is graded but never tied to specific
   calendar dates even in the (wrong) Spring schedule.

---

## Cross-cutting judgment calls

- **`item_kind` mapping choices not explicit in the schema description:** Team-evaluation-style
  submissions use `"admin"`; general reflection/assessment papers with no closer fit use
  `"other"`; anything graded as attendance or in-class engagement uses `"participation"` (there
  is no separate `"attendance"` enum value).
- **All "week of" ranges** (used across MGT 301, ACCT 201, PHIL 104, MKT 301) use the literal
  first and last calendar day printed for that week in the schedule table/prose, not an assumed
  Monday–Friday unless that is what's printed (see PHIL 104 Unit Quiz 4 exception, and ACCT 201's
  explicit "Week 7 Oct 14 – Oct 16" 3-day short week after the midterm break).
- **Instructor name formatting** follows what the syllabus itself uses in the header/signature
  block (e.g., "Dr. Gillham" has no stated first name anywhere in the PHIL 104 document, so that
  exact string is used rather than inventing a first name).
- **No item was invented that isn't traceable to a specific, quoted `source_text`.** Every dated
  item in every fixture can be verified by searching for its `source_text` string inside the
  corresponding file in `syllabi/` (docx files were read via a paragraph/table-aware XML
  extraction script, not a raw substring scan of the OOXML, since Word frequently splits a single
  visible sentence across multiple `<w:r>` runs — searching the rendered paragraph text, not the
  raw XML, is the correct level of verification and is what we used throughout).
