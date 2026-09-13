/**
 * Kevin Study OS — FROZEN HTTP contract.
 *
 * This is the single source of truth for every request/response shape the
 * API exposes. Every field name, type, and enum here matches
 * `supabase/migrations/0001_init.sql` exactly — do not add a field here that
 * doesn't exist as a column, and do not rename one relative to its column.
 *
 * Consumed as:
 *   - CommonJS, from `api/`: `const { CourseSchema } = require('../../../shared/contract.js');`
 *   - Native ESM, from `web/` (Vite): `import { CourseSchema } from '../../shared/contract.js';`
 *     Vite/esbuild's CJS interop handles importing named exports from a
 *     CommonJS `module.exports = { ... }` object fine — no change needed on
 *     the web/ side.
 *
 * Plain CommonJS (not `"type": "module"` + Node's require()-of-ESM trick,
 * which this file used until it broke Vercel's production deployment):
 * `shared/package.json` originally set `"type": "module"` specifically so
 * this one file could be `require()`'d from api/ (Node 22.12+ supports
 * synchronous require() of an ES module with no top-level await) AND
 * `import`'d natively from web/ — avoiding any duplication. That worked
 * everywhere it was tested (local dev, `npm test`) but broke in Vercel's
 * actual deployed Function runtime: its stack traces show a custom Rust-based
 * Node runtime (`/opt/rust/nodejs.js`) that throws `ERR_REQUIRE_ESM` on this
 * require(), regardless of the dashboard's configured Node.js Version (24.x
 * exhibited the exact same failure as older versions) — Node's own
 * `require(esm)` feature evidently isn't implemented there. Plain CommonJS
 * has no such platform-specific gap: both sides consume the exact same file,
 * just via each side's own native module system's normal interop.
 *
 * IMPORTANT: This endpoint list is frozen as of Task 2. Auth, syllabus
 * extraction, notes, calendar board, and the AI course-profile pipeline all
 * build against exactly what's defined here. Do not add, remove, or reshape
 * an endpoint without explicitly flagging it — three other tasks depend on
 * this file staying stable.
 */

const { z } = require('zod');

// ============================================================================
// Shared primitives
// ============================================================================

const uuidSchema = z.string().uuid();

// Date-only (Postgres `date`), e.g. "2026-10-26".
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// Time-only (Postgres `time`, no DST/timezone baggage), e.g. "14:30" or "14:30:00".
const timeOnlySchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:MM or HH:MM:SS');

// Postgres `timestamptz`, serialized as ISO-8601. The comment here used to
// claim "always ... with a trailing Z" and validated with the strict
// `z.string().datetime()` (Z-only, no offset, fixed precision) on that
// assumption — but PostgREST (what supabase-js talks to) actually returns
// timestamptz values with a numeric UTC offset and microsecond precision,
// e.g. "2026-09-07T15:18:06.328677+00:00", which that strict schema
// rejects outright. That mismatch surfaced as every route returning a real
// (non-empty) timestamptz field failing Zod validation and falling through
// to a 500 — invisible until real data existed, since every route's tests
// and early manual checks ran against rows this app itself had just
// inserted, which happened to render as "Z" in their fixtures. Validated
// with `Date.parse` instead, which accepts both forms and is what actually
// matters: is this a real, parseable point in time.
const isoDatetimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Invalid datetime',
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

// ============================================================================
// Enums (match CHECK constraints in 0001_init.sql exactly)
// ============================================================================

const GRADING_SCHEME_VALUES = ['percent', 'points'];
const GRADING_SCALE_UNIT_VALUES = ['percent', 'points'];
const SYLLABUS_UPLOAD_STATUS_VALUES = ['pending', 'parsed', 'quarantined', 'accepted'];
const ITEM_KIND_VALUES = [
  'exam', 'final_exam', 'quiz', 'pop_quiz', 'homework', 'reading', 'project',
  'presentation', 'discussion', 'writing_lab', 'participation', 'course_eval',
  'lab_session', 'admin', 'break', 'other',
];
const DATE_PRECISION_VALUES = ['exact', 'range', 'tba', 'external_ref', 'none'];
const ITEM_ORIGIN_VALUES = ['syllabus', 'manual'];
const BOARD_STATE_VALUES = ['upcoming', 'completed'];

const GradingSchemeEnum = z.enum(GRADING_SCHEME_VALUES);
const GradingScaleUnitEnum = z.enum(GRADING_SCALE_UNIT_VALUES);
const SyllabusUploadStatusEnum = z.enum(SYLLABUS_UPLOAD_STATUS_VALUES);
const ItemKindEnum = z.enum(ITEM_KIND_VALUES);
const DatePrecisionEnum = z.enum(DATE_PRECISION_VALUES);
const ItemOriginEnum = z.enum(ITEM_ORIGIN_VALUES);
const BoardStateEnum = z.enum(BOARD_STATE_VALUES);

