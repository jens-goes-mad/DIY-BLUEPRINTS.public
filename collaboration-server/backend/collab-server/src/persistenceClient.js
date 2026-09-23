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
