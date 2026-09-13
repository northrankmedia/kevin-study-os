import { useState } from 'react'
import {
  itemKindLabel,
  itemKindOptions,
  formatItemDate,
  needsAttention,
  isLowConfidence,
} from '../lib/syllabusFormat.js'

const DATE_PRECISION_OPTIONS = [
  { value: 'exact', label: 'Exact date' },
  { value: 'range', label: 'Date range (week of)' },
  { value: 'tba', label: 'TBA (not announced yet)' },
  { value: 'external_ref', label: 'Listed elsewhere (see other document)' },
  { value: 'none', label: 'No date needed' },
]

function buildPatch(form) {
  const patch = {
    title: form.title.trim(),
    item_kind: form.item_kind,
    date_precision: form.date_precision,
  }

  if (form.date_precision === 'exact') {
    patch.due_start = form.due_start || null
    patch.due_end = null
    patch.due_time = form.due_time || null
  } else if (form.date_precision === 'range') {
    patch.due_start = form.due_start || null
    patch.due_end = form.due_end || null
    patch.due_time = null
  } else {
    patch.due_start = null
    patch.due_end = null
    patch.due_time = null
  }

  return patch
}

function validate(form) {
  if (!form.title.trim()) return 'Title cannot be empty.'
  if (form.date_precision === 'exact' && !form.due_start) {
    return 'An exact date needs a due date.'
  }
  if (form.date_precision === 'range' && (!form.due_start || !form.due_end)) {
    return 'A date range needs both a start and an end date.'
  }
  if (form.date_precision === 'range' && form.due_start > form.due_end) {
    return 'The range start must be on or before the range end.'
  }
  return null
}

export default function ItemRow({ item, onSave }) {
  const [editing, setEditing] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(() => formFromItem(item))

  const attention = needsAttention(item)
  const lowConfidence = isLowConfidence(item)
  const dateInfo = formatItemDate(item)

  function formFromItem(source) {
    return {
      title: source.title,
      item_kind: source.item_kind,
      date_precision: source.date_precision,
      due_start: source.due_start || '',
      due_end: source.due_end || '',
      due_time: source.due_time ? source.due_time.slice(0, 5) : '',
    }
  }

  function startEditing() {
    setForm(formFromItem(item))
    setError(null)
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setError(null)
  }

  async function handleSave(event) {
    event.preventDefault()
    const problem = validate(form)
    if (problem) {
      setError(problem)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onSave(item.id, buildPatch(form))
      setEditing(false)
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not save this change. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="syl-item" data-attention={attention} data-editing={editing}>
      {!editing && (
        <div className="syl-item-top">
          <div className="syl-item-main">
            <p className="syl-item-title">{item.title}</p>
            <div className="syl-item-meta">
              <span className="syl-kind-tag">{itemKindLabel(item.item_kind)}</span>
              {item.needs_review && <span className="syl-attention-tag">Needs review</span>}
              {!item.needs_review && lowConfidence && (
                <span className="syl-attention-tag">Low confidence</span>
              )}
              {item.is_user_edited && <span className="syl-edited-tag">Edited by you</span>}
            </div>
          </div>
          <button
            type="button"
            className="syl-date-badge"
            data-variant={dateInfo.variant}
            onClick={startEditing}
            aria-label={
              dateInfo.variant === 'mismatch-empty'
                ? `Enter the real date for ${item.title}`
                : `Edit date for ${item.title}, currently ${dateInfo.label}`
            }
          >
            {dateInfo.label}
          </button>
        </div>
      )}

      {!editing && (
        <>
          <button
            type="button"
            className="syl-source-toggle"
            onClick={() => setSourceOpen((open) => !open)}
            aria-expanded={sourceOpen}
          >
            {sourceOpen ? 'Hide original text' : 'Show original text'}
          </button>
          {sourceOpen && (
            <div className="syl-source-text">
              {item.source_text}
              {item.source_section && (
                <span className="syl-source-section">Source: {item.source_section}</span>
              )}
            </div>
          )}
          <div className="syl-item-actions">
            <button type="button" className="syl-btn" onClick={startEditing}>
              Edit
            </button>
          </div>
        </>
      )}

      {editing && (
        <form className="syl-edit-form" onSubmit={handleSave}>
          <div className="syl-edit-row">
            <label htmlFor={`title-${item.id}`}>Title</label>
            <input
              id={`title-${item.id}`}
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>

          <div className="syl-edit-row">
            <label htmlFor={`kind-${item.id}`}>Type</label>
            <select
              id={`kind-${item.id}`}
              value={form.item_kind}
              onChange={(e) => setForm((f) => ({ ...f, item_kind: e.target.value }))}
            >
              {itemKindOptions().map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="syl-edit-row">
            <label htmlFor={`precision-${item.id}`}>Date type</label>
            <select
              id={`precision-${item.id}`}
              value={form.date_precision}
              onChange={(e) => setForm((f) => ({ ...f, date_precision: e.target.value }))}
            >
              {DATE_PRECISION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {form.date_precision === 'exact' && (
            <div className="syl-edit-dates">
              <div className="syl-edit-row">
                <label htmlFor={`start-${item.id}`}>Due date</label>
                <input
                  id={`start-${item.id}`}
                  type="date"
                  value={form.due_start}
                  onChange={(e) => setForm((f) => ({ ...f, due_start: e.target.value }))}
                />
              </div>
              <div className="syl-edit-row">
                <label htmlFor={`time-${item.id}`}>Time (optional)</label>
                <input
                  id={`time-${item.id}`}
                  type="time"
                  value={form.due_time}
                  onChange={(e) => setForm((f) => ({ ...f, due_time: e.target.value }))}
                />
              </div>
            </div>
          )}

          {form.date_precision === 'range' && (
            <div className="syl-edit-dates">
              <div className="syl-edit-row">
                <label htmlFor={`start-${item.id}`}>Week starts</label>
                <input
                  id={`start-${item.id}`}
                  type="date"
                  value={form.due_start}
                  onChange={(e) => setForm((f) => ({ ...f, due_start: e.target.value }))}
                />
              </div>
              <div className="syl-edit-row">
                <label htmlFor={`end-${item.id}`}>Week ends</label>
                <input
                  id={`end-${item.id}`}
                  type="date"
                  value={form.due_end}
                  onChange={(e) => setForm((f) => ({ ...f, due_end: e.target.value }))}
                />
              </div>
            </div>
          )}

          {error && <p className="syl-edit-error">{error}</p>}

          <div className="syl-item-actions">
            <button type="submit" className="syl-btn" data-variant="primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="syl-btn" onClick={cancelEditing} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  )
}
