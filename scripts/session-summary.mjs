#!/usr/bin/env node
/**
 * Decision-oriented summary of one DSH session log.
 *
 * Reads the log through session-transcript.mjs (single source of truth) and projects
 * the parts a retro actually needs: approvals, injected instructions, skills loaded,
 * tool mix, failures, and files written. Unknown event shapes are reported raw
 * instead of being guessed.
 *
 * Usage: node session-summary.mjs [--cwd DIR] [--session ID] [--kinds a,b] [--json]
 * Kinds: session, approvals, instructions, skills, tools, failures, files
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRANSCRIPT = join(HERE, 'session-transcript.mjs')
const KINDS = ['session', 'approvals', 'instructions', 'skills', 'tools', 'failures', 'files']

function fail(message) { console.error('session-summary: ' + message); process.exit(1) }

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: node session-summary.mjs [--cwd DIR] [--session ID] [--kinds a,b] [--json]')
    console.log('kinds: ' + KINDS.join(', '))
    process.exit(0)
  }
  const options = { kinds: KINDS.slice() }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.slice(0, 2) !== '--') fail('unexpected argument: ' + token)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (key === 'cwd' || key === 'session' || key === 'kinds') {
      // These take a value; a bare flag here would silently corrupt the filter.
      if (value === undefined || value.slice(0, 2) === '--') {
        fail('missing value for ' + token + ' (usage: node session-summary.mjs [--cwd DIR] [--session ID] [--kinds a,b] [--json])')
      }
      options[key] = value
      index += 1
      continue
    }
    if (key !== 'json') fail('unknown argument: ' + token + ' (usage: node session-summary.mjs [--cwd DIR] [--session ID] [--kinds a,b] [--json])')
    if (value === undefined || value.slice(0, 2) === '--') { options[key] = true; continue }
    options[key] = value
    index += 1
  }
  if (typeof options.kinds === 'string') {
    const wanted = options.kinds.split(',').map(kind => kind.trim()).filter(Boolean)
    for (const kind of wanted) if (!KINDS.includes(kind)) fail('unknown kind: ' + kind + ' (have ' + KINDS.join(', ') + ')')
    options.kinds = wanted
  }
  return options
}

function readEvents(options) {
  const args = [TRANSCRIPT, 'show']
  if (typeof options.cwd === 'string') args.push('--cwd', options.cwd)
  if (typeof options.session === 'string') args.push('--session', options.session)
  let stdout
  try {
    stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    // Name the invoked helper and carry its message; never dump the raw stack.
    fail(`cannot read transcript via ${TRANSCRIPT}: ${error.message}`)
  }
  const events = []
  let malformed = 0
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    try { events.push(JSON.parse(line)) } catch { malformed += 1 }
  }
  return { events, malformed }
}

function truncated(value, length) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (raw === undefined) return ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length <= length ? flat : flat.slice(0, length) + '...'
}

function summarize(events) {
  const result = {
    session: undefined,
    approvals: [],
    instructions: [],
    skills: [],
    tools: new Map(),
    failures: [],
    files: new Set(),
    malformed: 0,
  }
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : ''
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (type === 'session') { result.session = event; continue }
    if (type === 'approval/asked') { result.approvals.push({ asked: data }); continue }
    if (type === 'approval/decided') {
      const last = result.approvals[result.approvals.length - 1]
      if (last !== undefined && last.decided === undefined) last.decided = data
      else result.approvals.push({ decided: data })
      continue
    }
    const source = data.source !== null && typeof data.source === 'object' ? data.source : undefined
  
    if (source !== undefined && source.kind === 'agent-instructions') {
      const target = data.content !== undefined ? data.content : data.text
      result.instructions.push(truncated(target === undefined ? data : target, 200))
      continue
    }
    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : typeof data.tool === 'string' ? data.tool : 'unknown'
      result.tools.set(name, (result.tools.get(name) || 0) + 1)
      const input = data.input !== null && typeof data.input === 'object' ? data.input : data.arguments
      if (name === 'skill' && input !== null && typeof input === 'object' && typeof input.name === 'string') result.skills.push(input.name)
      if (name === 'read' && input !== null && typeof input === 'object' && typeof input.path === 'string' && input.path.indexOf('skills/') !== -1) result.skills.push(input.path.replace(/.*skills\//, '').replace(/\/SKILL\.md$/, ''))
      if (input !== null && typeof input === 'object') {
        for (const key of ['path', 'file', 'file_path', 'destination']) {
          if (typeof input[key] === 'string' && (name === 'write' || name === 'edit' || name === 'apply_patch')) result.files.add(input[key])
        }
      }
      continue
    }
    if (type === 'tool/result' || type === 'tool/failed') {
      const failed = data.isError === true || data.ok === false || type === 'tool/failed'
      if (failed) {
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        result.failures.push(name + ': ' + truncated(data.error !== undefined ? data.error : data.result, 160))
      }
    }
  }
  return result
}

function render(summary, kinds, transcriptNote) {
  const lines = []
  const has = kind => kinds.includes(kind)
  if (has('session')) {
    lines.push('## session')
    if (summary.session === undefined) lines.push('- header not found')
    else {
      const session = summary.session
      lines.push('- id: ' + String(session.id))
      lines.push('- cwd: ' + String(session.cwd))
      lines.push('- preset: ' + String(session.agentPreset) + '  depth: ' + String(session.delegationDepth))
    }
    lines.push('')
  }
  if (has('approvals')) {
    lines.push('## approvals (' + summary.approvals.length + ')')
    if (summary.approvals.length === 0) lines.push('- none recorded')
    for (const entry of summary.approvals) {
      if (entry.asked !== undefined) lines.push('- asked: ' + truncated(entry.asked, 160))
      if (entry.decided !== undefined) lines.push('  - decided: ' + truncated(entry.decided, 120))
    }
    lines.push('')
  }
  if (has('instructions')) {
    lines.push('## injected instructions (' + summary.instructions.length + ')')
    if (summary.instructions.length === 0) lines.push('- none recorded as agent-instructions messages')
    for (const entry of summary.instructions) lines.push('- ' + entry)
    lines.push('')
  }
  if (has('skills')) {
    const unique = Array.from(new Set(summary.skills))
    lines.push('## skills read (' + unique.length + ')')
    if (unique.length === 0) lines.push('- none')
    for (const entry of unique) lines.push('- ' + entry)
    lines.push('')
  }
  if (has('tools')) {
    const rows = Array.from(summary.tools.entries()).sort((a, b) => b[1] - a[1])
    const total = rows.reduce((sum, row) => sum + row[1], 0)
    lines.push('## tools (' + total + ' calls)')
    if (rows.length === 0) lines.push('- none')
    for (const row of rows) lines.push('- ' + row[0] + ' x ' + row[1])
    lines.push('')
  }
  if (has('failures')) {
    lines.push('## failures (' + summary.failures.length + ')')
    if (summary.failures.length === 0) lines.push('- none recorded')
    for (const entry of summary.failures) lines.push('- ' + entry)
    lines.push('')
  }
  if (has('files')) {
    const files = Array.from(summary.files)
    lines.push('## files written (' + files.length + ')')
    if (files.length === 0) lines.push('- none')
    for (const entry of files) lines.push('- ' + entry)
    lines.push('')
  }
  if (transcriptNote.malformed > 0) lines.push('note: ' + transcriptNote.malformed + ' malformed line(s) skipped')
  return lines.join('\n')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const { events, malformed } = readEvents(options)
  const summary = summarize(events)
  if (options.json === true) {
    const has = kind => options.kinds.includes(kind)
    const payload = {}
    if (has('session')) payload.session = summary.session
    if (has('approvals')) payload.approvals = summary.approvals
    if (has('instructions')) payload.instructions = summary.instructions
    if (has('skills')) payload.skills = Array.from(new Set(summary.skills))
    if (has('tools')) payload.tools = Object.fromEntries(summary.tools)
    if (has('failures')) payload.failures = summary.failures
    if (has('files')) payload.files = Array.from(summary.files)
    payload.malformed = malformed
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  process.stdout.write(render(summary, options.kinds, { malformed }) + '\n')
}

main()

