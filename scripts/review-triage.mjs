#!/usr/bin/env node
/**
 * Review-thread triage: the forge-side replacement for Cursor's Bugbot loop.
 *
 * Upstream pstack ships a decision rubric (skills/poteto-mode/references/bugbot-triage.md)
 * but no way to read or answer the threads it classifies. This tool closes that loop
 * with the GitHub CLI: list, plan, record a verdict, draft the replies, and -- only in
 * apply mode -- post and resolve them.
 *
 * Modes
 *   propose (default)  write state and drafts; never touches the pull request
 *   apply              reply + resolve (ask verdicts are replied but not resolved); requires --yes AND PSTACK_REVIEW_APPLY=1
 *
 * Commands
 *   inbox  [--repo o/n] [--limit N] [--json]
 *   plan   --pr N [--repo o/n] [--all]
 *   record --pr N --thread ID --verdict fix|dismiss|ask --reason TEXT [--reply TEXT]
 *   draft  --pr N [--repo o/n] [--out FILE]
 *   apply  --pr N [--repo o/n] [--thread ID] --yes
 *   state  --pr N [--repo o/n]
 *   selftest
 *
 * Idempotency: a verdict records the head SHA it was made against. When the head
 * moves, the thread is reported as stale and must be re-classified; apply skips
 * stale threads. DSH webhook deliveries carry no dedupe state, so this file is it.
 */
import { execFileSync } from 'node:child_process'
import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERDICTS = ['fix', 'dismiss', 'ask']
const APPLY_ENV = 'PSTACK_REVIEW_APPLY'

function fail(message) {
  console.error('review-triage: ' + message)
  process.exit(1)
}

// Flags that carry no value.
const BOOLEAN_FLAGS = ['help', 'yes', 'json', 'all']
// Flags that carry a value; any other --flag is rejected as unknown.
const VALUE_FLAGS = ['pr', 'repo', 'thread', 'verdict', 'reason', 'reply', 'out', 'limit']

export function parseArgs(argv) {
  if (argv.some(token => token === '-h' || token === '--help')) return { command: 'help', options: {} }
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token.slice(0, 2) !== '--') throw new Error('unexpected argument: ' + token)
    const key = token.slice(2)
    if (!VALUE_FLAGS.includes(key) && !BOOLEAN_FLAGS.includes(key)) throw new Error('unknown argument: --' + key + '\n' + HELP)
    const next = rest[index + 1]
    if (!VALUE_FLAGS.includes(key)) { options[key] = true; continue }
    if (next === undefined || next.slice(0, 2) === '--') throw new Error('--' + key + ' needs a value')
    options[key] = next
    index += 1
  }
  return { command, options }
}

function dshHome() {
  return process.env.DSH_HOME === undefined ? join(homedir(), '.dsh') : process.env.DSH_HOME
}

export function stateFile(repo, pr) {
  const slug = String(repo).replace(/[^A-Za-z0-9._-]+/g, '__')
  if (slug === '.' || slug === '..') throw new Error('unsafe repo slug: ' + String(repo))
  return join(dshHome(), 'review-triage', slug, 'pr-' + pr + '.json')
}

function loadState(repo, pr) {
  const file = stateFile(repo, pr)
  if (!existsSync(file)) return { repo, pr, headSha: undefined, threads: {} }
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function saveState(repo, pr, state) {
  const file = stateFile(repo, pr)
  mkdirSync(dirname(file), { recursive: true })
  // Same-directory temp + rename: readers never see a half-written state file.
  const temp = join(dirname(file), basename(file) + '.' + process.pid + '.tmp')
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n')
  renameSync(temp, file)
  return file
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim() !== '' ? error.stderr.trim() : error.message
    throw new Error('gh ' + args.slice(0, 2).join(' ') + ' failed: ' + detail)
  }
}

function resolveRepo(options) {
  if (typeof options.repo === 'string') return options.repo
  try {
    return gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
  } catch (error) {
    throw new Error('cannot infer the repository; pass --repo owner/name (' + error.message + ')')
  }
}

