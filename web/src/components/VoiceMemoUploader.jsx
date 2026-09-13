import { useRef, useState } from 'react'
import { getVoiceUploadUrl, submitVoiceNote } from '../lib/api.js'
import { uploadFileDirectly } from '../lib/directUpload.js'
import { classifyUploadError, validateVoiceFile, VOICE_ACCEPT_ATTR } from '../lib/voiceNote.js'
import NoteItem from './NoteItem.jsx'

// Replaces the old "coming soon" voice-memo stub. Kevin uploads an
// already-recorded voice memo file (phone Voice Memos app export, not
// in-browser recording -- there is no MediaRecorder here on purpose). The
// file never passes through our own API's request body -- it goes straight
// from the browser to Supabase Storage via a signed URL, then a small JSON
// request (POST /api/courses/:id/notes/voice, a real
// several-second-to-a-minute Whisper call, not instant) tells the server
// where to find it, and the result shows up immediately as an editable note
// with its original audio attached.
//
// phase: 'idle' (ready to upload) | 'uploading' | 'error' | 'success'
//
// 'uploading' covers all three steps of the flow (get signed URL -> upload
// directly to storage -> processing/transcription) -- `uploadStage` tracks
// which one is in flight purely for the on-screen message, so a
// signed-URL-request failure (rejected before any bytes ever leave the
// browser) reads differently from a storage-transport failure, which reads
// differently again from an actual transcription failure, without adding a
// whole new job-polling phase machine.
export default function VoiceMemoUploader({ courseId, today, onCreated, onUpdated }) {
  const [phase, setPhase] = useState('idle')
  const [uploadStage, setUploadStage] = useState(null) // 'requesting-url' | 'uploading' | 'transcribing'
  const [uploadProgress, setUploadProgress] = useState(0)
  const [errorInfo, setErrorInfo] = useState(null) // { message, retry: 'reupload' | 'retry-same' }
  const [pendingFile, setPendingFile] = useState(null)
  const [createdNote, setCreatedNote] = useState(null)
  const fileInputRef = useRef(null)

  function openPicker() {
    if (fileInputRef.current) fileInputRef.current.click()
  }

  function reset() {
    setPhase('idle')
    setUploadStage(null)
    setUploadProgress(0)
    setErrorInfo(null)
    setPendingFile(null)
    setCreatedNote(null)
  }

  async function upload(file) {
    setPendingFile(file)
    setPhase('uploading')
    setErrorInfo(null)
    setUploadProgress(0)

    setUploadStage('requesting-url')
    let uploadUrlInfo
    try {
      uploadUrlInfo = await getVoiceUploadUrl(courseId, { mimetype: file.type, size_bytes: file.size })
    } catch (err) {
      setPhase('error')
      setErrorInfo(classifyUploadError(err))
      return
    }

    setUploadStage('uploading')
    try {
      await uploadFileDirectly(uploadUrlInfo.upload_url, file, (fraction) =>
        setUploadProgress(Math.round(fraction * 100))
      )
    } catch {
      setPhase('error')
      setErrorInfo({
        message: 'Could not upload this recording. Check your connection and try again.',
        retry: 'retry-same',
      })
      return
    }

    setUploadStage('transcribing')
    try {
      const note = await submitVoiceNote(courseId, {
        storage_path: uploadUrlInfo.storage_path,
        original_filename: file.name,
        mimetype: file.type,
        note_date: today || undefined,
      })
      setCreatedNote(note)
      setPhase('success')
      onCreated(note)
    } catch (err) {
      setPhase('error')
      setErrorInfo(classifyUploadError(err))
    }
  }

  function handleFileChange(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = '' // always allow re-selecting the same file path
    if (!file) return

    const check = validateVoiceFile(file)
    if (!check.ok) {
      setPhase('error')
      setErrorInfo({ message: check.message, retry: 'reupload' })
      setPendingFile(null)
      return
    }

    upload(file)
  }

  function handleRetry() {
    if (errorInfo && errorInfo.retry === 'retry-same' && pendingFile) {
      upload(pendingFile)
    } else {
      reset()
      openPicker()
    }
  }

  function handleNoteUpdated(updated) {
    setCreatedNote(updated)
    onUpdated(updated)
  }

  const uploading = phase === 'uploading'

  const uploadingLabel =
    uploadStage === 'uploading'
      ? `Uploading your recording... ${uploadProgress}%`
      : uploadStage === 'transcribing'
        ? 'Transcribing...'
        : 'Preparing upload...'

  const uploadingDetail =
    uploadStage === 'uploading'
      ? `Uploading your recording directly to storage... ${uploadProgress}%`
      : uploadStage === 'transcribing'
        ? 'Transcribing your voice memo. This can take up to a minute for a longer recording.'
        : 'Preparing your upload...'

  return (
    <section className="crs-panel crs-voice-panel" aria-labelledby="crs-voice-h">
      <div className="crs-panel-head">
        <h2 id="crs-voice-h">Voice memo</h2>
      </div>

      {phase !== 'success' && (
        <>
          <p className="crs-voice-copy">
            Upload a voice memo you already recorded on your phone and it will be transcribed into a
            note automatically.
          </p>

          <div className="crs-voice-upload" data-disabled={uploading}>
            <label className="crs-voice-upload-label">
              {uploading ? uploadingLabel : 'Choose a voice memo'}
              <input
                ref={fileInputRef}
                type="file"
                accept={VOICE_ACCEPT_ATTR}
                onChange={handleFileChange}
                disabled={uploading}
              />
            </label>
            <p className="crs-voice-hint">m4a, mp3, wav, or webm, up to 25MB.</p>
          </div>

          {uploading && (
            <div className="crs-voice-progress" role="status" aria-live="polite">
              <span className="crs-regen-dot" />
              <span className="crs-regen-dot" />
              <span className="crs-regen-dot" />
              <span>{uploadingDetail}</span>
            </div>
          )}

          {phase === 'error' && errorInfo && (
            <div className="crs-panel-error" role="alert">
              <p>{errorInfo.message}</p>
              <button type="button" className="crs-btn" onClick={handleRetry}>
                {errorInfo.retry === 'retry-same' ? 'Try again' : 'Choose a different file'}
              </button>
            </div>
          )}
        </>
      )}

      {phase === 'success' && createdNote && (
        <div className="crs-voice-result">
          <p className="crs-voice-transcribed-note">
            Transcribed. Check it over and fix anything that is off.
          </p>
          <NoteItem note={createdNote} onUpdated={handleNoteUpdated} />
          <button type="button" className="crs-btn" onClick={reset}>
            Upload another voice memo
          </button>
        </div>
      )}
    </section>
  )
}
