const AK_URL = process.env.ARTIFACT_KEEPER_URL || 'http://artifact-keeper:8080'
const AK_USERNAME = process.env.ARTIFACT_KEEPER_USERNAME || 'admin'
const AK_PASSWORD = process.env.ARTIFACT_KEEPER_PASSWORD
const AK_REPO = process.env.ARTIFACT_KEEPER_REPO || 'editor-assets'
// The URL the BROWSER can reach -- different from AK_URL, which is the
// internal docker-network address collab-server uses to talk to Artifact
// Keeper server-to-server. This one has to be the published host port.
const AK_PUBLIC_URL = process.env.ARTIFACT_KEEPER_PUBLIC_URL || 'http://localhost:8082'

// A fresh login per upload was the original design ("uploads aren't a hot
// path, avoid token-refresh complexity") -- proven wrong in practice, not
// just in theory: Artifact Keeper rate-limits its login endpoint (sensible
// anti-brute-force default), and it took only a handful of test uploads in
// one session to hit 429. A real user dragging a few images in would hit
// the same wall. Caching the access token (it carries its own expires_in)
// and only re-logging in when it's actually gone or near expiry fixes this
// properly, not just for testing.
let cachedToken = null
let cachedTokenExpiresAt = 0

// Restarting the artifact-keeper container flips its admin account back to
// must_change_password=true (verified directly: login still succeeds with
// the already-set password, but every other endpoint -- including public,
// anonymous-access downloads -- then 403s with SETUP_REQUIRED until the
// password-change endpoint is called again, even re-submitting the SAME
// password). Confirmed via real API calls, not documented anywhere.
// Self-healing here means a restart never leaves uploads permanently
// broken without a manual curl dance.
async function unlockIfNeeded(token) {
  const res = await fetch(`${AK_URL}/api/v1/users/me/password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: AK_PASSWORD, new_password: AK_PASSWORD }),
  })
  if (!res.ok) throw new Error(`artifact-keeper unlock (password re-confirm) failed: ${res.status}`)
}

async function login() {
  const res = await fetch(`${AK_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AK_USERNAME, password: AK_PASSWORD }),
  })
  if (!res.ok) throw new Error(`artifact-keeper login failed: ${res.status}`)
  const body = await res.json()
  if (body.must_change_password) await unlockIfNeeded(body.access_token)
  cachedToken = body.access_token
  // Refresh a bit early (60s safety margin) rather than cutting it exactly
  // at the token's real expiry.
  cachedTokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000
  return cachedToken
}

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken
  return login()
}

function sanitizeFilename(name) {
  return (name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function putArtifact(path, bytes, contentType, token) {
  return fetch(`${AK_URL}/api/v1/repositories/${AK_REPO}/artifacts/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: bytes,
  })
}

/**
 * Uploads bytes to the "editor-assets" generic repository (created public,
 * anonymous-downloadable -- see STATE.md) and returns a URL the browser can
 * use directly as an <img src>, with no auth required to fetch it.
 */
export async function uploadAsset(filename, bytes, contentType) {
  const path = `images/${Date.now()}-${sanitizeFilename(filename)}`

  let res = await putArtifact(path, bytes, contentType, await getToken())
  if (res.status === 401 || res.status === 403) {
    // 401: cached token turned out to be stale despite our expiry tracking
    // (e.g. the backend restarted and invalidated sessions). 403: the
    // must_change_password gate re-armed itself (see unlockIfNeeded above)
    // after our token was cached, so the cached token is otherwise valid
    // but every endpoint is gated -- a fresh login re-runs the unlock check.
    // Either way, one retry with a forced fresh login before giving up.
    res = await putArtifact(path, bytes, contentType, await login())
  }
  if (!res.ok) throw new Error(`artifact-keeper upload failed: ${res.status}`)

  return `${AK_PUBLIC_URL}/api/v1/repositories/${AK_REPO}/download/${path}`
}
