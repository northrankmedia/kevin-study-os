# Deploying Kevin Study OS to Vercel

This app was originally built and tested only as a persistent local Node
process (`web/` on :3000 via Vite's dev server proxying `/api` to `api/` on
:3003). It now deploys as a single Vercel project: the built React frontend
(`web/dist`) served as static files, and the Express API (`api/src/index.js`)
served as one Vercel Function, both on the **same domain** — required
because auth uses an httpOnly `SameSite=Strict` session cookie
(`api/src/lib/auth.js`), which silently stops being sent if the frontend and
API ever end up on different origins.

This file is written for a human to follow step by step. Nothing in it has
been run against the real Vercel account.

## Why the deployment plumbing looks the way it does

- **One Vercel project, not two.** Cloudflare-Pages-style "frontend project +
  separate backend project" is explicitly wrong here — see the cookie note
  above. `vercel.json`'s `rewrites` send `/api/*` to the Express function and
  everything else to the built frontend, from one project/one domain.
- **`api/src/index.js` is the Vercel Function, unmodified in its routing
  logic.** Vercel's current, non-deprecated convention for a plain Node/
  Express project is "any `.js`/`.ts`/`.mjs` file under a top-level `api/`
  directory becomes its own Vercel Function, addressed by its own path with
  the extension stripped" (see Vercel's "Advanced Node.js Usage" and
  "Advanced Configuration" docs). This repo's backend workspace already
  happens to be named `api/` — so `api/src/index.js` (which does
  `module.exports = app`, an Express app — itself a callable
  `(req, res)` function) is automatically picked up as a Vercel Function at
  `/api/src/index`, with zero extra wiring. `vercel.json`'s `rewrites` map
  every real `/api/*` request onto that one path, and `functions` sets its
  `maxDuration`.
- **Known quirk of that convention, and why it's harmless here:** the same
  directory scan also picks up every *other* `.js` file under `api/src/**`
  (`lib/*.js`, `routes/*.js`, `middleware/*.js`) as its *own* separate,
  additional Vercel Function, since none of them are prefixed with `_`
  or `.` (Vercel's documented way to opt a helper file out of this scan —
  not usable here without renaming files two other in-flight tasks are
  actively editing by their current paths). These extra "shadow" functions
  are never reachable in production: the `rewrites` entry above intercepts
  *every* path under `/api/*` before Vercel would ever fall through to one
  of their own file-based routes, and nothing in this app links to them.
  Worst case if someone directly requests e.g. `/api/src/lib/queue`, they
  get a 500 (that file's export isn't a valid request handler) — no data
  or secret exposure, just dead weight in the Vercel dashboard and a little
  extra build time. `api/test/**` is excluded from the deployment via
  `.vercelignore` (never needed at runtime, and the one category of file in
  this tree that could otherwise do something *actively* confusing — vitest
  globals like `describe`/`it` are undefined outside a test run).
  If this ever bothers you enough to clean up: the real fix is moving
  `api/src/lib` and `api/src/routes` under underscore-prefixed names (or,
  more simply, moving them entirely out of a directory literally named
  `api/`), which is a coordinated refactor, not a one-line config change —
  intentionally out of scope for this deployment-plumbing pass.
- **One Function, one `maxDuration`, not per-route.** Because the whole
  Express app (all routes, shared session/auth middleware, the single
  error handler) ships as one Vercel Function, `maxDuration` can only be set
  once for that whole function, not per internal Express route. It's set to
  `300` (the Pro-plan ceiling) so the three routes that call Claude/Whisper
  (`POST /api/courses/:id/syllabus`, `POST /api/courses/:id/notes/voice`,
  `POST /api/courses/:id/profile/regenerate`) have real headroom. This
  costs nothing extra for the fast routes (auth, board, note CRUD) —
  Vercel Functions are billed on actual compute used, not on the configured
  ceiling — the only real tradeoff is that a genuinely hung request on a
  fast route could now run up to 300s before Vercel kills it, instead of a
  smaller default. Splitting into multiple Functions (one per
  `maxDuration` tier) would require duplicating `index.js`'s shared
  middleware setup across several new entrypoint files and was judged not
  worth it for a single-user app — flag this if it ever needs revisiting.