const THREADS_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!,$cursor:String){',
  '  repository(owner:$owner,name:$name){',
  '    pullRequest(number:$number){',
  '      headRefOid title url',
  '      reviewThreads(first:100,after:$cursor){',
  '        pageInfo{hasNextPage endCursor}',
  '        nodes{ id isResolved isOutdated path line',
  '          firstComments:comments(first:20){nodes{author{login} body createdAt url}}',
  '          lastComment:comments(last:1){nodes{author{login} body createdAt url}} }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n')

export function fetchThreads(repo, number, ghFn = gh) {
  const parts = String(repo).split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') throw new Error('repo must be owner/name: ' + repo)
  const nodes = []
  let cursor = null
  let head
  let title
  let url
  let truncated = true
  for (let page = 0; page < 20; page += 1) {
    const args = ['api', 'graphql', '-f', 'query=' + THREADS_QUERY, '-f', 'owner=' + parts[0], '-f', 'name=' + parts[1], '-F', 'number=' + number]
    if (cursor !== null) args.push('-f', 'cursor=' + cursor)
    const parsed = JSON.parse(ghFn(args))
    const pr = parsed.data && parsed.data.repository && parsed.data.repository.pullRequest
    if (pr === null || pr === undefined) throw new Error('pull request not found: ' + repo + '#' + number)
    if (pr.reviewThreads === null || pr.reviewThreads === undefined) throw new Error('unexpected GraphQL response for ' + repo + '#' + number + ': missing reviewThreads')
    if (!Array.isArray(pr.reviewThreads.nodes)) throw new Error('unexpected GraphQL response for ' + repo + '#' + number + ': reviewThreads.nodes is not an array')
    head = pr.headRefOid
    title = pr.title
    url = pr.url
    for (const node of pr.reviewThreads.nodes) nodes.push(node)
    if (pr.reviewThreads.pageInfo.hasNextPage !== true) { truncated = false; break }
    cursor = pr.reviewThreads.pageInfo.endCursor
  }
  if (truncated) throw new Error('review threads on ' + repo + '#' + number + ' hit the 20-page (2000-thread) fetch cap with more pages remaining; aborting instead of silently truncating the list')
  return { repo, number, head, title, url, threads: nodes }
}

export function flattenThreads(threads, state, head) {
  return threads.map(thread => {
    const record = state.threads[thread.id] || {}
    const firstComments = (thread.firstComments && thread.firstComments.nodes) || []
    const first = firstComments[0] || {}
    // lastComment(last:1) is the true final comment even past the 20-comment window.
    const lastNodes = (thread.lastComment && thread.lastComment.nodes) || []
    const last = lastNodes.length === 0 ? {} : lastNodes[lastNodes.length - 1]
    const stale = record.sha !== undefined && head !== undefined && record.sha !== head
    return {
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      resolved: thread.isResolved === true,
      outdated: thread.isOutdated === true,
      author: first.author === undefined || first.author === null ? undefined : first.author.login,
      url: first.url,
      comments: firstComments.length,
      body: typeof first.body === 'string' ? first.body : '',
      lastAuthor: last.author === undefined || last.author === null ? undefined : last.author.login,
      verdict: record.verdict,
      reason: record.reason,
      reply: record.reply,
      applied: record.applied === true,
      stale,
      recordedSha: record.sha,
      headSha: head,
    }
  })
}

