import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getVoiceUploadUrl, submitVoiceNote, updateNote } from './api.js'

// Tests api.js's fetch wrappers against mocked responses shaped exactly
// like shared/contract.js's schemas for the two voice-memo endpoints and
// PATCH /api/notes/:id -- the same "mock the contract shape, not the live
// backend" approach the task brief calls for, since the real endpoint may
// still be a stub while this runs.

const COURSE_ID = '11111111-1111-4111-8111-111111111111'
const NOTE_ID = '22222222-2222-4222-8222-222222222222'

const UPLOAD_URL_200 = {
  storage_path: 'voice-memos/11111111-1111-4111-8111-111111111111/abc.m4a',
  upload_url: 'https://storage.example.com/signed/upload?token=abc',
  token: 'abc',
}

const VOICE_NOTE_201 = {
  id: NOTE_ID,
  course_id: COURSE_ID,
  note_date: '2026-09-07',
  title: null,
  body_md: 'Professor covered chapter four and mentioned a pop quiz next week.',
  source: 'voice',
  audio_url: 'https://storage.example.com/signed/voice-memo.m4a?token=abc',
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
  deleted_at: null,
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

describe('getVoiceUploadUrl', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs { mimetype, size_bytes } as JSON and returns the signed upload URL info on 200', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, UPLOAD_URL_200))

    const result = await getVoiceUploadUrl(COURSE_ID, { mimetype: 'audio/x-m4a', size_bytes: 2048 })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe(`/api/courses/${COURSE_ID}/notes/voice/upload-url`)
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ mimetype: 'audio/x-m4a', size_bytes: 2048 })

    expect(result).toEqual(UPLOAD_URL_200)
  })

  it('throws a distinguishable error carrying .status on a 400 (bad mimetype)', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'Unsupported audio format.' }))
    await expect(getVoiceUploadUrl(COURSE_ID, { mimetype: 'text/plain', size_bytes: 1 })).rejects.toMatchObject({
      status: 400,
      message: 'Unsupported audio format.',
    })
  })

  it('throws a distinguishable error carrying .status on a 413 (declared size too large)', async () => {
    global.fetch.mockResolvedValue(jsonResponse(413, { error: 'Audio file exceeds the 25MB limit' }))
    await expect(
      getVoiceUploadUrl(COURSE_ID, { mimetype: 'audio/mp4', size_bytes: 999999999 })
    ).rejects.toMatchObject({
      status: 413,
      message: 'Audio file exceeds the 25MB limit',
    })
  })
})

describe('submitVoiceNote', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs { storage_path, original_filename, mimetype, note_date } as JSON and returns the created Note on 201', async () => {
    global.fetch.mockResolvedValue(jsonResponse(201, VOICE_NOTE_201))

    const result = await submitVoiceNote(COURSE_ID, {
      storage_path: UPLOAD_URL_200.storage_path,
      original_filename: 'memo.m4a',
      mimetype: 'audio/x-m4a',
      note_date: '2026-09-07',
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe(`/api/courses/${COURSE_ID}/notes/voice`)
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      storage_path: UPLOAD_URL_200.storage_path,
      original_filename: 'memo.m4a',
      mimetype: 'audio/x-m4a',
      note_date: '2026-09-07',
    })

    expect(result).toEqual(VOICE_NOTE_201)
    expect(result.source).toBe('voice')
    expect(result.audio_url).toMatch(/^https:\/\//)
  })

  it('omits the note_date field entirely when none is given', async () => {
    global.fetch.mockResolvedValue(jsonResponse(201, VOICE_NOTE_201))
    await submitVoiceNote(COURSE_ID, {
      storage_path: UPLOAD_URL_200.storage_path,
      original_filename: 'memo.m4a',
      mimetype: 'audio/x-m4a',
    })
    const [, options] = global.fetch.mock.calls[0]
    expect(JSON.parse(options.body).note_date).toBeUndefined()
  })

  it('throws a distinguishable error carrying .status on a 400 (upload not found in storage)', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'Could not find the uploaded audio file.' }))
    await expect(
      submitVoiceNote(COURSE_ID, { storage_path: 'bogus', original_filename: 'memo.m4a', mimetype: 'audio/mp4' })
    ).rejects.toMatchObject({ status: 400, message: 'Could not find the uploaded audio file.' })
  })

  it('throws a distinguishable error carrying .status on a 413 (downloaded file too large)', async () => {
    global.fetch.mockResolvedValue(jsonResponse(413, { error: 'Audio file exceeds the 25MB limit' }))
    await expect(
      submitVoiceNote(COURSE_ID, {
        storage_path: UPLOAD_URL_200.storage_path,
        original_filename: 'memo.m4a',
        mimetype: 'audio/mp4',
      })
    ).rejects.toMatchObject({ status: 413, message: 'Audio file exceeds the 25MB limit' })
  })

  it('throws a distinguishable error carrying .status on a 422 (transcription failed)', async () => {
    global.fetch.mockResolvedValue(jsonResponse(422, { error: 'Transcription came back empty.' }))
    await expect(
      submitVoiceNote(COURSE_ID, {
        storage_path: UPLOAD_URL_200.storage_path,
        original_filename: 'memo.m4a',
        mimetype: 'audio/mp4',
      })
    ).rejects.toMatchObject({
      status: 422,
      message: 'Transcription came back empty.',
    })
  })

  it('falls back to a generic status message when the server sends no JSON body', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.reject(new Error('no body')),
    })
    await expect(
      submitVoiceNote(COURSE_ID, {
        storage_path: UPLOAD_URL_200.storage_path,
        original_filename: 'memo.m4a',
        mimetype: 'audio/mp4',
      })
    ).rejects.toMatchObject({
      status: 422,
      message: 'Request failed (422)',
    })
  })
})

describe('updateNote', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('PATCHes /api/notes/:id with a JSON body and returns the updated Note', async () => {
    const updated = { ...VOICE_NOTE_201, body_md: 'Corrected transcript text.' }
    global.fetch.mockResolvedValue(jsonResponse(200, updated))

    const result = await updateNote(NOTE_ID, { body_md: 'Corrected transcript text.' })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe(`/api/notes/${NOTE_ID}`)
    expect(options.method).toBe('PATCH')
    expect(JSON.parse(options.body)).toEqual({ body_md: 'Corrected transcript text.' })
    expect(result.body_md).toBe('Corrected transcript text.')
  })

  it('throws with the server message on a 400', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'body_md cannot be empty.' }))
    await expect(updateNote(NOTE_ID, { body_md: '' })).rejects.toThrow('body_md cannot be empty.')
  })
})
