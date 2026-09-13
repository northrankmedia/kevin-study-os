import { useState } from 'react'
import { updateNote } from '../lib/api.js'

// Renders a single note's body. For a voice note (source === 'voice') this
// also renders the native audio player against `audio_url` and an "Edit
// transcript" affordance -- Whisper transcripts can have real errors
// (misheard words, wrong punctuation), and per the backend's design the
// note is already saved as a real row the moment transcription succeeds,
// so this is "edit after the fact" via the same PATCH /api/notes/:id every
// other note edit would use, not a separate unsaved-draft step.
//
// Used both in the notes list (Course.jsx) and in the "just uploaded"
// review card (VoiceMemoUploader.jsx) -- same component, same behavior,
// so editing a transcript works identically whether Kevin does it right
// after upload or later while scrolling back through his notes.
export default function NoteItem({ note, onUpdated }) {
  const [editing, setEditing] = useState(false)
  const [bodyDraft, setBodyDraft] = useState(note.body_md)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const isVoice = note.source === 'voice'

  function startEditing() {
    setBodyDraft(note.body_md)
    setError(null)
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setError(null)
  }

  async function handleSave(event) {
    event.preventDefault()
    if (!bodyDraft.trim()) {
      setError('This note cannot be empty.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const updated = await updateNote(note.id, { body_md: bodyDraft })
      setEditing(false)
      onUpdated(updated)
    } catch (err) {
      setError((err && err.message) || 'Could not save this change. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="crs-note-body-wrap">
      {isVoice && note.audio_url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a spoken
        // voice memo has no caption track to attach; the transcript next to
        // it serves that role.
        <audio controls className="crs-note-audio" src={note.audio_url}>
          Your browser does not support audio playback.{' '}
          <a href={note.audio_url}>Download the recording</a>.
        </audio>
      )}

      {!editing && <p className="crs-note-body">{note.body_md}</p>}

      {!editing && isVoice && (
        <button type="button" className="crs-btn crs-btn-ghost" onClick={startEditing}>
          Edit transcript
        </button>
      )}

      {editing && (
        <form className="crs-note-edit-form" onSubmit={handleSave}>
          <label className="crs-composer-field">
            <span>Transcript</span>
            <textarea
              value={bodyDraft}
              onChange={(event) => setBodyDraft(event.target.value)}
              rows={5}
              disabled={saving}
            />
          </label>

          {error && (
            <p className="crs-composer-error" role="alert">
              {error}
            </p>
          )}

          <div className="crs-composer-actions">
            <button type="submit" className="crs-btn crs-btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="crs-btn" onClick={cancelEditing} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
