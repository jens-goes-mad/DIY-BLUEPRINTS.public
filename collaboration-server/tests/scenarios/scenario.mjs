import * as Y from 'yjs'
import { mergeDocs } from '../../backend/collab-server/src/mergeDocs.js'

// Scenario engine: plays a plain-text script of versions/edits/merges against
// real Y.Docs and produces a transcript. See README.md in this directory for
// the command reference. The merge itself is the SAME mergeDocs() the real
// pipeline (mergeBranches.js) calls -- this file only supplies what the real
// pipeline gets from git: a commit graph with a merge base.

const FIELD = 'default'
const SETUP_CLIENT_ID = 1

// ---- parsing ---------------------------------------------------------------

function tokenize(line) {
  const tokens = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) tokens.push({ quoted: true, value: m[1].replace(/\\(.)/g, '$1') })
    else tokens.push({ quoted: false, value: m[2] })
  }
  return tokens
}

function parseAttrValue(v) {
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
}

// Commands that own an indented block of paragraph lines beneath them.
function takesBlock(tokens) {
  const w = tokens.map((t) => t.value)
  return w[0] === 'doc' || (w[0] === 'expect' && w[1] === 'doc')
}

export function parseScenario(text) {
  const commands = []
  text.split('\n').forEach((raw, i) => {
    const lineNo = i + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return

    if (/^\s/.test(raw)) {
      const cur = commands[commands.length - 1]
      if (!cur || !cur.block) throw new Error(`line ${lineNo}: indented line without a doc/expect doc block above it`)
      cur.block.push(parseBlockLine(trimmed, lineNo))
      return
    }
    const tokens = tokenize(trimmed)
    commands.push({ lineNo, raw: trimmed, tokens, block: takesBlock(tokens) ? [] : null })
  })
  return commands
}

// "heading level=2 "text"" / "para "text"" -> { name, attrs, text }
function parseBlockLine(line, lineNo) {
  const tokens = tokenize(line)
  const kind = tokens[0]?.value
  if (kind !== 'para' && kind !== 'heading') throw new Error(`line ${lineNo}: block line must start with para or heading`)
  const last = tokens[tokens.length - 1]
  if (tokens.length < 2 || !last.quoted) throw new Error(`line ${lineNo}: block line must end with a quoted text`)
  const attrs = {}
  for (const t of tokens.slice(1, -1)) {
    const eq = t.value.indexOf('=')
    if (t.quoted || eq < 1) throw new Error(`line ${lineNo}: expected key=value, got ${t.value}`)
    attrs[t.value.slice(0, eq)] = parseAttrValue(t.value.slice(eq + 1))
  }
  return { name: kind === 'para' ? 'paragraph' : 'heading', attrs, text: last.value }
}

// ---- rendering -------------------------------------------------------------

