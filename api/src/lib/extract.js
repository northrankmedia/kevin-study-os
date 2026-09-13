'use strict';

/**
 * Core syllabus extraction logic for Kevin Study OS.
 *
 * Orchestrates a two-pass Claude Haiku extraction (Pass A: course metadata +
 * grading components, Pass B: schedule/dated items) over a document already
 * prepared by `docPrep.prepareDocument`, then runs deterministic,
 * code-owned post-processing that the LLM is not trusted to get right on its
 * own:
 *   - Zod validation of the tool-call output (bounded one-retry on failure).
 *   - A dedup safety net for the same real-world deadline mentioned twice in
 *     one document (schedule table + body prose) — see `dedupItems`.
 *   - `content_hash` computation (identity-only: course + normalized title +
 *     source_section — never dates, so a user-edited item survives a
 *     re-upload even though its own dates may since have changed upstream).
 *   - The term-mismatch guard: majority-outside-window detection, and
 *     suppression of every date field for the whole upload if triggered —
 *     never a per-item guess.
 *   - NY-local wall-clock -> UTC `timestamptz` conversion for
 *     `available_from`/`available_until` (the LLM reports these as local
 *     wall-clock strings; only code does the DST-aware timezone math).
 *   - Mirroring the DB's `syllabus_items_precision_dates_check` constraint
 *     pre-insert, so a bad extraction fails loud here instead of silently
 *     showing Kevin a wrong date.
 *
 * This module does not touch Supabase or Express — see `routes/syllabus.js`
 * for how its output is persisted and shaped into the frozen HTTP contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { distance } = require('fastest-levenshtein');
const { NY_TIME_ZONE } = require('./nyDate');
const {
  ITEM_KIND_VALUES,
  DATE_PRECISION_VALUES,
  GRADING_SCHEME_VALUES,
  GRADING_SCALE_UNIT_VALUES,
} = require('../../../shared/contract.js');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'syllabus-extract.md');

const PASS_A_TOOL_NAME = 'extract_course_metadata';
const PASS_B_TOOL_NAME = 'extract_schedule_items';

const MAX_EXTRACTION_ATTEMPTS = 2; // one real attempt + one bounded retry

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when Claude's tool-call output fails Zod validation on both the
 * initial attempt and the single retry. Carries the raw model output so the
 * caller can persist it for debugging rather than silently discarding it.
 */
class ExtractionValidationError extends Error {
  constructor(message, { pass, rawResponses }) {
    super(message);
    this.name = 'ExtractionValidationError';
    this.pass = pass;
    this.rawResponses = rawResponses;
  }
}

// ============================================================================
// Prompt loading
// ============================================================================

let cachedPromptSource = null;

function loadPromptSource() {
  if (cachedPromptSource === null) {
    cachedPromptSource = fs.readFileSync(PROMPT_PATH, 'utf8');
  }
  return cachedPromptSource;
}

function extractMarkerSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `syllabus-extract.md is missing the ${startMarker} / ${endMarker} section`
    );
  }
  return source.slice(start + startMarker.length, end).trim();
}

function interpolate(template, vars) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(String(value)),
    template
  );
}

function buildPrompts({ termLabel, termStart, termEnd }) {
  const source = loadPromptSource();
  const vars = { TERM_LABEL: termLabel, TERM_START: termStart, TERM_END: termEnd };

  const shared = interpolate(
    extractMarkerSection(source, '<!-- SHARED_CONTEXT_START -->', '<!-- SHARED_CONTEXT_END -->'),
    vars
  );
  const passA = interpolate(
    extractMarkerSection(source, '<!-- PASS_A_START -->', '<!-- PASS_A_END -->'),
    vars
  );
  const passB = interpolate(
    extractMarkerSection(source, '<!-- PASS_B_START -->', '<!-- PASS_B_END -->'),
    vars
  );

  return {
    passAPrompt: `${shared}\n\n${passA}`,
    passBPrompt: `${shared}\n\n${passB}`,
  };
}

// ============================================================================
// Tool schemas (Anthropic JSON Schema `input_schema` for forced tool-use)
// ============================================================================

