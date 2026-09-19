const PERSISTENCE_URL = 'http://localhost:8081'
const COLLAB_URL = 'http://localhost:3000'
const DOC_ID = 'default'

async function loadBranches() {
  const res = await fetch(`${PERSISTENCE_URL}/api/branches`)
  const branches = await res.json()
  return branches.sort()
}

function fillSelect(select, branches, selected) {
  select.innerHTML = ''
  for (const b of branches) {
    const opt = document.createElement('option')
    opt.value = b
    opt.textContent = b
    if (b === selected) opt.selected = true
    select.appendChild(opt)
  }
}

async function refresh() {
  const branches = await loadBranches()

  const list = document.getElementById('branch-list')
  list.innerHTML = ''
  for (const b of branches) {
    const li = document.createElement('li')
    li.textContent = b
    list.appendChild(li)
  }
  if (branches.length === 0) list.innerHTML = '<li>(none yet)</li>'

  fillSelect(document.getElementById('from-branch'), branches, 'master')
  fillSelect(document.getElementById('source-branch'), branches)
  fillSelect(document.getElementById('target-branch'), branches, 'master')
}

function renderConflicts(conflicts) {
  const rows = conflicts
    .map((c) => {
      if (c.type === 'attribute') {
        return `<tr><td>attribute</td><td>${c.attribute}</td><td>base=${c.base}, sourceBranch=${c.valueB}, targetBranch=${c.valueA}</td></tr>`
      }
      if (c.type === 'delete-vs-edit') {
        return `<tr><td>delete-vs-edit</td><td>-</td><td>deleted by side ${c.deletedBySide}, touched by side ${c.editedBySide} (target ${c.targetId})</td></tr>`
      }
      return `<tr><td>${c.type}</td><td>-</td><td>${JSON.stringify(c)}</td></tr>`
    })
    .join('')
  return `<table class="conflicts"><thead><tr><th>Type</th><th>Attribute</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`
}

document.getElementById('create-branch-btn').addEventListener('click', async () => {
  const newBranch = document.getElementById('new-branch-name').value.trim()
  const fromBranch = document.getElementById('from-branch').value
  const resultEl = document.getElementById('create-result')

  if (!newBranch) {
    resultEl.textContent = 'Enter a branch name.'
    resultEl.className = 'err'
    return
  }

  resultEl.textContent = 'Creating...'
  resultEl.className = ''
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newBranch, fromBranch }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    resultEl.textContent = `Created "${newBranch}" from "${fromBranch}".`
    resultEl.className = 'ok'
    document.getElementById('new-branch-name').value = ''
    await refresh()
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

document.getElementById('merge-btn').addEventListener('click', async () => {
  const sourceBranch = document.getElementById('source-branch').value
  const targetBranch = document.getElementById('target-branch').value
  const author = document.getElementById('merge-author').value.trim() || 'admin-page'
  const resultEl = document.getElementById('merge-result')

  if (!sourceBranch || !targetBranch) {
    resultEl.textContent = 'Pick both a source and target branch.'
    resultEl.className = 'err'
    return
  }
  if (sourceBranch === targetBranch) {
    resultEl.textContent = 'Source and target must be different branches.'
    resultEl.className = 'err'
    return
  }

  resultEl.innerHTML = 'Merging...'
  resultEl.className = ''
  try {
    const res = await fetch(`${COLLAB_URL}/api/documents/${DOC_ID}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceBranch, targetBranch, author }),
    })
    const body = await res.json()
    if (!res.ok) {
      resultEl.textContent = 'Failed: ' + (body.error || res.status)
      resultEl.className = 'err'
      return
    }
    if (body.merged) {
      resultEl.innerHTML = `<span class="ok">Merged.</span> Commit ${body.commitId} (parents: ${body.parentCount}).`
    } else {
      resultEl.innerHTML =
        `<span class="err">Not merged -- ${body.conflicts.length} conflict(s) found:</span>` + renderConflicts(body.conflicts)
    }
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message
    resultEl.className = 'err'
  }
})

refresh()
