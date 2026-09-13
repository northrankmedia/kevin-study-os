-- Adds voice-memo support to `notes`: a source tag (text vs voice) and a
-- private storage path to the original audio recording. Additive only —
-- every existing row backfills to source='text', audio_storage_path=null,
-- which is exactly correct (every note before this migration was typed).
--
-- Safe to re-run: `if not exists` guards throughout, same convention as
-- 0001_init.sql.
--
-- See ../README.md and shared/contract.js's NOTE_SOURCE_VALUES /
-- VOICE_NOTE_ACCEPTED_MIMETYPES / VOICE_NOTE_MAX_BYTES for the reasoning
-- this migration mirrors on the application side.

-- ============================================================================
-- NOTES: source + audio_storage_path
-- ============================================================================

alter table notes
  add column if not exists source text not null default 'text',
  add column if not exists audio_storage_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notes_source_check'
  ) then
    alter table notes
      add constraint notes_source_check check (source in ('text', 'voice'));
  end if;
end $$;

-- A voice note must actually have an audio file to point to; a text note
-- must not (there's nothing to sign a URL for). This is the same kind of
-- "fail loud at INSERT, not silently render wrong" guard 0001_init.sql
-- already uses for syllabus_items' date_precision — a malformed insert from
-- application code should error immediately, not produce a note that claims
-- to be a voice memo with no audio behind it (or vice versa).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notes_source_audio_check'
  ) then
    alter table notes
      add constraint notes_source_audio_check check (
        (source = 'voice' and audio_storage_path is not null) or
        (source = 'text' and audio_storage_path is null)
      );
  end if;
end $$;

-- ============================================================================
-- STORAGE: private "voice-memos" bucket
-- ============================================================================
-- Private for the same reason `syllabi` is: this is Kevin's own voice audio
-- of his private class notes. Express must issue signed URLs; never expose
-- a public bucket URL. See README.

insert into storage.buckets (id, name, public)
values ('voice-memos', 'voice-memos', false)
on conflict (id) do nothing;
