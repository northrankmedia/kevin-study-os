'use strict';

const crypto = require('crypto');
const express = require('express');
const {
  NoteSchema,
  NoteCreateRequestSchema,
  NoteUpdateRequestSchema,
  NotesListQuerySchema,
  ErrorResponseSchema,
  UploadUrlRequestSchema,
  UploadUrlResponseSchema,
  VoiceNoteProcessRequestSchema,
  VOICE_NOTE_ACCEPTED_MIMETYPES,
  VOICE_NOTE_MAX_BYTES,
} = require('../../../shared/contract.js');
const { getSupabaseClient } = require('../lib/supabaseClient');
const { todayNY, isNoteDateWithinBounds } = require('../lib/nyDate');
// Referenced via the module object (not destructured) so a test can swap
// `queue.queueProfileRegeneration` out after this file has already loaded.
const queue = require('../lib/queue');
// Same convention — referenced via the module object so a test can swap
// `transcribe.transcribeAudio` out for a fake after this file has loaded.
const transcribe = require('../lib/transcribe');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 20;

const VOICE_MEMOS_BUCKET = 'voice-memos';
const SIGNED_URL_EXPIRY_SECONDS = 3600;

// Picked from the declared mimetype (never trusted blindly — validated
// against VOICE_NOTE_ACCEPTED_MIMETYPES first) — matches the accepted-
// mimetypes list this same field is validated against below.
const MIME_EXTENSIONS = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

