// Client-side rules for the voice-memo upload control, mirrored against the
// exact same limits the frozen contract declares (VOICE_NOTE_ACCEPTED_MIMETYPES
// / VOICE_NOTE_MAX_BYTES in shared/contract.js) so Kevin gets a clear answer
// immediately instead of waiting through a several-second-to-a-minute
// transcription just to have the server reject the file afterward.

import { VOICE_NOTE_ACCEPTED_MIMETYPES, VOICE_NOTE_MAX_BYTES } from '../../../shared/contract.js'

export { VOICE_NOTE_ACCEPTED_MIMETYPES, VOICE_NOTE_MAX_BYTES }

// Extension fallback for the file-type check: some Android share-sheet /
// file-picker flows hand back a File with an empty or generic `.type`, so a
// name-based check catches those the same way CourseSetup.jsx's own
// `looksLikeAcceptedFile()` falls back to extensions for the syllabus
// upload.
const ACCEPTED_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.webm']

// `accept` attribute value for the file input -- mimetypes plus extensions,
// since browsers honor whichever one a given OS file picker understands.
export const VOICE_ACCEPT_ATTR = [...VOICE_NOTE_ACCEPTED_MIMETYPES, ...ACCEPTED_EXTENSIONS].join(',')

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

const MAX_BYTES_LABEL = formatBytes(VOICE_NOTE_MAX_BYTES)

// Pre-flight check run before any network request. Returns
// `{ ok: true }` or `{ ok: false, message }` -- never throws, so a caller
// can render `message` directly without a try/catch.
export function validateVoiceFile(file) {
  if (!file) return { ok: false, message: 'Choose a voice memo file first.' }

  const looksAccepted =
    VOICE_NOTE_ACCEPTED_MIMETYPES.includes(file.type) ||
    ACCEPTED_EXTENSIONS.some((ext) => file.name && file.name.toLowerCase().endsWith(ext))

  if (!looksAccepted) {
    return {
      ok: false,
      message: 'That file type is not supported. Upload an m4a, mp3, wav, or webm voice memo.',
    }
  }

  if (file.size > VOICE_NOTE_MAX_BYTES) {
    return {
      ok: false,
      message: `This file is too large (${formatBytes(file.size)}). Voice memos must be under ${MAX_BYTES_LABEL}.`,
    }
  }

  return { ok: true }
}

// A server error message is only trustworthy to show verbatim when the API
// actually sent one -- apiFetch-style wrappers fall back to
// `Request failed (<status>)` when a response has no JSON body at all (e.g.
// a proxy timeout), and that generic text should never be shown to Kevin as
// if it were a real explanation.
function hasRealServerMessage(err) {
  return Boolean(err && err.message && !/^Request failed \(\d+\)$/.test(err.message))
}

// Classifies a thrown getVoiceUploadUrl()/submitVoiceNote() error into a
// specific, distinct on-screen message plus which retry affordance makes
// sense:
//   - 'reupload'    -- retrying the exact same file would fail the exact
//                       same way (wrong type, too large), so the retry
//                       action should prompt for a different file.
//   - 'retry-same'  -- a real transient failure (transcription didn't come
//                       back, a network hiccup) where re-sending the same
//                       file is worth trying again.
export function classifyUploadError(err) {
  const status = err && err.status
  const hasMessage = hasRealServerMessage(err)

  if (status === 400) {
    return {
      kind: 'bad-request',
      message: hasMessage ? err.message : 'That file type is not supported for voice memos.',
      retry: 'reupload',
    }
  }

  if (status === 413) {
    return {
      kind: 'too-large',
      message: hasMessage
        ? err.message
        : `This recording is too large to upload. Voice memos must be under ${MAX_BYTES_LABEL}.`,
      retry: 'reupload',
    }
  }

  if (status === 422) {
    return {
      kind: 'transcription-failed',
      message: hasMessage
        ? err.message
        : 'This recording could not be transcribed. It may be silent or unclear, or transcription is not available right now. Try again in a moment.',
      retry: 'retry-same',
    }
  }

  return {
    kind: 'network',
    message: (err && err.message) || 'Something went wrong uploading this voice memo. Try again.',
    retry: 'retry-same',
  }
}
