'use strict';

/**
 * Core course-profile synthesis logic for Kevin Study OS.
 *
 * Orchestrates a single Claude Sonnet synthesis call (forced tool-use,
 * `report_course_profile`) that reasons across everything Kevin has written
 * for one course so far — plus the course's own grading structure, any
 * syllabus items relevant to exam scope, and the previous profile version if
 * one exists — to produce a running `summary_md` and a ranked `exam_topics`
 * list. See `prompts/course-profile.md` for the prompt itself and the full
 * ranking-signal rules.
 *
 * Follows the same plumbing conventions as `extract.js` (the completed
 * syllabus-extraction task): forced tool-use, Zod validation of the tool
 * output, a bounded one-retry on validation failure, and a dedicated
 * validation-error class carrying the raw responses for debugging. This is a
 * different call in spirit (synthesis/reasoning over accumulated notes, not
 * structured extraction from one document) and always uses Sonnet, never
 * Haiku — see the task boundaries.
 *
 * Versioning, locking, and persistence (append-only rows, the advisory-lock
 * acquisition, the two-step `is_current` flip) all happen in
 * `generateProfile` below — see `supabase/README.md` §3 and §4 for why
 * `notes_through_at` is a timestamptz watermark and why both DB uniqueness
 * constraints on `course_profiles` are required together.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { CourseProfileSchema } = require('../../../shared/contract.js');
const { getSupabaseClient } = require('./supabaseClient');
const { withCourseProfileLock } = require('./profileLock');
const { titleSimilarity } = require('./extract');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'course-profile.md');
const PROMPT_START_MARKER = '<!-- PROFILE_PROMPT_START -->';
const PROMPT_END_MARKER = '<!-- PROFILE_PROMPT_END -->';

const TOOL_NAME = 'report_course_profile';
const MAX_SYNTHESIS_ATTEMPTS = 2; // one real attempt + one bounded retry, same as extract.js

// Below this many active notes, generateProfile never calls Claude — no
// summary, hallucinated or otherwise, can be grounded in fewer than 2 notes.
const MIN_NOTES_REQUIRED = 2;

// Two exam-topic entries whose normalized labels are at least this similar
// are treated as the same underlying topic and merged — a deterministic
// backstop for the prompt's own "don't emit near-duplicate topics" rule,
// same spirit (and same similarity primitive) as extract.js's dedupItems.
const TOPIC_SIMILARITY_THRESHOLD = 0.82;

const PLACEHOLDER_SONNET_MODEL = 'replace-with-an-exact-pinned-model-id';
const SONNET_MODEL =
  process.env.ANTHROPIC_MODEL_SONNET && process.env.ANTHROPIC_MODEL_SONNET !== PLACEHOLDER_SONNET_MODEL
    ? process.env.ANTHROPIC_MODEL_SONNET
    : 'claude-sonnet-5';

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when Claude's tool-call output fails Zod validation on both the
 * initial attempt and the single retry. Carries the raw model output so the
 * caller can log it for debugging rather than silently discarding it — no
 * profile row is ever written from unvalidated output.
 */
class ProfileValidationError extends Error {
  constructor(message, { rawResponses }) {
    super(message);
    this.name = 'ProfileValidationError';
    this.rawResponses = rawResponses;
  }
}

// ============================================================================
// Anthropic client (Sonnet only — see task boundaries)
// ============================================================================

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ============================================================================
// Prompt loading (splits on the <!-- PROFILE_PROMPT_START/END --> markers,
// same convention as extract.js's marker-based prompt file)
// ============================================================================

let cachedPromptSource = null;

function loadPromptSource() {
  if (cachedPromptSource === null) {
    cachedPromptSource = fs.readFileSync(PROMPT_PATH, 'utf8');
  }
  return cachedPromptSource;
}

function buildPromptText() {
  const source = loadPromptSource();
  const start = source.indexOf(PROMPT_START_MARKER);
  const end = source.indexOf(PROMPT_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('course-profile.md is missing the PROFILE_PROMPT_START / PROFILE_PROMPT_END markers');
  }
  return source.slice(start + PROMPT_START_MARKER.length, end).trim();
}

// ============================================================================
// Tool schema (Anthropic JSON Schema `input_schema` for forced tool-use)
// ============================================================================

const TOOL = {
  name: TOOL_NAME,
  description: 'Report the synthesized course profile: a running summary and ranked exam topics.',
  input_schema: {
    type: 'object',
    properties: {
      summary_md: { type: 'string' },
      exam_topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            rank: { type: 'integer' },
            rationale: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
            confidence: { type: 'number' },
          },
          required: ['topic', 'rank', 'rationale', 'evidence', 'confidence'],
        },
      },
    },
    required: ['summary_md', 'exam_topics'],
  },
};

