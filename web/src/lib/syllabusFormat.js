// Pure formatting/grouping helpers for the syllabus review UI. Kept
// dependency-free and side-effect-free so they can be unit tested without
// rendering anything.

import { ITEM_KIND_VALUES } from '../../../shared/contract.js'

// Human-readable labels for the frozen item_kind enum. Every value in
// ITEM_KIND_VALUES must have an entry here — a missing one falls back to a
// title-cased version of the raw enum value (see itemKindLabel below), so a
// future enum addition never renders as a blank tag.
const ITEM_KIND_LABELS = {
  exam: 'Exam',
  final_exam: 'Final exam',
  quiz: 'Quiz',
  pop_quiz: 'Pop quiz',
  homework: 'Homework',
  reading: 'Reading',
  project: 'Project',
  presentation: 'Presentation',
  discussion: 'Discussion',
  writing_lab: 'Writing lab',
  participation: 'Participation',
  course_eval: 'Course evaluation',
  lab_session: 'Lab session',
  admin: 'Admin',
  break: 'Break',
  other: 'Other',
}

export function itemKindLabel(kind) {
  if (ITEM_KIND_LABELS[kind]) return ITEM_KIND_LABELS[kind]
  if (!kind) return 'Item'
  return kind
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function itemKindOptions() {
  return ITEM_KIND_VALUES.map((value) => ({ value, label: itemKindLabel(value) }))
}

const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

const MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

// Parses a "YYYY-MM-DD" date-only string as a UTC instant so formatting
// never shifts a day backward/forward based on the browser's local
// timezone (a real risk for anyone west of UTC looking at a midnight date).
function parseDateOnly(dateOnly) {
  if (!dateOnly) return null
  const [year, month, day] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function formatMonthDay(dateOnly) {
  const date = parseDateOnly(dateOnly)
  if (!date) return null
  return MONTH_DAY_FORMATTER.format(date)
}

export function formatTime(dueTime) {
  if (!dueTime) return null
  const [hourStr, minuteStr] = dueTime.split(':')
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const period = hour >= 12 ? 'PM' : 'AM'
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12
  return `${twelveHour}:${String(minute).padStart(2, '0')} ${period}`
}

// Returns the {key, label} for the month-group an item belongs to, based on
// its earliest known date. Items with no derivable date (tba/external_ref/
// none) are bucketed into a single "needs a date" group so undated items
// never silently vanish into "whatever month happens to sort first."
export function monthGroupForItem(item) {
  const anchor = item.due_start || item.sort_date
  if (!anchor) {
    return { key: 'no-date', label: 'Needs a date' }
  }
  const date = parseDateOnly(anchor)
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  return { key, label: MONTH_YEAR_FORMATTER.format(date) }
}

export function isLowConfidence(item, threshold = 0.6) {
  return typeof item.confidence === 'number' && item.confidence < threshold
}

export function needsAttention(item) {
  return Boolean(item.needs_review) || isLowConfidence(item)
}

// Groups items by month, "no-date" group first, then chronological by the
// group's own anchor date. Within each group, items needing attention
// (needs_review or low confidence) sort first, then by date/title.
export function groupItemsByMonth(items) {
  const groups = new Map()

  for (const item of items) {
    const { key, label } = monthGroupForItem(item)
    if (!groups.has(key)) groups.set(key, { key, label, items: [] })
    groups.get(key).items.push(item)
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'no-date') return -1
    if (b === 'no-date') return 1
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sortedKeys.map((key) => {
    const group = groups.get(key)
    const items = [...group.items].sort((a, b) => {
      const aAttention = needsAttention(a) ? 0 : 1
      const bAttention = needsAttention(b) ? 0 : 1
      if (aAttention !== bAttention) return aAttention - bAttention
      const aDate = a.due_start || a.sort_date || ''
      const bDate = b.due_start || b.sort_date || ''
      if (aDate !== bDate) return aDate < bDate ? -1 : 1
      return a.title.localeCompare(b.title)
    })
    return { ...group, items }
  })
}

// Renders the due-date cell for one item. `variant` drives the visual
// treatment in ItemRow.jsx — each date_precision (plus the term-mismatch
// "none" case) must look distinct, never collapsed into one generic style.
export function formatItemDate(item) {
  const { date_precision: precision } = item

  if (precision === 'exact') {
    const day = formatMonthDay(item.due_start)
    const time = formatTime(item.due_time)
    return { variant: 'exact', label: time ? `${day}, ${time}` : day }
  }

  if (precision === 'range') {
    const start = formatMonthDay(item.due_start)
    const end = formatMonthDay(item.due_end)
    return { variant: 'range', label: `Week of ${start} to ${end}` }
  }

  if (precision === 'tba') {
    return { variant: 'tba', label: 'Date TBA' }
  }

  if (precision === 'external_ref') {
    return { variant: 'external_ref', label: 'See referenced source, not yet entered' }
  }

  // precision === 'none'
  if (item.term_mismatch) {
    return { variant: 'mismatch-empty', label: 'Enter the real date' }
  }
  return { variant: 'none', label: 'No date needed' }
}
