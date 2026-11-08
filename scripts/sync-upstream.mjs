#!/usr/bin/env node
/**
 * Byte gate against an upstream pstack checkout.
 *
 * The port copies upstream verbatim, so only the deltas listed below are legitimate.
 * Anything else means the port drifted, or upstream moved and the port needs a rebase.
 *
 * Fetch a checkout without pulling every plugin in the repository:
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins <dir>
 *   git -C <dir> sparse-checkout set pstack
 *
 * Then run:
 *   node scripts/sync-upstream.mjs --upstream <dir>/pstack
 *
 * Exit codes: 0 clean, 1 unexpected delta or stale expectation, 2 bad usage.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PSTACK_ROOT === undefined
  ? dirname(dirname(fileURLToPath(import.meta.url)))
  : resolve(process.env.PSTACK_ROOT)

/** Upstream files the port drops on purpose: Cursor packaging only. */
export const EXPECTED_MISSING = ['.cursor-plugin/plugin.json', 'assets/logo.png', 'plugin.json']

/**
 * Upstream files the port edits on purpose, each one explained in COMPATIBILITY.md
 * section 6. Every entry is a manual merge point when upstream moves.
 */
export const EXPECTED_CHANGED = ['README.md', '.gitignore', 'skills/poteto-mode/SKILL.md']

/**
 * Compare two path-to-digest maps. Pure: no filesystem, no exit.
 * @param {Map<string, string>} port
 * @param {Map<string, string>} upstream
 * @param {{ expectedMissing?: string[], expectedChanged?: string[] }} [expectations]
 */
export function compareTrees(port, upstream, {
  expectedMissing = EXPECTED_MISSING,
  expectedChanged = EXPECTED_CHANGED,
} = {}) {
  const unexpectedMissing = [...upstream.keys()]
    .filter(path => !port.has(path) && !expectedMissing.includes(path))
    .sort()
  const staleMissing = expectedMissing.filter(path => !upstream.has(path))
  const unexpectedChanged = [...upstream.keys()]
    .filter(path => port.has(path) && port.get(path) !== upstream.get(path))
    .filter(path => !expectedChanged.includes(path))
    .sort()
  const staleIdentical = expectedChanged.filter(path =>
    upstream.has(path) && port.has(path) && upstream.get(path) === port.get(path))
  const staleRestored = expectedMissing.filter(path => port.has(path))
  const extra = [...port.keys()].filter(path => !upstream.has(path)).sort()
  const failed = unexpectedMissing.length + unexpectedChanged.length + staleMissing.length + staleIdentical.length + staleRestored.length
  return { unexpectedMissing, unexpectedChanged, staleMissing, staleIdentical, staleRestored, extra, failed }
}

function usage(message) {
  if (message !== undefined) console.error(message)
  console.error('usage: sync-upstream.mjs --upstream <path-to-upstream-pstack>')
  process.exit(2)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--upstream') options.upstream = argv[++index]
    else if (token === '--help' || token === '-h') usage()
    else usage(`unknown argument: ${token}`)
  }
  if (typeof options.upstream !== 'string' || options.upstream === '') usage('--upstream is required')
  return options
}

/** Tool output never belongs to the byte contract; only at the repo root's first level. */
const SKIP = new Set(['.git', '.metrics', 'target'])

/** Path-to-absolute map of the tree; SKIP names are honored only at the first level. */
export function walk(dir, base = dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    if (dir === base && SKIP.has(name)) continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, base, out)
    else out.set(relative(base, abs).split(sep).join('/'), abs)
  }
  return out
}

/** Bytes compare 1:1; the CRLF swap drops the checkout's line-ending noise. */
function digests(tree) {
  const hashes = new Map()
  for (const [path, abs] of tree) {
    hashes.set(path, createHash('sha256')
      .update(readFileSync(abs).toString('latin1').replace(/\r\n/g, '\n'))
      .digest('hex'))
  }
  return hashes
}

function section(title, rows) {
  console.log(`\n${title} (${rows.length})`)
  for (const row of rows) console.log(`  ${row}`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  let upstreamTree
  try {
    upstreamTree = walk(options.upstream)
  } catch (error) {
    usage(`cannot read upstream tree at ${options.upstream}: ${error.message}`)
  }

  /** A wrong --upstream would look like "everything is extra", so refuse it here. */
  if (!upstreamTree.has('plugin.json') || ![...upstreamTree.keys()].some(path => path.startsWith('skills/'))) {
    usage(`does not look like an upstream pstack tree, missing plugin.json or skills/: ${options.upstream}`)
  }

  const portTree = walk(ROOT)
  const result = compareTrees(digests(portTree), digests(upstreamTree))

  console.log(`upstream ${upstreamTree.size} files, port ${portTree.size} files`)
  section('unexpected missing from the port', result.unexpectedMissing)
  section('unexpected content change', result.unexpectedChanged)
  section('stale expectation, upstream no longer has the file', result.staleMissing)
  section('stale expectation, file restored despite expectedMissing', result.staleRestored)
  section('stale expectation, file matches upstream now', result.staleIdentical)
  section('extra in the port, informational', result.extra)

  if (result.failed > 0) {
    console.error('\nFAIL: the byte contract changed. Rebase the port or update the expectation lists in this file.')
    process.exit(1)
  }
  console.log(`\nok: ${EXPECTED_MISSING.length} dropped, ${EXPECTED_CHANGED.length} edited, ${result.extra.length} added`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
