'use strict';

/**
 * Runs `fn` (a no-argument function returning a promise) in the background:
 * kicked off immediately, never awaited by the caller, but with best effort
 * given to actually letting it finish even after the caller's own HTTP
 * response has already been sent.
 *
 * On a normal long-lived Node process (local dev, every test in this repo,
 * any non-Vercel deployment), plain fire-and-forget is enough: the process
 * keeps running after the response goes out, so an un-awaited call to
 * `fn()` reliably runs to completion on its own.
 *
 * On Vercel specifically, a serverless function instance is very likely torn
 * down shortly after it sends its response — an un-awaited async call
 * started inside the handler has a real chance of being cut off mid-flight.
 * `waitUntil` (from `@vercel/functions`) is exactly the escape hatch for
 * this: it tells the platform "keep this instance alive until this promise
 * settles" without making the HTTP response itself wait on it. Detected via
 * `process.env.VERCEL`, which the platform sets on every Vercel deployment
 * and which is never set locally or in tests — so nothing changes outside
 * of an actual Vercel runtime.
 */

let cachedWaitUntil = null;

function resolveWaitUntil() {
  if (!cachedWaitUntil) {
    // eslint-disable-next-line global-require -- only resolved on an actual
    // Vercel runtime, so this dependency is never required in local dev or
    // in any test in this repo.
    ({ waitUntil: cachedWaitUntil } = require('@vercel/functions'));
  }
  return cachedWaitUntil;
}

/**
 * @param {() => Promise<any>} fn
 */
function runBackgroundTask(fn) {
  if (process.env.VERCEL) {
    resolveWaitUntil()(fn());
  } else {
    fn();
  }
}

// Test-only utility — substitutes a fake in place of the real
// `@vercel/functions` `waitUntil`, so the Vercel branch above can be
// exercised without a real Vercel runtime. Not reachable from any HTTP
// route. `@vercel/functions`'s own `waitUntil` export is a non-configurable
// getter (its build output defines named exports via `Object.defineProperty`
// with no setter) — it cannot be monkey-patched in place the way this repo's
// other tests patch a plain CommonJS module's own exports, so this explicit
// seam exists instead. Pass `null` to clear the override and go back to
// resolving the real `waitUntil` on the next call.
function __setWaitUntilForTests(fakeWaitUntil) {
  cachedWaitUntil = fakeWaitUntil;
}

module.exports = { runBackgroundTask, __setWaitUntilForTests };