// ============================================================================
// Course
// ============================================================================

const CourseShape = z.object({
  id: uuidSchema,
  term_id: uuidSchema,
  code: z.string(),
  name: z.string(),
  instructor_name: z.string().nullable(),
  instructor_email: z.string().nullable(),
  grading_scheme: GradingSchemeEnum,
  points_total_stated: z.number().nullable(),
  grading_scale_unit: GradingScaleUnitEnum.nullable(),
  grading_scale_cutoffs: z.record(z.string(), z.any()).nullable(),
  needs_review: z.boolean(),
  review_reason: z.string().nullable(),
  created_at: isoDatetimeSchema,
  updated_at: isoDatetimeSchema,
  deleted_at: isoDatetimeSchema.nullable(),
});
const CourseSchema = CourseShape;

// ============================================================================
// SyllabusUpload
// ============================================================================

const SyllabusUploadShape = z.object({
  id: uuidSchema,
  course_id: uuidSchema,
  storage_path: z.string(),
  checksum: z.string(),
  term_detected: z.string().nullable(),
  term_mismatch: z.boolean(),
  status: SyllabusUploadStatusEnum,
  created_at: isoDatetimeSchema,
});
const SyllabusUploadSchema = SyllabusUploadShape;

// ============================================================================
// GradingComponent
// ============================================================================

const GradingComponentShape = z.object({
  id: uuidSchema,
  course_id: uuidSchema,
  parent_id: uuidSchema.nullable(),
  title: z.string(),
  weight_percent: z.number().nullable(),
  points_possible: z.number().nullable(),
  expected_count: z.number().int().nullable(),
  count_best_n: z.number().int().nullable(),
  drop_lowest_n: z.number().int().nullable(),
  created_at: isoDatetimeSchema,
  updated_at: isoDatetimeSchema,
});
const GradingComponentSchema = GradingComponentShape;

// ============================================================================
// SyllabusItem
//
// The `.superRefine` below mirrors `syllabus_items_precision_dates_check` in
// 0001_init.sql — the DB's own comment calls it "the highest-value
// constraint in this schema", so the contract enforces the same rule rather
// than silently allowing a shape the DB would reject.
// ============================================================================

const SyllabusItemShape = z.object({
  id: uuidSchema,
  course_id: uuidSchema,
  upload_id: uuidSchema,
  grading_component_id: uuidSchema.nullable(),
  points_possible: z.number().nullable(),
  title: z.string(),
  item_kind: ItemKindEnum,
  due_start: dateOnlySchema.nullable(),
  due_end: dateOnlySchema.nullable(),
  due_time: timeOnlySchema.nullable(),
  available_from: isoDatetimeSchema.nullable(),
  available_until: isoDatetimeSchema.nullable(),
  date_precision: DatePrecisionEnum,
  source_text: z.string(),
  source_section: z.string().nullable(),
  content_hash: z.string(),
  is_recurring: z.boolean(),
  expected_count: z.number().int().nullable(),
  completed_count: z.number().int().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  needs_review: z.boolean(),
  is_user_edited: z.boolean(),
  term_mismatch: z.boolean(),
  origin: ItemOriginEnum,
  completed_at: isoDatetimeSchema.nullable(),
  sort_date: dateOnlySchema.nullable(),
  deleted_at: isoDatetimeSchema.nullable(),
  superseded_by_upload_id: uuidSchema.nullable(),
  created_at: isoDatetimeSchema,
  updated_at: isoDatetimeSchema,
});

