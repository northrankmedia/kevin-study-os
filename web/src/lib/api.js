// Thin fetch wrapper for the board page. Every call is same-origin (the
// browser session cookie set by /api/auth/login rides along automatically)
// and every non-2xx response is turned into a thrown Error carrying the
// server's own { error } message when one is available, so callers can
// show it directly instead of inventing a generic "something went wrong".

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  if (res.status === 204) return null

  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const error = new Error((body && body.error) || `Request failed (${res.status})`)
    error.status = res.status
    throw error
  }

  return body
}

// GET /api/board?courseIds=&from=&to=&state=
//
// The board page always fetches the full (both-state) response and
// partitions Upcoming/Completed client-side per the task brief, so `state`
// is intentionally never sent from here. `courseIds` filtering is also done
// client-side (see Board.jsx) since the whole semester's item set is small
// (documented tradeoff, mirrors the same "small dataset" reasoning the
// board.js route itself documents) and re-filtering in memory means
// toggling a course checkbox never needs a network round trip.
export function fetchBoard() {
  return apiFetch('/api/board')
}

export function fetchCourses() {
  return apiFetch('/api/courses')
}

export function patchItem(id, patch) {
  return apiFetch(`/api/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// GET /api/courses/:id/notes?page=&pageSize= -- newest first, per
// api/src/routes/notes.js's own `.order('created_at', { ascending: false })`.
export function fetchNotes(courseId, { page, pageSize } = {}) {
  const params = new URLSearchParams()
  if (page) params.set('page', String(page))
  if (pageSize) params.set('pageSize', String(pageSize))
  const query = params.toString()
  return apiFetch(`/api/courses/${courseId}/notes${query ? `?${query}` : ''}`)
}

// POST /api/courses/:id/notes { note_date, body_md, title? } -- returns
// 201 with the created note immediately; the profile regeneration this
// triggers server-side is fire-and-forget and debounced (see notes.js), so
// callers should not expect the profile panel to reflect this note yet.
export function createNote(courseId, { note_date, body_md, title }) {
  const body = { note_date, body_md }
  if (title) body.title = title
  return apiFetch(`/api/courses/${courseId}/notes`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// POST /api/courses/:id/notes/voice/upload-url { mimetype, size_bytes } --
// step 1 of the direct-to-storage voice-memo flow (see VoiceMemoUploader.jsx
// and lib/directUpload.js for steps 2/3). Mints a short-lived Supabase
// Storage signed upload URL after validating mimetype/size server-side --
// this is a real request-shape validation the server enforces, not just a
// client-side courtesy, so a 400/413 here is a real, distinct failure mode
// from an actual-processing failure (see classifyUploadError in
// voiceNote.js, which branches on `.status` the same way regardless of
// which of these two endpoints threw).
export function getVoiceUploadUrl(courseId, { mimetype, size_bytes }) {
  return apiFetch(`/api/courses/${courseId}/notes/voice/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ mimetype, size_bytes }),
  })
}

// POST /api/courses/:id/notes/voice { storage_path, original_filename,
// mimetype, note_date? } -- step 3: the file already lives in Supabase
// Storage (the browser PUT it there directly via the signed URL from step
// 1), so this is a small JSON body, not a multipart upload. The server
// fetches the bytes itself before transcribing.
//
// Same 201 shape as the text-note create response (a real Note, with
// source: 'voice' and audio_url set). 400/413/422 are all real, distinct
// failure modes (bad mimetype / downloaded file over VOICE_NOTE_MAX_BYTES /
// transcription failed or came back empty) -- apiFetch's thrown Error
// carries the server's own message plus a `.status` field so callers can
// tell these apart and show something more specific than "upload failed".
export function submitVoiceNote(courseId, { storage_path, original_filename, mimetype, note_date }) {
  const body = { storage_path, original_filename, mimetype }
  if (note_date) body.note_date = note_date
  return apiFetch(`/api/courses/${courseId}/notes/voice`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// PATCH /api/notes/:id { note_date?, body_md?, title? } -- the same
// edit-after-the-fact mechanism a voice note's transcript review uses (see
// components/NoteItem.jsx), general enough to cover any future
// note-editing surface too.
export function updateNote(id, patch) {
  return apiFetch(`/api/notes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// GET /api/courses/:id/profile -- either a full CourseProfile or
// { status: 'not_enough_notes' }. Both are valid 200 responses; callers
// must branch on `status` rather than treating the latter as an error.
export function fetchProfile(courseId) {
  return apiFetch(`/api/courses/${courseId}/profile`)
}

// POST /api/courses/:id/profile/regenerate -- either { status: 'queued' }
// or a full CourseProfile if the (real, synchronous) regeneration
// completed before responding. See profile.js's route handler for why
// "queued" is also the honest response for "not enough notes yet" and
// "already in flight."
export function regenerateProfile(courseId) {
  return apiFetch(`/api/courses/${courseId}/profile/regenerate`, {
    method: 'POST',
  })
}
