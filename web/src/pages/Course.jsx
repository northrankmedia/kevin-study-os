import { useEffect, useState } from 'react'
import { useSession } from '../lib/session.js'
import { fetchBoard, fetchCourses, fetchNotes, fetchProfile, regenerateProfile } from '../lib/api.js'
import { letterGradeRows, formatGradeRange, gradingSchemeSummary } from '../lib/courseFormat.js'
import NoteComposer from '../components/NoteComposer.jsx'
import VoiceMemoUploader from '../components/VoiceMemoUploader.jsx'
import NoteItem from '../components/NoteItem.jsx'
import ProfilePanel from '../components/ProfilePanel.jsx'
import ExamTopics from '../components/ExamTopics.jsx'
import '../styles/course.css'

// Mirrors CourseSetup.jsx's own `courseIdFromPath()` convention: App.jsx
// already parses and passes `courseId` as a prop for the real routed case,
// this is only a fallback for standalone mounting (e.g. embedding this
// page directly without going through App.jsx's router).
function courseIdFromPath() {
  const match = window.location.pathname.match(/\/courses\/([^/]+)\/?$/)
  return match ? match[1] : null
}

const NOTES_PAGE_SIZE = 50

const NOTE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', // note_date is a plain date, never re-derived from local offset
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

function formatNoteDate(dateOnly) {
  if (!dateOnly) return ''
  const [year, month, day] = dateOnly.split('-').map(Number)
  return NOTE_DATE_FORMATTER.format(new Date(Date.UTC(year, month - 1, day)))
}

