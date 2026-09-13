import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession, logout } from '../lib/session.js'
import { fetchBoard, fetchCourses, patchItem } from '../lib/api.js'
import { buildCourseColorMap, formatDayHeading, courseLabel } from '../lib/boardFormat.js'
import { itemKindLabel } from '../lib/syllabusFormat.js'
import CourseFilter from '../components/CourseFilter.jsx'
import DayGroup from '../components/DayGroup.jsx'
import '../styles/board.css'

// Standalone page component — intended to mount at `/board` (or `/`) once
// app-wide routing exists. Takes no required props: it guards its own
// session via useSession() (redirects to /login the same way App.jsx's
// Gated area does) and fetches its own data. See the end-of-task report for
// the exact integration note.

// Filters + partitions the single `groups` response into one column's rows.
// `wantCompleted` selects the Upcoming/Completed subset of each day's items
// client-side (per the task brief) rather than a second `state=` request;
// day-groups themselves never change shape when an item's completed_at
// flips, only which side of the partition it lands on.
function partitionGroups(groups, selectedIds, wantCompleted) {
  return groups
    .map((g) => ({
      date: g.date,
      items: g.items.filter(
        (item) => selectedIds.has(item.course_id) && (wantCompleted ? item.completed_at != null : item.completed_at == null)
      ),
    }))
    .filter((g) => g.items.length > 0)
}

// Builds the row list a column renders: real day-groups, plus a synthetic
// "today" divider inserted at the correct sorted position when no group in
// this column's (already-filtered) data actually lands on `today` — so
// there's always a visible anchor for "where today is" even on a day with
// nothing due, per the task's Today-marker requirement. A real `today`
// day-group already renders its own "Today" heading (see
// formatDayHeading), so the synthetic marker is skipped when one exists.
function buildRows(groups, today) {
  if (!today) return groups.map((group) => ({ type: 'group', group }))

  const hasTodayGroup = groups.some((g) => g.date === today)
  if (hasTodayGroup) return groups.map((group) => ({ type: 'group', group }))

  const rows = []
  let inserted = false
  for (const group of groups) {
    if (!inserted && group.date !== null && group.date > today) {
      rows.push({ type: 'today-marker' })
      inserted = true
    }
    rows.push({ type: 'group', group })
  }
  if (!inserted) {
    const nullIndex = rows.findIndex((row) => row.type === 'group' && row.group.date === null)
    if (nullIndex === -1) rows.push({ type: 'today-marker' })
    else rows.splice(nullIndex, 0, { type: 'today-marker' })
  }
  return rows
}

// Applies a patch to one item wherever it appears in the board response
// (a day-group, or needsReview) — used for both the optimistic write and
// its rollback on failure.
function updateItemEverywhere(board, itemId, patch) {
  if (!board) return board
  return {
    ...board,
    groups: board.groups.map((g) => ({
      ...g,
      items: g.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    })),
    needsReview: board.needsReview.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
  }
}

