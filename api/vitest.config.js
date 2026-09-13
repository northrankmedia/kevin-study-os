'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    // Forces every test run to use the in-memory Supabase/Anthropic
    // fallback, regardless of a real .env.local on the machine running the
    // tests. See test/setup.js for why this matters.
    setupFiles: ['./test/setup.js'],
  },
});