// ============================================================================
// Zod validation — mirrors the tool schema, plus two code-owned gates that
// enforce the prompt's own ground rules rather than trusting the model:
//   - the rationale must literally name which signal(s) it draws from
//     ("syllabus" and/or "notes"), per the prompt's `exam_topics` section.
//   - at least one evidence snippet per topic must be a verbatim substring
//     of something Kevin actually wrote or the syllabus actually states —
//     mirrors extract.js's "never invented, always verbatim" convention for
//     source_text, applied here to exam_topics' evidence.
// ============================================================================

function buildOutputSchema(sourceTexts) {
  return z
    .object({
      summary_md: z.string().min(1),
      exam_topics: z.array(
        z.object({
          topic: z.string().min(1),
          rank: z.number().int().min(1),
          rationale: z.string().min(1),
          evidence: z.array(z.string().min(1)).min(1),
          confidence: z.number().min(0).max(1),
        })
      ),
    })
    .superRefine((val, ctx) => {
      val.exam_topics.forEach((topic, index) => {
        if (!/syllabus|notes?/i.test(topic.rationale)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['exam_topics', index, 'rationale'],
            message: 'rationale must explicitly name which signal(s) it draws from ("syllabus" and/or "notes")',
          });
        }
        const hasVerbatimEvidence = topic.evidence.some((snippet) =>
          sourceTexts.some((source) => source.includes(snippet))
        );
        if (!hasVerbatimEvidence) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['exam_topics', index, 'evidence'],
            message: 'at least one evidence snippet must be a verbatim substring of a note or syllabus item',
          });
        }
      });
    });
}

// ============================================================================
// Claude invocation (forced tool-use, bounded retry on invalid output — same
// shape as extract.js's callClaudeTool)
// ============================================================================

async function callClaudeProfileTool({ client, model, promptText, dataBlockText, sourceTexts }) {
  const schema = buildOutputSchema(sourceTexts);
  const rawResponses = [];
  let lastIssues = null;

  for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
    const promptSuffix =
      attempt === 1
        ? ''
        : `\n\nYour previous reply did not match the required schema. Validation errors:\n${JSON.stringify(lastIssues, null, 2)}\n\nCall the tool again with corrected input that satisfies every field.`;

    // eslint-disable-next-line no-await-in-loop
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: dataBlockText },
            { type: 'text', text: promptText + promptSuffix },
          ],
        },
      ],
    });

    rawResponses.push(response);

    const toolUse = (response.content || []).find((block) => block.type === 'tool_use');
    if (!toolUse) {
      lastIssues = [{ message: 'no tool_use block in response' }];
      continue; // eslint-disable-line no-continue
    }

    const result = schema.safeParse(toolUse.input);
    if (result.success) {
      return { parsed: result.data, rawResponses };
    }
    lastIssues = result.error.issues;
  }

  throw new ProfileValidationError(
    `Course profile synthesis failed schema validation after ${MAX_SYNTHESIS_ATTEMPTS} attempt(s): ${JSON.stringify(lastIssues)}`,
    { rawResponses }
  );
}

// ============================================================================
// Data block assembly — the course record, grading components, syllabus
// items, notes (chronological), and previous profile, attached as a single
// text block in the user turn (never re-described in the prompt's own text —
// see course-profile.md's own module doc comment).
// ============================================================================

function formatGradingComponent(component) {
  const weight =
    component.weight_percent != null
      ? `${component.weight_percent}%`
      : component.points_possible != null
        ? `${component.points_possible} pts`
        : 'weight unspecified';
  const extras = [];
  if (component.expected_count != null) extras.push(`expected_count=${component.expected_count}`);
  if (component.count_best_n != null) extras.push(`count_best_n=${component.count_best_n}`);
  if (component.drop_lowest_n != null) extras.push(`drop_lowest_n=${component.drop_lowest_n}`);
  return `- ${component.title} — ${weight}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

function formatSyllabusItem(item) {
  const dateInfo = item.due_start
    ? item.due_end && item.due_end !== item.due_start
      ? `${item.due_start} .. ${item.due_end}`
      : item.due_start
    : item.date_precision;
  return `- [${item.item_kind}] ${item.title} (${dateInfo}) — source: "${item.source_text}"`;
}

function formatNote(note) {
  const heading = `${note.note_date}${note.title ? ` — ${note.title}` : ''}`;
  return `### ${heading}\n${note.body_md}`;
}

