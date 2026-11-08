#!/usr/bin/env node
/** Gate for the review-triage capability: skill contract, tool selftest, presets, summary view. */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

// PSTACK_ROOT points the gate at another copy, which is what a mutation worker
// needs: the worker links this script, so import.meta.url resolves to the real tree.
const ROOT = process.env.PSTACK_ROOT === undefined
  ? dirname(dirname(fileURLToPath(import.meta.url)))
  : resolve(process.env.PSTACK_ROOT)
const failures = []
const checks = []
function check(name, condition, detail) {
  if (condition) { checks.push(name); return }
  failures.push(detail === undefined ? name : name + ' -- ' + detail)
}

// 1. skill contract
const skillFile = join(ROOT, 'skills', 'review-triage', 'SKILL.md')
check('skill exists', existsSync(skillFile))
const skillText = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText)
check('skill has frontmatter', frontmatter !== null)
const head = frontmatter === null ? '' : frontmatter[1]
check('skill name matches directory', /^name:\s*review-triage\s*$/m.test(head))
check('skill has a description', /^description:\s*\S/m.test(head))
check('skill stays model-invocable', !/disable-model-invocation/.test(head))
check('skill names the rubric', skillText.indexOf('bugbot-triage.md') !== -1)
check('skill documents the apply guard', skillText.indexOf('PSTACK_REVIEW_APPLY=1') !== -1)
check('skill degrades ask when unattended', skillText.indexOf('## Unattended runs') !== -1)

// 2. tool selftest
const tool = join(ROOT, 'scripts', 'review-triage.mjs')
let selftest = ''
let selftestFailure = ''
try {
  selftest = execFileSync(process.execPath, [tool, 'selftest'], { encoding: 'utf8' })
} catch (error) {
  // A failing selftest used to surface as a raw child-error dump; report the
  // child's own stderr tail so the broken assertion is readable in the FAIL line.
  selftestFailure = typeof error.stderr === 'string' && error.stderr !== '' ? error.stderr : String(error.stdout ?? '')
}
check('review-triage selftest', selftest.indexOf('selftest ok') !== -1,
  selftestFailure !== '' ? 'selftest stderr tail: ' + selftestFailure.trim().slice(-400) : selftest.trim())
const help = execFileSync(process.execPath, [tool, 'help'], { encoding: 'utf8' })
for (const command of ['inbox', 'plan', 'record', 'draft', 'apply', 'state']) {
  check('review-triage lists ' + command, help.indexOf(command) !== -1)
}

// 3. presets
const presetsReviewPath = join(ROOT, 'presets-review.mjs')
if (!existsSync(presetsReviewPath)) {
  fail('presets-review.mjs: missing — preset checks cannot run')
} else {
  const { buildReviewPresets } = await import(pathToFileURL(presetsReviewPath).href)
  const reviewPresets = buildReviewPresets({ root: ROOT })
  check('two review presets', reviewPresets.length === 2)
  const byId = new Map(reviewPresets.map(preset => [preset.id, preset]))
  const flatten = rows => rows.flatMap(row => row.group === true ? flatten(row.config) : [row])
  const proposeFs = flatten(byId.get('review-triage').plugins).find(row => row.id === 'tool-fs')
  const applyFs = flatten(byId.get('review-triage-apply').plugins).find(row => row.id === 'tool-fs')
  check('propose has no write tool', proposeFs.config.write === false && proposeFs.config.edit === false)
  check('apply has write tools', applyFs.config.write === undefined || applyFs.config.write === true)
  for (const preset of reviewPresets) {
    const rows = flatten(preset.plugins)
    check(preset.id + ': unique ids', new Set(rows.map(row => row.id)).size === rows.length)
    check(preset.id + ': shipped scopes', rows.every(row => row.name === 'cordis:group' || row.name.indexOf('@deepseek-ai/') === 0))
    const persona = rows.find(row => row.id === 'persona')
    check(preset.id + ': persona points at the skill', persona.config.prefix.indexOf(join(ROOT, 'skills', 'review-triage', 'SKILL.md')) !== -1)
  }
}

