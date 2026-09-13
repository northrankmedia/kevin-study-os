import { formatDayHeading, formatItemWhen, courseLabel } from '../lib/boardFormat.js'
import { itemKindLabel } from '../lib/syllabusFormat.js'

// Renders one day's worth of board items (or the trailing `date: null`
// "date not set" tray). The `items` passed in are already the
// Upcoming-or-Completed subset for this column — see Board.jsx's
// partitionGroups, which filters the single `groups` API response by
// `completed_at` client-side rather than issuing a second request.
export default function DayGroup({ group, today, colorMap, coursesById, onToggleItem, pendingIds, variant }) {
  const heading = formatDayHeading(group.date, today)

  return (
    <section
      className="brd-day"
      data-today={heading.isToday}
      data-no-date={group.date === null}
      data-today-anchor={heading.isToday ? 'true' : undefined}
    >
      <header className="brd-day-heading">
        <span className="brd-day-primary">{heading.primary}</span>
        {heading.secondary && <span className="brd-day-secondary">{heading.secondary}</span>}
      </header>
      <ul className="brd-day-items">
        {group.items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            course={coursesById.get(item.course_id)}
            color={colorMap.get(item.course_id)}
            onToggle={onToggleItem}
            pending={pendingIds.has(item.id)}
            variant={variant}
          />
        ))}
      </ul>
    </section>
  )
}

function ItemCard({ item, course, color, onToggle, pending, variant }) {
  const when = formatItemWhen(item)
  const completed = item.completed_at != null

  return (
    <li className="brd-item" data-completed={completed} data-variant={when.variant} style={{ '--course-color': color || '#7a7362' }}>
      <button
        type="button"
        className="brd-item-check"
        role="checkbox"
        aria-checked={completed}
        aria-label={completed ? `Mark "${item.title}" not complete` : `Mark "${item.title}" complete`}
        onClick={() => onToggle(item)}
        disabled={pending}
        data-pending={pending}
      >
        {completed && (
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
            <path d="M3 8.5 6.2 12 13 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div className="brd-item-body">
        <p className="brd-item-title">{item.title}</p>
        <div className="brd-item-meta">
          <span className="brd-item-course" style={{ color }}>
            {courseLabel(course)}
          </span>
          <span className="brd-item-kind">{itemKindLabel(item.item_kind)}</span>
          {when.label && (
            <span className="brd-item-when" data-variant={when.variant}>
              {when.label}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}
