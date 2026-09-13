import { describe, it, expect } from 'vitest'
import {
  classifyUploadError,
  formatBytes,
  validateVoiceFile,
  VOICE_NOTE_ACCEPTED_MIMETYPES,
  VOICE_NOTE_MAX_BYTES,
} from './voiceNote.js'

// Mirrors courseFormat.test.js's own convention -- mock objects shaped
// exactly like what the browser's File API and the frozen contract's error
// responses actually look like, no DOM/File polyfill required since only
// `.type`, `.name`, and `.size` are ever read.

function mockFile({ type, name, size }) {
  return { type, name, size }
}

describe('validateVoiceFile', () => {
  it('accepts every mimetype the contract lists', () => {
    for (const type of VOICE_NOTE_ACCEPTED_MIMETYPES) {
      const result = validateVoiceFile(mockFile({ type, name: 'memo', size: 1024 }))
      expect(result.ok).toBe(true)
    }
  })

  it('accepts a recognized extension even when the browser reports no mimetype', () => {
    const result = validateVoiceFile(mockFile({ type: '', name: 'lecture.m4a', size: 1024 }))
    expect(result.ok).toBe(true)
  })

  it('rejects an unsupported file type with a clear, specific message', () => {
    const result = validateVoiceFile(mockFile({ type: 'image/png', name: 'photo.png', size: 1024 }))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not supported/)
  })

  it('rejects a file over VOICE_NOTE_MAX_BYTES with a clear, specific message', () => {
    const result = validateVoiceFile(
      mockFile({ type: 'audio/mpeg', name: 'lecture.mp3', size: VOICE_NOTE_MAX_BYTES + 1 })
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/too large/)
  })

  it('accepts a file exactly at VOICE_NOTE_MAX_BYTES', () => {
    const result = validateVoiceFile(
      mockFile({ type: 'audio/mpeg', name: 'lecture.mp3', size: VOICE_NOTE_MAX_BYTES })
    )
    expect(result.ok).toBe(true)
  })

  it('rejects when no file is given', () => {
    expect(validateVoiceFile(null).ok).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats megabytes with one decimal place', () => {
    expect(formatBytes(25 * 1024 * 1024)).toBe('25.0MB')
  })

  it('formats kilobytes as whole numbers', () => {
    expect(formatBytes(2048)).toBe('2KB')
  })

  it('formats sub-kilobyte sizes in bytes', () => {
    expect(formatBytes(512)).toBe('512B')
  })
})

describe('classifyUploadError', () => {
  it('gives a distinct message for a 413 (file too large) and suggests a different file', () => {
    const err = new Error('Request failed (413)')
    err.status = 413
    const result = classifyUploadError(err)
    expect(result.kind).toBe('too-large')
    expect(result.retry).toBe('reupload')
    expect(result.message).toMatch(/too large/)
  })

  it('gives a distinct message for a 422 (failed transcription) and allows retrying the same file', () => {
    const err = new Error('Request failed (422)')
    err.status = 422
    const result = classifyUploadError(err)
    expect(result.kind).toBe('transcription-failed')
    expect(result.retry).toBe('retry-same')
    expect(result.message).toMatch(/transcrib/)
  })

  it('gives a distinct message for a 400 (bad mimetype) and suggests a different file', () => {
    const err = new Error('Request failed (400)')
    err.status = 400
    const result = classifyUploadError(err)
    expect(result.kind).toBe('bad-request')
    expect(result.retry).toBe('reupload')
  })

  it('prefers the server-provided message when one was actually sent', () => {
    const err = new Error('Transcription came back empty for this file.')
    err.status = 422
    const result = classifyUploadError(err)
    expect(result.message).toBe('Transcription came back empty for this file.')
  })

  it('treats a status-less failure as a retryable network error', () => {
    const err = new Error('Failed to fetch')
    const result = classifyUploadError(err)
    expect(result.kind).toBe('network')
    expect(result.retry).toBe('retry-same')
    expect(result.message).toBe('Failed to fetch')
  })

  it('never produces the same message for all three error statuses', () => {
    const messages = [400, 413, 422].map((status) => {
      const err = new Error(`Request failed (${status})`)
      err.status = status
      return classifyUploadError(err).message
    })
    expect(new Set(messages).size).toBe(3)
  })
})