// 4. index registration matrix
const pluginEntry = join(ROOT, 'index.js')
if (!existsSync(pluginEntry)) {
  fail('index.js: missing — registration checks cannot run')
} else {
  const plugin = await import(pathToFileURL(pluginEntry).href)
  function stubContext() {
    const sections = []
    const registrations = []
    const pending = []
    const registry = {
      async list() { return registrations.map(definition => ({ id: definition.id })) },
      async register(definition) { registrations.push(definition); return async () => {} },
    }
    const ctx = {
      sections,
      registrations,
      systemPrompt: { section: section => { sections.push(section); return () => {} } },
      effect: () => {},
      get: key => (key === 'agentPresets' ? registry : undefined),
      // The registry service arrives after this plugin activates, so the real
      // plugin waits for it through ctx.inject.
      inject: (services, callback) => {
        if (!services.includes('agentPresets')) return undefined
        pending.push(Promise.resolve(callback(ctx)))
      },
      settled: async () => { await Promise.all(pending) },
    }
    return ctx
  }
  /** Apply the plugin and wait for its deferred preset registration. */
  async function applyPlugin(ctx, config) {
    await plugin.apply(ctx, config)
    await ctx.settled()
  }
  const off = stubContext()
  await applyPlugin(off, { enabled: false })
  check('apply preset stays off by default', off.registrations.map(d => d.id).join(',') === 'poteto-agent,comment-sicko,pstack,review-triage')
  const on = stubContext()
  await applyPlugin(on, { enabled: false, reviewTriage: { apply: true } })
  check('apply preset registers when enabled', on.registrations.map(d => d.id).join(',').indexOf('review-triage-apply') !== -1)
  let rejected
  try { await applyPlugin(stubContext(), { reviewTriage: { apply: 'yes' } }) } catch (e) { rejected = e }
  check('config rejects a non-boolean apply',
    rejected instanceof TypeError && rejected.message === 'pstack-router: config.reviewTriage.apply must be a boolean',
    rejected === undefined ? 'no error raised' : String(rejected))
}

// 5. summary view against a fixture log
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-summary-'))
try {
  const workspace = join(sandbox, 'ws')
  mkdirSync(workspace, { recursive: true })
  const slug = '--' + resolve(workspace).replace(/:/g, '').replace(/[\\/]+/g, '-') + '--'
  const folder = join(sandbox, '.dsh', 'sessions', slug, 'session-fx')
  mkdirSync(folder, { recursive: true })
  const events = [
    { type: 'session', id: 'session-fx', cwd: workspace, agentPreset: 'pstack', delegationDepth: 0 },
    { type: 'approval/asked', data: { toolName: 'pwsh', reason: 'rm -rf build' } },
    { type: 'approval/decided', data: { outcome: 'allowed-once' } },
    { type: 'system/message', data: { source: { kind: 'agent-instructions' }, content: 'AGENTS.md rules' } },
    { type: 'model/selection', data: { provider: 'magpie', model: 'codearts/x' } },
    { type: 'tool/call', data: { name: 'read', input: { path: 'skills/tdd/SKILL.md' } } },
    { type: 'tool/call', data: { name: 'write', input: { path: 'src/a.ts' } } },
    { type: 'tool/result', data: { name: 'write', isError: true, error: 'denied' } },
  ]
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')))))
  const summary = execFileSync(process.execPath, [join(ROOT, 'scripts', 'session-summary.mjs')], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DSH_HOME: join(sandbox, '.dsh') }),
    cwd: workspace,
  })
  check('summary: session header', summary.indexOf('session-fx') !== -1)
  check('summary: approval pair', summary.indexOf('## approvals (1)') !== -1 && summary.indexOf('allowed-once') !== -1)
  check('summary: instructions', summary.indexOf('AGENTS.md rules') !== -1)
  check('summary: skill read', summary.indexOf('- tdd') !== -1)
  check('summary: failure', summary.indexOf('denied') !== -1)
  check('summary: files', summary.indexOf('src/a.ts') !== -1)
  const json = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'scripts', 'session-summary.mjs'), '--json'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DSH_HOME: join(sandbox, '.dsh') }),
    cwd: workspace,
  }))
  check('summary json: tools counted', json.tools.read === 1)
  check('summary json: malformed zero', json.malformed === 0)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// 6. manifest and patch
const manifestPath = join(ROOT, 'package.json')
check('manifest: package.json exists', existsSync(manifestPath))
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: [], scripts: {} }
check('manifest: presets-review.mjs shipped', manifest.files.indexOf('presets-review.mjs') !== -1)
check('manifest: test runs both gates',
  manifest.scripts.test !== undefined
  && manifest.scripts.test.indexOf('verify.mjs') !== -1
  && manifest.scripts.test.indexOf('verify-review.mjs') !== -1)
const patchPath = join(ROOT, 'cordis.patch.yml')
check('patch: cordis.patch.yml exists', existsSync(patchPath))
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
check('patch: reviewTriage switch present', patch.indexOf('reviewTriage:') !== -1 && patch.indexOf('apply: false') !== -1)

