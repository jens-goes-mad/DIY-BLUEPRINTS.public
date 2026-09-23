const PERSISTENCE_URL = 'http://localhost:8081'

let currentCustomerId = null
let currentDocId = null

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

function fillList(list, items, emptyText) {
  list.innerHTML = ''
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item
    list.appendChild(li)
  }
  if (items.length === 0) list.innerHTML = `<li>${emptyText}</li>`
}

async function loadCustomers() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`)
  const customers = await res.json()
  return customers.sort((a, b) => a.customerId.localeCompare(b.customerId))
}

async function loadDocuments(customerId) {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents`)
  return res.ok ? await res.json() : []
}

async function loadVersions(customerId, docId) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/${encodeURIComponent(docId)}/versions`,
  )
  return res.ok ? await res.json() : []
}

async function loadLanguages(customerId, docId, versionName) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
      `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages`,
  )
  return res.ok ? await res.json() : []
}

async function refreshLanguages() {
  const select = document.getElementById('language-version-select')
  const list = document.getElementById('language-list')
  const versionName = select.value

  if (!currentCustomerId || !currentDocId || !versionName) {
    fillList(list, [], 'pick a version')
    return
  }
  const languages = await loadLanguages(currentCustomerId, currentDocId, versionName)
  fillList(list, languages, '(no languages in this version yet)')
}

async function refreshVersions() {
  const list = document.getElementById('version-list')
  const fromSelect = document.getElementById('from-version-select')
  const deleteSelect = document.getElementById('delete-version-select')
  const languageVersionSelect = document.getElementById('language-version-select')

  if (!currentCustomerId || !currentDocId) {
    fillList(list, [], 'pick a customer and document')
    fillSelect(fromSelect, [])
    fillSelect(deleteSelect, [])
    fillSelect(languageVersionSelect, [])
    await refreshLanguages()
    return
  }

  const versions = await loadVersions(currentCustomerId, currentDocId)
  fillList(list, versions, '(none yet)')

  fillSelect(fromSelect, versions, 'master')
  // master is never deletable (see GitDocumentStorageService.deleteVersion)
  // -- left out of this select entirely, same reasoning as admin.js's
  // delete-branch-select.
  fillSelect(deleteSelect, versions.filter((v) => v !== 'master'))
  fillSelect(languageVersionSelect, versions, 'master')
  await refreshLanguages()
}

async function refreshDocuments() {
  const select = document.getElementById('document-select')
  if (!currentCustomerId) {
    select.innerHTML = ''
    currentDocId = null
    await refreshVersions()
    return
  }

  const docIds = await loadDocuments(currentCustomerId)
  fillSelect(select, docIds, currentDocId)
  if (docIds.length === 0) {
    currentDocId = null
  } else if (!currentDocId || !docIds.includes(currentDocId)) {
    currentDocId = docIds[0]
    select.value = currentDocId
  }
  await refreshVersions()
}

async function refreshCustomers() {
  const customers = await loadCustomers()
  const select = document.getElementById('customer-select')
  select.innerHTML = ''
  for (const c of customers) {
    const opt = document.createElement('option')
    opt.value = c.customerId
    opt.textContent = `${c.displayName} (${c.customerId})`
    if (c.customerId === currentCustomerId) opt.selected = true
    select.appendChild(opt)
  }
  if (!currentCustomerId && customers.length > 0) {
    currentCustomerId = customers[0].customerId
    select.value = currentCustomerId
  }
  await refreshDocuments()
}

document.getElementById('customer-select').addEventListener('change', async (e) => {
  currentCustomerId = e.target.value
  currentDocId = null
  await refreshDocuments()
})

document.getElementById('document-select').addEventListener('change', async (e) => {
  currentDocId = e.target.value
  await refreshVersions()
})

document.getElementById('language-version-select').addEventListener('change', refreshLanguages)

document.getElementById('create-customer-btn').addEventListener('click', async () => {
  const customerId = document.getElementById('new-customer-id').value.trim()
  const displayName = document.getElementById('new-customer-name').value.trim()
  const resultEl = document.getElementById('customer-result')

  if (!customerId || !displayName) {
    resultEl.textContent = 'Enter a customer ID and display name.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId, displayName }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Created customer ${customerId}.`
    resultEl.className = 'ok'
    document.getElementById('new-customer-id').value = ''
    document.getElementById('new-customer-name').value = ''
    currentCustomerId = customerId
    await refreshCustomers()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('delete-customer-btn').addEventListener('click', async () => {
  const customerId = document.getElementById('customer-select').value
  const resultEl = document.getElementById('delete-customer-result')

  if (!customerId) {
    resultEl.textContent = 'Pick a customer to delete.'
    resultEl.className = 'err'
    return
  }
  // Bigger blast radius than deleting a version -- this wipes every
  // document, every version, every commit for this customer, not one
  // ref (see GitDocumentStorageService.deleteCustomer). Spelled out in
  // full here rather than reusing the shorter version-delete wording.
  if (
    !confirm(
      `Delete customer "${customerId}"? This permanently deletes ALL of its documents, ` +
        `versions, and history. This cannot be undone from this page.`,
    )
  ) {
    return
  }

  resultEl.textContent = 'Deleting...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Deleted customer ${customerId}.`
    resultEl.className = 'ok'
    if (currentCustomerId === customerId) {
      currentCustomerId = null
      currentDocId = null
    }
    await refreshCustomers()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('create-document-btn').addEventListener('click', async () => {
  const docId = document.getElementById('new-doc-id').value.trim()
  const title = document.getElementById('new-doc-title').value.trim()
  const resultEl = document.getElementById('document-result')

  if (!currentCustomerId) {
    resultEl.textContent = 'Pick or create a customer first.'
    resultEl.className = 'err'
    return
  }
  if (!docId) {
    resultEl.textContent = 'Enter a docId.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(currentCustomerId)}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, title }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Created document ${docId}.`
    resultEl.className = 'ok'
    document.getElementById('new-doc-id').value = ''
    document.getElementById('new-doc-title').value = ''
    currentDocId = docId
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

  if (!currentCustomerId || !currentDocId) {
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
        `${encodeURIComponent(currentDocId)}/versions`,
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

  if (!currentCustomerId || !currentDocId) {
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
        `${encodeURIComponent(currentDocId)}/versions/${encodeURIComponent(versionName)}`,
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
