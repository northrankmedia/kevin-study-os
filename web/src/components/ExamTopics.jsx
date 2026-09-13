// Ranked exam-topic predictions, sourced from the same CourseProfile the
// running summary panel renders (`exam_topics`, already deterministically
// renumbered by api/src/lib/profile.js's `renumberRanks` before this ever
// reaches the client -- no client-side re-sorting needed).
//
// Regeneration decision: there is exactly one backend endpoint
// (`POST /api/courses/:id/profile/regenerate`) that produces both the
// summary and the exam topics in a single Claude call -- there is no
// separate "just re-rank topics" operation to have. This component
// therefore shares Course.jsx's one `onRegenerate`/`regenerating` state
// with ProfilePanel rather than inventing a second, redundant action; its
// own button is a second, contextual affordance for reaching the same
// call, not a second call.
export default function ExamTopics({ profileState, onRegenerate, regenerating }) {
  if (profileState.status === 'loading') {
    return (
      <section className="crs-panel crs-topics" aria-labelledby="crs-topics-h">
        <div className="crs-panel-head">
          <h2 id="crs-topics-h">Ranked exam topics</h2>
        </div>
        <div className="crs-skeleton" aria-busy="true" aria-label="Loading exam topics">
          <div className="crs-skeleton-line" style={{ width: '55%' }} />
          <div className="crs-skeleton-line" style={{ width: '85%' }} />
        </div>
      </section>
    )
  }

  // The "not enough notes yet" and transport-error states are already
  // communicated by ProfilePanel, which sits above this section on the
  // page -- repeating the same message here would just be noise.
  if (profileState.status === 'not_enough_notes' || profileState.status === 'error') {
    return null
  }

  const topics = profileState.profile.exam_topics || []

  return (
    <section className="crs-panel crs-topics" aria-labelledby="crs-topics-h">
      <div className="crs-panel-head">
        <h2 id="crs-topics-h">Ranked exam topics</h2>
        <button type="button" className="crs-btn crs-btn-ghost" onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? 'Regenerating...' : 'Regenerate'}
        </button>
      </div>

      {topics.length === 0 && (
        <p className="crs-topics-empty">No exam topics have been identified from your notes yet.</p>
      )}

      <ol className="crs-topics-list">
        {topics.map((topic) => (
          <li key={`${topic.rank}-${topic.topic}`} className="crs-topic">
            <div className="crs-topic-head">
              <span className="crs-topic-rank">#{topic.rank}</span>
              <span className="crs-topic-title">{topic.topic}</span>
              <span className="crs-topic-confidence" title="How confident this prediction is">
                {Math.round(topic.confidence * 100)}% confidence
              </span>
            </div>
            <p className="crs-topic-rationale">{topic.rationale}</p>
            {topic.evidence && topic.evidence.length > 0 && (
              <ul className="crs-topic-evidence">
                {topic.evidence.map((snippet, index) => (
                  <li key={index}>"{snippet}"</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
