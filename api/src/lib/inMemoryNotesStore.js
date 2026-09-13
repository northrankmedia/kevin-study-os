'use strict';

/**
 * Minimal in-memory stand-in for the subset of @supabase/supabase-js's
 * PostgREST query builder that `routes/notes.js` actually uses
 * (select/insert/update, chained with eq/is/order/range/single), plus
 * `gte`/`lt`, added for `lib/auth.js`'s login-attempts rate limiter
 * (supabase/migrations/0003_login_attempts.sql), which counts and prunes
 * rows by a `timestamptz` window rather than an exact-match column.
 *
 * This is NOT a general-purpose Supabase mock. It exists solely so the API
 * runs end-to-end (including in tests) before a live Supabase project is
 * provisioned — see the deployment note in `supabaseClient.js`. Swapping in
 * a real project later is purely an env-var change; no route code changes.
 *
 * It also mirrors the one piece of DB behavior routes.js relies on but
 * never sets itself: `set_updated_at()` (0001_init.sql) stamps `updated_at`
 * on every UPDATE regardless of what the client sends, so this fake does
 * the same.
 */

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Mirrors `syllabus_items.sort_date` (0001_init.sql: `generated always as
 * (coalesce(due_start, due_end)) stored`) — the one other generated-column
 * behavior this fake needs to simulate, same spirit as the `updated_at`
 * mirroring documented in this file's module comment. Only touches a row
 * that actually has a `due_start`/`due_end` key at all (i.e. `syllabus_items`
 * rows); every other table (notes, courses, ...) has neither key and this is
 * a no-op for them.
 */
function applyGeneratedColumns(row) {
  if ('due_start' in row || 'due_end' in row) {
    row.sort_date = row.due_start ?? row.due_end ?? null;
  }
  return row;
}

class InMemoryQueryBuilder {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.op = null; // 'select' | 'insert' | 'update' | 'delete'
    this.payload = null;
    this.orderSpec = null;
    this.rangeSpec = null;
    this.limitSpec = null;
    this.wantsSingle = false;
    this.wantsMaybeSingle = false;
  }

  select() {
    if (this.op === null) this.op = 'select';
    return this;
  }

  insert(row) {
    this.op = 'insert';
    this.payload = row;
    return this;
  }

  update(patch) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => row[column] >= value);
    return this;
  }

  lt(column, value) {
    this.filters.push((row) => row[column] < value);
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orderSpec = { column, ascending };
    return this;
  }

  range(from, to) {
    this.rangeSpec = { from, to };
    return this;
  }

  limit(n) {
    this.limitSpec = n;
    return this;
  }

  single() {
    this.wantsSingle = true;
    return this;
  }

  // Like `.single()`, but zero matched rows is not an error (real
  // supabase-js `.maybeSingle()` semantics) — used wherever "not found" is
  // an expected, handled outcome rather than a failure.
  maybeSingle() {
    this.wantsMaybeSingle = true;
    return this;
  }

  then(resolve, reject) {
    this._execute().then(resolve, reject);
  }

  async _execute() {
    if (this.op === 'insert') return this._executeInsert();
    if (this.op === 'update') return this._executeUpdate();
    if (this.op === 'delete') return this._executeDelete();
    return this._executeSelect();
  }

  _matches(row) {
    return this.filters.every((matchesFilter) => matchesFilter(row));
  }

  _singleResult(rows) {
    if (rows.length === 1) return { data: rows[0], error: null };
    if (this.wantsMaybeSingle && rows.length === 0) return { data: null, error: null };
    return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
  }

  _executeInsert() {
    const now = nowIso();
    const row = {
      title: null,
      deleted_at: null,
      ...this.payload,
      // Real Postgres only applies `default gen_random_uuid()` when `id` is
      // OMITTED from the insert — an explicitly-provided id (as this app's
      // syllabus pipeline relies on, to wire cross-references before any DB
      // round-trip) must be respected, not silently overwritten.
      id: this.payload.id || crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    };
    applyGeneratedColumns(row);
    this.table.rows.push(row);
    if (this.wantsSingle || this.wantsMaybeSingle) return this._singleResult([row]);
    return { data: [row], error: null };
  }

  _executeUpdate() {
    const now = nowIso();
    const matched = this.table.rows.filter((row) => this._matches(row));
    matched.forEach((row) => applyGeneratedColumns(Object.assign(row, this.payload, { updated_at: now })));
    if (this.wantsSingle || this.wantsMaybeSingle) return this._singleResult(matched);
    return { data: matched, error: null };
  }

  _executeDelete() {
    const matched = this.table.rows.filter((row) => this._matches(row));
    const matchedIds = new Set(matched.map((row) => row.id));
    this.table.rows = this.table.rows.filter((row) => !matchedIds.has(row.id));
    if (this.wantsSingle || this.wantsMaybeSingle) return this._singleResult(matched);
    return { data: matched, error: null };
  }

  _executeSelect() {
    let rows = this.table.rows.filter((row) => this._matches(row));

    if (this.orderSpec) {
      const { column, ascending } = this.orderSpec;
      rows = [...rows].sort((a, b) => {
        if (a[column] < b[column]) return ascending ? -1 : 1;
        if (a[column] > b[column]) return ascending ? 1 : -1;
        return 0;
      });
    }

    if (this.rangeSpec) {
      rows = rows.slice(this.rangeSpec.from, this.rangeSpec.to + 1);
    }

    if (this.limitSpec != null) {
      rows = rows.slice(0, this.limitSpec);
    }

    if (this.wantsSingle || this.wantsMaybeSingle) return this._singleResult(rows);
    return { data: rows, error: null };
  }
}