// 7. apply engine: parseArgs strictness and runApply persistence timing
const triage = await import(pathToFileURL(tool).href)
let parsed = null
try {
  const { command, options } = triage.parseArgs(['apply', '--pr', '7', '--repo', 'o/n', '--thread', 'T1', '--yes', '--json'])
  parsed = command === 'apply' && options.pr === '7' && options.repo === 'o/n' && options.thread === 'T1' && options.yes === true && options.json === true
} catch (error) { parsed = String(error) }
check('parseArgs: values and boolean flags parse as before', parsed === true, String(parsed))
let missingValue = ''
try { triage.parseArgs(['apply', '--thread', '--yes']) } catch (error) { missingValue = error.message }
check('parseArgs: --thread without a value throws', missingValue === '--thread needs a value', missingValue)
let missingPr = ''
try { triage.parseArgs(['plan', '--pr']) } catch (error) { missingPr = error.message }
check('parseArgs: --pr without a value throws', missingPr === '--pr needs a value', missingPr)

const applyHead = 'h1'
const applyState = { repo: 'o/n', pr: 7, headSha: undefined, threads: { T1: { verdict: 'fix', reason: 'real', reply: 'r1', sha: head }, T2: { verdict: 'fix', reason: 'real', reply: 'r2', sha: head } } }
const posted = []
const resolved = []
const savedSnapshots = []
let t1DoneWhenT2Posted = null
let applyError
try {
  triage.runApply({
    repo: 'o/n', number: 7, head: applyHead,
    items: [
      { threadId: 'T1', path: 'a.ts', line: 3, verdict: 'fix', reply: 'r1' },
      { threadId: 'T2', path: 'b.ts', line: 9, verdict: 'fix', reply: 'r2' },
    ],
    state: applyState,
    postReply: threadId => {
      posted.push(threadId)
      if (threadId === 'T2') t1DoneWhenT2Posted = applyState.threads.T1.applied === true && applyState.threads.T1.pending === false
      if (threadId === 'T2') throw new Error('gh down')
    },
    postResolve: threadId => resolved.push(threadId),
    save: (repo, number, state) => savedSnapshots.push({ repo, number, first: state.threads.T1.applied === true, firstPending: state.threads.T1.pending === true, second: state.threads.T2.applied === true, secondPending: state.threads.T2.pending === true }),
  })
} catch (error) { applyError = error }
check('runApply: post failure reaches the caller', applyError !== undefined && applyError.message === 'gh down', applyError === undefined ? 'no error' : applyError.message)
check('runApply: pending is persisted before each reply is posted', savedSnapshots.length === 3 && savedSnapshots[0].firstPending === true && savedSnapshots[0].first === false && savedSnapshots[1].first === true && savedSnapshots[1].firstPending === false && savedSnapshots[2].secondPending === true, JSON.stringify(savedSnapshots))
check('runApply: first thread fully applied before the second reply is posted', t1DoneWhenT2Posted === true && savedSnapshots[1].first === true, 'posted ' + posted.join(',') + ' saved ' + JSON.stringify(savedSnapshots))
check('runApply: crash leaves T1 applied and T2 pending, never applied', applyState.threads.T1.applied === true && applyState.threads.T1.pending === false && applyState.threads.T2.applied === undefined && applyState.threads.T2.pending === true && applyState.headSha === applyHead, JSON.stringify(applyState.threads))
// A pending marker means the earlier run may have already sent the reply, so the
// rerun must skip the thread and hand it to a human instead of re-posting blindly.
const rerunWarnings = []
const realConsoleError = console.error
console.error = line => rerunWarnings.push(String(line))
const rerunPosts = []
let rerunError
try {
  triage.runApply({
    repo: 'o/n', number: 7, head: applyHead,
    items: [{ threadId: 'T2', path: 'b.ts', line: 9, verdict: 'fix', reply: 'r2' }],
    state: applyState,
    postReply: threadId => rerunPosts.push(threadId),
    postResolve: threadId => resolved.push(threadId),
    save: () => {},
  })
} catch (error) { rerunError = error } finally { console.error = realConsoleError }
check('runApply: rerun skips a pending thread, warns, and never re-posts', rerunError === undefined && rerunPosts.length === 0 && rerunWarnings.join('\n').indexOf('T2') !== -1 && rerunWarnings.join('\n').indexOf('verify manually') !== -1 && applyState.threads.T2.applied === undefined, JSON.stringify(rerunWarnings))
// Once a human verified the reply never landed and cleared the marker, the rerun finishes T2 without repeating T1.
delete applyState.threads.T2.pending
const clearedPosts = []
try {
  triage.runApply({
    repo: 'o/n', number: 7, head: applyHead,
    items: [{ threadId: 'T2', path: 'b.ts', line: 9, verdict: 'fix', reply: 'r2' }],
    state: applyState,
    postReply: threadId => { posted.push(threadId); clearedPosts.push(threadId) },
    postResolve: threadId => resolved.push(threadId),
    save: () => {},
  })
} catch (error) { applyError = error }
check('runApply: cleared marker lets the rerun finish T2 without repeating T1', clearedPosts.join(',') === 'T2' && posted.filter(id => id === 'T1').length === 1 && applyState.threads.T2.applied === true && applyState.threads.T2.pending === false && resolved.join(',') === 'T1,T2', 'posted ' + posted.join(','))
// Reply succeeds, resolve fails: the pending marker must survive so the rerun skips the re-post.
const pendState = { repo: 'o/n', pr: 9, headSha: undefined, threads: { T9: { verdict: 'fix', reason: 'real', reply: 'r9', sha: 'h9' } } }
const pendPosts = []
let pendError
try {
  triage.runApply({
    repo: 'o/n', number: 9, head: 'h9',
    items: [{ threadId: 'T9', path: 'a.ts', line: 1, verdict: 'fix', reply: 'r9' }],
    state: pendState,
    postReply: threadId => pendPosts.push(threadId),
    postResolve: () => { throw new Error('resolve down') },
    save: () => {},
  })
} catch (error) { pendError = error }
check('runApply: pending marker survives a resolve failure after the reply', pendError !== undefined && pendError.message === 'resolve down' && pendPosts.length === 1 && pendState.threads.T9.pending === true && pendState.threads.T9.applied !== true, pendError === undefined ? 'no error' : pendError.message + ' / ' + JSON.stringify(pendState.threads.T9))
const pendWarnings = []
console.error = line => pendWarnings.push(String(line))
let pendRerunError
try {
  triage.runApply({
    repo: 'o/n', number: 9, head: 'h9',
    items: [{ threadId: 'T9', path: 'a.ts', line: 1, verdict: 'fix', reply: 'r9' }],
    state: pendState,
    postReply: threadId => pendPosts.push(threadId),
    postResolve: () => {},
    save: () => {},
  })
} catch (error) { pendRerunError = error } finally { console.error = realConsoleError }
check('runApply: second run after a resolve failure re-posts nothing and warns', pendRerunError === undefined && pendPosts.length === 1 && pendWarnings.join('\n').indexOf('T9') !== -1, 'posted ' + pendPosts.length + ' warned ' + JSON.stringify(pendWarnings))
const askState = { repo: 'o/n', pr: 8, threads: {} }
const askCalls = { reply: 0, resolve: 0, saves: 0 }
let askError
try {
  triage.runApply({
    repo: 'o/n', number: 8, head: 'h2',
    items: [{ threadId: 'T3', path: 'c.ts', line: 1, verdict: 'ask', reply: 'which path?' }],
    state: askState,
    postReply: () => { askCalls.reply += 1 },
    postResolve: () => { askCalls.resolve += 1 },
    save: () => { askCalls.saves += 1 },
  })
} catch (error) { askError = error }
check('runApply: ask replies without resolving', askError === undefined && askCalls.reply === 1 && askCalls.resolve === 0, askError === undefined ? JSON.stringify(askCalls) : askError.message)
const t3 = askState.threads.T3 || {}
check('runApply: ask still records applied and clears pending', t3.applied === true && t3.pending === false && askCalls.saves === 2, JSON.stringify(t3))
let applyExit = 0
let applyStderr = ''
try {
  execFileSync(process.execPath, [tool, 'apply', '--pr', '--yes'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PSTACK_REVIEW_APPLY: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) { applyExit = error.status; applyStderr = error.stderr }
check('apply --pr without a value refuses to run', applyExit !== 0 && applyStderr.indexOf('--pr needs a value') !== -1, 'exit ' + applyExit + ' stderr ' + applyStderr.trim())

// 8. fetchThreads: pagination fail-closed, GraphQL shape validation, lastComment alias.
//    The third argument injects a fake gh so these checks never touch the network.
function ghPage(nodes, hasNextPage, cursor) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: 'head-sha', title: 't', url: 'u',
          reviewThreads: { pageInfo: { hasNextPage, endCursor: cursor }, nodes },
        },
      },
    },
  }
}
function comment(login, body) { return { author: { login }, body } }
function injectedThread(id, firstComments, lastComment) {
  return { id, isResolved: false, isOutdated: false, path: 'a.ts', line: 1, firstComments: { nodes: firstComments }, lastComment: { nodes: lastComment } }
}

