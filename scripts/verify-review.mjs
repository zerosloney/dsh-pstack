#!/usr/bin/env node
/** Gate for the review-triage capability: skill contract, tool selftest, presets, summary view. */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const selftest = execFileSync(process.execPath, [tool, 'selftest'], { encoding: 'utf8' })
check('review-triage selftest', selftest.indexOf('selftest ok') !== -1, selftest.trim())
const help = execFileSync(process.execPath, [tool, 'help'], { encoding: 'utf8' })
for (const command of ['inbox', 'plan', 'record', 'draft', 'apply', 'state']) {
  check('review-triage lists ' + command, help.indexOf(command) !== -1)
}

// 3. presets
const { buildReviewPresets } = await import(pathToFileURL(join(ROOT, 'presets-review.mjs')).href)
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

// 4. index registration matrix
const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
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
let rejected = false
try { await applyPlugin(stubContext(), { reviewTriage: { apply: 'yes' } }) } catch { rejected = true }
check('config rejects a non-boolean apply', rejected)

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
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('manifest: presets-review.mjs shipped', manifest.files.indexOf('presets-review.mjs') !== -1)
check('manifest: test runs both gates', manifest.scripts.test.indexOf('verify-review.mjs') !== -1)
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
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
let applyError
try {
  triage.runApply({
    repo: 'o/n', number: 7, head: applyHead,
    items: [
      { threadId: 'T1', path: 'a.ts', line: 3, verdict: 'fix', reply: 'r1' },
      { threadId: 'T2', path: 'b.ts', line: 9, verdict: 'fix', reply: 'r2' },
    ],
    state: applyState,
    postReply: threadId => { posted.push(threadId); if (threadId === 'T2') throw new Error('gh down') },
    postResolve: threadId => resolved.push(threadId),
    save: (repo, number, state) => savedSnapshots.push({ repo, number, first: state.threads.T1.applied === true, second: state.threads.T2.applied === true }),
  })
} catch (error) { applyError = error }
check('runApply: post failure reaches the caller', applyError !== undefined && applyError.message === 'gh down', applyError === undefined ? 'no error' : applyError.message)
check('runApply: saves once, right after the first thread', savedSnapshots.length === 1 && savedSnapshots[0].first === true && savedSnapshots[0].second === false, JSON.stringify(savedSnapshots))
check('runApply: first thread persisted before the second was posted', posted.join(',') === 'T1,T2' && savedSnapshots.length === 1, 'posted ' + posted.join(',') + ' saved ' + savedSnapshots.length)
check('runApply: state keeps applied on T1 only', applyState.threads.T1.applied === true && applyState.threads.T2.applied === undefined && applyState.headSha === applyHead)
const resumed = []
try {
  triage.runApply({
    repo: 'o/n', number: 7, head: applyHead,
    items: [{ threadId: 'T2', path: 'b.ts', line: 9, verdict: 'fix', reply: 'r2' }],
    state: applyState,
    postReply: threadId => { posted.push(threadId); resumed.push(threadId) },
    postResolve: threadId => resolved.push(threadId),
    save: () => {},
  })
} catch (error) { applyError = error }
check('runApply: rerun finishes T2 without repeating T1', resumed.join(',') === 'T2' && posted.filter(id => id === 'T1').length === 1 && applyState.threads.T2.applied === true && resolved.join(',') === 'T1,T2', 'posted ' + posted.join(','))
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
check('runApply: ask still records applied', t3.applied === true && askCalls.saves === 1, JSON.stringify(t3))
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
  check('stateFile: ".." slug rejected', dotdot !== '' && dotdot.indexOf('..') !== -1, dotdot === '' ? 'accepted' : dotdot)

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

for (const line of failures) console.error('FAIL  ' + line)
if (failures.length > 0) {
  console.error('\n' + failures.length + ' failure(s), ' + checks.length + ' check(s) passed')
  process.exit(1)
}
console.log('ok -- ' + checks.length + ' checks: review-triage skill, tool selftest, presets, registration matrix, summary view, manifest, patch')

