// Pure formatting/grouping helpers for the board page. Dependency-free and
// side-effect-free, same convention as syllabusFormat.js, so they can be
// reasoned about (and unit tested later) without rendering anything.

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' })
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
const MONTH_DAY_SHORT_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// Parses a "YYYY-MM-DD" date-only string as a UTC instant so formatting
// never shifts a day backward/forward based on the browser's own
// timezone offset (the board's `today` anchor is server-computed NY-local;
// once it's a plain date string, every date on the page is compared and
// displayed as that same UTC-anchored calendar date, never re-derived from
// `new Date()` locally).
function parseDateOnly(dateOnly) {
  if (!dateOnly) return null
  const [year, month, day] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function addDaysToDateOnly(dateOnly, days) {
  const date = parseDateOnly(dateOnly)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
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

// Heading for a day-group's date, relative to the server-computed `today`.
// "Today"/"Tomorrow" are shown as their own labels (with the full date as a
// smaller sub-label) so the eye can find "today" without reading every date;
// everything else is weekday + month/day. `date === null` is the "date not
// set" tray, which never claims a real date at all.
export function formatDayHeading(date, today) {
  if (date === null) {
    return { primary: 'Date not set', secondary: null, isToday: false }
  }

  const isToday = date === today
  const isTomorrow = today ? date === addDaysToDateOnly(today, 1) : false
  const weekday = WEEKDAY_FORMATTER.format(parseDateOnly(date))
  const monthDay = MONTH_DAY_FORMATTER.format(parseDateOnly(date))

  if (isToday) return { primary: 'Today', secondary: `${weekday}, ${monthDay}`, isToday: true }
  if (isTomorrow) return { primary: 'Tomorrow', secondary: `${weekday}, ${monthDay}`, isToday: false }
  return { primary: weekday, secondary: monthDay, isToday: false }
}

// Renders the due-date line for one item card. `variant` drives the visual
// treatment in DayGroup.jsx — every date_precision must read as visibly
// different prose, never collapsed into one generic "due" string, per the
// task's render-honesty requirement.
export function formatItemWhen(item) {
  const { date_precision: precision } = item

  if (precision === 'exact') {
    // The day-group heading above already carries the actual date; a time
    // is the only extra fact worth stating here. Without one there is
    // nothing else honest to say, so no label at all (never a fabricated
    // "Due today" for a date that may not be today).
    const time = formatTime(item.due_time)
    return { variant: 'exact', label: time ? `Due ${time}` : null }
  }

  if (precision === 'range') {
    const start = MONTH_DAY_SHORT_FORMATTER.format(parseDateOnly(item.due_start))
    const end = MONTH_DAY_SHORT_FORMATTER.format(parseDateOnly(item.due_end))
    return { variant: 'range', label: `Week of ${start} to ${end}` }
  }

  if (precision === 'tba') {
    return { variant: 'tba', label: 'Date TBA' }
  }

  if (precision === 'external_ref') {
    return { variant: 'external_ref', label: 'See course calendar for exact date' }
  }

  // precision === 'none' — deliberately no date, nothing more to say.
  return { variant: 'none', label: null }
}

// Deterministic, order-stable color assignment: courses sorted by `code`
// so the same course always lands on the same palette slot for as long as
// the course list itself doesn't change, without needing a `color` column
// anywhere in the schema (there isn't one — see shared/contract.js).
const COURSE_PALETTE = [
  { id: 'forest', hex: '#2f6d4f' },
  { id: 'cobalt', hex: '#2f5fa8' },
  { id: 'plum', hex: '#6b3f8a' },
  { id: 'rose', hex: '#a83f77' },
  { id: 'ember', hex: '#c76b1f' },
  { id: 'indigo', hex: '#4a4a8a' },
]

export function buildCourseColorMap(courses) {
  const sorted = [...(courses || [])].sort((a, b) => a.code.localeCompare(b.code))
  const map = new Map()
  sorted.forEach((course, index) => {
    map.set(course.id, COURSE_PALETTE[index % COURSE_PALETTE.length].hex)
  })
  return map
}

export function courseLabel(course) {
  if (!course) return 'Unknown course'
  return course.code
}
