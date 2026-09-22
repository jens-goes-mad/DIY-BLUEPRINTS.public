const PERSISTENCE_URL = 'http://localhost:8081'

let currentCustomerId = null
let currentDocument = null // { docId, language }

function fillSelect(select, items, selected) {
  select.innerHTML = ''
  for (const item of items) {
    const opt = document.createElement('option')
    opt.value = item
    opt.textContent = item
    if (item === selected) opt.selected = true
    select.appendChild(opt)
  }
}

function documentKey(doc) {
  return `${doc.docId} / ${doc.language}`
}

async function loadCustomers() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`)
  return (await res.json()).sort()
}

async function loadDocuments(customerId) {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents`)
  return res.ok ? await res.json() : []
}

async function loadVersions(customerId, doc) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
      `${encodeURIComponent(doc.docId)}/${encodeURIComponent(doc.language)}/versions`,
  )
  return res.ok ? await res.json() : []
}

async function refreshVersions() {
  const list = document.getElementById('version-list')
  const fromSelect = document.getElementById('from-version-select')
  const deleteSelect = document.getElementById('delete-version-select')

  if (!currentCustomerId || !currentDocument) {
    list.innerHTML = '<li>pick a customer and document</li>'
    fillSelect(fromSelect, [])
    fillSelect(deleteSelect, [])
    return
  }

  const versions = await loadVersions(currentCustomerId, currentDocument)
  list.innerHTML = ''
  for (const v of versions) {
    const li = document.createElement('li')
    li.textContent = v
    list.appendChild(li)
  }
  if (versions.length === 0) list.innerHTML = '<li>(none yet)</li>'

  fillSelect(fromSelect, versions, 'master')
  // master is never deletable (see GitDocumentStorageService.deleteVersion)
  // -- left out of this select entirely, same reasoning as admin.js's
  // delete-branch-select.
  fillSelect(deleteSelect, versions.filter((v) => v !== 'master'))
}

async function refreshDocuments() {
  const select = document.getElementById('document-select')
  if (!currentCustomerId) {
    select.innerHTML = ''
    currentDocument = null
    await refreshVersions()
    return
  }

  const documents = await loadDocuments(currentCustomerId)
  select.innerHTML = ''
  for (const doc of documents) {
    const opt = document.createElement('option')
    opt.value = documentKey(doc)
    opt.textContent = documentKey(doc)
    select.appendChild(opt)
  }
  if (documents.length === 0) {
    currentDocument = null
  } else if (!currentDocument || !documents.some((d) => documentKey(d) === documentKey(currentDocument))) {
    currentDocument = documents[0]
  }
  if (currentDocument) select.value = documentKey(currentDocument)
  await refreshVersions()
}

async function refreshCustomers() {
  const customers = await loadCustomers()
  fillSelect(document.getElementById('customer-select'), customers, currentCustomerId)
  if (!currentCustomerId && customers.length > 0) {
    currentCustomerId = customers[0]
    document.getElementById('customer-select').value = currentCustomerId
  }
  await refreshDocuments()
}

document.getElementById('customer-select').addEventListener('change', async (e) => {
  currentCustomerId = e.target.value
  currentDocument = null
  await refreshDocuments()
})

document.getElementById('document-select').addEventListener('change', async (e) => {
  const [docId, language] = e.target.value.split(' / ')
  currentDocument = { docId, language }
  await refreshVersions()
})

document.getElementById('create-customer-btn').addEventListener('click', async () => {
  const slug = document.getElementById('new-customer-slug').value.trim()
  const displayName = document.getElementById('new-customer-name').value.trim()
  const resultEl = document.getElementById('customer-result')

  if (!slug || !displayName) {
    resultEl.textContent = 'Enter a slug and display name.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, displayName }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const body = await res.json()
    resultEl.textContent = `Created customer ${body.customerId}.`
    resultEl.className = 'ok'
    document.getElementById('new-customer-slug').value = ''
    document.getElementById('new-customer-name').value = ''
    currentCustomerId = body.customerId
    await refreshCustomers()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('create-document-btn').addEventListener('click', async () => {
  const docId = document.getElementById('new-doc-id').value.trim()
  const language = document.getElementById('new-doc-language').value.trim()
  const title = document.getElementById('new-doc-title').value.trim()
  const resultEl = document.getElementById('document-result')

  if (!currentCustomerId) {
    resultEl.textContent = 'Pick or create a customer first.'
    resultEl.className = 'err'
    return
  }
  if (!docId || !language) {
    resultEl.textContent = 'Enter a docId and language.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(currentCustomerId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, language, title }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Created document ${docId} / ${language}.`
    resultEl.className = 'ok'
    document.getElementById('new-doc-id').value = ''
    document.getElementById('new-doc-language').value = ''
    document.getElementById('new-doc-title').value = ''
    currentDocument = { docId, language }
    await refreshDocuments()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('create-version-btn').addEventListener('click', async () => {
  const versionName = document.getElementById('new-version-name').value.trim()
  const fromVersionName = document.getElementById('from-version-select').value
  const resultEl = document.getElementById('create-version-result')

  if (!currentCustomerId || !currentDocument) {
    resultEl.textContent = 'Pick a customer and document first.'
    resultEl.className = 'err'
    return
  }
  if (!versionName) {
    resultEl.textContent = 'Enter a version name.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(
      `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(currentCustomerId)}/documents/` +
        `${encodeURIComponent(currentDocument.docId)}/${encodeURIComponent(currentDocument.language)}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionName, fromVersionName }),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Created "${versionName}" from "${fromVersionName}".`
    resultEl.className = 'ok'
    document.getElementById('new-version-name').value = ''
    await refreshVersions()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('delete-version-btn').addEventListener('click', async () => {
  const versionName = document.getElementById('delete-version-select').value
  const resultEl = document.getElementById('delete-version-result')

  if (!currentCustomerId || !currentDocument) {
    resultEl.textContent = 'Pick a customer and document first.'
    resultEl.className = 'err'
    return
  }
  if (!versionName) {
    resultEl.textContent = 'Pick a version to delete.'
    resultEl.className = 'err'
    return
  }
  if (!confirm(`Delete version "${versionName}"? This cannot be undone from this page.`)) return

  resultEl.textContent = 'Deleting...'
  resultEl.className = ''
  try {
    const res = await fetch(
      `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(currentCustomerId)}/documents/` +
        `${encodeURIComponent(currentDocument.docId)}/${encodeURIComponent(currentDocument.language)}/versions/` +
        `${encodeURIComponent(versionName)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Deleted "${versionName}".`
    resultEl.className = 'ok'
    await refreshVersions()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

refreshCustomers()