function checkPrecisionDates(item, ctx) {
  const { date_precision: precision, due_start: start, due_end: end } = item;
  if (precision === 'exact' && start == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_start'], message: 'due_start is required when date_precision is "exact"' });
  }
  if (precision === 'range' && (start == null || end == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_end'], message: 'due_start and due_end are both required when date_precision is "range"' });
  }
  if (['tba', 'external_ref', 'none'].includes(precision) && (start != null || end != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_start'], message: 'due_start/due_end must be null when date_precision is "tba", "external_ref", or "none"' });
  }
}

const SyllabusItemSchema = SyllabusItemShape.superRefine(checkPrecisionDates);

// Patchable subset for `PATCH /api/items/:id` — identity/derived columns
// (id, course_id, upload_id, content_hash, term_mismatch, origin, sort_date,
// created_at/updated_at, deleted_at, superseded_by_upload_id) are
// server-managed and intentionally excluded from the request shape.
const SyllabusItemPatchRequestSchema = SyllabusItemShape.pick({
  title: true,
  item_kind: true,
  grading_component_id: true,
  points_possible: true,
  due_start: true,
  due_end: true,
  due_time: true,
  available_from: true,
  available_until: true,
  date_precision: true,
  source_section: true,
  is_recurring: true,
  expected_count: true,
  completed_count: true,
  completed_at: true,
  needs_review: true,
}).partial();

// ============================================================================
// Note
// ============================================================================

// 'text' covers every note created before voice memos existed — `.default`
// means older code/tests that build a Note without this field still parse
// cleanly, they just come out as 'text' (correct: they are text notes).
const NOTE_SOURCE_VALUES = ['text', 'voice'];

const NoteShape = z.object({
  id: uuidSchema,
  course_id: uuidSchema,
  note_date: dateOnlySchema,
  title: z.string().nullable(),
  body_md: z.string(),
  source: z.enum(NOTE_SOURCE_VALUES).default('text'),
  // A signed, short-lived URL to the original audio recording — present only
  // when source === 'voice'. Computed fresh by the server on every read
  // (the underlying storage path is private and never handed to the
  // browser directly), never persisted as-is, so it's fine for this to be
  // absent/null on older code paths that don't know about voice notes yet.
  audio_url: z.string().nullable().default(null),
  created_at: isoDatetimeSchema,
  updated_at: isoDatetimeSchema,
  deleted_at: isoDatetimeSchema.nullable(),
});
const NoteSchema = NoteShape;

const NoteCreateRequestSchema = NoteShape
  .pick({ note_date: true, body_md: true, title: true })
  .partial({ title: true });

// `note_date` is optional in the request body (defaults server-side to
// NY-local today, same as the text-note composer); this schema exists so
// the accepted audio mimetypes are declared in one reviewable place rather
// than scattered across the upload handler.
const VOICE_NOTE_ACCEPTED_MIMETYPES = [
  'audio/mp4', // .m4a (iPhone/Android Voice Memos)
  'audio/x-m4a',
  'audio/mpeg', // .mp3
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
];
const VOICE_NOTE_MAX_BYTES = 25 * 1024 * 1024; // Whisper API's hard per-file cap

// POST /api/courses/:id/notes/voice — JSON body (see the direct-to-storage
// section below). `storage_path`/`mimetype` must be the exact values the
// paired upload-url endpoint returned/was given; `original_filename` is not
// persisted anywhere, it's passed to Whisper only as the multipart part's
// filename (see transcribe.js), same as the old multipart flow's
// `req.file.originalname`.
const VoiceNoteProcessRequestSchema = z.object({
  storage_path: z.string(),
  original_filename: z.string(),
  mimetype: z.string(),
  note_date: dateOnlySchema.optional(),
});

const NoteUpdateRequestSchema = NoteShape
  .pick({ note_date: true, body_md: true, title: true })
  .partial();

// ============================================================================
// CourseProfile
// ============================================================================

const ExamTopicSchema = z.object({
  topic: z.string(),
  rank: z.number().int().min(1),
  rationale: z.string(),
  // Verbatim snippets (from notes and/or the syllabus) that justify ranking
  // this topic — mirrors syllabus_items.source_text's "verbatim, never
  // invented" convention, applied to the profile pipeline's own citations.
  evidence: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

const CourseProfileShape = z.object({
  id: uuidSchema,
  course_id: uuidSchema,
  version: z.number().int().min(1),
  summary_md: z.string(),
  exam_topics: z.array(ExamTopicSchema),
  notes_through_at: isoDatetimeSchema,
  notes_through_note_id: uuidSchema.nullable(),
  model: z.string(),
  is_current: z.boolean(),
  created_at: isoDatetimeSchema,
});
const CourseProfileSchema = CourseProfileShape;

const NotEnoughNotesSchema = z.object({
  status: z.literal('not_enough_notes'),
});

const CourseProfileOrNotEnoughSchema = z.union([CourseProfileSchema, NotEnoughNotesSchema]);

const ProfileRegenerateQueuedSchema = z.object({
  status: z.literal('queued'),
});

const ProfileRegenerateResponseSchema = z.union([ProfileRegenerateQueuedSchema, CourseProfileSchema]);

// ============================================================================
// Auth
// ============================================================================

const UserSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
});

const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LoginResponseSchema = z.object({ user: UserSchema });
const MeResponseSchema = z.object({ user: UserSchema });

// ============================================================================
// Direct-to-storage signed upload
//
// Large files (syllabus PDFs up to 32MB, voice memos up to 25MB) must never
// pass through this API's own request body — a serverless deploy target
// caps that well under these sizes, and this has nothing to do with
// duration/timeouts. Both large-file endpoints below now follow the same
// two-step shape instead of a multipart upload straight into this API:
//   1. POST .../upload-url — declares { mimetype, size_bytes } up front, and
//      the server validates both against the same allowlist/cap it always
//      enforced (this is a real security boundary, not just a UX nicety — a
//      client cannot get a signed URL for a mimetype or size the allowlist
//      exists to reject) before minting a short-lived Supabase Storage
//      signed upload URL. `storage_path` is bucket-prefixed (matches the
//      convention `notes.js`'s audio_storage_path/bucketRelativePath already
//      established) — the exact value the caller must send back in step 2.
//   2. The browser PUTs the file bytes directly to `upload_url`, bypassing
//      this API entirely for the binary transfer.
//   3. The existing processing endpoint (POST .../syllabus or
//      .../notes/voice) is called with a small JSON body referencing
//      `storage_path` instead of a multipart file — the server fetches the
//      bytes from Supabase Storage itself (server-to-server, not subject to
//      the client-facing body-size limit) before running the exact same
//      extraction/transcription logic as before.
// ============================================================================

const UploadUrlRequestSchema = z.object({
  mimetype: z.string(),
  size_bytes: z.number().int().positive(),
});

const UploadUrlResponseSchema = z.object({
  storage_path: z.string(),
  upload_url: z.string(),
  token: z.string(),
});

// ============================================================================
// Syllabus upload
// ============================================================================

// POST /api/courses/:id/syllabus — JSON body (see the direct-to-storage
// section above). `storage_path`/`mimetype` must be the exact values the
// paired upload-url endpoint returned/was given; `original_filename` is not
// persisted anywhere, it exists only so a quarantined/failed extraction's
// server-side debug log can reference the real filename.
const SyllabusProcessRequestSchema = z.object({
  storage_path: z.string(),
  original_filename: z.string(),
  mimetype: z.string(),
});

const SyllabusUploadResponseSchema = z.object({
  upload: SyllabusUploadSchema,
  items: z.array(SyllabusItemSchema),
  gradingComponents: z.array(GradingComponentSchema),
  termMismatch: z.boolean(),
});

// ============================================================================
// Board
// ============================================================================

const BoardQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  courseIds: z.union([z.string(), z.array(z.string())]).optional(),
  state: BoardStateEnum.optional(),
});

