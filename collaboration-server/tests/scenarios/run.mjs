import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScenario } from './scenario.mjs'

// Usage: node tests/scenarios/run.mjs [--update] [name-substring ...]
//
// Plays every *.scn in this directory and compares the transcript with
// expected/<name>.out. A scenario passes only if (a) every `expect` line in
// it held and (b) the transcript matches the committed one byte for byte.
// --update rewrites the expected files: read the diff before committing it --
// a golden file records what happened, it doesn't prove that's what SHOULD.

const dir = path.dirname(fileURLToPath(import.meta.url))
const expectedDir = path.join(dir, 'expected')
const args = process.argv.slice(2)
const update = args.includes('--update')
const filters = args.filter((a) => !a.startsWith('--'))

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.scn'))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort()

function firstDifferences(expected, actual, max = 12) {
  const e = expected.split('\n')
  const a = actual.split('\n')
  const lines = []
  for (let i = 0; i < Math.max(e.length, a.length) && lines.length < max; i++) {
    if (e[i] !== a[i]) lines.push(`    line ${i + 1}:`, `      - ${e[i] ?? '(missing)'}`, `      + ${a[i] ?? '(missing)'}`)
  }
  return lines
}

let failed = 0
fs.mkdirSync(expectedDir, { recursive: true })

for (const file of files) {
  const name = file.replace(/\.scn$/, '')
  const { transcript, failures } = runScenario(file, fs.readFileSync(path.join(dir, file), 'utf8'))
  const expectedPath = path.join(expectedDir, `${name}.out`)
  const problems = []

  if (failures > 0) problems.push(`${failures} failed expectation(s)/error(s) -- see the transcript`)

  if (update) {
    fs.writeFileSync(expectedPath, transcript)
  } else if (!fs.existsSync(expectedPath)) {
    problems.push('no expected transcript yet (run with --update, then review it)')
  } else {
    const expected = fs.readFileSync(expectedPath, 'utf8')
    if (expected !== transcript) problems.push('transcript differs from expected/' + name + '.out:', ...firstDifferences(expected, transcript))
  }

  if (problems.length === 0) {
    console.log(`PASS  ${file}${update ? ' (expected file updated)' : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${file}`)
    for (const p of problems) console.log(`  ${p}`)
    if (failures > 0) console.log(transcript.split('\n').map((l) => `  | ${l}`).join('\n'))
  }
}

console.log(`\n${files.length - failed}/${files.length} scenario(s) passed`)
process.exit(failed === 0 ? 0 : 1)