const PASS_A_TOOL = {
  name: PASS_A_TOOL_NAME,
  description: 'Report the extracted course metadata and grading components.',
  input_schema: {
    type: 'object',
    properties: {
      course: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          instructor_name: { type: ['string', 'null'] },
          instructor_email: { type: ['string', 'null'] },
          grading_scheme: { type: 'string', enum: GRADING_SCHEME_VALUES },
          points_total_stated: { type: ['number', 'null'] },
          grading_scale_unit: { type: ['string', 'null'], enum: [...GRADING_SCALE_UNIT_VALUES, null] },
          grading_scale_cutoffs: { type: ['object', 'null'] },
        },
        required: [
          'code', 'name', 'instructor_name', 'instructor_email', 'grading_scheme',
          'points_total_stated', 'grading_scale_unit', 'grading_scale_cutoffs',
        ],
      },
      term_detected: { type: ['string', 'null'] },
      grading_components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            parent_title: { type: ['string', 'null'] },
            weight_percent: { type: ['number', 'null'] },
            points_possible: { type: ['number', 'null'] },
            expected_count: { type: ['integer', 'null'] },
            count_best_n: { type: ['integer', 'null'] },
            drop_lowest_n: { type: ['integer', 'null'] },
          },
          required: [
            'title', 'parent_title', 'weight_percent', 'points_possible',
            'expected_count', 'count_best_n', 'drop_lowest_n',
          ],
        },
      },
    },
    required: ['course', 'term_detected', 'grading_components'],
  },
};

const PASS_B_TOOL = {
  name: PASS_B_TOOL_NAME,
  description: 'Report every dated or undated syllabus schedule item.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            item_kind: { type: 'string', enum: ITEM_KIND_VALUES },
            due_start: { type: ['string', 'null'] },
            due_end: { type: ['string', 'null'] },
            due_time: { type: ['string', 'null'] },
            available_from_local: { type: ['string', 'null'] },
            available_until_local: { type: ['string', 'null'] },
            date_precision: { type: 'string', enum: DATE_PRECISION_VALUES },
            source_text: { type: 'string' },
            source_section: { type: ['string', 'null'], enum: ['schedule_table', 'body_prose', null] },
            points_possible: { type: ['number', 'null'] },
            is_recurring: { type: 'boolean' },
            expected_count: { type: ['integer', 'null'] },
            grading_component_title: { type: ['string', 'null'] },
            confidence: { type: 'number' },
          },
          required: [
            'title', 'item_kind', 'due_start', 'due_end', 'due_time',
            'available_from_local', 'available_until_local', 'date_precision',
            'source_text', 'source_section', 'points_possible', 'is_recurring',
            'expected_count', 'grading_component_title', 'confidence',
          ],
        },
      },
    },
    required: ['items'],
  },
};

// ============================================================================
// Zod validation (mirrors the tool schemas above; this is what actually
// gates whether a Claude response is accepted)
// ============================================================================

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const timeOnly = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable();
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).nullable();

const PassACourseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  instructor_name: z.string().nullable(),
  instructor_email: z.string().nullable(),
  grading_scheme: z.enum(GRADING_SCHEME_VALUES),
  points_total_stated: z.number().nullable(),
  grading_scale_unit: z.enum(GRADING_SCALE_UNIT_VALUES).nullable(),
  grading_scale_cutoffs: z.record(z.string(), z.any()).nullable(),
});

// No `.refine()` requiring weight_percent or points_possible here (there
// used to be one) — the DB schema itself (supabase/migrations/0001_init.sql)
// never requires either column, and real syllabi legitimately have
// components that state neither (e.g. PHIL 104's unscored "~5% extra
// credit" mention). Rejecting the whole extraction over one such component
// was discarding every other correctly-extracted item along with it — see
// `parseArrayLeniently`'s module comment for the general fix.
const PassAGradingComponentSchema = z.object({
  title: z.string().min(1),
  parent_title: z.string().nullable(),
  weight_percent: z.number().nullable(),
  points_possible: z.number().nullable(),
  expected_count: z.number().int().nullable(),
  count_best_n: z.number().int().nullable(),
  drop_lowest_n: z.number().int().nullable(),
});

const PassAOutputSchema = z.object({
  course: PassACourseSchema,
  term_detected: z.string().nullable(),
  grading_components: z.array(PassAGradingComponentSchema),
});

