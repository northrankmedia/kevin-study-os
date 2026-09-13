# Kevin Study OS

Single-user college course tracker: syllabus parsing, task board, daily notes, AI course-summary pipeline. Kevin is the only user (see `supabase/README.md`).

This is **Task 2** of a larger build: the runnable repo skeleton and the frozen HTTP contract. Auth, syllabus extraction, notes, the calendar board, and the AI course-profile pipeline are later tasks that build against exactly what's defined here.

## Layout

```
api/            Express app (port 3003)
  src/index.js       app entry point, middleware, route mounting, error handler
  src/routes/        one file per resource area (auth, courses, syllabus, board, notes, profile)
  src/lib/docPrep.js document-prep module (pre-existing, Task 1 of this piece — DOCX/PDF -> Claude-ready input)
  test/              vitest — docPrep.test.js (pre-existing) + contract.test.js (new)
web/            React + Vite frontend (port 3000), proxies /api/* to :3003
shared/
  contract.js        Zod schemas for every resource + the frozen endpoint list
supabase/
  migrations/0001_init.sql   the finalized DB schema (Task 1)
  README.md                  schema design rationale
fixtures/       real syllabus fixtures + expected-extraction JSON (used by later tasks)
```

## Workspace setup

This repo uses **npm workspaces** (`api`, `web`, `shared`) so a single `npm install` at the repo root installs and hoists dependencies for all three, and `shared/contract.js` resolves cleanly from both `api/` (via `require`) and `web/` (via `import`).

```
npm install          # from D:\kevinStudyOS — installs all three workspaces
npm run dev           # starts the Express API (3003) and the Vite dev server (3000) together
```

Or run them separately:

```
npm run dev:api        # Express only, http://localhost:3003
npm run dev:web        # Vite only, http://localhost:3000 (proxies /api to :3003)
```

Visit `http://localhost:3000` — you should see "Kevin Study OS" and the API health payload (proven end-to-end through the Vite proxy). `GET http://localhost:3003/api/health` on its own returns 200 with a small status payload.

## The frozen contract

`shared/contract.js` exports:
- Zod schemas for every DB-backed resource (`Course`, `SyllabusUpload`, `GradingComponent`, `SyllabusItem`, `Note`, `CourseProfile`, ...), matching `supabase/migrations/0001_init.sql` field-for-field.
- Request/response schemas for every endpoint.
- `ENDPOINTS` — the frozen list of every route, method, and its documented response schemas per status code.

**Why one plain CommonJS file works for both a CommonJS app and an ESM app:** `shared/contract.js` is plain CommonJS (`module.exports = { ... }`) — `api/` (CommonJS, matching the existing `docPrep.js` style) does `const { CourseSchema } = require('../../../shared/contract.js')`, while `web/` (Vite, native ESM) does `import { CourseSchema } from '../../shared/contract.js'`, which Vite/esbuild's CJS interop resolves fine. One file, no duplication, no build step.

(An earlier version of this file set `shared/package.json`'s `"type": "module"` and relied on Node 22.12+'s synchronous `require()`-of-an-ES-module support instead, to let `api/` consume the exact same ESM syntax `web/` does. That worked in local dev and in every test in this repo, but broke in production: Vercel's deployed Function runtime throws `ERR_REQUIRE_ESM` on that require() regardless of the configured Node.js version — its stack traces show a custom Rust-based runtime that doesn't implement the feature. Plain CommonJS has no such platform-specific gap.)

### Endpoint list (frozen — see `shared/contract.js` for exact schemas)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → `{user}` (200) or `{error}` (401) |
| POST | `/api/auth/logout` | 204 |
| GET | `/api/me` | `{user}` (200) or `{error}` (401) |
| GET | `/api/courses` | `Course[]` |
| POST | `/api/courses/:id/syllabus` | multipart upload (`file` field) → `{upload, items, gradingComponents, termMismatch}` |
| GET | `/api/courses/:id/syllabus-items` | `SyllabusItem[]` |
| PATCH | `/api/items/:id` | partial `SyllabusItem` → updated `SyllabusItem` |
| GET | `/api/board` | query: `from, to, courseIds, state` → day-grouped `SyllabusItem[]` |
| GET | `/api/courses/:id/notes` | paged, newest first → `Note[]` |
| POST | `/api/courses/:id/notes` | `{note_date, body_md, title?}` → `Note` (201) |
| PATCH | `/api/notes/:id` | partial `Note` → updated `Note` |
| DELETE | `/api/notes/:id` | 204 |
| GET | `/api/courses/:id/profile` | `CourseProfile` or `{status: 'not_enough_notes'}` |
| POST | `/api/courses/:id/profile/regenerate` | `{status: 'queued'}` or new `CourseProfile` |

Every route above is currently a **stub**: it returns a fixed mock object that validates against its own Zod schema, with no real Supabase or Anthropic calls behind it yet. `GET /api/courses/:id/profile` demonstrates both branches by treating the path param value `not-enough-notes` as a sentinel that returns `{status: 'not_enough_notes'}`; any other id returns the mock full profile.

## Testing

```
cd api
npm test
```

Runs vitest: the pre-existing `docPrep.test.js` (unchanged, still passing) plus the new `contract.test.js`, which spins up the Express app in-process (via `supertest`) and, for every entry in `shared/contract.js`'s `ENDPOINTS` list, hits the route and validates the actual JSON response against that endpoint's documented Zod schema for the status code returned.

## Environment variables

See `.env.example` at the repo root for every variable name and a placeholder. Copy it to `.env.local` (gitignored, never committed) and fill in real values before wiring up real Supabase/Anthropic calls in later tasks. `SUPABASE_SERVICE_ROLE_KEY` must only ever be read server-side by `api/` — never bundled into `web/`.

## Out of scope for this task

No real DB calls, no Anthropic calls, no auth logic beyond a fixed-identity stub, no calendar/notes/profile UI. See the top of this file and each route file's comments for exactly what's stubbed vs. real.

## Deployment

This app deploys to Vercel (one project, one domain, serving both the built
frontend and the API — required for the session cookie to work). See
`DEPLOY.md` at the repo root for environment variables, Vercel project
settings, and first-deploy steps.