let capPages = 0
let capError = ''
try {
  triage.fetchThreads('o/n', 7, () => {
    capPages += 1
    return JSON.stringify(ghPage([injectedThread('T' + capPages, [comment('bot', 'x')], [comment('bot', 'x')])], true, 'cursor-' + capPages))
  })
} catch (error) { capError = error.message }
check('fetchThreads: pagination cap fails closed', capPages === 20 && capError.indexOf('o/n#7') !== -1 && capError.indexOf('silently truncat') !== -1, capPages + ' pages seen, error: ' + capError)

let missingShape = ''
try {
  triage.fetchThreads('o/n', 8, () => JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'h', title: 't', url: 'u' } } } }))
} catch (error) { missingShape = error.message }
check('fetchThreads: missing reviewThreads fails closed', missingShape.indexOf('o/n#8') !== -1 && missingShape.indexOf('reviewThreads') !== -1, missingShape)

let badNodes = ''
try {
  triage.fetchThreads('o/n', 9, () => JSON.stringify(ghPage('not-an-array', false, null)))
} catch (error) { badNodes = error.message }
check('fetchThreads: non-array nodes fails closed', badNodes.indexOf('o/n#9') !== -1 && badNodes.indexOf('reviewThreads.nodes') !== -1, badNodes)

let aliasError = ''
let aliasItem = null
try {
  const twenty = Array.from({ length: 20 }, (_, i) => comment('n' + i, 'c' + i))
  const aliasFetch = triage.fetchThreads('o/n', 10, () => JSON.stringify(ghPage([injectedThread('T1', twenty, [comment('the-final-author', 'last word')])], false, null)))
  aliasItem = triage.flattenThreads(aliasFetch.threads, { repo: 'o/n', pr: 10, threads: {} }, aliasFetch.head)[0]
} catch (error) { aliasError = error.message }
check('fetchThreads: lastAuthor comes from the lastComment alias', aliasItem !== null && aliasItem.lastAuthor === 'the-final-author' && aliasItem.author === 'n0' && aliasItem.comments === 20, aliasError !== '' ? aliasError : JSON.stringify(aliasItem))

