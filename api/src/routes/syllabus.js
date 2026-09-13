'use strict';

const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const {
  UploadUrlRequestSchema,
  UploadUrlResponseSchema,
  SyllabusProcessRequestSchema,
  SyllabusUploadResponseSchema,
  SyllabusItemSchema,
  SyllabusItemPatchRequestSchema,
  ErrorResponseSchema,
} = require('../../../shared/contract.js');
const { getSupabaseClient } = require('../lib/supabaseClient');
const {
  computeContentHash,
  remapGradingComponentIds,
  extractSyllabus,
  reconcileItems,
  ExtractionValidationError,
} = require('../lib/extract');
const { prepareDocument, SUPPORTED_MIMETYPES, MAX_PDF_BYTES } = require('../lib/docPrep');

const router = express.Router();

const SYLLABUS_BUCKET = 'syllabi';
const SYLLABUS_MIME_EXTENSIONS = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

// `syllabus_uploads.storage_path`/the fallback quarantine row are stored
// with the bucket name as a human-readable prefix (same convention as
// `notes.js`'s `audio_storage_path`), but the actual storage API calls
// (download) take a path relative to the bucket — this strips that prefix
// back off.
function bucketRelativePath(fullPath) {
  const prefix = `${SYLLABUS_BUCKET}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

const HAIKU_MODEL = process.env.ANTHROPIC_MODEL_HAIKU || 'claude-haiku-4-5-20251001';

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The frozen contract documents only a 200 response for this endpoint (see
 * `shared/contract.js`'s `ENDPOINTS` entry) — there is deliberately no error
 * status in that shape. That matches the task's own instruction: on
 * anything that prevents a real parse (an unreadable file, a Claude
 * extraction that fails validation twice, no course/term to attach to, a
 * downstream Supabase failure), the right response is a "needs manual
 * review" state the caller can render, never a 4xx/5xx the frozen contract
 * doesn't advertise and never a partial write of made-up rows.
 *
 * When the failure happened after a real course_id was confirmed to exist,
 * this best-effort-persists a quarantined `syllabus_uploads` row so the
 * failure is visible to Kevin later, not just swallowed in memory. If even
 * that can't be written (e.g. no live Supabase project configured yet), the
 * response is still returned — just not durably recorded anywhere.
 */
async function buildFallbackResponse({ supabase, courseId, reason, checksum, storagePath, originalFilename }) {
  console.error(
    `[syllabus] extraction failed for course ${courseId} (file: ${originalFilename || 'unknown'}): ${reason}`
  );

  const fallbackUpload = {
    id: crypto.randomUUID(),
    course_id: courseId,
    storage_path: storagePath || `syllabi/${courseId}/unprocessed`,
    checksum: checksum || 'unavailable',
    term_detected: null,
    term_mismatch: false,
    status: 'quarantined',
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from('syllabus_uploads')
      .insert({
        id: fallbackUpload.id,
        course_id: courseId,
        storage_path: fallbackUpload.storage_path,
        checksum: fallbackUpload.checksum,
        term_detected: null,
        term_mismatch: false,
        status: 'quarantined',
      })
      .select()
      .single();
    if (!error && data) {
      return SyllabusUploadResponseSchema.parse({
        upload: data,
        items: [],
        gradingComponents: [],
        termMismatch: false,
      });
    }
  } catch (persistErr) {
    console.error('[syllabus] could not persist the quarantined fallback upload row:', persistErr);
  }

  return SyllabusUploadResponseSchema.parse({
    upload: fallbackUpload,
    items: [],
    gradingComponents: [],
    termMismatch: false,
  });
}

/**
 * Compensating rollback for the sequential inserts in the try block below —
 * the closest available approximation of a transaction against
 * supabase-js's REST-based client (no raw multi-table SQL transaction is
 * available without a custom RPC function, which is out of scope here).
 * Deletes only rows THIS request inserted, and restores any existing item it
 * soft-deleted back to active. Never touches anything else.
 */
async function rollback(supabase, tracker) {
  try {
    if (tracker.insertedItemIds.length) {
      await supabase.from('syllabus_items').delete().in('id', tracker.insertedItemIds);
    }
    if (tracker.softDeletedItemIds.length) {
      await supabase
        .from('syllabus_items')
        .update({ deleted_at: null, superseded_by_upload_id: null })
        .in('id', tracker.softDeletedItemIds);
    }
    if (tracker.insertedComponentIds.length) {
      await supabase.from('grading_components').delete().in('id', tracker.insertedComponentIds);
    }
    if (tracker.uploadId) {
      await supabase.from('syllabus_uploads').delete().eq('id', tracker.uploadId);
    }
  } catch (rollbackErr) {
    console.error('[syllabus] rollback itself failed — manual cleanup may be required:', rollbackErr);
  }
}

// POST /api/courses/:id/syllabus/upload-url — mints a short-lived Supabase
// Storage signed upload URL for the browser to PUT the raw file directly to
// (bypassing this API's own request body entirely for the binary transfer —
// see shared/contract.js's "Direct-to-storage signed upload" section).
// Validates mimetype/size server-side against the exact same rules
// `docPrep.js` has always enforced, since a client's declared Content-Type
// is not a trustworthy boundary on its own — this is what actually gates
// whether a signed URL gets minted at all.
router.post('/courses/:id/syllabus/upload-url', async (req, res, next) => {
  const parsed = UploadUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  const { mimetype, size_bytes: sizeBytes } = parsed.data;

  if (!SUPPORTED_MIMETYPES.has(mimetype)) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: `Unsupported mimetype: ${mimetype}` }));
  }

  if (sizeBytes > MAX_PDF_BYTES) {
    return res
      .status(413)
      .json(
        ErrorResponseSchema.parse({ error: `File exceeds the ${MAX_PDF_BYTES / (1024 * 1024)}MB document limit` })
      );
  }

  try {
    const supabase = getSupabaseClient();
    const courseId = req.params.id;
    const relativePath = `${courseId}/${crypto.randomUUID()}.${SYLLABUS_MIME_EXTENSIONS[mimetype]}`;

    const { data, error } = await supabase.storage.from(SYLLABUS_BUCKET).createSignedUploadUrl(relativePath);
    if (error || !data) {
      return next(
        Object.assign(new Error(error ? error.message : 'Could not create a signed upload URL'), { status: 500 })
      );
    }

    res.status(200).json(
      UploadUrlResponseSchema.parse({
        storage_path: `${SYLLABUS_BUCKET}/${relativePath}`,
        upload_url: data.signedUrl,
        token: data.token,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/courses/:id/syllabus', async (req, res) => {
  const courseId = req.params.id;
  const supabase = getSupabaseClient();
  let checksum = null;

  const parsedBody = SyllabusProcessRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  const { storage_path: storagePath, original_filename: originalFilename, mimetype } = parsedBody.data;

  try {
    // Server-to-server fetch of the bytes the browser already PUT directly
    // to Supabase Storage via the signed URL from the /upload-url step above
    // — not subject to this API's own client-facing request body limit.
    const { data: downloaded, error: downloadErr } = await supabase.storage
      .from(SYLLABUS_BUCKET)
      .download(bucketRelativePath(storagePath));
    if (downloadErr || !downloaded) {
      throw new Error(
        `could not download syllabus file at ${storagePath}: ${downloadErr ? downloadErr.message : 'not found'}`
      );
    }
    const buffer = Buffer.from(await downloaded.arrayBuffer());

    // `docPrep.js`'s own PDF path already enforces this same cap internally;
    // this closes the same gap for DOCX (previously enforced only by
    // multer's request-body-level limit, now gone) so both mimetypes are
    // capped uniformly, exactly as before.
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(`Downloaded file exceeds the ${MAX_PDF_BYTES / (1024 * 1024)}MB document limit`);
    }

    checksum = sha256Hex(buffer);

    const { data: course, error: courseErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .is('deleted_at', null)
      .single();
    if (courseErr || !course) throw new Error(`course ${courseId} not found`);

    const { data: term, error: termErr } = await supabase
      .from('terms')
      .select('*')
      .eq('id', course.term_id)
      .single();
    if (termErr || !term) throw new Error(`term ${course.term_id} not found`);

    // Byte-identical re-upload is an app-layer no-op (see
    // supabase/README.md §10) — return the course's current state rather
    // than re-running extraction or writing a duplicate upload row.
    const { data: existingUpload } = await supabase
      .from('syllabus_uploads')
      .select('*')
      .eq('course_id', courseId)
      .eq('checksum', checksum)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingUpload) {
      const { data: currentItems } = await supabase
        .from('syllabus_items')
        .select('*')
        .eq('course_id', courseId)
        .is('deleted_at', null);
      const { data: currentComponents } = await supabase
        .from('grading_components')
        .select('*')
        .eq('course_id', courseId);

      return res.status(200).json(
        SyllabusUploadResponseSchema.parse({
          upload: existingUpload,
          items: currentItems || [],
          gradingComponents: currentComponents || [],
          termMismatch: existingUpload.term_mismatch,
        })
      );
    }

    const prepared = await prepareDocument(buffer, mimetype);

    const extraction = await extractSyllabus({
      prepared,
      termLabel: term.name,
      termStart: term.term_start,
      termEnd: term.term_end,
      client: getAnthropicClient(),
      model: HAIKU_MODEL,
    });

    const uploadId = crypto.randomUUID();

    // Reconcile grading components against the course's existing ones —
    // updated in place by title match, never deleted-and-recreated, since
    // `syllabus_items.grading_component_id` is a hard FK with no cascade
    // (see supabase/README.md §9) and existing items may still reference
    // them.
    const { data: existingComponents } = await supabase
      .from('grading_components')
      .select('*')
      .eq('course_id', courseId);

    const { components: remappedComponents, idMap: componentIdMap } = remapGradingComponentIds(
      extraction.gradingComponents,
      existingComponents || []
    );

    const newItemRows = extraction.items.map((item) => {
      const grading_component_id = item.grading_component_id
        ? componentIdMap.get(item.grading_component_id) || null
        : null;
      return {
        ...item,
        id: crypto.randomUUID(),
        course_id: courseId,
        upload_id: uploadId,
        grading_component_id,
        content_hash: computeContentHash({
          courseId,
          title: item.title,
          sourceSection: item.source_section,
        }),
      };
    });

    const { data: existingItems } = await supabase
      .from('syllabus_items')
      .select('*')
      .eq('course_id', courseId)
      .is('deleted_at', null);

    const { toInsert, toSoftDelete } = reconcileItems({
      existingItems: existingItems || [],
      newItemRows,
      newUploadId: uploadId,
    });

    const tracker = {
      uploadId: null,
      insertedComponentIds: [],
      insertedItemIds: [],
      softDeletedItemIds: [],
    };

    try {
      const { error: uploadErr } = await supabase.from('syllabus_uploads').insert({
        id: uploadId,
        course_id: courseId,
        // The real object key the browser already PUT the bytes to directly
        // (see the /upload-url step above) — no separate archive upload is
        // needed here anymore, unlike the old multipart flow, since the
        // bytes are already durably in the private bucket by the time this
        // handler runs.
        storage_path: storagePath,
        checksum,
        term_detected: extraction.termDetected,
        term_mismatch: extraction.termMismatch,
        status: extraction.termMismatch ? 'quarantined' : 'parsed',
      });
      if (uploadErr) throw uploadErr;
      tracker.uploadId = uploadId;

      for (const component of remappedComponents) {
        if (component._isNew) {
          const { error } = await supabase.from('grading_components').insert({
            id: component.id,
            course_id: courseId,
            parent_id: component.parent_id,
            title: component.title,
            weight_percent: component.weight_percent,
            points_possible: component.points_possible,
            expected_count: component.expected_count,
            count_best_n: component.count_best_n,
            drop_lowest_n: component.drop_lowest_n,
          });
          if (error) throw error;
          tracker.insertedComponentIds.push(component.id);
        } else {
          const { error } = await supabase
            .from('grading_components')
            .update({
              parent_id: component.parent_id,
              weight_percent: component.weight_percent,
              points_possible: component.points_possible,
              expected_count: component.expected_count,
              count_best_n: component.count_best_n,
              drop_lowest_n: component.drop_lowest_n,
            })
            .eq('id', component.id);
          if (error) throw error;
        }
      }

      if (toSoftDelete.length) {
        const { error } = await supabase
          .from('syllabus_items')
          .update({ deleted_at: new Date().toISOString(), superseded_by_upload_id: uploadId })
          .in('id', toSoftDelete);
        if (error) throw error;
        tracker.softDeletedItemIds = toSoftDelete;
      }

      if (toInsert.length) {
        const { error } = await supabase.from('syllabus_items').insert(toInsert);
        if (error) throw error;
        tracker.insertedItemIds = toInsert.map((row) => row.id);
      }

      if (extraction.termMismatch) {
        const { error } = await supabase
          .from('courses')
          .update({ needs_review: true, review_reason: 'term_mismatch' })
          .eq('id', courseId);
        if (error) throw error;
      }
    } catch (persistErr) {
      await rollback(supabase, tracker);
      throw persistErr;
    }

    const { data: finalUpload } = await supabase
      .from('syllabus_uploads')
      .select('*')
      .eq('id', uploadId)
      .single();
    const { data: finalItems } = await supabase
      .from('syllabus_items')
      .select('*')
      .eq('course_id', courseId)
      .is('deleted_at', null);
    const { data: finalComponents } = await supabase
      .from('grading_components')
      .select('*')
      .eq('course_id', courseId);

    return res.status(200).json(
      SyllabusUploadResponseSchema.parse({
        upload: finalUpload,
        items: finalItems || [],
        gradingComponents: finalComponents || [],
        termMismatch: extraction.termMismatch,
      })
    );
  } catch (err) {
    // Per task instruction: a Claude response that still fails schema
    // validation after the bounded retry must have its raw output persisted
    // for debugging, not silently discarded. There is no dedicated raw-log
    // table in the schema for this (out of scope to add one here), so the
    // full raw tool-call responses are logged server-side in structured
    // form — the closest available durable trace without a migration
    // change.
    if (err instanceof ExtractionValidationError) {
      console.error(
        `[syllabus] Pass ${err.pass} raw Claude responses for course ${courseId} (debug):`,
        JSON.stringify(err.rawResponses, null, 2)
      );
    }

    const body = await buildFallbackResponse({
      supabase,
      courseId,
      reason: err && err.message ? err.message : String(err),
      checksum,
      storagePath,
      originalFilename,
    });
    return res.status(200).json(body);
  }
});

router.get('/courses/:id/syllabus-items', async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('syllabus_items')
      .select('*')
      .eq('course_id', req.params.id)
      .is('deleted_at', null);

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    res.status(200).json((data || []).map((item) => SyllabusItemSchema.parse(item)));
  } catch (err) {
    next(err);
  }
});

router.patch('/items/:id', async (req, res, next) => {
  const parsed = SyllabusItemPatchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(ErrorResponseSchema.parse({ error: 'Invalid request body' }));
  }

  try {
    const supabase = getSupabaseClient();
    // Any manual edit through this route means Kevin has taken ownership of
    // this row's content — is_user_edited flips permanently so a future
    // re-upload's reconciliation leaves it untouched (see extract.js's
    // `reconcileItems`).
    const { data, error } = await supabase
      .from('syllabus_items')
      .update({ ...parsed.data, is_user_edited: true })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json(ErrorResponseSchema.parse({ error: 'Item not found' }));
    }

    res.status(200).json(SyllabusItemSchema.parse(data));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
