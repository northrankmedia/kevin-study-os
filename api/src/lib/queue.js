'use strict';

/**
 * Profile-regeneration job queue — enqueue interface only.
 *
 * This file defines the clean call site notes.js uses
 * (`queueProfileRegeneration(courseId)`); `runJob` below calls the real
 * regeneration logic in `lib/profile.js`. Every caller (notes.js) stays
 * unchanged from the original stub — this is a scheduling wrapper only, not
 * where the synthesis logic itself lives.
 *
 * No debounce, intentionally: this file used to collapse several notes
 * landing for the same course in quick succession into one `setTimeout`-
 * delayed job (5s, per course). That doesn't survive on Vercel — a
 * serverless function instance is very likely torn down shortly after it
 * sends its HTTP response, and a pending `setTimeout` scheduled during that
 * request has a real chance of never firing, which would silently break
 * "the profile updates after notes are added" entirely, not just lose the
 * debounce optimization. At Kevin's actual usage volume (a student adding a
 * few notes per class per day, not rapid-fire), the debounce was only ever
 * an optimization to avoid redundant Claude calls when several notes land
 * within seconds of each other — losing it just means an occasional extra
 * Claude call, which is cheap and harmless at this scale. So
 * `queueProfileRegeneration` now just triggers `runJob` directly, every
 * time, with no delay.
 *
 * `runJob` is not awaited by its caller — `runBackgroundTask` (see
 * `lib/backgroundTask.js`) is what lets it actually finish (via `waitUntil`
 * on Vercel, or simply the process staying alive everywhere else) without
 * making the HTTP request that triggered it wait on it. Errors are caught
 * and logged here rather than left as an unhandled rejection.
 */

const { runBackgroundTask } = require('./backgroundTask');

async function runJob(courseId) {
  try {
    // eslint-disable-next-line global-require -- required lazily so a test
    // that only exercises the trigger mechanism (and stubs runJob's caller)
    // never has to load the Anthropic/Supabase wiring.
    const { generateProfile } = require('./profile');
    const result = await generateProfile(courseId);

    if (result && result.status === 'not_enough_notes') {
      console.log(`[queue] profile regeneration for course ${courseId} skipped — fewer than 2 notes`);
    } else if (result && result.status === 'skipped') {
      console.log(`[queue] profile regeneration for course ${courseId} skipped — already in progress`);
    } else if (result) {
      console.log(`[queue] profile regeneration for course ${courseId} produced version ${result.version}`);
    } else {
      console.log(`[queue] profile regeneration for course ${courseId} produced no new version (validation failed)`);
    }
  } catch (err) {
    console.error(`[queue] profile regeneration for course ${courseId} failed:`, err);
  }
}

function queueProfileRegeneration(courseId) {
  runBackgroundTask(() => runJob(courseId));
}

module.exports = { queueProfileRegeneration };