// 9. state file safety: atomic save semantics, slug traversal
const stateSandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-state-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = stateSandbox
try {
  let saved = null
  let savedError = ''
  try { saved = triage.saveState('o/n', 42, { repo: 'o/n', pr: 42, headSha: 'h1', threads: { T1: { verdict: 'fix', reason: 'real' } } }) }
  catch (error) { savedError = error.message }
  check('saveState: round-trip after atomic rename', typeof saved === 'string' && existsSync(saved) && JSON.parse(readFileSync(saved, 'utf8')).threads.T1.verdict === 'fix', savedError !== '' ? savedError : String(saved))

  let overwriteError = ''
  let overwritten = false
  try {
    triage.saveState('o/n', 42, { repo: 'o/n', pr: 42, threads: { T1: { verdict: 'dismiss', reason: 'nit' } } })
    overwritten = typeof saved === 'string' && JSON.parse(readFileSync(saved, 'utf8')).threads.T1.verdict === 'dismiss'
  } catch (error) { overwriteError = error.message }
  check('saveState: rename replaces existing state', overwritten, overwriteError !== '' ? overwriteError : 'kept first content')

  const stateDir = join(stateSandbox, 'review-triage', 'o__n')
  const residue = existsSync(stateDir) ? readdirSync(stateDir).filter(name => name.endsWith('.tmp')) : ['no state dir']
  check('saveState: no temp residue', existsSync(stateDir) && residue.length === 0, residue.join(','))

  let dotdot = ''
  try { triage.stateFile('..', 42) } catch (error) { dotdot = error.message }
  check('stateFile: ".." slug rejected', dotdot === 'unsafe repo slug: ..', dotdot === '' ? 'accepted' : dotdot)

  let dot = ''
  try { triage.stateFile('.', 42) } catch (error) { dot = error.message }
  check('stateFile: "." slug rejected', dot !== '' && dot.indexOf('unsafe repo slug') !== -1, dot === '' ? 'accepted' : dot)

  let stateExit = 0
  let stateStderr = ''
  try {
    execFileSync(process.execPath, [tool, 'state', '--repo', '..', '--pr', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) { stateExit = error.status; stateStderr = error.stderr }
  check('state --repo .. refuses to run', stateExit !== 0 && stateStderr.indexOf('..') !== -1, 'exit ' + stateExit + ' stderr ' + stateStderr.trim())
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(stateSandbox, { recursive: true, force: true })
}

// 10. draft excerpt hardening: fence escape and surrogate-safe slicing
const fenceDraft = triage.renderDraft({ repo: 'o/n', number: 11, head: 'h1' }, [{ threadId: 'TF', path: 'a.ts', line: 1, body: 'look ```code``` inline' }])
const fenceLine = fenceDraft.split('\n').filter(line => line.indexOf('a.ts') !== -1).join(' | ')
check('renderDraft: ``` in the excerpt is escaped', fenceDraft.indexOf('```') === -1 && fenceDraft.indexOf('\\`\\`\\`') !== -1, fenceLine)
const emojiLine = triage.renderDraft({ repo: 'o/n', number: 11, head: 'h1' }, [{ threadId: 'TE', path: 'b.ts', line: 2, body: 'x'.repeat(159) + '\u{1F600}'.repeat(3) }])
  .split('\n')
  .find(line => line.indexOf('b.ts') !== -1)
check('renderDraft: excerpt slicing is surrogate-safe', typeof emojiLine === 'string' && emojiLine.endsWith('\u{1F600}') && emojiLine.indexOf('\uFFFD') === -1, String(emojiLine))

// 11. inbox: the pr list calls must target the resolved repo, not whatever repo cwd points at
let inboxCalls = []
let inboxError = ''
try {
  triage.cmdInbox({ repo: 'acme/widget', limit: '5', json: true }, args => { inboxCalls.push(args.join(' ')); return '[]' })
} catch (error) { inboxError = error.message }
const inboxList = inboxCalls.filter(line => line.indexOf('pr list') === 0)
check('inbox: pr list carries the resolved --repo', inboxError === '' && inboxList.length === 2 && inboxList.every(line => line.indexOf('--repo acme/widget') !== -1), inboxError !== '' ? inboxError : JSON.stringify(inboxCalls))

// 12. entry guard: argv[1] keeps the link path while import.meta.url is the real path,
//     so the script must still run when invoked through a junction (win32) / symlink (posix)
const linkSandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-entry-'))
try {
  let linkedTool = null
  try {
    if (process.platform === 'win32') {
      const junctionDir = join(linkSandbox, 'scripts')
      symlinkSync(join(ROOT, 'scripts'), junctionDir, 'junction')
      linkedTool = join(junctionDir, 'review-triage.mjs')
    } else {
      linkedTool = join(linkSandbox, 'review-triage.mjs')
      symlinkSync(tool, linkedTool, 'file')
    }
  } catch { linkedTool = null }
  if (linkedTool === null) {
    checks.push('entry guard: runs through a junction/symlink (skipped: links unavailable here)')
  } else {
    let linkedHelp = ''
    let linkedExit = 0
    try {
      linkedHelp = execFileSync(process.execPath, [linkedTool, 'help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { linkedExit = error.status; linkedHelp = typeof error.stdout === 'string' ? error.stdout : '' }
    check('entry guard: runs through a junction/symlink', linkedExit === 0 && linkedHelp.indexOf('review-triage <command>') !== -1, 'exit ' + linkedExit + ' stdout ' + JSON.stringify(linkedHelp.slice(0, 60)))
  }
} finally {
  rmSync(linkSandbox, { recursive: true, force: true })
}

// 13. applyReply: a 200 body that carries GraphQL errors must fail closed instead of flagging applied
let replyError = ''
try {
  triage.applyReply('T7', 'the race is real', () => JSON.stringify({ data: null, errors: [{ message: 'Thread not found: T7', type: 'NOT_FOUND' }] }))
} catch (error) { replyError = error.message }
check('applyReply: GraphQL errors in the body fail closed', replyError.indexOf('addPullRequestReviewThreadReply') !== -1 && replyError.indexOf('Thread not found: T7') !== -1, replyError === '' ? 'no error raised' : replyError)
const errState = { repo: 'o/n', pr: 12, headSha: undefined, threads: { TE: { verdict: 'fix', reason: 'real', reply: 'r', sha: 'h' } } }
let errApply = ''
try {
  triage.runApply({
    repo: 'o/n', number: 12, head: 'h',
    items: [{ threadId: 'TE', path: 'a.ts', line: 1, verdict: 'fix', reply: 'r' }],
    state: errState,
    postReply: (threadId, body) => triage.applyReply(threadId, body, () => JSON.stringify({ data: null, errors: [{ message: 'comment rejected' }] })),
    postResolve: () => {},
    save: () => {},
  })
} catch (error) { errApply = error.message }
check('applyReply: errors body keeps the thread unapplied', errApply.indexOf('addPullRequestReviewThreadReply') !== -1 && errState.threads.TE.applied !== true, errApply === '' ? 'no error raised' : errApply)

// 14. state lock: stale lockfiles are preempted, contended locks time out loudly, releases are pid-checked
const lockSandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-lock-'))
const previousLockHome = process.env.DSH_HOME
process.env.DSH_HOME = lockSandbox
try {
  const lockPath = triage.stateFile('o/n', 21) + '.lock'
  mkdirSync(dirname(lockPath), { recursive: true })
  let preemptRan = false
  let preemptError = ''
  try {
    writeFileSync(lockPath, '424242')
    utimesSync(lockPath, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
    triage.withStateLock('o/n', 21, () => { preemptRan = existsSync(lockPath) })
  } catch (error) { preemptError = error.message }
  check('stateLock: stale lockfile is preempted', preemptError === '' && preemptRan === true && existsSync(lockPath) === false, preemptError !== '' ? preemptError : 'ran ' + preemptRan + ', lock remains ' + existsSync(lockPath))
  let contendedError = ''
  const contendedStart = Date.now()
  try {
    writeFileSync(lockPath, '424242')
    triage.withStateLock('o/n', 21, () => {})
  } catch (error) { contendedError = error.message }
  check('stateLock: contended lock times out naming the lock file', contendedError.indexOf('state lock') !== -1 && contendedError.indexOf(lockPath) !== -1, contendedError === '' ? 'no error raised' : contendedError)
  check('stateLock: contention retries before giving up', Date.now() - contendedStart >= 1500, 'waited ' + (Date.now() - contendedStart) + 'ms')
  check('stateLock: a foreign lockfile survives the timeout', existsSync(lockPath) === true, 'lock was removed by the timed-out waiter')
} finally {
  if (previousLockHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousLockHome
  rmSync(lockSandbox, { recursive: true, force: true })
}

// 15. comment counts: totalCount spans the whole thread; the first:20 node window under-reports
let countError = ''
let countQuery = ''
let countItem = null
try {
  const twenty = Array.from({ length: 20 }, (_, i) => comment('n' + i, 'c' + i))
  const countFetch = triage.fetchThreads('o/n', 13, args => {
    countQuery = args.join(' ')
    return JSON.stringify(ghPage([{ id: 'TC', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, firstComments: { totalCount: 34, nodes: twenty }, lastComment: { nodes: [comment('n33', 'latest')] } }], false, null))
  })
  countItem = triage.flattenThreads(countFetch.threads, { repo: 'o/n', pr: 13, threads: {} }, countFetch.head)[0]
} catch (error) { countError = error.message }
check('fetchThreads: query asks for comments.totalCount', countError === '' && countQuery.indexOf('totalCount') !== -1, countError !== '' ? countError : countQuery.slice(0, 200))
check('fetchThreads: comment count reports totalCount past the 20-node window', countItem !== null && countItem.comments === 34, countError !== '' ? countError : JSON.stringify(countItem))

// 16. cross-line comments carry line: null; the draft row must not say "path:undefined"
const nullLineDraft = triage.renderDraft({ repo: 'o/n', number: 14, head: 'h1' }, [{ threadId: 'TN', path: 'a.ts', line: null, body: 'spans several lines' }])
const nullLine = nullLineDraft.split('\n').filter(line => line.indexOf('a.ts') !== -1).join(' | ')
check('renderDraft: null line renders the path as multi-line, not :undefined', nullLine.indexOf('undefined') === -1 && nullLine.indexOf(':null') === -1 && nullLine.indexOf('multi-line') !== -1, nullLine)

// 17. --pr and --limit are integers; junk must die at parse time with a readable usage error
let badPr = ''
try { triage.parseArgs(['state', '--pr', '7.5']) } catch (error) { badPr = error.message }
check('parseArgs: non-integer --pr is rejected', badPr.indexOf('--pr') !== -1 && badPr.indexOf('integer') !== -1, badPr === '' ? 'accepted 7.5' : badPr)
let badLimit = ''
try { triage.parseArgs(['inbox', '--limit', 'abc']) } catch (error) { badLimit = error.message }
check('parseArgs: non-integer --limit is rejected', badLimit.indexOf('--limit') !== -1 && badLimit.indexOf('integer') !== -1, badLimit === '' ? 'accepted abc' : badLimit)
let intParse = ''
try {
  const limit = triage.parseArgs(['inbox', '--limit', '5'])
  const pr = triage.parseArgs(['plan', '--pr', '12'])
  intParse = limit.options.limit === '5' && pr.options.pr === '12' ? 'ok' : 'value changed'
} catch (error) { intParse = error.message }
check('parseArgs: integer --pr/--limit still parse to strings', intParse === 'ok', intParse)
let fracExit = 0
let fracStderr = ''
try {
  execFileSync(process.execPath, [tool, 'state', '--repo', 'o/n', '--pr', '7.5'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) { fracExit = error.status; fracStderr = error.stderr }
check('state --pr 7.5 refuses to run', fracExit !== 0 && fracStderr.indexOf('integer') !== -1, 'exit ' + fracExit + ' stderr ' + fracStderr.trim())

// 18. win32 folds path case: the same repo written in two spellings must reuse the one on-disk dir
if (process.platform !== 'win32') {
  checks.push('stateFile: case-variant repo spellings reuse the on-disk dir (skipped: not win32)')
} else {
  const caseSandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-case-'))
  const previousCaseHome = process.env.DSH_HOME
  process.env.DSH_HOME = caseSandbox
  try {
    const upper = triage.saveState('Acme/Widget', 5, { repo: 'Acme/Widget', pr: 5, headSha: 'h5', threads: { T1: { verdict: 'fix', reason: 'real' } } })
    const lower = triage.saveState('acme/widget', 5, { repo: 'acme/widget', pr: 5, headSha: 'h6', threads: { T1: { verdict: 'dismiss', reason: 'nit' } } })
    const caseDirs = readdirSync(join(caseSandbox, 'review-triage'))
    check('stateFile: case-variant spellings share one state dir', caseDirs.length === 1 && dirname(lower).toLowerCase() === dirname(upper).toLowerCase(), 'dirs: ' + caseDirs.join(','))
    const reused = triage.stateFile('ACME/WIDGET', 5)
    check('stateFile: later calls reuse the on-disk spelling', dirname(reused) === dirname(upper), dirname(reused) + ' vs on-disk ' + dirname(upper))
    const reread = JSON.parse(readFileSync(reused, 'utf8'))
    check('stateFile: the reused spelling serves the latest state', reread.threads.T1.verdict === 'dismiss', JSON.stringify(reread.threads))
  } finally {
    if (previousCaseHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousCaseHome
    rmSync(caseSandbox, { recursive: true, force: true })
  }
}

// 19. inbox stale: judge against the head fetchThreads just returned, not the older pr-list head
const staleSandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-stale-'))
const previousStaleHome = process.env.DSH_HOME
process.env.DSH_HOME = staleSandbox
try {
  // Recorded against the fresh head the GraphQL fetch reports; the pr-list row still carries an older sha.
  triage.saveState('acme/widget', 7, { repo: 'acme/widget', pr: 7, headSha: 'head-sha', threads: { T1: { verdict: 'fix', reason: 'real', reply: 'r', sha: 'head-sha' } } })
  const staleLines = []
  const realLog = console.log
  console.log = line => staleLines.push(String(line))
  let staleError = ''
  try {
    triage.cmdInbox({ repo: 'acme/widget', limit: '5', json: true }, args => {
      if (args[0] === 'api') return JSON.stringify(ghPage([injectedThread('T1', [comment('bot', 'x')], [comment('bot', 'x')])], false, null))
      return JSON.stringify([{ number: 7, title: 't', url: 'u', headRefOid: 'older-list-sha' }])
    })
  } catch (error) { staleError = error.message } finally { console.log = realLog }
  let staleRows = null
  try { staleRows = staleLines.filter(Boolean).map(line => JSON.parse(line)) } catch { staleRows = null }
  check('inbox: pending judges against the fetched head, not the pr-list head', staleError === '' && staleRows !== null && staleRows.length === 1 && staleRows[0].open === 1 && staleRows[0].pending === 0, staleError !== '' ? staleError : JSON.stringify(staleRows))
} finally {
  if (previousStaleHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousStaleHome
  rmSync(staleSandbox, { recursive: true, force: true })
}

for (const line of failures) console.error('FAIL  ' + line)
if (failures.length > 0) {
  console.error('\n' + failures.length + ' failure(s), ' + checks.length + ' check(s) passed')
  process.exit(1)
}
console.log('ok -- ' + checks.length + ' checks: review-triage skill, tool selftest, presets, registration matrix, summary view, manifest, patch, inbox repo passthrough, entry guard, applyReply validation, state lock, apply pending dedupe, comment totalCount, null-line draft, integer flags, slug case reuse, inbox stale head')

