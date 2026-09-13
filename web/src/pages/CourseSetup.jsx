import { useEffect, useRef, useState } from 'react'
import SyllabusReview from '../components/SyllabusReview.jsx'
import { uploadFileDirectly } from '../lib/directUpload.js'
import '../styles/syllabus.css'

// Kevin Study OS - syllabus upload and review page.
//
// Mounting contract (no app-wide router exists yet, see task boundaries -
// App.jsx is intentionally untouched by this task):
//   <CourseSetup courseId="<uuid>" onConfirmed={(payload) => ...} />
//
// - `courseId` (optional): the course this upload is for. If omitted, this
//   component tries to read it from the URL path itself, matching a
//   `/courses/:courseId/setup` shape (window.location.pathname), the same
//   pattern App.jsx already uses to gate /login without a router library.
//   If neither a prop nor a matching URL is present, the page falls back to
//   an in-page course picker (built against the real `GET /api/courses`
//   list) so it still works standalone.
// - `onConfirmed` (optional): called with `{ courseId, result }` when the
//   user taps "Confirm and add to calendar". There is no dedicated
//   confirm/finalize endpoint in shared/contract.js - by the time this
//   screen has data to show, `POST /api/courses/:id/syllabus` has already
//   written the course's items live (see api/src/routes/syllabus.js), so
//   confirming is a client-side "I'm done reviewing" signal only. If
//   `onConfirmed` is not provided, the default behavior navigates the
//   browser to `/` (today's stand-in for "back to the board" until a real
//   route exists).
//
// Accepted file types come from api/src/lib/docPrep.js's
// SUPPORTED_MIMETYPES: application/pdf and the DOCX Open XML mimetype.

const ACCEPTED_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const ACCEPTED_EXTENSIONS = ['.pdf', '.docx']
const ACCEPT_ATTR =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function courseIdFromPath() {
  const match = window.location.pathname.match(/\/courses\/([^/]+)\/setup/)
  return match ? match[1] : null
}

function looksLikeAcceptedFile(file) {
  if (!file) return false
  if (ACCEPTED_MIMETYPES.has(file.type)) return true
  const lowerName = file.name ? file.name.toLowerCase() : ''
  return ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
}

