#!/usr/bin/env node
/**
 * Read the DeepSeek Harness session log that replaces Cursor's
 * `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`.
 *
 * The harness stores one zstd-compressed JSONL per session:
 *   $DSH_HOME/sessions/<slug>/session-<id>/session.v4.jsonl.zstd
 * The first line is the session header (`cwd`, `agentPreset`, `delegationDepth`, …);
 * subagent runs are separate session directories under the same slug.
 *
 * Usage:
 *   node session-transcript.mjs list [--cwd <dir>] [--all] [--json]
 *   node session-transcript.mjs show [--cwd <dir>] [--session <id>] [--grep <text>] [--tail <n>]
 *
 * `--cwd` defaults to the current directory. `list` prints one row per session,
 * newest first. `show` prints the decompressed JSONL; without `--session` it picks
 * the newest session for that cwd. Reading any other workspace's slug would cross
 * a privacy boundary, so `--all` is explicit and prints metadata only, never bodies.
 *
 * No dependencies. Requires Node >= 22.19 for `node:zlib` zstd support.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

function helpText() {
  return [
    'usage: session-transcript.mjs list [--cwd <dir>] [--all] [--json]',
    '       session-transcript.mjs show [--cwd <dir>] [--session <id>] [--grep <text>] [--tail <n>]',
  ].join('\n')
}

function help() {
  console.log(helpText())
  process.exit(0)
}

function usage(message) {
  if (message !== undefined) console.error(message)
  console.error(helpText())
  process.exit(2)
}

function parseArgs(argv) {
  if (argv.some(token => token === '-h' || token === '--help')) help()
  const [command = 'list', ...rest] = argv
  const options = { command, cwd: process.cwd(), all: false, json: false }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    const next = () => {
      const value = rest[index + 1]
      if (value === undefined) usage(`missing value for ${token}`)
      index += 1
      return value
    }
    if (token === '--cwd') options.cwd = next()
    else if (token === '--session') options.session = next()
    else if (token === '--grep') options.grep = next()
    else if (token === '--tail') options.tail = Number(next())
    else if (token === '--all') options.all = true
    else if (token === '--json') options.json = true
    else usage(`unknown argument: ${token}`)
  }
  if (options.command !== 'list' && options.command !== 'show') usage(`unknown command: ${options.command}`)
  if (options.tail !== undefined && (!Number.isInteger(options.tail) || options.tail < 1)) usage('--tail needs a positive integer')
  return options
}

/**
 * Faithful mirror of DSH's session slug derivation: projectKey() in
 * deepseek-harness packages/session/session-persistence-jsonl/src/format.ts:225.
 * Separator runs (`/`, `\`, `:`) collapse to one `-`; [A-Za-z0-9._-] passes
 * through; every other UTF-16 code unit escapes as `~XXXX` (surrogate halves
 * individually, matching the source's charCodeAt iteration); leading `-` runs
 * strip, an empty key falls back to `root`, and the key caps at 251 chars.
 */
function slugFor(cwd) {
  const normalized = resolve(cwd)
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** Windows reports one directory under several casings; compare paths accordingly. */
function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/** Session files for one slug, newest first. */
function sessionsIn(slug) {
  const directory = join(sessionsRoot(), slug)
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    // The same workspace reached as E:\Demo vs e:\demo hashes to different slug
    // spellings; Windows folds path case, so retry with a case-insensitive scan.
    if (process.platform !== 'win32') return []
    const match = allSlugs().find(name => name.toLowerCase() === slug.toLowerCase())
    return match === undefined ? [] : sessionsIn(match)
  }
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
    const folder = join(directory, entry.name)
    const file = readdirSync(folder).find(name => name.startsWith('session.v4.jsonl'))
    if (file === undefined) continue
    const path = join(folder, file)
    const bytes = statSync(path).size
    sessions.push({ slug, sessionId: entry.name.slice('session-'.length), path, bytes, modified: statSync(path).mtimeMs })
  }
  return sessions.sort((left, right) => right.modified - left.modified)
}

