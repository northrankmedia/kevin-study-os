import { useEffect, useRef, useState } from 'react'
import { createNote } from '../lib/api.js'

// Local-storage draft key: scoped to course + date, per the task brief, so
// a half-written note about a specific day survives an accidental
// navigation or a mistyped URL without bleeding into a different day's
// draft.
function draftKey(courseId, noteDate) {
  return `kso:note-draft:${courseId}:${noteDate}`
}

function readDraft(courseId, noteDate) {
  try {
    const raw = window.localStorage.getItem(draftKey(courseId, noteDate))
    return raw ? JSON.parse(raw) : null
  } catch {
    // localStorage can throw in some private-browsing / embedded contexts.
    // A missing draft is never fatal -- there's just nothing to restore.
    return null
  }
}

function writeDraft(courseId, noteDate, draft) {
  try {
    if (!draft.title && !draft.body_md) {
      window.localStorage.removeItem(draftKey(courseId, noteDate))
      return
    }
    window.localStorage.setItem(draftKey(courseId, noteDate), JSON.stringify(draft))
  } catch {
    // ignore -- see readDraft
  }
}

function clearDraft(courseId, noteDate) {
  try {
    window.localStorage.removeItem(draftKey(courseId, noteDate))
  } catch {
    // ignore
  }
}

// `today` is the NY-local "today" the parent page resolved from the
// server (see Course.jsx) -- never derived from `new Date()` in the
// browser, since Kevin's classes run on America/New_York regardless of
// where his device thinks it is.
export default function NoteComposer({ courseId, today, onCreated }) {
  const [noteDate, setNoteDate] = useState(today || '')
  const [title, setTitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [justSaved, setJustSaved] = useState(false)
  const savedTimerRef = useRef(null)
  const loadedDateRef = useRef(null)

  // Adopt the server-resolved "today" as the default date once it
  // arrives -- but only if the composer hasn't already been pointed at a
  // date (so a slow /api/board response never clobbers a date Kevin
  // already picked).
  useEffect(() => {
    if (today && !noteDate) setNoteDate(today)
  }, [today, noteDate])

  // Load whichever draft exists for the current course + date, once per
  // date (not on every keystroke -- see the autosave effect below for
  // that).
  useEffect(() => {
    if (!courseId || !noteDate) return
    if (loadedDateRef.current === noteDate) return
    loadedDateRef.current = noteDate
    const draft = readDraft(courseId, noteDate)
    setTitle(draft ? draft.title || '' : '')
    setBodyMd(draft ? draft.body_md || '' : '')
  }, [courseId, noteDate])

  // Autosave on every change. Cheap and synchronous, so no debounce is
  // needed -- the only failure mode this guards against is losing text
  // between keystrokes, not request volume.
  useEffect(() => {
    if (!courseId || !noteDate) return
    if (loadedDateRef.current !== noteDate) return // don't overwrite with blanks before the load effect above has run
    writeDraft(courseId, noteDate, { title, body_md: bodyMd })
  }, [courseId, noteDate, title, bodyMd])

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    if (!bodyMd.trim()) {
      setError('Write something before saving this note.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const created = await createNote(courseId, {
        note_date: noteDate,
        body_md: bodyMd,
        title: title.trim() || undefined,
      })
      clearDraft(courseId, noteDate)
      setTitle('')
      setBodyMd('')
      onCreated(created)
      setJustSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 2400)
    } catch (err) {
      setError((err && err.message) || 'Could not save this note. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="crs-composer" onSubmit={handleSubmit} aria-label="Add a note">
      <div className="crs-composer-row">
        <label className="crs-composer-field crs-composer-field-date">
          <span>Date</span>
          <input
            type="date"
            value={noteDate}
            onChange={(event) => setNoteDate(event.target.value)}
            disabled={submitting}
            required
          />
        </label>
        <label className="crs-composer-field crs-composer-field-title">
          <span>Title (optional)</span>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Lecture 4 recap"
            disabled={submitting}
          />
        </label>
      </div>

      <label className="crs-composer-field crs-composer-field-body">
        <span>What happened in class today</span>
        <textarea
          value={bodyMd}
          onChange={(event) => setBodyMd(event.target.value)}
          placeholder="What was covered, what the professor emphasized, anything that sounded exam-worthy..."
          rows={5}
          disabled={submitting}
        />
      </label>

      {error && (
        <p className="crs-composer-error" role="alert">
          {error}
        </p>
      )}

      <div className="crs-composer-actions">
        <button type="submit" className="crs-btn crs-btn-primary" disabled={submitting}>
          {submitting ? 'Saving...' : 'Save note'}
        </button>
        {justSaved && (
          <span className="crs-composer-saved" role="status">
            Saved
          </span>
        )}
      </div>
    </form>
  )
}