const BoardGroupSchema = z.object({
  date: dateOnlySchema.nullable(),
  items: z.array(SyllabusItemSchema),
});

// ----------------------------------------------------------------------------
// CONTRACT CHANGE (Task 9 — combined calendar/task board):
//
// `BoardResponseSchema` was a bare `z.array(BoardGroupSchema)`. It is now an
// object with three fields. Any consumer written against the old bare-array
// shape (there should be none yet outside this task, per the task-9 brief,
// but flagging loudly since Task 8 runs concurrently) must update.
//
//   - `today`      — "what day is it" computed server-side via
//                     `nyDate.js`'s `todayNY()` (America/New_York), so the
//                     client never has to trust its own device clock to know
//                     which day-group is "Today". See api/src/lib/nyDate.js.
//   - `groups`     — same shape as before: day buckets ordered by
//                     `sort_date` ascending, NULLS LAST. The `date: null`
//                     group holds every item with no resolvable date at all
//                     (`date_precision` "tba"/"external_ref"/"none" that is
//                     NOT term_mismatch) — this is the "date not set" tray.
//                     `term_mismatch` items are never in here (see below).
//   - `needsReview`— items with `term_mismatch: true` (e.g. QMX 210's
//                     wrong-semester syllabus), returned as a flat list
//                     instead of being silently dropped from the API
//                     response entirely. These have no real date by
//                     definition and are not part of any day-group.
// ----------------------------------------------------------------------------
const BoardResponseSchema = z.object({
  today: dateOnlySchema,
  groups: z.array(BoardGroupSchema),
  needsReview: z.array(SyllabusItemSchema),
});

// ============================================================================
// Notes list query
// ============================================================================

const NotesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

// ============================================================================
// Frozen endpoint list
//
// One entry per endpoint. `responses` maps HTTP status code -> Zod schema
// for that status's body (omit the entry for a status with no body, e.g.
// 204). This is the registry the acceptance test iterates to prove every
// stub's mock response actually validates against its own schema.
// ============================================================================

