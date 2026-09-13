'use strict';

const express = require('express');
const {
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  ErrorResponseSchema,
} = require('../../../shared/contract.js');
const {
  verifyPassword,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  isRateLimited,
  recordFailedLoginAttempt,
  clearLoginAttempts,
} = require('../lib/auth');
const { getSupabaseClient } = require('../lib/supabaseClient');

const router = express.Router();

// Generic on purpose — unknown email and wrong password must be
// indistinguishable to the caller.
const INVALID_CREDENTIALS_ERROR = 'Invalid email or password';

router.post('/auth/login', async (req, res, next) => {
  try {
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
    }

    const ip = req.ip;

    // Checked before any DB/hash work — a rate-limited caller shouldn't be
    // able to burn a password-verification cycle at all.
    if (await isRateLimited(ip)) {
      return res
        .status(429)
        .json(ErrorResponseSchema.parse({ error: 'Too many login attempts. Try again later.' }));
    }

    const supabase = getSupabaseClient();
    const { data: userRow, error } = await supabase
      .from('app_user')
      .select('id, email, password_hash')
      .eq('email', parsed.data.email)
      .single();

    // PGRST116 is PostgREST's "no rows found" code for .single() — that's
    // an unknown email, not a real failure. Any other error is a genuine
    // DB/network problem and should surface as a 500, not a 401.
    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (!userRow) {
      await recordFailedLoginAttempt(ip);
      return res.status(401).json(ErrorResponseSchema.parse({ error: INVALID_CREDENTIALS_ERROR }));
    }

    const passwordOk = await verifyPassword(parsed.data.password, userRow.password_hash);
    if (!passwordOk) {
      await recordFailedLoginAttempt(ip);
      return res.status(401).json(ErrorResponseSchema.parse({ error: INVALID_CREDENTIALS_ERROR }));
    }

    await clearLoginAttempts(ip);

    const user = { id: userRow.id, email: userRow.email };
    setSessionCookie(res, createSessionToken(user));

    res.status(200).json(LoginResponseSchema.parse({ user }));
  } catch (err) {
    next(err);
  }
});

// Gated by requireAuth in index.js like every other /api/* route except
// health and login — a session is required to log out of it.
router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// Gated by requireAuth in index.js — by the time this handler runs,
// req.user is already populated from a verified session.
router.get('/me', (req, res) => {
  res.status(200).json(MeResponseSchema.parse({ user: req.user }));
});

module.exports = router;
