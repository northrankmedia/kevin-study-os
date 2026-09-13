import { groupItemsByMonth, needsAttention } from '../lib/syllabusFormat.js'
import ItemRow from './ItemRow.jsx'

function GradingSummary({ gradingComponents }) {
  if (!gradingComponents || gradingComponents.length === 0) return null

  return (
    <div className="syl-grading">
      <h2>Grading breakdown</h2>
      <div className="syl-grading-list">
        {gradingComponents.map((component) => (
          <span className="syl-grading-chip" key={component.id}>
            <span>{component.title}</span>
            {component.weight_percent != null && <strong>{component.weight_percent}%</strong>}
            {component.weight_percent == null && component.points_possible != null && (
              <strong>{component.points_possible} pts</strong>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function TermMismatchBanner({ termDetected }) {
  return (
    <div className="syl-mismatch-banner" role="status">
      <span className="syl-mismatch-tag">Different semester detected</span>
      <h2>This syllabus looks like it is from a different semester</h2>
      <p>
        {termDetected
          ? `The schedule in this file appears to be dated for ${termDetected}, not the current term.`
          : 'The dates printed in this file do not line up with the current term.'}{' '}
        This happens sometimes when a professor reuses a template from an earlier semester
        without updating the calendar.
      </p>
      <p>
        Nothing is broken and no wrong dates were added to your schedule. The assignment
        titles and grading breakdown below were still read correctly and are shown as a
        starting point. Enter the real due dates by hand for each item below once you know
        them.
      </p>
    </div>
  )
}

function ExtractionFailedNotice({ onRetry }) {
  return (
    <div className="syl-empty-banner">
      <h2>This file could not be read</h2>
      <p>
        Something went wrong while reading this syllabus, so nothing was extracted. Try
        uploading again, or confirm the file opens normally on your phone first.
      </p>
      {onRetry && (
        <button type="button" className="syl-btn" onClick={onRetry}>
          Try uploading again
        </button>
      )}
    </div>
  )
}

export default function SyllabusReview({
  upload,
  items,
  gradingComponents,
  termMismatch,
  termDetected,
  onSaveItem,
  onConfirm,
  onRetryUpload,
}) {
  const extractionFailed = !termMismatch && upload && upload.status === 'quarantined' && items.length === 0
  const groups = groupItemsByMonth(items)
  const attentionCount = items.filter(needsAttention).length

  return (
    <div>
      {termMismatch && <TermMismatchBanner termDetected={termDetected} />}
      {extractionFailed && <ExtractionFailedNotice onRetry={onRetryUpload} />}

      <GradingSummary gradingComponents={gradingComponents} />

      {items.length === 0 && !extractionFailed && (
        <div className="syl-empty-banner">
          <h2>No items to review yet</h2>
          <p>Upload a syllabus above to extract assignments, quizzes, and exams.</p>
        </div>
      )}

      {groups.map((group) => (
        <section className="syl-group" key={group.key} data-no-date={group.key === 'no-date'}>
          <h3 className="syl-group-label">{group.label}</h3>
          <ul className="syl-group-items">
            {group.items.map((item) => (
              <ItemRow key={item.id} item={item} onSave={onSaveItem} />
            ))}
          </ul>
        </section>
      ))}

      {items.length > 0 && (
        <div className="syl-confirm-bar">
          <p className="syl-confirm-note">
            {attentionCount > 0
              ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} still flagged for review.`
              : 'All items reviewed.'}
          </p>
          <button type="button" className="syl-btn" data-variant="primary" onClick={onConfirm}>
            Confirm and add to calendar
          </button>
        </div>
      )}
    </div>
  )
}
