'use strict';

/**
 * Exercises `lib/queue.js`'s real (unmocked) `queueProfileRegeneration` —
 * the debounce is gone, so this verifies the replacement contract directly:
 * regeneration is triggered promptly (no artificial delay) and the caller
 * is never made to wait on it.
 *
 * `require`d (not `import`ed), same convention as notes.test.js/auth.test.js:
 * queue.js reaches profile.js via a lazily-scoped CommonJS `require` inside
 * `runJob`, so patching `profileModule.generateProfile` directly (rather
 * than `vi.mock`) is what lets the fake take effect for a require that
 * happens at call time, not at this file's import time.
 */

import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const profileModule = require('../src/lib/profile.js');
const { queueProfileRegeneration } = require('../src/lib/queue.js');

describe('queueProfileRegeneration', () => {
  it('triggers generateProfile promptly (no artificial delay), without the caller waiting on it', async () => {
    const realGenerateProfile = profileModule.generateProfile;
    let resolveRegeneration;
    let calledWith;
    const regenerationStarted = new Promise((resolveStarted) => {
      profileModule.generateProfile = (courseId) => {
        calledWith = courseId;
        resolveStarted();
        return new Promise((resolve) => {
          resolveRegeneration = resolve;
        });
      };
    });

    try {
      const start = Date.now();
      queueProfileRegeneration('course-test-id');
      const elapsedMs = Date.now() - start;

      // No 5-second debounce: generateProfile is already invoked
      // synchronously as part of this same call, well under any artificial
      // delay.
      expect(elapsedMs).toBeLessThan(50);

      await regenerationStarted;
      expect(calledWith).toBe('course-test-id');
    } finally {
      if (resolveRegeneration) resolveRegeneration({ version: 1 });
      profileModule.generateProfile = realGenerateProfile;
    }
  });
});
