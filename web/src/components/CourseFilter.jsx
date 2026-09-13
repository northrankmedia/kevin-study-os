import { courseLabel } from '../lib/boardFormat.js'

// Multi-select course filter, per-course color coding. Selection state is
// owned by Board.jsx (a Set of course ids) so it can be reused to filter
// both the day groups and the needs-review section from one source of
// truth.
export default function CourseFilter({ courses, selectedIds, onToggleCourse, onSelectAll, colorMap, loading, error, onRetry }) {
  if (loading) {
    return (
      <div className="brd-filter" aria-busy="true" aria-label="Loading courses">
        {[0, 1, 2].map((key) => (
          <span key={key} className="brd-filter-chip brd-filter-skeleton" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="brd-filter-error" role="alert">
        <span>Could not load your courses.</span>
        <button type="button" className="brd-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (!courses || courses.length === 0) {
    return (
      <div className="brd-filter-empty">
        No courses yet. Upload a syllabus to a course to see it here.
      </div>
    )
  }

  const allSelected = courses.every((course) => selectedIds.has(course.id))

  return (
    <div className="brd-filter" role="group" aria-label="Filter by course">
      <button
        type="button"
        className="brd-filter-chip brd-filter-all"
        data-selected={allSelected}
        onClick={onSelectAll}
        aria-pressed={allSelected}
      >
        All courses
      </button>
      {courses.map((course) => {
        const selected = selectedIds.has(course.id)
        return (
          <span key={course.id} className="brd-filter-chip-wrap" data-selected={selected}>
            <button
              type="button"
              className="brd-filter-chip"
              data-selected={selected}
              onClick={() => onToggleCourse(course.id)}
              aria-pressed={selected}
            >
              <span className="brd-filter-dot" style={{ background: colorMap.get(course.id) }} aria-hidden="true" />
              <span className="brd-filter-code">{courseLabel(course)}</span>
              {course.needs_review && (
                <span className="brd-filter-flag" aria-label="This course needs review">
                  !
                </span>
              )}
            </button>
            {/* Separate affordance from the toggle button above -- clicking
                this opens the course detail page; it must never also flip
                the filter's own selection state, so it is a sibling link,
                not something nested inside the toggle button itself. */}
            <a
              className="brd-filter-view"
              href={`/courses/${course.id}`}
              aria-label={`View ${courseLabel(course)} details`}
              title={`View ${courseLabel(course)} details`}
            >
              &rsaquo;
            </a>
          </span>
        )
      })}
    </div>
  )
}