const PassBItemSchema = z.object({
  title: z.string().min(1),
  item_kind: z.enum(ITEM_KIND_VALUES),
  due_start: dateOnly,
  due_end: dateOnly,
  due_time: timeOnly,
  available_from_local: localDateTime,
  available_until_local: localDateTime,
  date_precision: z.enum(DATE_PRECISION_VALUES),
  source_text: z.string().min(1),
  source_section: z.enum(['schedule_table', 'body_prose']).nullable(),
  points_possible: z.number().nullable(),
  is_recurring: z.boolean(),
  expected_count: z.number().int().nullable(),
  grading_component_title: z.string().nullable(),
  confidence: z.number().min(0).max(1),
}).superRefine((item, ctx) => {
  assertPrecisionDates(item, ctx);
});

const PassBOutputSchema = z.object({
  items: z.array(PassBItemSchema),
});

/**
 * Mirrors `syllabus_items_precision_dates_check` from
 * `supabase/migrations/0001_init.sql` (and `contract.js`'s own
 * `checkPrecisionDates`) so a malformed date shape is rejected here, before
 * it ever reaches the DB or Kevin's screen.
 */
function assertPrecisionDates(item, ctx) {
  const { date_precision: precision, due_start: start, due_end: end } = item;
  if (precision === 'exact' && start == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_start'], message: 'due_start required when date_precision is "exact"' });
  }
  if (precision === 'range' && (start == null || end == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_end'], message: 'due_start and due_end both required when date_precision is "range"' });
  }
  if (['tba', 'external_ref', 'none'].includes(precision) && (start != null || end != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_start'], message: 'due_start/due_end must be null when date_precision is "tba", "external_ref", or "none"' });
  }
}

// ============================================================================
// Lenient array validation — salvage valid entries instead of an
// all-or-nothing failure
//
// Real syllabi are messy: on 3 of the 5 real documents this app was actually
// tested against, exactly one entry out of a batch of 20-40 violated a
// schema rule the rest of the batch satisfied fine (see the two repaired/
// relaxed cases below). Validating the whole `items`/`grading_components`
// array as one Zod object meant a single bad entry anywhere threw out every
// other correctly-extracted entry in the same response, then burned the one
// bounded retry, then quarantined the entire upload with ZERO items
// persisted — the worst possible outcome for a single item that could
// usually just be dropped (or repaired) instead.
//
// This validates each array entry independently: entries that pass go
// through, entries that fail are logged (for the same debugging visibility
// `ExtractionValidationError.rawResponses` already provides) and dropped.
// The bounded retry in `callClaudeTool` is still triggered, but only for a
// genuinely structural failure — the array key missing/not-an-array at all,
// or a non-empty array where NOTHING survived validation (both signal the
// model's output itself was broken, not just one messy entry).
// ============================================================================

function parseArrayLeniently({ input, arrayKey, itemSchema, repairItem }) {
  if (!input || !Array.isArray(input[arrayKey])) {
    return { success: false, issues: [{ path: [arrayKey], message: `${arrayKey} must be an array` }] };
  }

  const raw = input[arrayKey];
  const validItems = [];
  const dropped = [];

  raw.forEach((rawItem, index) => {
    const candidate = repairItem ? repairItem(rawItem) : rawItem;
    const result = itemSchema.safeParse(candidate);
    if (result.success) {
      validItems.push(result.data);
    } else {
      dropped.push({ index, issues: result.error.issues });
    }
  });

  if (dropped.length) {
    console.warn(
      `[syllabus] dropped ${dropped.length} of ${raw.length} "${arrayKey}" entr${raw.length === 1 ? 'y' : 'ies'} that failed validation (kept ${validItems.length}):`,
      JSON.stringify(dropped, null, 2)
    );
  }

  // An empty input array ("nothing extracted") is a legitimate result and
  // must not be conflated with "the model's output was garbage" — only a
  // non-empty array that salvaged nothing at all counts as a structural
  // failure worth the bounded retry.
  if (raw.length > 0 && validItems.length === 0) {
    return { success: false, issues: dropped.flatMap((d) => d.issues) };
  }

  return { success: true, data: { [arrayKey]: validItems } };
}

/**
 * Deterministic pre-validation repair, same spirit as this module's other
 * code-owned post-processing: mirrors `assertPrecisionDates` below, but
 * FIXES the violation instead of rejecting the whole item over it. Claude
 * occasionally states a real-looking due_start/due_end on an item it also
 * (correctly) marked "tba"/"external_ref"/"none" — e.g. "you are required to
 * have a meal approved one week in advance" read as a concrete date attached
 * to what is genuinely a TBA item. The precision is trustworthy even when
 * the leftover date field isn't, so keep the item and null the field rather
 * than discarding it.
 */
function repairPassBItem(item) {
  if (
    item &&
    ['tba', 'external_ref', 'none'].includes(item.date_precision) &&
    (item.due_start != null || item.due_end != null)
  ) {
    return { ...item, due_start: null, due_end: null };
  }
  return item;
}

function parsePassBOutput(input) {
  return parseArrayLeniently({ input, arrayKey: 'items', itemSchema: PassBItemSchema, repairItem: repairPassBItem });
}

function parsePassAOutput(input) {
  if (!input || typeof input !== 'object') {
    return { success: false, issues: [{ message: 'Pass A input must be an object' }] };
  }

  const courseResult = PassACourseSchema.safeParse(input.course);
  if (!courseResult.success) {
    return {
      success: false,
      issues: courseResult.error.issues.map((issue) => ({ ...issue, path: ['course', ...issue.path] })),
    };
  }

  if (input.term_detected !== null && typeof input.term_detected !== 'string') {
    return { success: false, issues: [{ path: ['term_detected'], message: 'term_detected must be a string or null' }] };
  }

  const componentsResult = parseArrayLeniently({
    input,
    arrayKey: 'grading_components',
    itemSchema: PassAGradingComponentSchema,
  });
  if (!componentsResult.success) {
    return componentsResult;
  }

  return {
    success: true,
    data: {
      course: courseResult.data,
      term_detected: input.term_detected,
      grading_components: componentsResult.data.grading_components,
    },
  };
}

// ============================================================================
// Claude invocation (forced tool-use, bounded retry on invalid output)
// ============================================================================

/**
 * @param {object} opts
 * @param {object} opts.client - an Anthropic SDK client (or a test double
 *   with the same `messages.create(...)` shape).
 * @param {string} opts.model
 * @param {string} opts.pass - 'A' | 'B', for error reporting only.
 * @param {string} opts.promptText
 * @param {object} opts.documentBlock - the Claude content block for the
 *   prepared document (native PDF `document` block or a Markdown text
 *   block — see `buildDocumentBlock`).
 * @param {object} opts.tool - one of PASS_A_TOOL / PASS_B_TOOL
 * @param {(input: any) => {success: true, data: any} | {success: false, issues: any[]}} opts.parse -
 *   validates (and may lenently repair/salvage) the raw tool-call input —
 *   `parsePassAOutput` / `parsePassBOutput` above. Not a plain Zod schema:
 *   both of those salvage whatever array entries are individually valid
 *   instead of failing the whole response over one bad entry.
 * @returns {Promise<{parsed: any, rawResponses: any[]}>}
 */
async function callClaudeTool({ client, model, pass, promptText, documentBlock, tool, parse }) {
  const rawResponses = [];
  let lastIssues = null;

  for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
    const promptSuffix =
      attempt === 1
        ? ''
        : `\n\nYour previous reply did not match the required schema. Validation errors:\n${JSON.stringify(lastIssues, null, 2)}\n\nCall the tool again with corrected input that satisfies every field.`;

    // eslint-disable-next-line no-await-in-loop
    const response = await client.messages.create({
      model,
      // Haiku 4.5 supports up to 64K output tokens (confirmed live via the
      // Models API); this was previously capped at 8192, which silently
      // truncated Pass B mid-array on at least one real, dense syllabus
      // (QMX 210 — stop_reason: "max_tokens", the tool call missing `items`
      // entirely). 16000 stays comfortably under the non-streaming HTTP
      // timeout while giving a real syllabus's full schedule room to finish.
      max_tokens: 16000,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [
        {
          role: 'user',
          content: [documentBlock, { type: 'text', text: promptText + promptSuffix }],
        },
      ],
    });

    rawResponses.push(response);

    const toolUse = (response.content || []).find((block) => block.type === 'tool_use');
    if (!toolUse) {
      lastIssues = [{ message: 'no tool_use block in response' }];
      continue; // eslint-disable-line no-continue
    }

    const result = parse(toolUse.input);
    if (result.success) {
      return { parsed: result.data, rawResponses };
    }
    lastIssues = result.issues;
  }

  throw new ExtractionValidationError(
    `Pass ${pass} extraction failed schema validation after ${MAX_EXTRACTION_ATTEMPTS} attempt(s): ${JSON.stringify(lastIssues)}`,
    { pass, rawResponses }
  );
}

/**
 * @param {{kind: 'pdf_document'|'markdown', payload: string}} prepared
 */
function buildDocumentBlock(prepared) {
  if (prepared.kind === 'pdf_document') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: prepared.payload },
    };
  }
  return { type: 'text', text: prepared.payload };
}

