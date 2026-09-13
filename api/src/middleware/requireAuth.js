'use strict';

const { ErrorResponseSchema } = require('../../../shared/contract.js');
const { getSessionUser } = require('../lib/auth');

// Applied to every `/api/*` route except `GET /api/health` and
// `POST /api/auth/login` (that exemption is wired in index.js, not here —
// this middleware itself has no route-shape knowledge). Missing, invalid,
// or expired session all collapse to the same generic 401 — no hint about
// which of those it was.
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json(ErrorResponseSchema.parse({ error: 'Not authenticated' }));
  }
  req.user = user;
  next();
}

module.exports = requireAuth;
