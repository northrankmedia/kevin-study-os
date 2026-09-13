'use strict';

const path = require('path');
// Loads D:\kevinStudyOS\.env.local for local/dev runs only. On Vercel, real
// env vars come from the project's dashboard settings directly into
// process.env (see DEPLOY.md) — .env.local is gitignored and never
// deployed (see .vercelignore), so this call is a harmless no-op there
// (dotenv silently does nothing when the file doesn't exist).
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local') });

const express = require('express');
const morgan = require('morgan');

const requireAuth = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth');
const coursesRoutes = require('./routes/courses');
const syllabusRoutes = require('./routes/syllabus');
const boardRoutes = require('./routes/board');
const notesRoutes = require('./routes/notes');
const profileRoutes = require('./routes/profile');

const PORT = process.env.PORT || 3003;

const app = express();

app.use(morgan('dev'));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'kevin-study-os-api',
    timestamp: new Date().toISOString(),
  });
});

// Gate every /api/* route behind a valid session except the two that must
// stay reachable while logged out: the health check and login itself.
function isPublicRoute(req) {
  const path = req.originalUrl.split('?')[0];
  return (
    (req.method === 'GET' && path === '/api/health') ||
    (req.method === 'POST' && path === '/api/auth/login')
  );
}

app.use('/api', (req, res, next) => {
  if (isPublicRoute(req)) return next();
  return requireAuth(req, res, next);
});

app.use('/api', authRoutes);
app.use('/api', coursesRoutes);
app.use('/api', syllabusRoutes);
app.use('/api', boardRoutes);
app.use('/api', notesRoutes);
app.use('/api', profileRoutes);

// 404 for anything under /api that no route above matched.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler — must be registered last, after all routes.
// Never leak stack traces or raw error messages to the client; the full
// error is logged server-side only.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

// `process.env.VERCEL` is set automatically in every Vercel runtime
// environment (production, preview, and `vercel dev`) — Vercel invokes this
// module's exported `app` directly as a serverless function per request and
// never wants anything binding a port. `require.main === module` is kept as
// a second, independent guard (this file is only ever the actual entry
// point when run directly via `node src/index.js`/`npm run dev`/`npm start`
// — any other consumer, including a Vercel-style wrapper that does
// `require('./src/index.js')`, is not `require.main`), so local dev keeps
// working exactly as before either way.
if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`kevin-study-os-api listening on port ${PORT}`);
  });
}

module.exports = app;