function CoursePicker({ courses, coursesError, onPick }) {
  return (
    <div className="syl-page">
      <header className="syl-header">
        <h1>Which course is this syllabus for?</h1>
        <p>Pick a course, then upload its syllabus.</p>
      </header>

      {coursesError && (
        <div className="syl-error-banner" role="alert">
          <p>{coursesError}</p>
        </div>
      )}

      {!coursesError && courses === null && <p>Loading your courses...</p>}

      {!coursesError && courses !== null && courses.length === 0 && (
        <div className="syl-empty-banner">
          <h2>No courses yet</h2>
          <p>Add a course first, then come back here to upload its syllabus.</p>
        </div>
      )}

      {courses && courses.length > 0 && (
        <div className="syl-course-list">
          {courses.map((course) => (
            <button
              key={course.id}
              type="button"
              className="syl-course-btn"
              onClick={() => onPick(course.id)}
            >
              <span>
                <span className="syl-course-code">{course.code}</span> {course.name}
              </span>
              {course.needs_review && <span className="syl-course-flag">Needs review</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CourseSetup({ courseId: courseIdProp, onConfirmed }) {
  const fixedCourseId = courseIdProp || courseIdFromPath()

  const [courses, setCourses] = useState(null)
  const [coursesError, setCoursesError] = useState(null)
  const [selectedCourseId, setSelectedCourseId] = useState(fixedCourseId)

  // phase: 'idle' (ready to upload) | 'uploading' | 'upload-error' | 'review'
  const [phase, setPhase] = useState('idle')
  // uploadStage tracks which step of the 3-step direct-to-storage flow is in
  // flight, purely for the on-screen message -- 'requesting-url' | 'uploading'
  // | 'processing'. A signed-URL-request failure (rejected before any bytes
  // leave the browser) and an actual-processing failure both land on the same
  // 'upload-error' phase, but with a distinct message since they're set from
  // different steps below.
  const [uploadStage, setUploadStage] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState(null)
  const [result, setResult] = useState(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/courses', { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load your courses.')
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setCourses(data)
      })
      .catch((err) => {
        if (cancelled) return
        setCoursesError((err && err.message) || 'Could not load your courses.')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const selectedCourse = courses ? courses.find((c) => c.id === selectedCourseId) || null : null

  async function submitFile(file) {
    if (!looksLikeAcceptedFile(file)) {
      setPhase('upload-error')
      setUploadError('That file type is not supported. Upload a PDF or a Word (.docx) file.')
      return
    }

    setPhase('uploading')
    setUploadError(null)
    setUploadProgress(0)

    // Step 1: ask our own API for a short-lived Supabase Storage signed
    // upload URL (validates mimetype/size server-side before minting one) --
    // a failure here never touches the file's bytes at all, so it gets its
    // own distinct message from an actual-processing failure below.
    setUploadStage('requesting-url')
    let uploadUrlInfo
    try {
      const res = await fetch(`/api/courses/${selectedCourseId}/syllabus/upload-url`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mimetype: file.type, size_bytes: file.size }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error((body && body.error) || 'Could not prepare this upload. Try again in a moment.')
      }
      uploadUrlInfo = await res.json()
    } catch (err) {
      setPhase('upload-error')
      setUploadError((err && err.message) || 'Could not prepare this upload. Try again in a moment.')
      return
    }

    // Step 2: PUT the file directly to Supabase Storage, bypassing our own
    // API's request body entirely for the binary transfer.
    setUploadStage('uploading')
    try {
      await uploadFileDirectly(uploadUrlInfo.upload_url, file, (fraction) =>
        setUploadProgress(Math.round(fraction * 100))
      )
    } catch {
      setPhase('upload-error')
      setUploadError('Could not upload this file. Check your connection and try again.')
      return
    }

    // Step 3: tell our API where to find the bytes it should now fetch,
    // extract, and persist -- the same processing this endpoint always did,
    // just via a small JSON body instead of a multipart file.
    setUploadStage('processing')
    try {
      const res = await fetch(`/api/courses/${selectedCourseId}/syllabus`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_path: uploadUrlInfo.storage_path,
          original_filename: file.name,
          mimetype: file.type,
        }),
      })

      if (!res.ok) {
        throw new Error('The server could not process this file. Try again in a moment.')
      }

      const data = await res.json()
      setResult(data)
      setPhase('review')
    } catch (err) {
      setPhase('upload-error')
      setUploadError(
        (err && err.message) || 'Something went wrong uploading this file. Try again.'
      )
    }
  }

  function handleFileChange(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (file) submitFile(file)
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (phase === 'uploading') return
    const file = event.dataTransfer.files && event.dataTransfer.files[0]
    if (file) submitFile(file)
  }

  async function handleSaveItem(itemId, patch) {
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error((body && body.error) || 'Could not save this change. Try again.')
    }

    const updatedItem = await res.json()
    setResult((current) => {
      if (!current) return current
      return {
        ...current,
        items: current.items.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
      }
    })
  }

  function handleRetryUpload() {
    setPhase('idle')
    setResult(null)
    setUploadError(null)
    setUploadStage(null)
    setUploadProgress(0)
  }

  function handleConfirm() {
    if (onConfirmed) {
      onConfirmed({ courseId: selectedCourseId, result })
      return
    }
    window.location.href = '/'
  }

  // No course resolved yet (no prop, no URL match, nothing picked from the
  // list) - show the picker built against the real course list.
  if (!selectedCourseId) {
    return (
      <CoursePicker
        courses={courses}
        coursesError={coursesError}
        onPick={(id) => setSelectedCourseId(id)}
      />
    )
  }

  if (phase === 'review' && result) {
    return (
      <div className="syl-page">
        <header className="syl-header">
          <h1>Review your syllabus</h1>
          <p>
            {selectedCourse
              ? `${selectedCourse.code}: ${selectedCourse.name}`
              : 'Check what was found below.'}
          </p>
        </header>
        <SyllabusReview
          upload={result.upload}
          items={result.items}
          gradingComponents={result.gradingComponents}
          termMismatch={result.termMismatch}
          termDetected={result.upload ? result.upload.term_detected : null}
          onSaveItem={handleSaveItem}
          onConfirm={handleConfirm}
          onRetryUpload={handleRetryUpload}
        />
      </div>
    )
  }

  const uploading = phase === 'uploading'
  const courseWasPicked = !fixedCourseId

  const uploadingLabel =
    uploadStage === 'uploading'
      ? `Uploading your file... ${uploadProgress}%`
      : uploadStage === 'processing'
        ? 'Reading your syllabus...'
        : 'Preparing upload...'

  const uploadingDetail =
    uploadStage === 'uploading'
      ? `Uploading your file directly to storage... ${uploadProgress}%`
      : uploadStage === 'processing'
        ? 'Reading your syllabus. This can take up to a minute for a longer file.'
        : 'Preparing your upload...'

  return (
    <div className="syl-page">
      <header className="syl-header">
        <h1>Add a syllabus</h1>
        <p>
          {selectedCourse
            ? `${selectedCourse.code}: ${selectedCourse.name}`
            : 'Upload a PDF or Word file for this course.'}
        </p>
      </header>

      {courseWasPicked && !uploading && (
        <button
          type="button"
          className="syl-btn syl-change-course"
          onClick={() => setSelectedCourseId(null)}
        >
          Choose a different course
        </button>
      )}

      {uploadError && (
        <div className="syl-error-banner" role="alert">
          <p>{uploadError}</p>
          <button type="button" onClick={handleRetryUpload}>
            Try again
          </button>
        </div>
      )}

      <div
        className="syl-upload"
        data-dragging={dragging}
        data-disabled={uploading}
        onDragOver={(event) => {
          event.preventDefault()
          if (!uploading) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <p className="syl-upload-title">Upload your syllabus</p>
        <p className="syl-upload-hint">PDF or Word (.docx), up to 32MB.</p>

        <label className="syl-upload-label">
          {uploading ? uploadingLabel : 'Choose a file'}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={handleFileChange}
            disabled={uploading}
          />
        </label>

        {uploading && (
          <div className="syl-progress" role="status" aria-live="polite">
            <span className="syl-progress-dot" />
            <span className="syl-progress-dot" />
            <span className="syl-progress-dot" />
            <span>{uploadingDetail}</span>
          </div>
        )}

        <p className="syl-upload-desktop-hint">You can also drag a file onto this box.</p>
      </div>
    </div>
  )
}