// ============================================================================
// NY-local wall-clock -> UTC `timestamptz` conversion
//
// The prompt asks Claude for `available_from_local`/`available_until_local`
// as plain local wall-clock strings (no timezone math expected of the LLM).
// Code alone does the DST-aware conversion to a real UTC instant, reusing
// `NY_TIME_ZONE` from `nyDate.js` rather than hardcoding the zone name again.
// ============================================================================

function nyOffsetMinutesAt(utcMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIME_ZONE,
    timeZoneName: 'shortOffset',
  });
  const part = fmt.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName');
  const match = part && part.value.match(/GMT([+-]\d+)/);
  return match ? parseInt(match[1], 10) * 60 : 0;
}

function nyLocalToUtcIso(localDateTimeStr) {
  if (!localDateTimeStr) return null;
  const normalized = localDateTimeStr.length === 16 ? `${localDateTimeStr}:00` : localDateTimeStr;
  const naiveUtcMs = Date.parse(`${normalized}Z`);
  const offsetMin = nyOffsetMinutesAt(naiveUtcMs);
  const utcMs = naiveUtcMs - offsetMin * 60000;
  return new Date(utcMs).toISOString();
}

// ============================================================================
// Title normalization + content hash
// ============================================================================

function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - distance(na, nb) / maxLen;
}