- **`api/src/prompts/*.md`** (the Claude prompt templates for syllabus
  extraction and course-profile generation) are loaded via
  `fs.readFileSync(path.join(__dirname, ...))`, not `require()`, so
  Vercel's automatic dependency tracing might not pick them up. `functions`
  in `vercel.json` explicitly lists them under `includeFiles` so they're
  guaranteed present in the deployed bundle.
- **`multer` uses `memoryStorage()`** in both `routes/syllabus.js` and
  `routes/notes.js` already — no disk writes, so nothing here needed to
  change for the serverless filesystem to work. (A separate in-flight task
  is reworking these routes toward direct-to-storage uploads; this
  deployment pass does not touch that logic.)
- **`api/src/lib/auth.js`'s login rate limiting and `api/src/lib/queue.js`
  /`api/src/lib/backgroundTask.js`'s background-job triggering already have
  Vercel-serverless-aware comments and a real `@vercel/functions`
  `waitUntil()` code path** (`process.env.VERCEL` gated) — these were
  written by the parallel tasks with Vercel already in mind, and this pass
  does not change them.

## Environment variables to set in the Vercel project dashboard

Project → Settings → Environment Variables. Set each for **Production**,
**Preview**, and (if you use `vercel dev`) **Development**. Never commit
real values anywhere in the repo — `.env.example` at the repo root has the
placeholder list this mirrors.

