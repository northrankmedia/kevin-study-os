'use strict';

/**
 * OpenAI Whisper transcription for Kevin Study OS voice memos.
 *
 * DEPLOYMENT STEP (not solved here — no live OpenAI key is provisioned yet):
 * set `OPENAI_API_KEY` in the environment this API runs in. Until then
 * (local dev without a key, and every test in this repo — see
 * `test/setup.js`, which force-empties this var), `transcribeAudio` throws a
 * `TranscriptionError` with a clear message instead of attempting a network
 * call, following the same graceful-degradation convention `extract.js` /
 * `profile.js` already established for a missing Anthropic key.
 *
 * Uses Node's built-in `fetch`/`FormData`/`Blob` rather than the `openai`
 * npm package — this is a single well-documented multipart endpoint call, so
 * pulling in a whole SDK for it isn't worth the added dependency surface.
 * `routes/notes.js` requires this module by reference (not destructured),
 * same convention as `lib/queue.js`, so a test can swap `transcribeAudio`
 * out for a fake after this file has already loaded.
 */

const WHISPER_MODEL = 'whisper-1';
const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Thrown whenever a note-worthy transcript can't be produced: no API key
 * provisioned, the request itself failed, a non-2xx response, or a
 * transcript that came back empty/whitespace-only. Callers (routes/notes.js)
 * map this to a 422 — never a crash, never a note created from garbage.
 */
class TranscriptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer - raw audio bytes
 * @param {string} opts.mimetype - one of VOICE_NOTE_ACCEPTED_MIMETYPES
 * @param {string} opts.filename - original filename, used only as the
 *   multipart part's filename Whisper sees; has no bearing on validation
 * @returns {Promise<string>} the trimmed, non-empty transcript
 * @throws {TranscriptionError} on a missing key, a failed request, or an
 *   empty/whitespace-only transcript — never returns a blank string
 */
async function transcribeAudio({ buffer, mimetype, filename }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TranscriptionError(
      'OPENAI_API_KEY is not set — voice transcription is unavailable until a live key is provisioned.'
    );
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model', WHISPER_MODEL);

  let response;
  try {
    response = await fetch(WHISPER_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new TranscriptionError(`Whisper transcription request failed: ${err.message}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new TranscriptionError(`Whisper transcription failed with status ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const transcript = typeof data.text === 'string' ? data.text.trim() : '';

  if (!transcript) {
    throw new TranscriptionError('Whisper returned an empty transcript.');
  }

  return transcript;
}

module.exports = { TranscriptionError, transcribeAudio, WHISPER_MODEL };
