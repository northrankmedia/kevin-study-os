import { describe, it, expect } from 'vitest'
import { isPointsScheme, letterGradeRows, formatGradeRange, gradingSchemeSummary } from './courseFormat.js'

// The in-memory backend only seeds percent-scheme courses (MGT 301, QMX
// 210) -- see api/src/routes/courses.js. ACCT 201 / PHIL 104 / MKT 301 are
// points-scheme per the task brief but can't be fetched from a live
// endpoint yet, so this file covers that branch with mock course objects
// shaped exactly like CourseSchema in shared/contract.js.

const percentCourse = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'MGT 301',
  name: 'Principles of Management',
  grading_scheme: 'percent',
  points_total_stated: null,
  grading_scale_unit: 'percent',
  grading_scale_cutoffs: { A: [93, 100], B: [83, 92.99], C: [73, 82.99] },
}

const pointsCourse = {
  id: '55555555-5555-4555-8555-555555555555',
  code: 'ACCT 201',
  name: 'Financial Accounting',
  grading_scheme: 'points',
  points_total_stated: 1000,
  grading_scale_unit: 'points',
  grading_scale_cutoffs: { A: [930, 1000], B: [830, 929], C: [730, 829] },
}

const pointsCourseNoCutoffs = {
  id: '66666666-6666-4666-8666-666666666666',
  code: 'PHIL 104',
  name: 'Intro Ethics',
  grading_scheme: 'points',
  points_total_stated: null,
  grading_scale_unit: null,
  grading_scale_cutoffs: null,
}

describe('isPointsScheme', () => {
  it('is false for a percent-scheme course', () => {
    expect(isPointsScheme(percentCourse)).toBe(false)
  })

  it('is true for a points-scheme course', () => {
    expect(isPointsScheme(pointsCourse)).toBe(true)
  })
})

describe('letterGradeRows', () => {
  it('renders percent cutoffs with the percent unit, highest first', () => {
    const rows = letterGradeRows(percentCourse)
    expect(rows.map((r) => r.letter)).toEqual(['A', 'B', 'C'])
    expect(rows.every((r) => r.unit === 'percent')).toBe(true)
  })

  it('renders points cutoffs with the points unit, highest first', () => {
    const rows = letterGradeRows(pointsCourse)
    expect(rows.map((r) => r.letter)).toEqual(['A', 'B', 'C'])
    expect(rows.every((r) => r.unit === 'points')).toBe(true)
    expect(rows[0]).toEqual({ letter: 'A', low: 930, high: 1000, unit: 'points' })
  })

  it('returns an empty list when no cutoffs are recorded yet', () => {
    expect(letterGradeRows(pointsCourseNoCutoffs)).toEqual([])
  })

  it('drops malformed cutoff entries instead of rendering garbage', () => {
    const malformed = { ...pointsCourse, grading_scale_cutoffs: { A: [930, 1000], B: 'not-a-range' } }
    const rows = letterGradeRows(malformed)
    expect(rows.map((r) => r.letter)).toEqual(['A'])
  })
})

describe('formatGradeRange', () => {
  it('formats a percent range', () => {
    expect(formatGradeRange({ letter: 'A', low: 93, high: 100, unit: 'percent' })).toBe('93 to 100%')
  })

  it('formats a points range', () => {
    expect(formatGradeRange({ letter: 'A', low: 930, high: 1000, unit: 'points' })).toBe('930 to 1000 pts')
  })

  it('collapses a single-value range instead of repeating it', () => {
    expect(formatGradeRange({ letter: 'A', low: 100, high: 100, unit: 'percent' })).toBe('100%')
  })
})

describe('gradingSchemeSummary', () => {
  it('describes a percent-scheme course', () => {
    expect(gradingSchemeSummary(percentCourse)).toMatch(/percentage of 100/)
  })

  it('describes a points-scheme course with a stated total', () => {
    expect(gradingSchemeSummary(pointsCourse)).toMatch(/1000 points total/)
  })

  it('describes a points-scheme course with no total recorded yet', () => {
    expect(gradingSchemeSummary(pointsCourseNoCutoffs)).toMatch(/have not been recorded yet/)
  })
})