/**
 * Identity-only hash: course + normalized title + source_section. Never
 * includes dates — a re-upload that only changes an item's date must still
 * match the same content_hash so a user-edited row is recognized and left
 * untouched (see `reconcileItems`).
 */
function computeContentHash({ courseId, title, sourceSection }) {
  const raw = `${courseId}|${normalizeTitle(title)}|${sourceSection || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ============================================================================
// Dedup safety net
//
// The prompt already instructs Claude not to double-emit the same deadline
// mentioned in both the schedule table and body prose (see the "dedup rule"
// section of syllabus-extract.md). This is a deterministic backstop in code
// in case the model doesn't fully comply: two raw items with a high title
// similarity AND an identical resolved due_start are treated as the same
// real-world deadline, and only the more complete one is kept.
// ============================================================================

const DEDUP_TITLE_SIMILARITY_THRESHOLD = 0.82;

function isMoreComplete(candidate, current) {
  if ((candidate.due_time != null) !== (current.due_time != null)) {
    return candidate.due_time != null;
  }
  return candidate.source_text.length > current.source_text.length;
}

function isLikelyDuplicate(a, b) {
  if (a.due_start !== b.due_start) return false; // includes both-null case
  // The documented anchor for this rule is specifically a deadline mentioned
  // once in the schedule table and once in body prose (see the module doc
  // comment above). Two items from the SAME section that happen to share a
  // date and a similar-looking title (e.g. a syllabus's "Chapter 10
  // Homework" and "Chapter 12 Homework" both due the same week) are two
  // real, distinct items, not a duplicate mention — requiring the sections
  // to differ avoids collapsing them.
  if (a.source_section != null && b.source_section != null && a.source_section === b.source_section) {
    return false;
  }
  return titleSimilarity(a.title, b.title) >= DEDUP_TITLE_SIMILARITY_THRESHOLD;
}

function dedupItems(items) {
  const used = new Array(items.length).fill(false);
  const result = [];

  for (let i = 0; i < items.length; i += 1) {
    if (used[i]) continue; // eslint-disable-line no-continue
    let winner = items[i];
    used[i] = true;

    for (let j = i + 1; j < items.length; j += 1) {
      if (used[j]) continue; // eslint-disable-line no-continue
      if (isLikelyDuplicate(winner, items[j])) {
        winner = isMoreComplete(items[j], winner) ? items[j] : winner;
        used[j] = true;
      }
    }

    result.push(winner);
  }

  return result;
}

// ============================================================================
// Term-mismatch guard
// ============================================================================

/**
 * Majority-of-dated-items-outside-the-term-window rule. Only counts items
 * that actually resolved to a real date (`due_start` non-null) — `tba` /
 * `external_ref` / `none` items have no date to check and are excluded from
 * both the numerator and denominator.
 */
function computeTermMismatch(items, termStart, termEnd) {
  let inWindow = 0;
  let outOfWindow = 0;

  for (const item of items) {
    if (!item.due_start) continue; // eslint-disable-line no-continue
    if (item.due_start >= termStart && item.due_start <= termEnd) {
      inWindow += 1;
    } else {
      outOfWindow += 1;
    }
  }

  if (inWindow + outOfWindow === 0) return false;
  return outOfWindow > inWindow;
}

/**
 * Applied only when `computeTermMismatch` is true. Never invents/keeps a
 * wrong-term date on any item in the upload — a real-looking ISO date is
 * exactly the kind of value a downstream consumer might trust, so every
 * date field is nulled out and `date_precision` collapses to `"none"`
 * (except `tba`/`external_ref`, which were already dateless and stay as
 * they were literally stated).
 */
function suppressDatesForMismatch(items) {
  return items.map((item) => ({
    ...item,
    due_start: null,
    due_end: null,
    due_time: null,
    available_from: null,
    available_until: null,
    date_precision: ['tba', 'external_ref'].includes(item.date_precision) ? item.date_precision : 'none',
    term_mismatch: true,
  }));
}

// ============================================================================
// Grading component tree assembly (client-generated ids so item ->
// grading_component_id can be wired before any DB round-trip)
// ============================================================================

function buildGradingComponents(rawComponents) {
  const idByTitle = new Map();
  for (const c of rawComponents) {
    idByTitle.set(normalizeTitle(c.title), crypto.randomUUID());
  }

  return rawComponents.map((c) => ({
    id: idByTitle.get(normalizeTitle(c.title)),
    parent_id: c.parent_title ? idByTitle.get(normalizeTitle(c.parent_title)) || null : null,
    title: c.title,
    weight_percent: c.weight_percent,
    points_possible: c.points_possible,
    expected_count: c.expected_count,
    count_best_n: c.count_best_n,
    drop_lowest_n: c.drop_lowest_n,
  }));
}

/**
 * Reconciles freshly client-generated grading-component ids (from
 * `buildGradingComponents`) against a course's existing components on
 * re-upload, so an existing component gets updated in place (its real DB id
 * preserved — required, since `syllabus_items.grading_component_id` is a
 * hard FK with no cascade, so the row can never be deleted-and-recreated
 * while items still reference it) rather than duplicated. Returns the
 * remapped components (each flagged `_isNew`) plus the fresh-id -> final-id
 * map, so the caller can apply the same remap to `item.grading_component_id`.
 *
 * @param {Array<object>} components - output of `buildGradingComponents`
 * @param {Array<{id: string, title: string}>} existingComponents - the
 *   course's current `grading_components` rows
 */
function remapGradingComponentIds(components, existingComponents) {
  const existingByTitle = new Map(
    existingComponents.map((c) => [normalizeTitle(c.title), c])
  );

  const idMap = new Map();
  for (const c of components) {
    const existing = existingByTitle.get(normalizeTitle(c.title));
    idMap.set(c.id, existing ? existing.id : c.id);
  }

  const remapped = components.map((c) => ({
    ...c,
    id: idMap.get(c.id),
    parent_id: c.parent_id ? idMap.get(c.parent_id) || null : null,
    _isNew: !existingByTitle.has(normalizeTitle(c.title)),
  }));

  return { components: remapped, idMap };
}

// ============================================================================
// Assembling final item rows (pre-insert shape)
// ============================================================================

const NEEDS_REVIEW_CONFIDENCE_THRESHOLD = 0.75;

function buildItemRows(rawItems, gradingComponents) {
  const componentIdByTitle = new Map(
    gradingComponents.map((c) => [normalizeTitle(c.title), c.id])
  );

  return rawItems.map((raw) => ({
    grading_component_id: raw.grading_component_title
      ? componentIdByTitle.get(normalizeTitle(raw.grading_component_title)) || null
      : null,
    points_possible: raw.points_possible,
    title: raw.title,
    item_kind: raw.item_kind,
    due_start: raw.due_start,
    due_end: raw.due_end,
    due_time: raw.due_time,
    available_from: nyLocalToUtcIso(raw.available_from_local),
    available_until: nyLocalToUtcIso(raw.available_until_local),
    date_precision: raw.date_precision,
    source_text: raw.source_text,
    source_section: raw.source_section,
    is_recurring: raw.is_recurring,
    expected_count: raw.expected_count,
    completed_count: null,
    confidence: raw.confidence,
    needs_review: raw.confidence < NEEDS_REVIEW_CONFIDENCE_THRESHOLD,
    is_user_edited: false,
    term_mismatch: false, // overwritten to true for every item if the guard trips
    origin: 'syllabus',
    completed_at: null,
  }));
}

// ============================================================================
// Top-level orchestration
// ============================================================================

/**
 * @param {object} opts
 * @param {{kind: 'pdf_document'|'markdown', payload: string}} opts.prepared
 * @param {string} opts.termLabel - e.g. "Fall 2026"
 * @param {string} opts.termStart - "YYYY-MM-DD"
 * @param {string} opts.termEnd - "YYYY-MM-DD"
 * @param {object} opts.client - Anthropic SDK client (or test double)
 * @param {string} opts.model - must be a Haiku model id; extraction never
 *   uses Sonnet (see task boundaries)
 * @returns {Promise<{
 *   course: object,
 *   termDetected: string|null,
 *   termMismatch: boolean,
 *   gradingComponents: Array<object>,
 *   items: Array<object>,
 * }>}
 */
async function extractSyllabus({ prepared, termLabel, termStart, termEnd, client, model }) {
  const { passAPrompt, passBPrompt } = buildPrompts({ termLabel, termStart, termEnd });
  const documentBlock = buildDocumentBlock(prepared);

  const [passA, passB] = await Promise.all([
    callClaudeTool({
      client, model, pass: 'A',
      promptText: passAPrompt,
      documentBlock,
      tool: PASS_A_TOOL,
      parse: parsePassAOutput,
    }),
    callClaudeTool({
      client, model, pass: 'B',
      promptText: passBPrompt,
      documentBlock,
      tool: PASS_B_TOOL,
      parse: parsePassBOutput,
    }),
  ]);

  const gradingComponents = buildGradingComponents(passA.parsed.grading_components);
  const dedupedRawItems = dedupItems(passB.parsed.items);
  let items = buildItemRows(dedupedRawItems, gradingComponents);

  const termMismatch = computeTermMismatch(items, termStart, termEnd);
  if (termMismatch) {
    items = suppressDatesForMismatch(items);
  }

  return {
    course: passA.parsed.course,
    termDetected: passA.parsed.term_detected,
    termMismatch,
    gradingComponents,
    items,
    rawResponses: { passA: passA.rawResponses, passB: passB.rawResponses },
  };
}

// ============================================================================
// Re-upload reconciliation
//
// Matches new candidate item rows (with `content_hash` already computed)
// against the course's existing active (`deleted_at IS NULL`) items:
//   - existing + is_user_edited=true + hash reappears -> keep the existing
//     row untouched, drop the corresponding new row entirely (the edit wins).
//   - existing + hash reappears, not user-edited -> soft-delete the existing
//     row (superseded_by_upload_id = new upload) and insert the new row.
//   - existing + hash does NOT reappear in the new parse -> soft-delete it
//     (superseded_by_upload_id = new upload), regardless of is_user_edited —
//     it is genuinely gone from the document, not merely re-parsed.
//   - hash never seen before -> insert as a new row.
// Never a hard delete anywhere in this function.
// ============================================================================

function reconcileItems({ existingItems, newItemRows, newUploadId }) {
  const existingByHash = new Map(existingItems.map((row) => [row.content_hash, row]));
  const newHashes = new Set();

  const toInsert = [];
  for (const row of newItemRows) {
    newHashes.add(row.content_hash);
    const existing = existingByHash.get(row.content_hash);
    if (existing && existing.is_user_edited) {
      continue; // eslint-disable-line no-continue -- the edited row wins, drop this candidate
    }
    toInsert.push(row);
  }

  const toSoftDelete = existingItems
    .filter((row) => {
      const reappearsAsUserEdited = row.is_user_edited && newHashes.has(row.content_hash);
      return !reappearsAsUserEdited;
    })
    .map((row) => row.id);

  return { toInsert, toSoftDelete };
}

module.exports = {
  ExtractionValidationError,
  PASS_A_TOOL,
  PASS_B_TOOL,
  PassAOutputSchema,
  PassBOutputSchema,
  buildPrompts,
  buildDocumentBlock,
  callClaudeTool,
  normalizeTitle,
  titleSimilarity,
  computeContentHash,
  dedupItems,
  computeTermMismatch,
  suppressDatesForMismatch,
  buildGradingComponents,
  remapGradingComponentIds,
  buildItemRows,
  nyLocalToUtcIso,
  extractSyllabus,
  reconcileItems,
};