function buildDataBlock({ course, gradingComponents, syllabusItems, notes, previousProfile }) {
  const parts = [];

  parts.push('## Course');
  parts.push(`Code: ${course.code}`);
  parts.push(`Name: ${course.name}`);
  parts.push(`Grading scheme: ${course.grading_scheme}`);

  parts.push('\n## Grading components');
  parts.push(gradingComponents.length ? gradingComponents.map(formatGradingComponent).join('\n') : '(none recorded)');

  parts.push('\n## Syllabus items (for exam-scope signals)');
  parts.push(syllabusItems.length ? syllabusItems.map(formatSyllabusItem).join('\n') : '(none recorded)');

  parts.push("\n## Kevin's notes for this course, oldest first");
  parts.push(notes.map(formatNote).join('\n\n'));

  parts.push('\n## Previous profile version (continuity context)');
  if (previousProfile) {
    parts.push(`Version ${previousProfile.version} summary:\n${previousProfile.summary_md}`);
    parts.push('Previous exam topics:');
    parts.push(
      (previousProfile.exam_topics || []).map((topic) => `${topic.rank}. ${topic.topic} — ${topic.rationale}`).join('\n')
    );
  } else {
    parts.push('(none — this is the first profile for this course)');
  }

  return parts.join('\n');
}

function collectSourceTexts({ notes, syllabusItems }) {
  return [...notes.map((note) => note.body_md), ...syllabusItems.map((item) => item.source_text)];
}

// ============================================================================
// Chronological ordering — sorted by note_date, then by created_at as the
// tiebreak. The created_at tiebreak is what actually matters here: it's the
// same sub-day precision course_profiles.notes_through_at exists to capture
// (see supabase/README.md §3) — the "latest note" for the watermark must be
// resolvable even when several notes share a note_date.
// ============================================================================