// `audio_storage_path` is stored with the bucket name as a human-readable
// prefix (same convention as syllabus_uploads.storage_path in syllabus.js),
// but the actual storage API calls (upload/createSignedUrl) take a path
// relative to the bucket — this strips that prefix back off.
function bucketRelativePath(fullPath) {
  const prefix = `${VOICE_MEMOS_BUCKET}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

// Postgres foreign_key_violation. A note insert hits this when `course_id`
// doesn't reference a real row — e.g. a stale/bookmarked course URL from
// before a reseed. That's a client error (the course is gone), not a server
// fault, so it gets its own 404 with a real message.
//
// This must be sent via `res.status(...).json(...)` directly, NOT via
// `next(err)` — the centralized error handler in index.js unconditionally
// overwrites every error's message with the literal string "Internal
// server error" (by design, to never leak raw DB errors), so an Error
// object's `.message` never actually reaches the client through that path
// no matter what it says. A first attempt at this fix set `.message` on an
// Error passed to `next()` and only ever changed the HTTP status code —
// the client kept seeing "Internal server error" either way.
const FOREIGN_KEY_VIOLATION = '23503';

// Returns true if it already sent a response for `error` (caller must
// return immediately); false if `error` wasn't one of the cases handled
// here and the caller should fall back to its own generic 500 handling.
function handleNoteInsertError(res, error) {
  if (error.code === FOREIGN_KEY_VIOLATION) {
    res.status(404).json(ErrorResponseSchema.parse({ error: 'Course not found' }));
    return true;
  }
  return false;
}

// Computes a fresh signed URL for a voice note on every read (never
// persisted as-is — the underlying path is private) and `null` for a text
// note, matching NoteSchema's `audio_url` contract.
async function attachAudioUrl(supabase, note) {
  if (note.source !== 'voice' || !note.audio_storage_path) {
    return { ...note, audio_url: null };
  }
  const { data } = await supabase.storage
    .from(VOICE_MEMOS_BUCKET)
    .createSignedUrl(bucketRelativePath(note.audio_storage_path), SIGNED_URL_EXPIRY_SECONDS);
  return { ...note, audio_url: data ? data.signedUrl : null };
}

// POST /api/courses/:id/notes/voice/upload-url — mints a short-lived
// Supabase Storage signed upload URL for the browser to PUT the raw
// recording directly to (bypassing this API's own request body entirely for
// the binary transfer — see shared/contract.js's "Direct-to-storage signed
// upload" section). Validates mimetype/size server-side against the exact
// same rules the old multipart route always enforced, since a client's
// declared Content-Type/size is not a trustworthy boundary on its own — this
// is what actually gates whether a signed URL gets minted at all.
router.post('/courses/:id/notes/voice/upload-url', async (req, res, next) => {
  const parsed = UploadUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  const { mimetype, size_bytes: sizeBytes } = parsed.data;

  if (!VOICE_NOTE_ACCEPTED_MIMETYPES.includes(mimetype)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: `Unsupported audio mimetype: ${mimetype}` }));
  }

  if (sizeBytes > VOICE_NOTE_MAX_BYTES) {
    return res.status(413).json(ErrorResponseSchema.parse({ error: 'Audio file exceeds the 25MB limit' }));
  }

  try {
    const supabase = getSupabaseClient();
    const courseId = req.params.id;
    const relativePath = `${courseId}/${crypto.randomUUID()}.${MIME_EXTENSIONS[mimetype]}`;

    const { data, error } = await supabase.storage.from(VOICE_MEMOS_BUCKET).createSignedUploadUrl(relativePath);
    if (error || !data) {
      return next(
        Object.assign(new Error(error ? error.message : 'Could not create a signed upload URL'), { status: 500 })
      );
    }

    res.status(200).json(
      UploadUrlResponseSchema.parse({
        storage_path: `${VOICE_MEMOS_BUCKET}/${relativePath}`,
        upload_url: data.signedUrl,
        token: data.token,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/courses/:id/notes/voice', async (req, res, next) => {
  const courseId = req.params.id;

  const parsedBody = VoiceNoteProcessRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  const { storage_path: audioStoragePath, original_filename: originalFilename, mimetype } = parsedBody.data;

  if (!VOICE_NOTE_ACCEPTED_MIMETYPES.includes(mimetype)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: `Unsupported audio mimetype: ${mimetype}` }));
  }

  const requestedNoteDate = parsedBody.data.note_date;
  let noteDate = todayNY();
  if (requestedNoteDate) {
    // Same bounds check the text-note path already applies — not a second,
    // looser version.
    if (!isNoteDateWithinBounds(requestedNoteDate)) {
      return res.status(400).json(ErrorResponseSchema.parse({ error: 'note_date is out of bounds' }));
    }
    noteDate = requestedNoteDate;
  }

  const supabase = getSupabaseClient();

  // Server-to-server fetch of the bytes the browser already PUT directly to
  // Supabase Storage via the signed URL from the /upload-url step above —
  // not subject to this API's own client-facing request body limit.
  let buffer;
  try {
    const { data: downloaded, error: downloadErr } = await supabase.storage
      .from(VOICE_MEMOS_BUCKET)
      .download(bucketRelativePath(audioStoragePath));
    if (downloadErr || !downloaded) {
      return res
        .status(400)
        .json(ErrorResponseSchema.parse({ error: 'Could not find the uploaded audio file. Try uploading again.' }));
    }
    buffer = Buffer.from(await downloaded.arrayBuffer());
  } catch (err) {
    return next(err);
  }

  // Previously enforced by multer's request-body-level `limits.fileSize`
  // (now gone, since the bytes never pass through this API's own body) —
  // re-checked here on the downloaded buffer so a client that declared a
  // small size at /upload-url but then PUT something bigger straight to
  // storage still gets rejected, same status/message as before.
  if (buffer.length > VOICE_NOTE_MAX_BYTES) {
    return res.status(413).json(ErrorResponseSchema.parse({ error: 'Audio file exceeds the 25MB limit' }));
  }

  // Transcribe before any DB write — a failed or empty/whitespace-only
  // transcript must never become a note's body_md. Unlike the old multipart
  // flow, the audio bytes already live in the private bucket by the time
  // this handler runs (the browser uploaded them directly via the signed
  // URL from the /upload-url step, before this endpoint was ever called) —
  // a failed transcription can no longer be prevented from ever having
  // touched storage, only prevented from ever becoming a saved note. An
  // audio file left in storage with no note pointing to it (a failed
  // transcription, or a client that abandons the flow after uploading but
  // before calling this endpoint at all) is an accepted, inherent tradeoff
  // of direct-to-storage uploads — cleaning it up would need a background
  // job, which is explicitly out of scope here.
  let transcript;
  try {
    transcript = await transcribe.transcribeAudio({
      buffer,
      mimetype,
      filename: originalFilename || 'voice-memo',
    });
  } catch (err) {
    if (err instanceof transcribe.TranscriptionError) {
      console.error(`[notes] voice transcription failed for course ${courseId}:`, err.message);
      return res.status(422).json(ErrorResponseSchema.parse({ error: err.message }));
    }
    return next(err);
  }

  try {
    const { data, error } = await supabase
      .from('notes')
      .insert({
        course_id: courseId,
        note_date: noteDate,
        title: null,
        body_md: transcript,
        source: 'voice',
        audio_storage_path: audioStoragePath,
      })
      .select()
      .single();

    if (error) {
      if (handleNoteInsertError(res, error)) return;
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    // Fire-and-forget: same contract as the text-note path — this write
    // must return 201 immediately regardless of how long (or whether) that
    // job takes, never awaited.
    queue.queueProfileRegeneration(courseId);

    const noteWithAudioUrl = await attachAudioUrl(supabase, data);
    res.status(201).json(NoteSchema.parse(noteWithAudioUrl));
  } catch (err) {
    next(err);
  }
});

function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

router.get('/courses/:id/notes', async (req, res, next) => {
  const parsedQuery = NotesListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid query parameters' }));
  }

  const page = parsedQuery.data.page ?? 1;
  const pageSize = parsedQuery.data.pageSize ?? DEFAULT_PAGE_SIZE;
  const rangeFrom = (page - 1) * pageSize;
  const rangeTo = rangeFrom + pageSize - 1;

  try {
    const supabase = getSupabaseClient();
    // Scoped to this course only — never a bare `select('*')` that could
    // leak another course's notes onto this page.
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('course_id', req.params.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(rangeFrom, rangeTo);

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    const notesWithAudioUrl = await Promise.all(data.map((note) => attachAudioUrl(supabase, note)));
    res.status(200).json(notesWithAudioUrl.map((note) => NoteSchema.parse(note)));
  } catch (err) {
    next(err);
  }
});

router.post('/courses/:id/notes', async (req, res, next) => {
  const parsed = NoteCreateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  const { note_date, body_md, title } = parsed.data;

  if (isBlank(body_md)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'body_md must not be empty' }));
  }

  // note_date is client-submitted — bounds-check it against NY "today"
  // rather than trusting it outright (client could be in any timezone).
  if (!isNoteDateWithinBounds(note_date)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'note_date is out of bounds' }));
  }

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('notes')
      .insert({
        course_id: req.params.id,
        note_date,
        title: title ?? null,
        body_md,
      })
      .select()
      .single();

    if (error) {
      if (handleNoteInsertError(res, error)) return;
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    // Fire-and-forget: Task 10 owns the real regeneration worker. This
    // write must return 201 immediately regardless of how long (or
    // whether) that job takes — never awaited.
    queue.queueProfileRegeneration(req.params.id);

    res.status(201).json(NoteSchema.parse(data));
  } catch (err) {
    next(err);
  }
});

router.patch('/notes/:id', async (req, res, next) => {
  const parsed = NoteUpdateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  if ('body_md' in parsed.data && isBlank(parsed.data.body_md)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'body_md must not be empty' }));
  }

  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'No fields to update' }));
  }

  try {
    const supabase = getSupabaseClient();
    // Matches by primary key only (the contract gives us no course_id on
    // this route) — `updated_at` is bumped by the same mechanism a real
    // update always goes through, not set here (see set_updated_at() in
    // 0001_init.sql, mirrored by the in-memory fallback for tests).
    const { data, error } = await supabase
      .from('notes')
      .update(parsed.data)
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json(ErrorResponseSchema.parse({ error: 'Note not found' }));
    }

    const noteWithAudioUrl = await attachAudioUrl(supabase, data);
    res.status(200).json(NoteSchema.parse(noteWithAudioUrl));
  } catch (err) {
    next(err);
  }
});

router.delete('/notes/:id', async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    // Soft delete only — never a hard delete. Idempotent by design: deleting
    // an already-deleted or nonexistent id still succeeds with 204.
    const { error } = await supabase
      .from('notes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .is('deleted_at', null);

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