export function renderDraft(pullRequest, items) {
  const lines = []
  lines.push('## Review triage: ' + pullRequest.repo + '#' + pullRequest.number)
  lines.push('')
  lines.push('Head: ' + pullRequest.head)
  lines.push('Threads: ' + items.length)
  lines.push('')
  const byVerdict = { fix: [], dismiss: [], ask: [], unclassified: [] }
  for (const item of items) {
    const key = VERDICTS.includes(item.verdict) ? item.verdict : 'unclassified'
    byVerdict[key].push(item)
  }
  for (const verdict of ['fix', 'dismiss', 'ask', 'unclassified']) {
    const group = byVerdict[verdict]
    if (group.length === 0) continue
    lines.push('### ' + verdict + ' (' + group.length + ')')
    lines.push('')
    for (const item of group) {
      const where = item.path === undefined ? '(file unknown)' : item.path + ':' + String(item.line)
      // Surrogate-safe slice; escape ``` so an excerpt can never open an unclosed fence.
      const excerpt = Array.from(item.body.split('\n')[0] || '(empty comment)').slice(0, 160).join('').replace(/```/g, '\\`\\`\\`')
      lines.push('- ' + where + ' -- ' + excerpt)
      if (item.reason !== undefined) lines.push('  - why: ' + item.reason)
      if (item.reply !== undefined) lines.push('  - reply: ' + item.reply)
      if (item.stale === true) lines.push('  - stale: recorded against ' + String(item.recordedSha).slice(0, 12) + ', head is ' + String(item.headSha).slice(0, 12))
      if (item.url !== undefined) lines.push('  - ' + item.url)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function cmdInbox(options) {
  const limit = options.limit === undefined ? 10 : Number(options.limit)
  const base = ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,url,headRefOid']
  const mine = JSON.parse(gh(base.concat(['--author', '@me'])))
  const review = JSON.parse(gh(base.concat(['--search', 'review-requested:@me'])))
  const seen = new Set()
  const rows = []
  for (const pr of mine.concat(review)) {
    if (seen.has(pr.number)) continue
    seen.add(pr.number)
    rows.push(pr)
  }
  const report = []
  const repo = resolveRepo(options)
  for (const pr of rows) {
    let threads = []
    try {
      const state = loadState(repo, pr.number)
      threads = flattenThreads(fetchThreads(repo, pr.number).threads, state, pr.headRefOid)
    } catch (error) {
      report.push({ number: pr.number, title: pr.title, error: error.message })
      continue
    }
    const open = threads.filter(thread => thread.resolved !== true)
    const pending = open.filter(thread => thread.verdict === undefined || thread.stale === true)
    report.push({ number: pr.number, title: pr.title, url: pr.url, open: open.length, pending: pending.length })
  }
  if (options.json === true) { for (const row of report) console.log(JSON.stringify(row)); return }
  for (const row of report) {
    if (row.error !== undefined) { console.log('#' + row.number + '  ERROR  ' + row.error); continue }
    console.log('#' + row.number + '  open=' + row.open + '  pending=' + row.pending + '  ' + row.title)
  }
  if (report.length === 0) console.log('no open pull requests')
}

function cmdPlan(options) {
  if (options.pr === undefined) fail('plan needs --pr')
  const repo = resolveRepo(options)
  const number = Number(options.pr)
  const fetched = fetchThreads(repo, number)
  const state = loadState(repo, number)
  let items = flattenThreads(fetched.threads, state, fetched.head)
  if (options.all !== true) items = items.filter(item => item.resolved !== true)
  for (const item of items) console.log(JSON.stringify(item))
  console.error('plan: ' + items.length + ' thread(s) on ' + repo + '#' + number + ' at ' + String(fetched.head).slice(0, 12))
}

function cmdRecord(options) {
  if (options.pr === undefined || options.thread === undefined || options.verdict === undefined) fail('record needs --pr, --thread, --verdict')
  if (!VERDICTS.includes(options.verdict)) fail('verdict must be one of ' + VERDICTS.join(', '))
  if (typeof options.reason !== 'string' || options.reason.trim() === '') fail('record needs a non-empty --reason')
  const repo = resolveRepo(options)
  const number = Number(options.pr)
  const state = loadState(repo, number)
  const fetched = fetchThreads(repo, number)
  if (!fetched.threads.some(thread => thread.id === options.thread)) fail('thread not found on ' + repo + '#' + number + ': ' + options.thread)
  state.headSha = fetched.head
  state.threads[options.thread] = {
    verdict: options.verdict,
    reason: options.reason,
    reply: typeof options.reply === 'string' ? options.reply : state.threads[options.thread] && state.threads[options.thread].reply,
    sha: fetched.head,
    at: new Date().toISOString(),
    applied: false,
  }
  const file = saveState(repo, number, state)
  console.log('recorded ' + options.verdict + ' for ' + options.thread + ' -> ' + file)
}

function cmdDraft(options) {
  if (options.pr === undefined) fail('draft needs --pr')
  const repo = resolveRepo(options)
  const number = Number(options.pr)
  const fetched = fetchThreads(repo, number)
  const state = loadState(repo, number)
  const items = flattenThreads(fetched.threads, state, fetched.head).filter(item => item.resolved !== true)
  const markdown = renderDraft(fetched, items)
  if (typeof options.out === 'string') {
    writeFileSync(options.out, markdown + '\n')
    console.log('wrote ' + options.out + ' (' + items.length + ' thread(s))')
    return
  }
  process.stdout.write(markdown + '\n')
}

function applyReply(threadId, body) {
  const mutation = [
    'mutation($thread:ID!,$body:String!){',
    '  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){',
    '    comment{ url }',
    '  }',
    '}',
  ].join('\n')
  return JSON.parse(gh(['api', 'graphql', '-f', 'query=' + mutation, '-f', 'thread=' + threadId, '-f', 'body=' + body]))
}

function applyResolve(threadId) {
  const mutation = [
    'mutation($thread:ID!){',
    '  resolveReviewThread(input:{threadId:$thread}){ thread{ isResolved } }',
    '}',
  ].join('\n')
  const parsed = JSON.parse(gh(['api', 'graphql', '-f', 'query=' + mutation, '-f', 'thread=' + threadId]))
  const thread = parsed && parsed.data && parsed.data.resolveReviewThread && parsed.data.resolveReviewThread.thread
  if (thread === null || thread === undefined || thread.isResolved !== true) {
    throw new Error('resolveReviewThread did not confirm isResolved for thread ' + threadId + ', got: ' + JSON.stringify(thread === undefined ? null : thread))
  }
  return parsed
}

export function runApply({ repo, number, head, items, state, postReply, postResolve, save }) {
  state.headSha = head
  for (const item of items) {
    postReply(item.threadId, item.reply)
    if (item.verdict !== 'ask') postResolve(item.threadId)
    state.threads[item.threadId] = Object.assign({}, state.threads[item.threadId], { applied: true, appliedAt: new Date().toISOString(), appliedSha: head })
    save(repo, number, state)
    console.log('applied ' + item.threadId + ' (' + String(item.path) + ':' + String(item.line) + ')')
  }
}

function cmdApply(options) {
  if (process.env[APPLY_ENV] !== '1') fail('apply mode is off; set ' + APPLY_ENV + '=1 and pass --yes to post replies')
  if (options.yes !== true) fail('apply needs --yes')
  if (options.pr === undefined) fail('apply needs --pr')
  const repo = resolveRepo(options)
  const number = Number(options.pr)
  const fetched = fetchThreads(repo, number)
  const state = loadState(repo, number)
  const items = flattenThreads(fetched.threads, state, fetched.head)
  const targets = items.filter(item => {
    if (item.resolved === true) return false
    if (options.thread !== undefined && item.threadId !== options.thread) return false
    if (item.applied === true) return false
    if (item.stale === true) return false
    if (typeof item.reply !== 'string' || item.reply.trim() === '') return false
    return true
  })
  if (targets.length === 0) { console.log('nothing to apply'); return }
  runApply({ repo, number, head: fetched.head, items: targets, state, postReply: applyReply, postResolve: applyResolve, save: saveState })
}

function cmdState(options) {
  if (options.pr === undefined) fail('state needs --pr')
  const repo = resolveRepo(options)
  console.log(JSON.stringify(loadState(repo, Number(options.pr)), null, 2))
}

function selftest() {
  const sandbox = mkdtempSync(join(tmpdir(), 'review-triage-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = sandbox
  try {
    const threads = [
      { id: 'T1', isResolved: false, isOutdated: false, path: 'a.ts', line: 3, firstComments: { nodes: [{ author: { login: 'bot' }, body: 'race condition?', url: 'u1' }] }, lastComment: { nodes: [{ author: { login: 'bot' }, body: 'race condition?', url: 'u1' }] } },
      { id: 'T2', isResolved: true, isOutdated: true, path: 'b.ts', line: 9, firstComments: { nodes: [{ author: { login: 'bot' }, body: 'nit', url: 'u2' }, { author: { login: 'dev' }, body: 'fixed' }] }, lastComment: { nodes: [{ author: { login: 'dev' }, body: 'fixed' }] } },
    ]
    const state = { repo: 'o/n', pr: 7, headSha: 'aaa', threads: { T1: { verdict: 'fix', reason: 'real', reply: 'good catch', sha: 'aaa' }, T2: { verdict: 'dismiss', reason: 'nit', reply: 'intentional', sha: 'zzz' } } }
    const items = flattenThreads(threads, state, 'bbb')
    assert.equal(items.length, 2)
    assert.equal(items[0].verdict, 'fix')
    assert.equal(items[0].stale, true, 'T1 was recorded at aaa but head is bbb')
    assert.equal(items[1].resolved, true)
    assert.equal(items[1].comments, 2)
    assert.equal(items[1].lastAuthor, 'dev')
    const draft = renderDraft({ repo: 'o/n', number: 7, head: 'bbb' }, items)
    assert.ok(draft.indexOf('### fix (1)') !== -1)
    assert.ok(draft.indexOf('### dismiss (1)') !== -1)
    const saved = saveState('o/n', 7, state)
    assert.ok(existsSync(saved))
    assert.deepEqual(loadState('o/n', 7).threads.T1.reason, 'real')
    assert.ok(saved.indexOf('review-triage') !== -1)
    assert.deepEqual(parseArgs(['apply', '--pr', '7', '--yes', '--json']).options, { pr: '7', yes: true, json: true })
    let missingValue = ''
    try { parseArgs(['apply', '--thread', '--yes']) } catch (error) { missingValue = error.message }
    assert.equal(missingValue, '--thread needs a value')
    const calls = { replies: [], resolves: [], saves: 0 }
    const applyState = { repo: 'o/n', pr: 7, threads: {} }
    runApply({
      repo: 'o/n', number: 7, head: 'bbb',
      items: [
        { threadId: 'T1', path: 'a.ts', line: 3, verdict: 'fix', reply: 'good catch' },
        { threadId: 'T2', path: 'c.ts', line: 5, verdict: 'ask', reply: 'which race?' },
      ],
      state: applyState,
      postReply: threadId => calls.replies.push(threadId),
      postResolve: threadId => calls.resolves.push(threadId),
      save: () => { calls.saves += 1 },
    })
    assert.deepEqual(calls.replies, ['T1', 'T2'])
    assert.deepEqual(calls.resolves, ['T1'], 'ask threads are answered but not resolved')
    assert.equal(applyState.threads.T1.applied, true)
    assert.equal(applyState.threads.T2.applied, true)
    assert.equal(calls.saves, 2)
    assert.equal(applyState.headSha, 'bbb')
    console.log('selftest ok: flatten, stale detection, draft rendering, state round-trip, apply engine, parseArgs')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(sandbox, { recursive: true, force: true })
  }
}

const HELP = [
  'review-triage <command> [options]',
  '',
  '  inbox  [--repo o/n] [--limit N] [--json]',
  '  plan   --pr N [--repo o/n] [--all]',
  '  record --pr N --thread ID --verdict fix|dismiss|ask --reason TEXT [--reply TEXT]',
  '  draft  --pr N [--repo o/n] [--out FILE]',
  '  apply  --pr N [--repo o/n] [--thread ID] --yes   (needs PSTACK_REVIEW_APPLY=1)',
  '  state  --pr N [--repo o/n]',
  '  selftest',
].join('\n')

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'help' || options.help === true) { console.log(HELP); return }
  if (command === 'selftest') { selftest(); return }
  if (command === 'inbox') { cmdInbox(options); return }
  if (command === 'plan') { cmdPlan(options); return }
  if (command === 'record') { cmdRecord(options); return }
  if (command === 'draft') { cmdDraft(options); return }
  if (command === 'apply') { cmdApply(options); return }
  if (command === 'state') { cmdState(options); return }
  fail('unknown command: ' + command + '\n' + HELP)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { fail(error.message) }
}