function sortNotesChronological(notes) {
  return [...notes].sort((a, b) => {
    if (a.note_date !== b.note_date) return a.note_date < b.note_date ? -1 : 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

// ============================================================================
// Exam-topic post-processing — deterministic, code-owned (per the prompt's
// own comment: "deterministic renumbering happens in code afterward").
// ============================================================================

function dedupExamTopics(topics) {
  const sorted = [...topics].sort((a, b) => a.rank - b.rank);
  const used = new Array(sorted.length).fill(false);
  const result = [];

  for (let i = 0; i < sorted.length; i += 1) {
    if (used[i]) continue; // eslint-disable-line no-continue
    const winner = { ...sorted[i], evidence: [...sorted[i].evidence] };
    used[i] = true;

    for (let j = i + 1; j < sorted.length; j += 1) {
      if (used[j]) continue; // eslint-disable-line no-continue
      if (titleSimilarity(sorted[i].topic, sorted[j].topic) >= TOPIC_SIMILARITY_THRESHOLD) {
        for (const snippet of sorted[j].evidence) {
          if (!winner.evidence.includes(snippet)) winner.evidence.push(snippet);
        }
        winner.confidence = Math.max(winner.confidence, sorted[j].confidence);
        used[j] = true;
      }
    }

    result.push(winner);
  }

  return result;
}

function renumberRanks(topics) {
  return [...topics].sort((a, b) => a.rank - b.rank).map((topic, index) => ({ ...topic, rank: index + 1 }));
}

function postProcessExamTopics(rawTopics) {
  return renumberRanks(dedupExamTopics(rawTopics));
}

// ============================================================================
// Top-level orchestration
// ============================================================================

/**
 * The critical section run while the course-profile lock is held: gathers
 * everything the prompt reasons over, calls Claude, post-processes the exam
 * topics, and writes a new append-only version.
 *
 * @returns {Promise<object|{status:'not_enough_notes'}|null>} the newly
 *   current profile row (contract-shaped), `{status:'not_enough_notes'}` if
 *   fewer than MIN_NOTES_REQUIRED active notes exist, or `null` if Claude's
 *   output never passed validation (logged, never persisted).
 */
async function runRegeneration({ courseId, supabase, client, model }) {
  const { data: rawNotes, error: notesErr } = await supabase
    .from('notes')
    .select('*')
    .eq('course_id', courseId)
    .is('deleted_at', null);
  if (notesErr) throw Object.assign(new Error(notesErr.message), { status: 500 });

  const notes = sortNotesChronological(rawNotes || []);
  if (notes.length < MIN_NOTES_REQUIRED) {
    return { status: 'not_enough_notes' };
  }

  const { data: course, error: courseErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .is('deleted_at', null)
    .single();
  if (courseErr || !course) {
    throw Object.assign(new Error(`course ${courseId} not found`), { status: 404 });
  }

  const { data: gradingComponents } = await supabase.from('grading_components').select('*').eq('course_id', courseId);
  const { data: syllabusItems } = await supabase
    .from('syllabus_items')
    .select('*')
    .eq('course_id', courseId)
    .is('deleted_at', null);
  const { data: previousProfile } = await supabase
    .from('course_profiles')
    .select('*')
    .eq('course_id', courseId)
    .eq('is_current', true)
    .maybeSingle();

  const sourceTexts = collectSourceTexts({ notes, syllabusItems: syllabusItems || [] });
  const dataBlockText = buildDataBlock({
    course,
    gradingComponents: gradingComponents || [],
    syllabusItems: syllabusItems || [],
    notes,
    previousProfile,
  });

  let parsed;
  try {
    ({ parsed } = await callClaudeProfileTool({
      client,
      model,
      promptText: buildPromptText(),
      dataBlockText,
      sourceTexts,
    }));
  } catch (err) {
    if (err instanceof ProfileValidationError) {
      console.error(`[profile] synthesis failed schema validation for course ${courseId}:`, err.message);
      return null;
    }
    throw err;
  }

  const examTopics = postProcessExamTopics(parsed.exam_topics);
  const latestNote = notes[notes.length - 1];

  const { data: maxVersionRow } = await supabase
    .from('course_profiles')
    .select('version')
    .eq('course_id', courseId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxVersionRow ? maxVersionRow.version : 0) + 1;

  const newProfileId = crypto.randomUUID();
  const { data: inserted, error: insertErr } = await supabase
    .from('course_profiles')
    .insert({
      id: newProfileId,
      course_id: courseId,
      version: nextVersion,
      summary_md: parsed.summary_md,
      exam_topics: examTopics,
      notes_through_at: latestNote.created_at,
      notes_through_note_id: latestNote.id,
      model,
      is_current: false,
    })
    .select()
    .single();
  if (insertErr || !inserted) {
    throw Object.assign(new Error(insertErr ? insertErr.message : 'profile insert failed'), { status: 500 });
  }

  // Flip old off, then new on — never the reverse. Flipping the new row on
  // first would (on real Postgres) momentarily violate the partial unique
  // index on is_current (two true rows at once); this order's worst case if
  // interrupted mid-way is zero current rows, never a duplicate/conflicting
  // is_current state. See supabase/README.md §4.
  if (previousProfile) {
    await supabase.from('course_profiles').update({ is_current: false }).eq('id', previousProfile.id);
  }

  const { data: flipped, error: flipErr } = await supabase
    .from('course_profiles')
    .update({ is_current: true })
    .eq('id', newProfileId)
    .select()
    .single();
  if (flipErr || !flipped) {
    throw Object.assign(new Error(flipErr ? flipErr.message : 'failed to flip is_current'), { status: 500 });
  }

  return CourseProfileSchema.parse(flipped);
}

/**
 * Regenerates the course profile for `courseId`, taking the advisory-lock
 * equivalent for the duration (see `profileLock.js`) so two near-simultaneous
 * regenerations for the same course never both proceed.
 *
 * @param {string} courseId
 * @param {object} [opts]
 * @param {object} [opts.supabase] - defaults to the shared client
 * @param {object} [opts.client] - Anthropic SDK client (or test double);
 *   defaults to the shared Sonnet client
 * @param {string} [opts.model] - defaults to the pinned Sonnet model id
 * @returns {Promise<object|{status:'not_enough_notes'}|{status:'skipped'}|null>}
 */
async function generateProfile(courseId, opts = {}) {
  const supabase = opts.supabase || getSupabaseClient();
  const client = opts.client || getAnthropicClient();
  const model = opts.model || SONNET_MODEL;

  const lockResult = await withCourseProfileLock(courseId, () => runRegeneration({ courseId, supabase, client, model }));

  if (!lockResult.acquired) {
    console.log(`[profile] regeneration for course ${courseId} skipped — another regeneration is already in progress`);
    return { status: 'skipped' };
  }

  return lockResult.result;
}

module.exports = {
  MIN_NOTES_REQUIRED,
  SONNET_MODEL,
  ProfileValidationError,
  generateProfile,
  // exported for focused unit tests
  TOOL,
  buildPromptText,
  buildDataBlock,
  collectSourceTexts,
  sortNotesChronological,
  dedupExamTopics,
  renumberRanks,
  postProcessExamTopics,
  callClaudeProfileTool,
};