| Variable | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase project settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings → API → `service_role` secret key. Server-only — read only by `api/`, never bundled into `web/`. |
| `ANTHROPIC_API_KEY` | Anthropic console → API keys |
| `ANTHROPIC_MODEL_HAIKU` | Pinned model id, e.g. `claude-haiku-4-5-20251001` (see `.env.example`'s comment) |
| `ANTHROPIC_MODEL_SONNET` | Pinned model id — **must be set explicitly**; if left unset `api/src/lib/profile.js` falls back to a hardcoded default, confirm that's still correct before relying on it |
| `OPENAI_API_KEY` | OpenAI platform → API keys — used only by `api/src/lib/transcribe.js` for voice-memo transcription (`POST /api/courses/:id/notes/voice`). Endpoint degrades to a clean 422 if unset, not a crash. |
| `DATABASE_URL` | Optional — a direct Postgres connection string from Supabase project settings → Database → Connection string. Only used by `api/src/lib/profileLock.js` for a real `pg_try_advisory_xact_lock`; safe to leave unset (falls back to an in-memory lock, fine for Kevin's single-user, single-course-at-a-time usage but not safe across multiple concurrent Function instances — set this in production if regeneration races ever show up in practice). |
| `SESSION_SECRET` | Generate a long random string yourself, e.g. `openssl rand -hex 32` |
| `KEVIN_EMAIL` | Kevin's login email |
| `KEVIN_PASSWORD_HASH` | Argon2 hash — generate with `node scripts/generate-password-hash.js` (run locally, never commit the plaintext password) |
| `PORT` | Not used on Vercel (Vercel invokes the exported handler directly, nothing binds a port) — safe to leave unset in the Vercel dashboard; only matters for local `npm run dev` |

## Vercel project settings

- **Root Directory:** repo root (leave blank / `.`) — do **not** set it to
  `api/` or `web/`. Both `vercel.json`'s `outputDirectory` (`web/dist`) and
  `functions` key (`api/src/index.js`) are relative to the repo root, and
  the single project needs to see both `api/` and `web/` at once.
- **Framework Preset:** Other (this repo's `vercel.json` sets
  `"framework": null` explicitly so nothing auto-detected ever silently
  overrides the explicit build/output config below).
- **Build Command:** `npm run build` (from `vercel.json`; runs the root
  package.json's `build` script — `npm install && npm run build
  --workspace=web`, i.e. installs every workspace, `api` and `web` both
  included via npm workspaces hoisting, then builds the Vite frontend).
- **Output Directory:** `web/dist`.
- **Install Command:** `npm install` (from `vercel.json`; also happens
  again inside the `build` script above — redundant but harmless, and
  means `npm run build` alone reproduces the Vercel build from a clean
  clone).
- **Node.js Version:** 24.x (pinned via `"engines"` in the repo-root
  `package.json`; must be 22.12+ — `shared/contract.js` relies on Node's
  synchronous `require()` of an ES module, which isn't supported below that.
  Vercel's dashboard "Node.js Version" project setting is a SEPARATE control
  from this `engines` field and governs the actual deployed Function
  runtime — confirm it's also set to 24.x (or at least 22.x) under Project
  Settings → General, don't rely on `engines` alone. Node 20 predates
  `require(esm)` entirely and is also being deprecated on Vercel October 1,
  2026 — see https://vercel.com/changelog/node-js-20-is-being-deprecated.

## First real deploy — step by step

```bash
# 1. From WSL or any terminal where you're comfortable running an
#    interactive login flow (this one command opens a browser):
npm install -g vercel   # or use `npx vercel@latest` for every command below

# 2. From the repo root (D:\kevinStudyOS):
vercel link
#    - "Set up and deploy?" -> yes
#    - Link to existing project, or create a new one (e.g. "kevin-study-os")
#    - This writes .vercel/project.json locally (already gitignored — check
#      `.gitignore` before committing anything if that ever changes)

# 3. Add every environment variable from the table above, once per
#    environment you care about (repeat for --environment=preview and
#    --environment=development if you'll use `vercel dev`):
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_MODEL_HAIKU production
vercel env add ANTHROPIC_MODEL_SONNET production
vercel env add OPENAI_API_KEY production
vercel env add DATABASE_URL production        # optional, can skip
vercel env add SESSION_SECRET production
vercel env add KEVIN_EMAIL production
vercel env add KEVIN_PASSWORD_HASH production
#    (Each prompts you to paste the real value — nothing typed here ever
#    touches a file in the repo.)

# 4. Sanity-check the build locally first, without deploying:
vercel build
#    Inspect .vercel/output/ if you want to see exactly what would ship.

# 5. Deploy a preview first (recommended before touching production):
vercel
#    Open the preview URL it prints. Check:
#      - GET /api/health returns { status: "ok", ... }
#      - /login loads, and logging in with KEVIN_EMAIL / the real password
#        for KEVIN_PASSWORD_HASH redirects to the board
#      - the board loads courses/items after logging in
#      - uploading a syllabus and a voice memo both complete (these are the
#        routes with the 300s maxDuration — watch Vercel's function logs if
#        either seems slow or times out)

# 6. Once the preview looks right, promote to production:
vercel --prod
```

## What to double-check yourself on that first deploy

This pass could not fully verify the following in this environment (no
Vercel login available here — see the verification report for exactly what
*was* checked):

- That `argon2` (a native module, used by `api/src/lib/auth.js` for
  password hashing) installs cleanly on Vercel's actual Linux build
  environment. It ships prebuilt binaries for common Linux targets and
  Vercel always does a fresh install on Linux regardless of your local OS,
  so this should be fine — but it's exactly the kind of thing that's cheap
  to confirm and expensive to discover broken in production. Check the
  build logs for the `vercel build` / `vercel --prod` step above for any
  argon2-related install errors.
- That the "shadow Vercel Functions" described above (`api/src/lib/*.js`,
  `api/src/routes/*.js`, `api/src/middleware/*.js` each becoming their own
  extra, unreachable Function entry) don't push you over any Vercel plan
  limit on function count. Unlikely at this app's size, but worth a glance
  at the deployment's Functions tab after the first deploy.
- That `GET /api/health` and a couple of authenticated routes behave
  identically through `vercel dev` / the real deployment as they do
  through plain `npm run dev` — this pass verified the local (non-Vercel)
  server and the production build output, but could not run `vercel dev`
  or `vercel build` end-to-end without a Vercel login. Do this once you
  run step 4 above.
