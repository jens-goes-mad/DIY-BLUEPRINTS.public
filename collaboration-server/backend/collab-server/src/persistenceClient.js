const PERSISTENCE_URL = process.env.PERSISTENCE_URL || 'http://persistence-service:8080'

// Every call here is scoped to (customerId, docId, versionName, language) --
// the single-tenant docId@branch path this used to sit alongside (and the
// "Tenant"-suffixed names this had while both existed) was retired
// 2026-09-24 once DocumentController became customerId-aware for real: in
// production, JWT/Keycloak resolves customerId and the client's own
// session already knows document/version/language, so there's no more
// "default" case to fall back to -- every caller supplies real values.

function contentUrl(customerId, docId, versionName, language) {
  return (
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages/` +
    `${encodeURIComponent(language)}/content`
  )
}

export async function loadSnapshot(customerId, docId, versionName, language) {
  const res = await fetch(contentUrl(customerId, docId, versionName, language))
  if (!res.ok) throw new Error(`persistence-service load failed: ${res.status}`)
  const body = await res.json()
  if (!body.ydoc) return null
  return Buffer.from(body.ydoc, 'base64')
}

export async function saveSnapshot(customerId, docId, versionName, language, ydocBytes, markdown, changelog, author) {
  const res = await fetch(contentUrl(customerId, docId, versionName, language), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      changelog,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service save failed: ${res.status}`)
}

// false ONLY on a definitive "no such customer" (404). If persistence-service
// can't be reached or errors, answer true (fail open): the fast tier already
// protects edits while it's down, and locking every editor out because a
// dependency restarted would be worse than the case this guards against --
// a room whose customer doesn't exist, whose edits could never be saved.
export async function customerExists(customerId) {
  let res
  try {
    res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}`)
  } catch {
    return true
  }
  return res.status !== 404
}

// Both fields come from ONE persistence-service call, resolved off the same
// tip commit server-side -- deliberately not two separate GETs. An earlier
// version of this split them (a previous-content call plus a changelog
// call); a checkpoint landing on the ref between the two round trips
// silently mixed states from two different commits (found by testing --
// see DocumentStorageService.loadRecentChanges's own javadoc).
export async function loadRecentChanges(customerId, docId, versionName, language) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages/` +
    `${encodeURIComponent(language)}/recent-changes`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`persistence-service recent-changes load failed: ${res.status}`)
  const body = await res.json()
  return {
    previousBytes: body.previousYdoc ? Buffer.from(body.previousYdoc, 'base64') : null,
    changelog: body.changelog ?? '',
  }
}

// The ranged version: every checkpoint strictly after `from` up to and
// including `to` (defaults to this version's current tip on the server side
// when omitted), oldest first. Each entry has the same two fields
// loadRecentChanges returns, plus which checkpoint it came from.
export async function loadChangesBetween(customerId, docId, versionName, language, from, to) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages/` +
    `${encodeURIComponent(language)}/changes-between?from=${encodeURIComponent(from)}` +
    (to ? `&to=${encodeURIComponent(to)}` : '')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`persistence-service changes-between load failed: ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return body.map((c) => ({
    commitId: c.commitId,
    previousBytes: c.previousYdoc ? Buffer.from(c.previousYdoc, 'base64') : null,
    changelog: c.changelog ?? '',
  }))
}

export async function findMergeBase(customerId, docId, versionA, versionB) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/merge-base?a=${encodeURIComponent(versionA)}&b=${encodeURIComponent(versionB)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`persistence-service merge-base lookup failed: ${res.status}`)
  const body = await res.json()
  return body.commitId
}

export async function commitMerge(customerId, docId, sourceVersionName, targetVersionName, language, ydocBytes, markdown, author) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(targetVersionName)}/merge`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceVersionName,
      language,
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service merge commit failed: ${res.status}`)
  return res.json()
}
