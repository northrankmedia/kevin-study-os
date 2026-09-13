import { useState } from 'react'

// Single-user login page. Kevin is the only account this app will ever
// have (see task boundaries) — no signup, no password reset, no OAuth.
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      })

      if (res.status === 200) {
        window.location.href = '/'
        return
      }

      if (res.status === 429) {
        setError('Too many attempts. Wait a few minutes and try again.')
      } else {
        setError('Invalid email or password.')
      }
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: '360px', margin: '0 auto' }}>
      <h1>Kevin Study OS</h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="username"
            style={{ display: 'block', width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
            style={{ display: 'block', width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>
        {error && <p style={{ color: '#b00020' }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: '0.5rem' }}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
