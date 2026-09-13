'use strict';

const express = require('express');
const {
  CourseProfileOrNotEnoughSchema,
  ProfileRegenerateResponseSchema,
} = require('../../../shared/contract.js');
const { getSupabaseClient } = require('../lib/supabaseClient');
const { generateProfile, MIN_NOTES_REQUIRED } = require('../lib/profile');

const router = express.Router();

const NOT_ENOUGH_NOTES = { status: 'not_enough_notes' };

router.get('/courses/:id/profile', async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    const courseId = req.params.id;

    const { data: notes, error: notesErr } = await supabase
      .from('notes')
      .select('id')
      .eq('course_id', courseId)
      .is('deleted_at', null);
    if (notesErr) {
      return next(Object.assign(new Error(notesErr.message), { status: 500 }));
    }

    if (!notes || notes.length < MIN_NOTES_REQUIRED) {
      return res.status(200).json(CourseProfileOrNotEnoughSchema.parse(NOT_ENOUGH_NOTES));
    }

    const { data: current, error: profileErr } = await supabase
      .from('course_profiles')
      .select('*')
      .eq('course_id', courseId)
      .eq('is_current', true)
      .maybeSingle();
    if (profileErr) {
      return next(Object.assign(new Error(profileErr.message), { status: 500 }));
    }

    if (!current) {
      // Enough notes exist, but no regeneration has completed yet (the
      // regeneration triggered by the note write is still running in the
      // background, or the most recent attempt failed Claude-output
      // validation and wrote nothing — see profile.js's ProfileValidationError
      // handling). The frozen response union has only two branches (a full
      // profile or not_enough_notes); this is the closest honest fit — there
      // is no profile to show yet.
      return res.status(200).json(CourseProfileOrNotEnoughSchema.parse(NOT_ENOUGH_NOTES));
    }

    // version count: the current row's own `version` field already IS the
    // total count of versions written so far (versions are always
    // sequential, starting at 1, one per regeneration — see profile.js's
    // nextVersion computation) — no separate field is added here, since the
    // frozen CourseProfileSchema has none and this repo's contract is not to
    // be reshaped without explicitly flagging it (see contract.js's own
    // header comment).
    res.status(200).json(CourseProfileOrNotEnoughSchema.parse(current));
  } catch (err) {
    next(err);
  }
});

router.post('/courses/:id/profile/regenerate', async (req, res, next) => {
  try {
    const result = await generateProfile(req.params.id);

    // `ProfileRegenerateResponseSchema` only has two branches: `{status:
    // 'queued'}` or a full profile. Neither "not enough notes yet" nor
    // "another regeneration is already in flight" nor "Claude's output never
    // validated" has a dedicated branch in the frozen contract — `queued` is
    // the closest honest fit for all three: nothing new to show right now,
    // and (for the lock-skip case) a regeneration genuinely is already
    // in-flight for this course.
    if (!result || result.status === 'not_enough_notes' || result.status === 'skipped') {
      return res.status(200).json(ProfileRegenerateResponseSchema.parse({ status: 'queued' }));
    }

    res.status(200).json(ProfileRegenerateResponseSchema.parse(result));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
