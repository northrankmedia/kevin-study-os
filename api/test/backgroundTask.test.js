'use strict';

/**
 * Exercises `lib/backgroundTask.js` directly: the plain fire-and-forget
 * fallback (every environment this repo's tests actually run in), and the
 * `waitUntil`-backed Vercel path (verified here via
 * `__setWaitUntilForTests`, backgroundTask.js's own test-only seam — there
 * is no real Vercel runtime available in this environment, same limitation
 * as every other live-integration path in this repo).
 */

import { createRequire } from 'module';
import { describe, it, expect, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const { runBackgroundTask, __setWaitUntilForTests } = require('../src/lib/backgroundTask.js');

describe('runBackgroundTask', () => {
  afterEach(() => {
    delete process.env.VERCEL;
    __setWaitUntilForTests(null);
  });

  it('outside Vercel (process.env.VERCEL unset), calls fn immediately — plain fire-and-forget', () => {
    delete process.env.VERCEL;

    let called = false;
    runBackgroundTask(() => {
      called = true;
      return Promise.resolve('done');
    });

    expect(called).toBe(true);
  });

  it('on Vercel (process.env.VERCEL set), hands fn()\'s promise to waitUntil so the platform keeps the instance alive until it settles', () => {
    process.env.VERCEL = '1';
    const waitUntilCalls = [];
    __setWaitUntilForTests((promise) => {
      waitUntilCalls.push(promise);
    });

    let called = false;
    let capturedPromise;
    runBackgroundTask(() => {
      called = true;
      capturedPromise = Promise.resolve('done');
      return capturedPromise;
    });

    expect(called).toBe(true);
    expect(waitUntilCalls).toHaveLength(1);
    expect(waitUntilCalls[0]).toBe(capturedPromise);
  });
});