const ENDPOINTS = Object.freeze([
  {
    method: 'POST',
    path: '/api/auth/login',
    request: { body: LoginRequestSchema },
    responses: { 200: LoginResponseSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    responses: {},
  },
  {
    method: 'GET',
    path: '/api/me',
    responses: { 200: MeResponseSchema, 401: ErrorResponseSchema },
  },
  {
    method: 'GET',
    path: '/api/courses',
    responses: { 200: z.array(CourseSchema) },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/syllabus/upload-url',
    request: { body: UploadUrlRequestSchema },
    responses: { 200: UploadUrlResponseSchema, 400: ErrorResponseSchema, 413: ErrorResponseSchema },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/syllabus',
    request: { body: SyllabusProcessRequestSchema },
    responses: { 200: SyllabusUploadResponseSchema, 400: ErrorResponseSchema },
  },
  {
    method: 'GET',
    path: '/api/courses/:id/syllabus-items',
    responses: { 200: z.array(SyllabusItemSchema) },
  },
  {
    method: 'PATCH',
    path: '/api/items/:id',
    request: { body: SyllabusItemPatchRequestSchema },
    responses: { 200: SyllabusItemSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
  },
  {
    method: 'GET',
    path: '/api/board',
    request: { query: BoardQuerySchema },
    responses: { 200: BoardResponseSchema, 400: ErrorResponseSchema },
  },
  {
    method: 'GET',
    path: '/api/courses/:id/notes',
    request: { query: NotesListQuerySchema },
    responses: { 200: z.array(NoteSchema) },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/notes',
    request: { body: NoteCreateRequestSchema },
    responses: { 201: NoteSchema, 400: ErrorResponseSchema },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/notes/voice/upload-url',
    request: { body: UploadUrlRequestSchema },
    responses: { 200: UploadUrlResponseSchema, 400: ErrorResponseSchema, 413: ErrorResponseSchema },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/notes/voice',
    request: { body: VoiceNoteProcessRequestSchema },
    // Same shape as the text-note create response — a real Note row, with
    // source: 'voice' and audio_url set. Kevin reviews/corrects a
    // transcription the same way he'd edit any note: PATCH /api/notes/:id,
    // already built, no separate confirm step.
    responses: {
      201: NoteSchema,
      400: ErrorResponseSchema,
      413: ErrorResponseSchema, // downloaded audio over VOICE_NOTE_MAX_BYTES
      422: ErrorResponseSchema, // transcription failed/came back empty
    },
  },
  {
    method: 'PATCH',
    path: '/api/notes/:id',
    request: { body: NoteUpdateRequestSchema },
    responses: { 200: NoteSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
  },
  {
    method: 'DELETE',
    path: '/api/notes/:id',
    responses: {},
  },
  {
    method: 'GET',
    path: '/api/courses/:id/profile',
    responses: { 200: CourseProfileOrNotEnoughSchema },
  },
  {
    method: 'POST',
    path: '/api/courses/:id/profile/regenerate',
    responses: { 200: ProfileRegenerateResponseSchema },
  },
]);

module.exports = {
  // primitives
  uuidSchema,
  dateOnlySchema,
  timeOnlySchema,
  isoDatetimeSchema,
  ErrorResponseSchema,
  // enums
  GRADING_SCHEME_VALUES,
  GRADING_SCALE_UNIT_VALUES,
  SYLLABUS_UPLOAD_STATUS_VALUES,
  ITEM_KIND_VALUES,
  DATE_PRECISION_VALUES,
  ITEM_ORIGIN_VALUES,
  BOARD_STATE_VALUES,
  // resources
  CourseSchema,
  SyllabusUploadSchema,
  GradingComponentSchema,
  SyllabusItemSchema,
  SyllabusItemPatchRequestSchema,
  NoteSchema,
  NoteCreateRequestSchema,
  NoteUpdateRequestSchema,
  NOTE_SOURCE_VALUES,
  VOICE_NOTE_ACCEPTED_MIMETYPES,
  VOICE_NOTE_MAX_BYTES,
  VoiceNoteProcessRequestSchema,
  ExamTopicSchema,
  CourseProfileSchema,
  NotEnoughNotesSchema,
  CourseProfileOrNotEnoughSchema,
  ProfileRegenerateQueuedSchema,
  ProfileRegenerateResponseSchema,
  // auth
  UserSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  // direct-to-storage signed upload
  UploadUrlRequestSchema,
  UploadUrlResponseSchema,
  // syllabus upload
  SyllabusProcessRequestSchema,
  SyllabusUploadResponseSchema,
  // board
  BoardQuerySchema,
  BoardGroupSchema,
  BoardResponseSchema,
  // notes list
  NotesListQuerySchema,
  // frozen registry
  ENDPOINTS,
};