function allSlugs() {
  try {
    return readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('--'))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Session header line, or undefined when the file is unreadable. */
function header(path) {
  try {
    const text = firstFrameText(readFileSync(path))
    return JSON.parse(text.split('\n', 1)[0])
  } catch {
    return undefined
  }
}

/**
 * The harness appends one zstd frame per event, so a session file is a
 * concatenation of frames. Node decodes only the first frame from a buffer or a
 * stream, so frames are located by their magic and decoded one at a time.
 */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const NEWLINE = Buffer.from('\n')

function firstFrameText(buffer) {
  let end = buffer.indexOf(FRAME_MAGIC, FRAME_MAGIC.length)
  for (;;) {
    const candidateEnd = end < 0 ? buffer.length : end
    try {
      return zstdDecompressSync(buffer.subarray(0, candidateEnd)).toString('utf8')
    } catch (error) {
      // A candidate offset inside compressed data is not a frame boundary: keep extending.
      if (end >= 0) {
        end = buffer.indexOf(FRAME_MAGIC, end + FRAME_MAGIC.length)
        continue
      }
      throw error
    }
  }
}

function allFramesText(buffer) {
  const parts = []
  let cursor = 0
  while (cursor < buffer.length) {
    let start = buffer.indexOf(FRAME_MAGIC, cursor)
    if (start < 0) break
    let end = buffer.indexOf(FRAME_MAGIC, start + FRAME_MAGIC.length)
    for (;;) {
      const candidateEnd = end < 0 ? buffer.length : end
      try {
        const decoded = zstdDecompressSync(buffer.subarray(start, candidateEnd))
        // The harness ends every event frame with \n; a frame that lost it would
        // glue two JSON events into one line, so restore the separator.
        if (decoded.length > 0 && decoded[decoded.length - 1] !== 0x0a) parts.push(Buffer.concat([decoded, NEWLINE]))
        else parts.push(decoded)
        cursor = candidateEnd
        break
      } catch (error) {
        // A candidate offset inside compressed data is not a frame boundary: keep extending.
        if (end >= 0) {
          end = buffer.indexOf(FRAME_MAGIC, end + FRAME_MAGIC.length)
          continue
        }
        // No further magic and still failing. A start that still has a later
        // magic is a fake one inside inter-frame garbage: resync to the next
        // real frame instead of dropping every frame behind the garbage.
        const nextMagic = buffer.indexOf(FRAME_MAGIC, start + FRAME_MAGIC.length)
        if (nextMagic >= 0) {
          console.error(`warning: skipped ${nextMagic - start} undecodable bytes at offset ${start}`)
          start = nextMagic
          end = buffer.indexOf(FRAME_MAGIC, start + FRAME_MAGIC.length)
          continue
        }
        // Otherwise the tail frame was cut mid-write. Keep the frames that
        // decoded instead of losing the whole log; rethrow only when not even
        // the first frame completed and there is nothing to show.
        if (parts.length === 0) throw error
        console.error(`warning: truncated tail frame dropped (${buffer.length - start} bytes); ${parts.length} earlier frame(s) decoded`)
        cursor = buffer.length
        break
      }
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function describe(session) {
  const head = header(session.path)
  // One log with a corrupt header must not kill the whole list: an unparseable
  // createdAt keeps its raw value (with a stderr warning) instead of throwing
  // RangeError out of toISOString().
  let createdAt
  if (head?.createdAt !== undefined) {
    const parsed = new Date(head.createdAt)
    if (Number.isNaN(parsed.getTime())) {
      console.error(`warning: ${session.path}: invalid createdAt ${JSON.stringify(head.createdAt)}`)
      createdAt = head.createdAt
    } else {
      createdAt = parsed.toISOString()
    }
  }
  return {
    sessionId: session.sessionId,
    createdAt,
    cwd: head?.cwd,
    agentPreset: head?.agentPreset,
    delegationDepth: head?.delegationDepth,
    modified: new Date(session.modified).toISOString(),
    bytes: session.bytes,
    slug: session.slug,
    path: session.path,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const slug = slugFor(options.cwd)

  if (options.command === 'list') {
    const slugs = options.all ? allSlugs() : [slug]
    // Header parsing decodes only each log's first frame, so `--all` still
    // surfaces metadata (depth/preset) and never prints other workspaces' bodies.
    const rows = slugs.flatMap(candidate => sessionsIn(candidate).map(session => describe(session)))
    const scoped = options.all ? rows : rows.filter(row => row.cwd === undefined || samePath(resolve(row.cwd), resolve(options.cwd)))
    if (scoped.length === 0) {
      console.error(`no session under ${join(sessionsRoot(), slug)}`)
      console.error('pass --cwd <dir> for another workspace, or --all to list every slug')
      process.exit(1)
    }
    if (options.json) {
      for (const row of scoped) console.log(JSON.stringify(row))
      return
    }
    for (const row of scoped) {
      const depth = row.delegationDepth === undefined ? '?' : String(row.delegationDepth)
      console.log(`${row.modified}  ${row.sessionId}  depth=${depth}  preset=${row.agentPreset ?? '?'}  ${row.bytes} bytes`)
    }
    return
  }

  const sessions = sessionsIn(slug).filter(session => {
    if (options.session === undefined) return true
    return session.sessionId === options.session || session.sessionId.startsWith(options.session)
  })
  if (sessions.length === 0) {
    console.error(`no session ${options.session === undefined ? '' : `matching "${options.session}" `}under ${join(sessionsRoot(), slug)}`)
    process.exit(1)
  }
  if (options.session !== undefined && sessions.length > 1) {
    // An exact id can only hit one directory, so several hits mean prefix
    // matching; say what got picked instead of silently choosing the newest.
    console.error(`warning: ${sessions.length} sessions match prefix "${options.session}"; showing the newest (${sessions[0].sessionId})`)
  }
  const chosen = sessions[0]
  const buffer = readFileSync(chosen.path)
  // A non-empty file that does not start with a zstd frame is not a session log;
  // staying silent here would report success with no output.
  if (buffer.length > 0 && buffer.indexOf(FRAME_MAGIC) !== 0) {
    console.error(`cannot decompress ${chosen.path}: not a session log`)
    process.exit(1)
  }
  let text
  try {
    text = allFramesText(buffer)
  } catch (error) {
    console.error(`cannot decompress ${chosen.path}: ${error.message}`)
    process.exit(1)
  }
  let lines = text.split('\n').filter(line => line !== '')
  if (options.grep !== undefined) {
    const needle = options.grep.toLowerCase()
    lines = lines.filter(line => line.toLowerCase().includes(needle))
  }
  if (options.tail !== undefined) lines = lines.slice(-options.tail)
  process.stdout.write(lines.join('\n') + (lines.length === 0 ? '' : '\n'))
  if (process.env.DSH_PSTACK_TRACE === '1') {
    console.error(`${chosen.path} (${chosen.bytes} bytes${options.grep === undefined ? '' : `, grep "${options.grep}"`})`)
  }
}

// Exported for scripts/verify.mjs unit probes.
export { slugFor, firstFrameText, allFramesText }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()