export default function Board() {
  const { user, loading: sessionLoading } = useSession()

  const [board, setBoard] = useState(null)
  const [boardLoading, setBoardLoading] = useState(true)
  const [boardError, setBoardError] = useState(null)

  const [courses, setCourses] = useState(null)
  const [coursesLoading, setCoursesLoading] = useState(true)
  const [coursesError, setCoursesError] = useState(null)

  const [selectedCourseIds, setSelectedCourseIds] = useState(null) // null = "all"
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const [toggleError, setToggleError] = useState(null)
  const [activeTab, setActiveTab] = useState('upcoming') // mobile-only stacked tabs

  const upcomingBodyRef = useRef(null)
  const completedBodyRef = useRef(null)

  function loadBoard() {
    setBoardLoading(true)
    setBoardError(null)
    fetchBoard()
      .then(setBoard)
      .catch((err) => setBoardError(err.message))
      .finally(() => setBoardLoading(false))
  }

  function loadCourses() {
    setCoursesLoading(true)
    setCoursesError(null)
    fetchCourses()
      .then(setCourses)
      .catch((err) => setCoursesError(err.message))
      .finally(() => setCoursesLoading(false))
  }

  useEffect(() => {
    if (!user) return
    loadBoard()
    loadCourses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const colorMap = useMemo(() => buildCourseColorMap(courses || []), [courses])
  const coursesById = useMemo(() => new Map((courses || []).map((c) => [c.id, c])), [courses])

  const effectiveSelected = useMemo(() => {
    if (selectedCourseIds) return selectedCourseIds
    return new Set((courses || []).map((c) => c.id))
  }, [selectedCourseIds, courses])

  function toggleCourse(id) {
    setSelectedCourseIds((prev) => {
      const base = prev ? new Set(prev) : new Set((courses || []).map((c) => c.id))
      if (base.has(id)) base.delete(id)
      else base.add(id)
      return base
    })
  }

  function selectAllCourses() {
    setSelectedCourseIds(null)
  }

  async function toggleItem(item) {
    const previousValue = item.completed_at
    const nextValue = previousValue == null ? new Date().toISOString() : null

    setPendingIds((prev) => new Set(prev).add(item.id))
    setToggleError(null)
    setBoard((prev) => updateItemEverywhere(prev, item.id, { completed_at: nextValue }))

    try {
      const updated = await patchItem(item.id, { completed_at: nextValue })
      setBoard((prev) => updateItemEverywhere(prev, item.id, updated))
    } catch (err) {
      setBoard((prev) => updateItemEverywhere(prev, item.id, { completed_at: previousValue }))
      setToggleError(`Could not update "${item.title}". ${err.message}`)
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  function scrollToToday(ref) {
    const node = ref.current && ref.current.querySelector('[data-today-anchor="true"]')
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (sessionLoading) {
    return (
      <div className="brd-page">
        <p className="brd-loading-line">Loading...</p>
      </div>
    )
  }

  if (!user) return null // useSession() has already redirected to /login

  const today = board ? board.today : null
  const todayLabel = today ? formatDayHeading(today, today).secondary : null

  const upcomingGroups = board ? partitionGroups(board.groups, effectiveSelected, false) : []
  const completedGroups = board ? partitionGroups(board.groups, effectiveSelected, true) : []
  const filteredNeedsReview = board ? board.needsReview.filter((item) => effectiveSelected.has(item.course_id)) : []

  const upcomingRows = buildRows(upcomingGroups, today)
  const completedRows = buildRows(completedGroups, today)

  // Drives the single centered empty-state hero vs. the two-column layout.
  // Checked against the *groups* (real data), not the row lists — buildRows
  // always injects a synthetic "Today" marker row whenever `today` is set,
  // so upcoming/completedRows.length is never actually 0 even when there is
  // nothing real to show; that marker-only row was making the empty check
  // false and silently keeping the old two-column layout on screen.
  // Deliberately ignores needsReview — that section (rendered above,
  // unconditionally when non-empty) already gives an all-needs-review board
  // real content up top, so the hero only takes over when there is truly
  // nothing else on the page.
  const isBoardEmpty = upcomingGroups.length === 0 && completedGroups.length === 0

  return (
    <div className="brd-page">
    <div className="brd-inner">
      <header className="brd-header">
        <div>
          <h1>Board</h1>
          <p className="brd-subtitle">{todayLabel ? `Today is ${todayLabel}` : 'Your upcoming and completed work'}</p>
        </div>
        <div className="brd-header-actions">
          <a className="brd-btn" href="/courses/setup">
            Upload syllabus
          </a>
          <button type="button" className="brd-btn" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <CourseFilter
        courses={courses}
        selectedIds={effectiveSelected}
        onToggleCourse={toggleCourse}
        onSelectAll={selectAllCourses}
        colorMap={colorMap}
        loading={coursesLoading}
        error={coursesError}
        onRetry={loadCourses}
      />

      {filteredNeedsReview.length > 0 && (
        <NeedsReviewSection items={filteredNeedsReview} coursesById={coursesById} />
      )}

      {toggleError && (
        <div className="brd-toggle-error" role="alert">
          <span>{toggleError}</span>
          <button type="button" onClick={() => setToggleError(null)} aria-label="Dismiss this message">
            Dismiss
          </button>
        </div>
      )}

      <main className="brd-main">
        {boardLoading && (
          <div className="brd-columns" aria-hidden="true">
            <div className="brd-column">
              <BoardSkeleton />
            </div>
            <div className="brd-column">
              <BoardSkeleton />
            </div>
          </div>
        )}

        {!boardLoading && boardError && <BoardErrorBanner message={boardError} onRetry={loadBoard} />}

        {!boardLoading && !boardError && isBoardEmpty && (
          <EmptyBoardHero filtered={!!selectedCourseIds} hasCourses={!!(courses && courses.length > 0)} />
        )}

        {!boardLoading && !boardError && !isBoardEmpty && (
          <>
            <div className="brd-tabs" role="tablist" aria-label="Board view">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'upcoming'}
                data-active={activeTab === 'upcoming'}
                onClick={() => setActiveTab('upcoming')}
              >
                Upcoming
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'completed'}
                data-active={activeTab === 'completed'}
                onClick={() => setActiveTab('completed')}
              >
                Completed
              </button>
            </div>

            <div className="brd-columns">
              <section className="brd-column" data-visible-mobile={activeTab === 'upcoming'} aria-labelledby="brd-col-upcoming-h">
                <div className="brd-column-head">
                  <h2 id="brd-col-upcoming-h">Upcoming</h2>
                  {today && upcomingRows.length > 0 && (
                    <button type="button" className="brd-jump" onClick={() => scrollToToday(upcomingBodyRef)}>
                      Jump to today
                    </button>
                  )}
                </div>
                <div className="brd-column-body" ref={upcomingBodyRef}>
                  {upcomingGroups.length === 0 && (
                    <p className="brd-empty">
                      All caught up{selectedCourseIds ? ' for this filter' : ''}. Nothing upcoming right now.
                    </p>
                  )}
                  {upcomingRows.map((row, index) =>
                    row.type === 'today-marker' ? (
                      <TodayMarker key="today-marker" />
                    ) : (
                      <DayGroup
                        key={row.group.date ?? `no-date-${index}`}
                        group={row.group}
                        today={today}
                        colorMap={colorMap}
                        coursesById={coursesById}
                        onToggleItem={toggleItem}
                        pendingIds={pendingIds}
                        variant="upcoming"
                      />
                    )
                  )}
                </div>
              </section>

              <section className="brd-column" data-visible-mobile={activeTab === 'completed'} aria-labelledby="brd-col-completed-h">
                <div className="brd-column-head">
                  <h2 id="brd-col-completed-h">Completed</h2>
                  {today && completedRows.length > 0 && (
                    <button type="button" className="brd-jump" onClick={() => scrollToToday(completedBodyRef)}>
                      Jump to today
                    </button>
                  )}
                </div>
                <div className="brd-column-body" ref={completedBodyRef}>
                  {completedGroups.length === 0 && (
                    <p className="brd-empty">Nothing completed yet{selectedCourseIds ? ' for this filter' : ''}.</p>
                  )}
                  {completedRows.map((row, index) =>
                    row.type === 'today-marker' ? (
                      <TodayMarker key="today-marker" />
                    ) : (
                      <DayGroup
                        key={row.group.date ?? `no-date-${index}`}
                        group={row.group}
                        today={today}
                        colorMap={colorMap}
                        coursesById={coursesById}
                        onToggleItem={toggleItem}
                        pendingIds={pendingIds}
                        variant="completed"
                      />
                    )
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
    </div>
  )
}

// The single centered empty-state, replacing the two-column spread when
// there is nothing to show on either side. Three copy variants: a genuinely
// empty board (no courses at all yet), a board with courses but no dated
// items yet (the common "syllabus uploaded, nothing extracted onto the
// board yet" case), and an empty *filtered* view (courses exist and likely
// have items, just none selected) — each points at a different next step.
function EmptyBoardHero({ filtered, hasCourses }) {
  const copy = filtered
    ? {
        heading: 'Nothing matches this filter',
        body: 'No upcoming or completed items for the courses currently selected. Try selecting more courses.',
        cta: null,
      }
    : hasCourses
    ? {
        heading: 'Your board is empty',
        body: 'Nothing has a date on it yet. Once a syllabus is uploaded and its assignments, readings, and exams are extracted, they will show up here grouped by day.',
        cta: { href: '/courses/setup', label: 'Upload a syllabus' },
      }
    : {
        heading: 'No courses yet',
        body: 'Add a course and upload its syllabus to start building your board.',
        cta: { href: '/courses/setup', label: 'Upload a syllabus' },
      }

  return (
    <div className="brd-hero">
      <div className="brd-hero-icon" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="5" width="18" height="16" rx="2.5" />
          <path d="M3 9.5h18" />
          <path d="M8 3v4.5M16 3v4.5" />
          <path d="M7.5 13.5l2.5 2.5L16.5 9" />
        </svg>
      </div>
      <h2>{copy.heading}</h2>
      <p>{copy.body}</p>
      {copy.cta && (
        <a className="brd-btn brd-btn-primary" href={copy.cta.href}>
          {copy.cta.label}
        </a>
      )}
    </div>
  )
}

function TodayMarker() {
  return (
    <div className="brd-today-marker" data-today-anchor="true">
      <span>Today</span>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div className="brd-skeleton" aria-busy="true" aria-label="Loading your board">
      {[0, 1, 2].map((key) => (
        <div key={key} className="brd-skeleton-row" />
      ))}
    </div>
  )
}

function BoardErrorBanner({ message, onRetry }) {
  return (
    <div className="brd-column-error" role="alert">
      <p>Could not load your board. {message}</p>
      <button type="button" className="brd-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

// Term-mismatch (and any other `term_mismatch: true`) items, kept clearly
// separate from the day-by-day list: these have no real date by
// definition (a wrong-semester syllabus), so folding them into a "date not
// set" tray next to genuinely undated items would hide *why* there's no
// date. Points back toward the course's own syllabus review, once that
// route is wired up (see the integration note in the final report).
function NeedsReviewSection({ items, coursesById }) {
  return (
    <section className="brd-needs-review" aria-labelledby="brd-needs-review-h">
      <h2 id="brd-needs-review-h">Needs review</h2>
      <p className="brd-needs-review-intro">
        {items.length} item{items.length === 1 ? '' : 's'} could not be placed on the board because the syllabus
        they came from looks like it is from a different semester. Nothing was scheduled with a wrong date; these
        are held here until the right syllabus is confirmed.
      </p>
      <ul className="brd-needs-review-list">
        {items.map((item) => {
          const course = coursesById.get(item.course_id)
          return (
            <li key={item.id} className="brd-needs-review-item">
              <span className="brd-needs-review-course">{courseLabel(course)}</span>
              <span className="brd-needs-review-title">{item.title}</span>
              <span className="brd-needs-review-kind">{itemKindLabel(item.item_kind)}</span>
              <span className="brd-needs-review-hint">
                Go to {courseLabel(course)}'s syllabus review to confirm the correct term and dates.
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
