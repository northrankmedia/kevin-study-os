import Login from './pages/Login.jsx'
import Board from './pages/Board.jsx'
import CourseSetup from './pages/CourseSetup.jsx'
import Course from './pages/Course.jsx'
import { useSession, logout } from './lib/session.js'

// Path-based routing, no router library — deliberately, since this is a
// personal single-user tool with three real pages. Each page owns its own
// session guard except CourseSetup (see Gated below), and navigation
// between pages is a plain full-page `window.location.href` change, the
// same pattern session.js already uses for /login and logout. If this app
// ever grows past a handful of pages, swap this for a real router; until
// then, one extra dependency isn't worth it.
export default function App() {
  const path = window.location.pathname

  if (path === '/login') {
    return <Login />
  }

  // CourseSetup handles both a specific course (`/courses/:courseId/setup`,
  // parsed internally via window.location.pathname) and the no-course
  // picker (`/courses/setup`) — see CourseSetup.jsx's own path parsing.
  if (path === '/courses/setup' || /^\/courses\/[^/]+\/setup\/?$/.test(path)) {
    return (
      <Gated>
        <CourseSetup onConfirmed={() => { window.location.href = '/' }} />
      </Gated>
    )
  }

  // Course detail (`/courses/:courseId`, a bare id -- NOT `/courses/setup`
  // or `/courses/:id/setup`, both already handled above). Checked after
  // those two so a literal `/courses/setup` never reaches here at all; the
  // `!== 'setup'` guard is a second, explicit line of defense in case that
  // ordering ever changes.
  const courseDetailMatch = path.match(/^\/courses\/([^/]+)\/?$/)
  if (courseDetailMatch && courseDetailMatch[1] !== 'setup') {
    return (
      <Gated>
        <Course courseId={courseDetailMatch[1]} />
      </Gated>
    )
  }

  // Board self-guards its own session (see Board.jsx) and is the default
  // landing page — everything else (`/`, `/board`, any unrecognized path)
  // falls through to it rather than a 404, since there's nowhere else to
  // send a signed-in Kevin in this app.
  return <Board />
}

// CourseSetup doesn't guard its own session (it's also usable embedded
// elsewhere), so App wraps it here the same way the pre-routing version of
// this file gated its single page.
function Gated({ children }) {
  const { user, loading } = useSession()

  if (loading) {
    return (
      <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
        <p>Loading...</p>
      </div>
    )
  }

  if (!user) {
    // useSession() has already redirected the browser to /login.
    return null
  }

  return children
}
