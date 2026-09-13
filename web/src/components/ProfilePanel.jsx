import { renderMarkdown } from '../lib/markdown.js'

const UPDATED_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function formatUpdatedAt(isoString) {
  if (!isoString) return null
  return `${UPDATED_FORMATTER.format(new Date(isoString))} (NY time)`
}

// `profileState` is a small discriminated union built by Course.jsx from
// the frozen `CourseProfileOrNotEnoughSchema` response, plus the loading /
// transport-error states that response shape has no branch for:
//   { status: 'loading' }
//   { status: 'error', message }
//   { status: 'not_enough_notes' }
//   { status: 'ready', profile }
export default function ProfilePanel({ profileState, onRegenerate, regenerating, regenerateError, pendingUpdate, onRetryLoad }) {
  return (
    <section className="crs-panel crs-profile" aria-labelledby="crs-profile-h">
      <div className="crs-panel-head">
        <h2 id="crs-profile-h">Running summary</h2>
        {profileState.status === 'ready' && (
          <button
            type="button"
            className="crs-btn crs-btn-ghost"
            onClick={onRegenerate}
            disabled={regenerating}
          >
            {regenerating ? 'Regenerating...' : 'Regenerate'}
          </button>
        )}
      </div>

      {pendingUpdate && profileState.status !== 'loading' && (
        <p className="crs-pending-note" role="status">
          New note saved. This summary will pick it up on the next regeneration.
        </p>
      )}

      {regenerateError && (
        <p className="crs-composer-error" role="alert">
          Could not regenerate right now. {regenerateError}
        </p>
      )}

      {profileState.status === 'loading' && <ProfileSkeleton />}

      {profileState.status === 'error' && (
        <div className="crs-panel-error" role="alert">
          <p>Could not load the running summary. {profileState.message}</p>
          <button type="button" className="crs-btn" onClick={onRetryLoad}>
            Retry
          </button>
        </div>
      )}

      {profileState.status === 'not_enough_notes' && (
        <div className="crs-encourage">
          <p>Add a couple more notes and I'll start building a picture of this course.</p>
          <p className="crs-encourage-sub">
            The running summary and exam-topic predictions need at least two notes to reason from.
          </p>
        </div>
      )}

      {profileState.status === 'ready' && (
        <>
          <div className="crs-profile-meta">
            <span className="crs-profile-version">Version {profileState.profile.version}</span>
            <span className="crs-profile-updated">
              Last updated {formatUpdatedAt(profileState.profile.notes_through_at)}
            </span>
          </div>
          <div className="crs-markdown">{renderMarkdown(profileState.profile.summary_md)}</div>
        </>
      )}

      {regenerating && profileState.status !== 'loading' && (
        <div className="crs-regen-progress" role="status" aria-live="polite">
          <span className="crs-regen-dot" />
          <span className="crs-regen-dot" />
          <span className="crs-regen-dot" />
          <span>Reasoning across your notes and the syllabus. This can take a little while.</span>
        </div>
      )}
    </section>
  )
}

function ProfileSkeleton() {
  return (
    <div className="crs-skeleton" aria-busy="true" aria-label="Loading the running summary">
      <div className="crs-skeleton-line" style={{ width: '40%' }} />
      <div className="crs-skeleton-line" />
      <div className="crs-skeleton-line" />
      <div className="crs-skeleton-line" style={{ width: '70%' }} />
    </div>
  )
}