export default function Course({ courseId: courseIdProp }) {
  const courseId = courseIdProp || courseIdFromPath()
  const { user, loading: sessionLoading } = useSession()

  const [courses, setCourses] = useState(null)
  const [coursesError, setCoursesError] = useState(null)

  const [today, setToday] = useState(null)

  const [notes, setNotes] = useState(null)
  const [notesError, setNotesError] = useState(null)
  const [notesLoading, setNotesLoading] = useState(true)

  // profileState: { status: 'loading' | 'error' | 'not_enough_notes' | 'ready', ... }
  const [profileState, setProfileState] = useState({ status: 'loading' })
  const [regenerating, setRegenerating] = useState(false)
  const [regenerateError, setRegenerateError] = useState(null)
  const [pendingUpdate, setPendingUpdate] = useState(false)

  function loadCourses() {
    setCoursesError(null)
    fetchCourses()
      .then(setCourses)
      .catch((err) => setCoursesError(err.message))
  }

  function loadNotes() {
    setNotesLoading(true)
    setNotesError(null)
    fetchNotes(courseId, { pageSize: NOTES_PAGE_SIZE })
      .then(setNotes)
      .catch((err) => setNotesError(err.message))
      .finally(() => setNotesLoading(false))
  }

  function loadProfile() {
    setProfileState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
    fetchProfile(courseId)
      .then((data) => {
        if (data && data.status === 'not_enough_notes') {
          setProfileState({ status: 'not_enough_notes' })
        } else {
          setProfileState({ status: 'ready', profile: data })
          setPendingUpdate(false)
        }
      })
      .catch((err) => setProfileState({ status: 'error', message: err.message }))
  }

  useEffect(() => {
    if (!user || !courseId) return
    loadCourses()
    loadNotes()
    loadProfile()
    fetchBoard()
      .then((board) => setToday(board.today))
      .catch(() => {
        // "today" is only used to default the note composer's date field --
        // if /api/board fails here, the composer just falls back to
        // whatever Kevin picks manually rather than blocking the page.
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, courseId])

  async function handleRegenerate() {
    setRegenerating(true)
    setRegenerateError(null)
    try {
      const result = await regenerateProfile(courseId)
      if (result && result.status !== 'queued') {
        setProfileState({ status: 'ready', profile: result })
        setPendingUpdate(false)
      } else {
        // "queued" covers three honest cases on the backend (not enough
        // notes, another regeneration already in flight, or a real attempt
        // that hasn't been persisted yet) -- refetching shows whatever is
        // actually current right now rather than guessing which one it was.
        loadProfile()
      }
    } catch (err) {
      setRegenerateError((err && err.message) || 'Something went wrong.')
    } finally {
      setRegenerating(false)
    }
  }

  function handleNoteCreated(note) {
    setNotes((prev) => [note, ...(prev || [])])
    setPendingUpdate(true)
  }

  function handleNoteUpdated(updatedNote) {
    setNotes((prev) => (prev || []).map((n) => (n.id === updatedNote.id ? updatedNote : n)))
  }

  if (sessionLoading) {
    return (
      <div className="crs-page">
        <p className="crs-loading-line">Loading...</p>
      </div>
    )
  }

  if (!user) return null // useSession() has already redirected to /login

  if (!courseId) {
    return (
      <div className="crs-page">
        <p className="crs-loading-line">No course specified.</p>
        <a className="crs-btn" href="/">
          Back to board
        </a>
      </div>
    )
  }

  const course = courses ? courses.find((c) => c.id === courseId) || null : null

  return (
    <div className="crs-page">
      <a className="crs-back-link" href="/">
        Back to board
      </a>

      <CourseHeader course={course} courses={courses} coursesError={coursesError} onRetry={loadCourses} />

      <div className="crs-grid">
        <div className="crs-col crs-col-notes">
          <section className="crs-panel" aria-labelledby="crs-composer-h">
            <div className="crs-panel-head">
              <h2 id="crs-composer-h">Add a note</h2>
            </div>
            <NoteComposer courseId={courseId} today={today} onCreated={handleNoteCreated} />
          </section>

          <VoiceMemoUploader
            courseId={courseId}
            today={today}
            onCreated={handleNoteCreated}
            onUpdated={handleNoteUpdated}
          />

          <section className="crs-panel" aria-labelledby="crs-notes-h">
            <div className="crs-panel-head">
              <h2 id="crs-notes-h">Notes</h2>
            </div>
            <NotesList
              notes={notes}
              loading={notesLoading}
              error={notesError}
              onRetry={loadNotes}
              onNoteUpdated={handleNoteUpdated}
            />
          </section>
        </div>

        <div className="crs-col crs-col-ai">
          <ProfilePanel
            profileState={profileState}
            onRegenerate={handleRegenerate}
            regenerating={regenerating}
            regenerateError={regenerateError}
            pendingUpdate={pendingUpdate}
            onRetryLoad={loadProfile}
          />
          <ExamTopics profileState={profileState} onRegenerate={handleRegenerate} regenerating={regenerating} />
        </div>
      </div>
    </div>
  )
}

function CourseHeader({ course, courses, coursesError, onRetry }) {
  if (coursesError) {
    return (
      <div className="crs-header-error" role="alert">
        <p>Could not load this course. {coursesError}</p>
        <button type="button" className="crs-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (courses === null) {
    return (
      <header className="crs-header" aria-busy="true">
        <div className="crs-skeleton">
          <div className="crs-skeleton-line" style={{ width: '45%', height: '1.6rem' }} />
          <div className="crs-skeleton-line" style={{ width: '65%' }} />
        </div>
      </header>
    )
  }

  if (!course) {
    return (
      <div className="crs-header-error" role="alert">
        <p>This course could not be found.</p>
        <a className="crs-btn" href="/">
          Back to board
        </a>
      </div>
    )
  }

  const rows = letterGradeRows(course)

  return (
    <header className="crs-header">
      <div className="crs-header-top">
        <span className="crs-header-code">{course.code}</span>
        {course.needs_review && <span className="crs-header-flag">Needs review</span>}
      </div>
      <h1 className="crs-header-name">{course.name}</h1>
      {course.instructor_name && <p className="crs-header-instructor">{course.instructor_name}</p>}

      {course.needs_review && (
        <div className="crs-header-review-note">
          <p>
            This course's syllabus needs a quick look before its dates can be fully trusted.{' '}
            <a href={`/courses/${course.id}/setup`}>Review the syllabus</a>.
          </p>
        </div>
      )}

      <div className="crs-grading">
        <p className="crs-grading-summary">{gradingSchemeSummary(course)}</p>
        {rows.length > 0 && (
          <ul className="crs-grading-list">
            {rows.map((row) => (
              <li key={row.letter} className="crs-grading-chip">
                <span className="crs-grading-letter">{row.letter}</span>
                <span className="crs-grading-range">{formatGradeRange(row)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  )
}

function NotesList({ notes, loading, error, onRetry, onNoteUpdated }) {
  if (loading && !notes) {
    return (
      <div className="crs-skeleton" aria-busy="true" aria-label="Loading notes">
        <div className="crs-skeleton-line" />
        <div className="crs-skeleton-line" style={{ width: '80%' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="crs-panel-error" role="alert">
        <p>Could not load your notes. {error}</p>
        <button type="button" className="crs-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (!notes || notes.length === 0) {
    return <p className="crs-notes-empty">No notes yet. Add your first one above.</p>
  }

  return (
    <ul className="crs-notes-list">
      {notes.map((note) => (
        <li key={note.id} className="crs-note">
          <div className="crs-note-head">
            <span className="crs-note-date">{formatNoteDate(note.note_date)}</span>
            {note.title && <span className="crs-note-title">{note.title}</span>}
          </div>
          <NoteItem note={note} onUpdated={onNoteUpdated} />
        </li>
      ))}
    </ul>
  )
}