function createInMemorySupabaseClient() {
  const tables = new Map();
  // Per-bucket path -> { buffer, contentType } — needed (unlike the old
  // no-op `upload()`) now that the syllabus/voice-note routes `.download()`
  // a file a test seeded via `.upload()` to stand in for "the browser
  // already PUT this file directly to Supabase Storage via a signed URL"
  // (see the task's own note on testing against this fallback additively).
  const storageBuckets = new Map();

  function tableFor(name) {
    if (!tables.has(name)) tables.set(name, { rows: [] });
    return tables.get(name);
  }

  function bucketFor(name) {
    if (!storageBuckets.has(name)) storageBuckets.set(name, new Map());
    return storageBuckets.get(name);
  }

  return {
    from(name) {
      return new InMemoryQueryBuilder(tableFor(name));
    },
    // Minimal stand-in for the storage calls the syllabus/voice-notes
    // pipelines make (a signed upload URL for the browser to PUT the raw
    // file directly to, then later a server-side download of those same
    // bytes, then a short-lived signed URL to read it back) — no real
    // object storage exists until a live Supabase project is provisioned,
    // so bytes are just kept in memory per bucket/path.
    storage: {
      from(bucketName) {
        const bucket = bucketFor(bucketName);
        return {
          async upload(path, body, options = {}) {
            const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
            bucket.set(path, { buffer, contentType: options.contentType || 'application/octet-stream' });
            return { data: { path }, error: null };
          },
          // Server-side fetch of previously-"uploaded" bytes — mirrors real
          // supabase-js's `download()`, which resolves a Blob-like object
          // (`.arrayBuffer()` works on both), not a raw Buffer.
          async download(path) {
            const object = bucket.get(path);
            if (!object) {
              return { data: null, error: { message: `Object not found: ${bucketName}/${path}` } };
            }
            return { data: new Blob([object.buffer], { type: object.contentType }), error: null };
          },
          // A fake signed URL string is fine here — same spirit as
          // `upload()` above, just for the read side. Scoped by bucket name
          // so two different buckets' fake URLs never collide.
          async createSignedUrl(path) {
            return { data: { signedUrl: `https://in-memory-stub/${bucketName}/${path}` }, error: null };
          },
          // Fake signed *upload* URL/token pair for the direct-to-storage
          // flow's mint-a-URL endpoints — nothing ever actually PUTs to this
          // URL in tests (there is no real HTTP server behind it), so its
          // exact shape only needs to satisfy `UploadUrlResponseSchema`.
          async createSignedUploadUrl(path) {
            const token = crypto.randomUUID();
            return {
              data: { signedUrl: `https://in-memory-stub/${bucketName}/${path}?token=${token}`, token, path },
              error: null,
            };
          },
        };
      },
    },
  };
}

module.exports = { createInMemorySupabaseClient };
