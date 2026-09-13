// Pure formatting helpers for the course detail page's header + grading
// breakdown. Dependency-free and side-effect-free, same convention as
// boardFormat.js / syllabusFormat.js, so they can be unit tested without
// rendering anything.
//
// A course is either a percent-scheme course (each grade cutoff is a
// percentage of 100, e.g. QMX 210, MGT 301) or a points-scheme course (each
// cutoff is a point total, usually out of `points_total_stated`, e.g. ACCT
// 201, PHIL 104, MKT 301). `courses.grading_scheme` is the single source of
// truth for which one a given course is -- never inferred from which
// fields happen to be non-null, since `grading_scale_unit` and
// `grading_scale_cutoffs` are both nullable regardless of scheme (a
// freshly created course, or one with no syllabus uploaded yet, has
// neither set).

export function isPointsScheme(course) {
  return Boolean(course && course.grading_scheme === 'points')
}

// One row per letter grade, high cutoff first. Rows with a malformed
// cutoff entry (not a 2-element [low, high] array) are dropped rather than
// rendered as broken text -- a missing row is honest, a garbled one is not.
export function letterGradeRows(course) {
  const cutoffs = course && course.grading_scale_cutoffs
  if (!cutoffs || typeof cutoffs !== 'object') return []

  const unit = isPointsScheme(course) ? 'points' : 'percent'

  return Object.entries(cutoffs)
    .map(([letter, range]) => {
      if (!Array.isArray(range) || range.length !== 2) return null
      const [low, high] = range
      if (typeof low !== 'number' || typeof high !== 'number') return null
      return { letter, low, high, unit }
    })
    .filter(Boolean)
    .sort((a, b) => b.low - a.low)
}

export function formatGradeRange(row) {
  if (!row) return ''
  const { low, high, unit } = row
  const suffix = unit === 'percent' ? '%' : ' pts'
  if (low === high) return `${low}${suffix}`
  return `${low} to ${high}${suffix}`
}

// One-line summary of the grading scheme itself, shown above the letter
// grade rows so the header still reads clearly even when no cutoffs have
// been recorded yet (e.g. a course before its syllabus is confirmed).
export function gradingSchemeSummary(course) {
  if (!course) return null
  if (isPointsScheme(course)) {
    return course.points_total_stated != null
      ? `Points-based grading. ${course.points_total_stated} points total for the course.`
      : 'Points-based grading. Total course points have not been recorded yet.'
  }
  return 'Percent-based grading. Grades are calculated as a percentage of 100.'
}