function renderLine(name, attrs, text) {
  const short = name === 'paragraph' ? 'para' : name
  const attrStr = Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`).join(' ')
  return `[${short}${attrStr ? ' ' + attrStr : ''}] ${text}`
}

function textOf(el) {
  return el
    .toArray()
    .filter((c) => c instanceof Y.XmlText)
    .map((t) => t.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join(''))
    .join('')
}

function renderDoc(doc) {
  return doc.getXmlFragment(FIELD).toArray().map((el) =>
    el instanceof Y.XmlElement ? renderLine(el.nodeName, el.getAttributes(), textOf(el)) : '[?]',
  )
}

function blockToLines(block) {
  return block.map((b) => renderLine(b.name, b.attrs, b.text))
}

function buildElement(spec) {
  const el = new Y.XmlElement(spec.name)
  for (const [k, v] of Object.entries(spec.attrs)) el.setAttribute(k, v)
  const t = new Y.XmlText()
  t.insert(0, spec.text)
  el.insert(0, [t])
  return el
}

function docFromBytes(bytes) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return doc
}

// ---- engine ----------------------------------------------------------------

class Engine {
  constructor() {
    this.versions = new Map() // name -> { doc, head, dirty, index }
    this.commits = new Map() // id -> { parents: [id], bytes }
    this.users = new Map() // user -> 1-based index, in order of first appearance
    this.commitCount = 0
    this.lastMerge = null
    this.out = []
    this.failures = 0
  }

  emit(line = '') {
    this.out.push(line)
  }

  version(name) {
    const v = this.versions.get(name)
    if (!v) throw new Error(`unknown version "${name}"`)
    return v
  }

  // Yjs orders concurrent inserts at the same position by clientID, so
  // random IDs would make transcripts differ run to run. One fixed ID per
  // (user, version): also required for correctness, not just tidiness --
  // the same user editing two diverged versions with ONE clientID would
  // mint conflicting (client, clock) pairs, which corrupts a later merge.
  // (Real browser sessions get a fresh random clientID per connection, so
  // the app never hits this.)
  clientId(user, versionName) {
    if (!this.users.has(user)) this.users.set(user, this.users.size + 1)
    return this.users.get(user) * 1000 + this.version(versionName).index
  }

  newCommitId() {
    return `c${this.commitCount++}`
  }

  // Stands in for the app's periodic git checkpoint: a version's live doc
  // becomes a commit. branch and merge do this implicitly on their inputs.
  commit(name) {
    const v = this.version(name)
    if (!v.dirty) return v.head
    const id = this.newCommitId()
    this.commits.set(id, { parents: v.head ? [v.head] : [], bytes: Y.encodeStateAsUpdate(v.doc) })
    v.head = id
    v.dirty = false
    return id
  }

  ancestors(id) {
    const seen = new Set()
    const stack = [id]
    while (stack.length) {
      const c = stack.pop()
      if (seen.has(c)) continue
      seen.add(c)
      stack.push(...this.commits.get(c).parents)
    }
    return seen
  }

  // Same definition as git's merge-base: the common ancestors that are not
  // themselves an ancestor of another common ancestor.
  mergeBase(a, b) {
    const ancA = this.ancestors(a)
    const common = [...this.ancestors(b)].filter((c) => ancA.has(c))
    const best = common.filter((c) => !common.some((o) => o !== c && this.ancestors(o).has(c)))
    return best.length ? best[best.length - 1] : null
  }

  createVersion(name, doc, head) {
    this.versions.set(name, { doc, head, dirty: false, index: this.versions.size + 1 })
  }

  paragraph(doc, token) {
    const m = /^p(\d+)$/.exec(token?.value ?? '')
    if (!m) throw new Error(`expected a paragraph reference like p1, got "${token?.value}"`)
    const index = Number(m[1]) - 1
    const frag = doc.getXmlFragment(FIELD)
    const el = frag.get(index)
    if (!(el instanceof Y.XmlElement)) throw new Error(`no paragraph ${m[1]} (document has ${frag.length})`)
    const text = el.toArray().find((c) => c instanceof Y.XmlText)
    return { frag, el, text, index }
  }

  showDoc(name, note = '') {
    const v = this.version(name)
    this.emit(`  ${name} @${v.head}${v.dirty ? ' +uncommitted' : ''}${note}:`)
    for (const line of renderDoc(v.doc)) this.emit(`    ${line}`)
  }

  run(command) {
    const w = command.tokens.map((t) => t.value)
    this.emit(`> ${command.raw}`)
    switch (w[0]) {
      case 'doc': return this.cmdDoc(command, w)
      case 'branch': return this.cmdBranch(w)
      case 'as': return this.cmdEdit(command)
      case 'commit': this.commit(w[1]); return this.showDoc(w[1])
      case 'merge': return this.cmdMerge(w)
      case 'show': return this.showDoc(w[1])
      case 'expect': return this.cmdExpect(command, w)
      default: throw new Error(`unknown command "${w[0]}"`)
    }
  }

  cmdDoc(command, w) {
    const name = w[1]
    if (!name || this.versions.has(name)) throw new Error(`doc needs a new version name (got "${name}")`)
    const doc = new Y.Doc()
    doc.clientID = SETUP_CLIENT_ID
    const frag = doc.getXmlFragment(FIELD)
    frag.insert(0, command.block.map(buildElement))
    this.createVersion(name, doc, null)
    this.versions.get(name).dirty = true
    this.commit(name)
    this.showDoc(name)
  }

  cmdBranch(w) {
    const [, name, kw, from] = w
    if (!name || kw !== 'from' || !from) throw new Error('usage: branch <new> from <existing>')
    if (this.versions.has(name)) throw new Error(`version "${name}" already exists`)
    const head = this.commit(from)
    this.createVersion(name, docFromBytes(this.commits.get(head).bytes), head)
    this.emit(`  ${name} created from ${from} @${head}`)
  }

  cmdEdit(command) {
    const w = command.tokens.map((t) => t.value)
    // as <user> on <version> <verb> ...
    if (w[2] !== 'on') throw new Error('usage: as <user> on <version> <command> ...')
    const [user, versionName] = [w[1], w[3]]
    const v = this.version(versionName)
    const args = command.tokens.slice(5)
    v.doc.clientID = this.clientId(user, versionName)
    v.doc.transact(() => this.applyEdit(v.doc, w[4], args))
    v.dirty = true
    this.showDoc(versionName)
  }

  applyEdit(doc, verb, args) {
    const a = args.map((t) => t.value)
    switch (verb) {
      case 'insert': {
        const { text } = this.paragraph(doc, args[0])
        const str = text.toString()
        const [where, anchorOrText] = [a[1], args[2]]
        if (where === 'at') {
          if (a[2] !== 'start' && a[2] !== 'end') throw new Error('insert ... at start|end "text"')
          return text.insert(a[2] === 'start' ? 0 : str.length, args[3].value)
        }
        if (where !== 'after' && where !== 'before') throw new Error('insert pN after|before "anchor" "text" | at start|end "text"')
        const idx = str.indexOf(anchorOrText.value)
        if (idx < 0) throw new Error(`anchor "${anchorOrText.value}" not found in "${str}"`)
        return text.insert(where === 'after' ? idx + anchorOrText.value.length : idx, args[3].value)
      }
      case 'replace': {
        const { text } = this.paragraph(doc, args[0])
        const [oldText, newText] = [args[1].value, args[3]?.value]
        if (a[2] !== '->' || newText === undefined) throw new Error('replace pN "old" -> "new"')
        const idx = text.toString().indexOf(oldText)
        if (idx < 0) throw new Error(`"${oldText}" not found in "${text.toString()}"`)
        text.delete(idx, oldText.length)
        return text.insert(idx, newText)
      }
      case 'delete': {
        const { frag, text, index } = this.paragraph(doc, args[0])
        if (args.length === 1) return frag.delete(index, 1)
        const idx = text.toString().indexOf(a[1])
        if (idx < 0) throw new Error(`"${a[1]}" not found in "${text.toString()}"`)
        return text.delete(idx, a[1].length)
      }
      case 'set': {
        const { el } = this.paragraph(doc, args[0])
        const eq = a[1]?.indexOf('=')
        if (!(eq > 0)) throw new Error('set pN key=value')
        return el.setAttribute(a[1].slice(0, eq), parseAttrValue(a[1].slice(eq + 1)))
      }
      case 'add': {
        const kind = a[0]
        if (kind !== 'para' && kind !== 'heading') throw new Error('add para|heading [key=value] after pN|at start|at end "text"')
        const attrs = {}
        let i = 1
        for (; i < a.length && a[i].includes('=') && !args[i].quoted; i++) {
          const eq = a[i].indexOf('=')
          attrs[a[i].slice(0, eq)] = parseAttrValue(a[i].slice(eq + 1))
        }
        const frag = doc.getXmlFragment(FIELD)
        let index
        if (a[i] === 'after') {
          index = this.paragraph(doc, args[i + 1]).index + 1
          i += 2
        } else if (a[i] === 'at' && (a[i + 1] === 'start' || a[i + 1] === 'end')) {
          index = a[i + 1] === 'start' ? 0 : frag.length
          i += 2
        } else throw new Error('add ... after pN | at start | at end "text"')
        return frag.insert(index, [buildElement({ name: kind === 'para' ? 'paragraph' : 'heading', attrs, text: args[i].value })])
      }
      default:
        throw new Error(`unknown edit "${verb}" (insert|replace|delete|set|add)`)
    }
  }

  cmdMerge(w) {
    const [, source, arrow, target, mode] = w
    if (arrow !== '->' || !target || (mode !== undefined && mode !== 'force')) throw new Error('usage: merge <source> -> <target> [force]')
    const s0 = this.version(source)
    const t0 = this.version(target)
    this.commit(source)
    this.commit(target)
    const baseId = this.mergeBase(s0.head, t0.head)
    if (!baseId) throw new Error(`versions share no common history: ${source}, ${target}`)
    this.emit(`  merge base ${baseId} (source @${s0.head}, target @${t0.head})`)

    const baseDoc = docFromBytes(this.commits.get(baseId).bytes)
    const targetDoc = docFromBytes(this.commits.get(t0.head).bytes)
    const sourceDoc = docFromBytes(this.commits.get(s0.head).bytes)
    const result = mergeDocs(baseDoc, targetDoc, sourceDoc, { field: FIELD, force: mode === 'force' })

    this.emit(`  conflicts: ${result.conflicts.length}`)
    for (const c of result.conflicts) this.emit(`    ${JSON.stringify(c)}`)
    this.lastMerge = { merged: result.merged, conflicts: result.conflicts }

    if (!result.merged) return this.emit(`  REFUSED, ${target} unchanged`)

    const id = this.newCommitId()
    this.commits.set(id, { parents: [t0.head, s0.head], bytes: result.mergedBytes })
    t0.head = id
    t0.doc = docFromBytes(result.mergedBytes)
    this.emit(`  MERGED as ${id} (parents ${this.commits.get(id).parents.join(', ')})${result.conflicts.length ? ' -- forced past the conflicts above' : ''}`)
    this.showDoc(target)
  }

  cmdExpect(command, w) {
    const failures = []
    switch (w[1]) {
      case 'merged': {
        const m = this.needMerge()
        if (String(m.merged) !== w[2]) failures.push(`merged is ${m.merged}, expected ${w[2]}`)
        break
      }
      case 'conflicts': {
        const m = this.needMerge()
        if (String(m.conflicts.length) !== w[2]) failures.push(`${m.conflicts.length} conflict(s), expected ${w[2]}`)
        break
      }
      case 'conflict': {
        const m = this.needMerge()
        const found = m.conflicts.some((c) => c.type === w[2] && (w[3] === undefined || c.attribute === w[3]))
        if (!found) failures.push(`no ${w.slice(2).join(' ')} conflict in ${JSON.stringify(m.conflicts)}`)
        break
      }
      case 'doc': {
        const actual = renderDoc(this.version(w[2]).doc)
        const expected = blockToLines(command.block)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push(`${w[2]} differs`, '    expected:', ...expected.map((l) => `      ${l}`), '    actual:', ...actual.map((l) => `      ${l}`))
        }
        break
      }
      default:
        throw new Error('expect merged|conflicts|conflict|doc ...')
    }
    if (failures.length === 0) return this.emit('  ok')
    this.failures++
    for (const [i, f] of failures.entries()) this.emit(i === 0 ? `  FAILED: ${f}` : `  ${f}`)
  }

  needMerge() {
    if (!this.lastMerge) throw new Error('no merge has happened yet')
    return this.lastMerge
  }
}

// Returns { transcript, failures }. A command error stops the scenario and
// counts as a failure; expectation failures are recorded and play continues.
export function runScenario(name, text) {
  const engine = new Engine()
  engine.emit(`# scenario: ${name}`)
  try {
    for (const command of parseScenario(text)) {
      try {
        engine.run(command)
      } catch (err) {
        engine.emit(`  ERROR at line ${command.lineNo}: ${err.message}`)
        engine.failures++
        break
      }
    }
  } catch (err) {
    engine.emit(`  ERROR: ${err.message}`)
    engine.failures++
  }
  engine.emit()
  engine.emit(engine.failures === 0 ? '# result: ok' : `# result: ${engine.failures} failure(s)`)
  return { transcript: engine.out.join('\n') + '\n', failures: engine.failures }
}
