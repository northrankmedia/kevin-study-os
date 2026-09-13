import { useEffect, useState } from 'react'

// Frontend session helpers, built against the auth contract in
// shared/contract.js. Never imports or references anything Supabase —
// the browser only ever talks to the Express API.

// Calls GET /api/me. Returns the { id, email } user on success, or null
// if there is no valid session.
export async function getSession() {
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  if (res.status !== 200) return null
  const data = await res.json()
  return data.user
}

// Hook for pages to guard themselves: on mount, checks the session and,
// if it's missing/expired, redirects the browser to /login. Returns
// { user, loading } — `user` is null while loading or after a redirect
// has been triggered.
export function useSession() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    getSession().then((sessionUser) => {
      if (cancelled) return

      if (!sessionUser) {
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
        setLoading(false)
        return
      }

      setUser(sessionUser)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return { user, loading }
}

// Clears the session server-side and sends the browser back to /login.
export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  window.location.href = '/login'
}
