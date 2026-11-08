#!/usr/bin/env node
/**
 * Static + unit gate for the dsh-pstack bundle. No dependencies, no network.
 *
 * The Host validates the Cordis patch at load time; this script covers what can
 * be checked before installing: the skill frontmatter contract DSH's filesystem
 * provider enforces, the adapter wiring, and the router plugin's behavior.
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

// PSTACK_ROOT points the gate at another copy, which is what a mutation worker
// needs: the worker links this script, so import.meta.url resolves to the real tree.
const ROOT = process.env.PSTACK_ROOT === undefined
  ? dirname(dirname(fileURLToPath(import.meta.url)))
  : resolve(process.env.PSTACK_ROOT)
const failures = []
const checks = []

function check(name, condition, detail = '') {
  if (condition) { checks.push(name); return }
  failures.push(detail === '' ? name : `${name} — ${detail}`)
}

function fail(message) {
  failures.push(message)
}

/** Parse the leading `---` block into top-level scalar keys. */
function frontmatter(text, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) { fail(`${label}: missing frontmatter`); return undefined }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (entry === null) continue
    let value = entry[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    data[entry[1]] = value
  }
  return data
}

// --- 1. skills: the contract dsh-skill-filesystem enforces -------------------

const SKILLS = join(ROOT, 'skills')
const LEGACY_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
const skillNames = new Set()
const skillDirs = readdirSync(SKILLS, { withFileTypes: true }).filter(entry => entry.isDirectory())

for (const entry of skillDirs) {
  const file = join(SKILLS, entry.name, 'SKILL.md')
  const label = `skills/${entry.name}/SKILL.md`
  if (!existsSync(file)) { fail(`${label}: not a directory bundle (no SKILL.md)`); continue }
  const data = frontmatter(readFileSync(file, 'utf8'), label)
  if (data === undefined) continue
  check(`${label}: name matches directory`, data.name === entry.name, `frontmatter name is ${String(data.name)}`)
  check(`${label}: non-empty description`, typeof data.description === 'string' && data.description.length > 0)
  check(`${label}: no legacy invocation keys`, !LEGACY_KEYS.some(key => key in data))
  if ('disable-model-invocation' in data) {
    check(`${label}: boolean disable-model-invocation`, data['disable-model-invocation'] === 'true' || data['disable-model-invocation'] === 'false')
  }
  if (skillNames.has(data.name)) fail(`${label}: duplicate skill name ${String(data.name)}`)
  skillNames.add(data.name)
}

// A floor count cannot catch a deleted or renamed directory, so the exact bundle
// is pinned here: 58 upstream skills + review-triage (added by this port).
const PINNED_SKILLS = [
  'architect', 'arena', 'automate-me', 'benchmark-checklist', 'blast-radius',
  'bro', 'correct', 'create-formal-verification-skill', 'create-verification-skill',
  'figure-it-out', 'how', 'in-your-own-words', 'interrogate', 'ketchup', 'ketchup-video',
  'maintain-formal-verification-skill', 'maintain-verification-skill', 'make-bot-ui',
  'no-comments', 'poteto-help', 'poteto-mode', 'principle-attack-the-premise',
  'principle-boundary-discipline', 'principle-build-the-lever', 'principle-encode-lessons-in-structure',
  'principle-exhaust-the-design-space', 'principle-experience-first', 'principle-explain-the-number',
  'principle-fix-root-causes', 'principle-foundational-thinking', 'principle-guard-the-context-window',
  'principle-laziness-protocol', 'principle-make-operations-idempotent',
  'principle-migrate-callers-then-delete-legacy-apis', 'principle-minimize-reader-load',
  'principle-model-the-domain', 'principle-never-block-on-the-human', 'principle-outcome-oriented-execution',
  'principle-prove-it-works', 'principle-redesign-from-first-principles',
  'principle-separate-before-serializing-shared-state', 'principle-sequence-verifiable-units',
  'principle-subtract-before-you-add', 'principle-test-behavior-not-implementation',
  'principle-type-system-discipline', 'recall', 'reflect', 'review-triage', 'setup-pstack',
  'sharpen', 'show-me-your-work', 'statechart', 'swarm', 'tdd', 'teach', 'technical-writing',
  'typescript-best-practices', 'unslop', 'why',
]
const portedSkills = skillDirs.map(entry => entry.name)
const missingSkills = PINNED_SKILLS.filter(name => !portedSkills.includes(name))
const extraSkills = portedSkills.filter(name => !PINNED_SKILLS.includes(name))
check('skills: directory matches the pinned 59-skill list exactly',
  missingSkills.length === 0 && extraSkills.length === 0,
  `missing: [${missingSkills.join(', ')}] extra: [${extraSkills.join(', ')}]`)
for (const principle of ['fix-root-causes', 'prove-it-works', 'guard-the-context-window']) {
  check(`skills: principle-${principle} present`, skillNames.has(`principle-${principle}`))
}
check('skills: poteto-mode hidden from model invocation',
  frontmatter(readFileSync(join(SKILLS, 'poteto-mode', 'SKILL.md'), 'utf8'), 'poteto-mode')?.['disable-model-invocation'] === 'true')

// --- 2. agents: shipped briefs, not skill-bundle entries ---------------------

for (const agent of ['poteto-agent', 'comment-sicko']) {
  const file = join(ROOT, 'agents', `${agent}.md`)
  if (!existsSync(file)) { fail(`agents/${agent}.md: missing`); continue }
  const data = frontmatter(readFileSync(file, 'utf8'), `agents/${agent}.md`)
  if (data === undefined) continue
  check(`agents/${agent}.md: name`, data.name === agent, `frontmatter name is ${String(data.name)}`)
  check(`agents/${agent}.md: description`, typeof data.description === 'string' && data.description.length > 0)
}

// --- 3. adapter wiring -------------------------------------------------------

const ADAPTER = join(ROOT, 'docs', 'harness', 'deepseek-harness.md')
check('adapter document exists', existsSync(ADAPTER) && statSync(ADAPTER).size > 1000)
const adapterText = existsSync(ADAPTER) ? readFileSync(ADAPTER, 'utf8') : ''
for (const heading of ['## Orchestration this deployment provides', '## Tools', '## Paths and state', '## Subagent briefs', '## Model routing', '## What stays degraded']) {
  check(`adapter: ${heading} section`, adapterText.includes(heading))
}
check('adapter: warns against the skill tool for hidden skills', adapterText.includes('Do not use `skill`'))
check('adapter: maps the model rule file', adapterText.includes('~/.cursor/rules/pstack-models.mdc') && adapterText.includes('~/.dsh/AGENTS.md'))
check('adapter: maps transcripts to the helper', adapterText.includes('session.v4.jsonl.zstd') && adapterText.includes('scripts/session-transcript.mjs'))
check('adapter: names the preset personas', adapterText.includes('`agent_preset: "poteto-agent"`') && adapterText.includes('`agent_preset: "comment-sicko"`'))
check('adapter: maps skill write roots', adapterText.includes('.dsh/skills/') && adapterText.includes('~/.agents/skills/'))
check('adapter: forbids Cursor model slugs', adapterText.includes('Never write a Cursor slug'))
const poteto = readFileSync(join(SKILLS, 'poteto-mode', 'SKILL.md'), 'utf8')
check('poteto-mode points at the adapter', poteto.includes('docs/harness/deepseek-harness.md'))

const routerText = readFileSync(join(ROOT, 'router.md'), 'utf8')
check('router: adapter placeholder once', (routerText.match(/\{\{adapter\}\}/g) ?? []).length === 1)
check('router: playbook placeholder once', (routerText.match(/\{\{potetoMode\}\}/g) ?? []).length === 1)
check('router: reads the playbook instead of the skill tool', routerText.includes('Do not reach for the `skill` tool'))
check('router: covers direct skill entry', routerText.includes('including the ones you enter directly'))
check('router: names poteto-mode', routerText.includes('poteto-mode'))

// --- 4. manifest and patch ---------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('manifest: name', manifest.name === 'dsh-pstack')
check('manifest: bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('manifest: patch file exists', existsSync(join(ROOT, 'cordis.patch.yml')))
check('manifest: icon export', manifest.exports?.['./icon'] === './icon.svg' && existsSync(join(ROOT, 'icon.svg')))
check('manifest: locale export', typeof manifest.exports?.['./locale/*.json'] === 'string')
for (const file of ['index.js', 'presets.mjs', 'presets-review.mjs', 'router.md', 'presets/', 'cordis.patch.yml', 'skills/', 'agents/', 'docs/', 'automations/', 'scripts/', 'locale/', 'icon.svg', 'README.md', 'COMPATIBILITY.md', 'NOTICE.md', 'LICENSE']) {
  check(`manifest: files covers ${file}`, (manifest.files ?? []).some(entry => entry === file || entry === `${file}/`))
}
for (const locale of ['en', 'zh']) {
  const meta = JSON.parse(readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf8'))
  check(`locale/${locale}.json: meta title`, typeof meta.meta?.title === 'string' && meta.meta.title.length > 0)
  check(`locale/${locale}.json: meta description`, typeof meta.meta?.description === 'string' && meta.meta.description.length > 0)
}

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check('patch: inserts pstack-router', patch.includes('id: pstack-router') && patch.includes("name: 'dsh-pstack'"))
check('patch: inserts pstack-skills', patch.includes('id: pstack-skills') && patch.includes("@deepseek-ai/dsh-skill-filesystem"))
check('patch: single provider instance', (patch.match(/^ {4}- id: /gm) ?? []).length === 2)
check('patch: pstack provider name', patch.includes('providerName: pstack'))
check('patch: default roots disabled', patch.includes('includeDefaultRoots: false'))
check('patch: resolves its own skills dir', patch.includes("resolve('dsh-pstack/package.json')") && patch.includes("'skills')"))
check('patch: new sessions default to the pstack preset', /^- id: agent-preset-registry$/m.test(patch) && /^\s+default: pstack$/m.test(patch))

// --- 5. orchestration presets ------------------------------------------------

const { buildPresets, SUBAGENT_PRESET_IDS } = await import(pathToFileURL(join(ROOT, 'presets.mjs')).href)
const presets = buildPresets({ root: ROOT })
const byId = new Map(presets.map(preset => [preset.id, preset]))
check('presets: three declared', presets.length === 3 && ['pstack', 'poteto-agent', 'comment-sicko'].every(id => byId.has(id)))

const flatten = rows => rows.flatMap(row => row.group === true ? flatten(row.config) : [row])

for (const preset of presets) {
  const flat = flatten(preset.plugins)
  const ids = flat.map(row => row.id)
  check(`preset ${preset.id}: plugin ids unique`, new Set(ids).size === ids.length)
  check(`preset ${preset.id}: every row names a plugin`, flat.every(row => typeof row.name === 'string' && row.name.length > 0))
  check(`preset ${preset.id}: package names are shipped scopes`,
    flat.every(row => row.name === 'cordis:group' || row.name.startsWith('@deepseek-ai/')))
}
// One shell per host: the delegation presets must not mount both.
const windowsHost = process.platform === 'win32'
for (const id of ['poteto-agent', 'comment-sicko']) {
  const flat = flatten(byId.get(id).plugins)
  const bash = flat.find(row => row.id === 'tool-bash')
  const pwsh = flat.find(row => row.id === 'tool-pwsh')
  check(`preset ${id}: one shell follows the platform`,
    bash?.disabled === windowsHost && pwsh?.disabled === !windowsHost)
}

const sessionPreset = byId.get('pstack')
const sessionFlat = flatten(sessionPreset.plugins)
const delegation = sessionPreset.plugins.find(row => row.id === 'delegation')
check('preset pstack: delegation group isolated', delegation?.group === true && delegation.isolate?.workflowEngine === true)
const spawnTool = delegation?.config.find(row => row.id === 'tool-subagent')
check('preset pstack: spawn tool under the plain name', spawnTool?.config?.provider === 'spawn' && spawnTool?.config?.toolName === 'subagent')
check('preset pstack: exposes both pstack personas', JSON.stringify(spawnTool?.config?.allowedAgentPresets) === JSON.stringify(SUBAGENT_PRESET_IDS))
check('preset pstack: no standing persona default', spawnTool?.config?.agentPreset === undefined)
check('preset pstack: model selection stays on', spawnTool?.config?.modelSelection === true && spawnTool?.config?.modelDiscovery === true)
check('preset pstack: keeps the standard tool surface',
  ['tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'tool-todo', 'tool-web', 'present', 'tool-goal', 'tool-schedule', 'tool-ask-user', 'tool-plugin-market']
    .every(id => sessionFlat.some(row => row.id === id)))
const planModeRow = sessionFlat.find(row => row.id === 'plan-mode')
check('preset pstack: plan mode policy carried', typeof planModeRow?.config?.section === 'string' && planModeRow.config.section.length > 200)
check('preset pstack: plan mode policy is body text', !(planModeRow?.config?.section ?? '').startsWith('---'))
const managerRow = sessionFlat.find(row => row.id === 'tool-plugin-manager')
check('preset pstack: plugin manager guarded by profile context',
  managerRow?.disabled?.__jsExpr === "!ctx.get('profileContext')")

// The self-comparison checks above cannot catch presets.mjs drifting from the
// shipped preset-standard, so compare the top-level (id, name) rows against the
// installed dsh-web-app copy. The patch yml carries !!js tags (not plain YAML),
// but its top-level plugin rows are stably indented: `- id:` at 10 spaces with
// `name:` on the next line; group config rows sit deeper and never match.
const standardPatch = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
if (!existsSync(standardPatch)) {
  console.log('note: dsh-web-app not installed; standard mirror check skipped')
} else {
  const shippedLines = readFileSync(standardPatch, 'utf8').split(/\r?\n/)
  const shipped = []
  for (let i = 0; i < shippedLines.length; i++) {
    const idMatch = /^ {10}- id: (\S+)$/.exec(shippedLines[i])
    if (idMatch === null) continue
    const nameMatch = /^ {12}name: (?:'([^']*)'|(\S+))$/.exec(shippedLines[i + 1] ?? '')
    shipped.push({ id: idMatch[1], name: nameMatch !== null ? (nameMatch[1] ?? nameMatch[2]) : undefined })
  }
  const mirror = sessionPreset.plugins.map(({ id, name }) => ({ id, name }))
  const firstDiff = shipped.findIndex((row, i) => row.id !== mirror[i]?.id || row.name !== mirror[i]?.name)
  const mirrorDetail = shipped.length < 15
    ? `extracted only ${shipped.length} top-level plugin rows from ${standardPatch}; the yml layout changed — update presets.mjs or this extraction`
    : firstDiff === -1
      ? ''
      : `shipped has ${shipped.length} top-level rows, mirror has ${mirror.length}; first divergence at index ${firstDiff}: shipped ${JSON.stringify(shipped[firstDiff])} vs mirror ${JSON.stringify(mirror[firstDiff])}`
  check('session preset mirrors shipped preset-standard (id+name sequence)', mirrorDetail === '', mirrorDetail)
}

const potetoPreset = byId.get('poteto-agent')
const potetoFlat = flatten(potetoPreset.plugins)
const potetoPersona = potetoFlat.find(row => row.id === 'persona')?.config?.prefix ?? ''
check('preset poteto-agent: persona is the shipped brief', potetoPersona.includes('poteto-mode') && !potetoPersona.startsWith('---'))
check('preset poteto-agent: can implement', potetoFlat.some(row => row.id === 'tool-fs' && row.config?.write !== false && row.config?.edit !== false))
check('preset poteto-agent: leaves questions to the parent', !potetoFlat.some(row => row.id === 'tool-ask-user'))
check('preset poteto-agent: does not nest delegation', !potetoFlat.some(row => row.id === 'tool-subagent'))

const sickoFlat = flatten(byId.get('comment-sicko').plugins)
const sickoFs = sickoFlat.find(row => row.id === 'tool-fs')
check('preset comment-sicko: read-only fs enforced', sickoFs?.config?.write === false && sickoFs?.config?.edit === false)
check('preset comment-sicko: persona is the shipped brief',
  (sickoFlat.find(row => row.id === 'persona')?.config?.prefix ?? '').includes('Comment Sicko'))

// --- 6. plugin behavior ------------------------------------------------------

const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
check('plugin: stable name', plugin.name === 'pstack-router')
check('plugin: injects systemPrompt as a service list', Array.isArray(plugin.inject) && plugin.inject.includes('systemPrompt'))
check('plugin: inject names only real services', Array.isArray(plugin.inject) && plugin.inject.every(name => ['systemPrompt', 'agentPresets'].includes(name)))
check('plugin: agentPresets is not a hard dependency', Array.isArray(plugin.inject) && !plugin.inject.includes('agentPresets'))

function stubContext({ registry: withRegistry = true, broken = [], known = [], logger, getService = withRegistry } = {}) {
  const sections = []
  const registrations = []
  const disposers = []
  const pending = []
  const registry = {
    async list() {
      return [
        ...known.map(id => ({ id, broken: undefined })),
        ...registrations.map(definition => ({ id: definition.id, broken: broken.includes(definition.id) ? 'failed to activate' : undefined })),
      ]
    },
    async register(definition) { registrations.push(definition); return async () => {} },
  }
  const ctx = {
    sections,
    registrations,
    disposers,
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    effect: (disposer) => { disposers.push(disposer) },
    logger,
    get: key => key === 'agentPresets' && getService ? registry : undefined,
    // The registry service arrives after this plugin activates, so the real
    // plugin waits for it through ctx.inject.
    inject: (services, callback) => {
      if (!services.includes('agentPresets') || !withRegistry) return undefined
      pending.push(Promise.resolve(callback(ctx)))
    },
    // Wait for the deferred registration the way the Host settles the fiber.
    settled: async () => { await Promise.all(pending) },
  }
  return ctx
}

/** Apply the plugin and wait for its deferred preset registration. */
async function applyPlugin(ctx, config) {
  await plugin.apply(ctx, config)
  await ctx.settled()
}

const enabled = stubContext()
await applyPlugin(enabled, { enabled: true })
check('plugin: registers children before the session preset',
  enabled.registrations.map(d => d.id).join(',') === 'poteto-agent,comment-sicko,pstack,review-triage')
check('plugin: owns one disposer per preset', enabled.disposers.length === 4)
check('plugin: registers one section', enabled.sections.length === 1)
check('plugin: session preset carries the allowlist',
  JSON.stringify(enabled.registrations.find(d => d.id === 'pstack')?.plugins
    ?.find(row => row.id === 'delegation')?.config?.find(row => row.id === 'tool-subagent')?.config?.allowedAgentPresets)
  === JSON.stringify(SUBAGENT_PRESET_IDS))
const section = enabled.sections[0] ?? {}
check('plugin: section name', section.name === 'pstack-router')
check('plugin: default order', section.order === 700)
check('plugin: adapter path substituted', typeof section.text === 'string' && section.text.includes(ADAPTER) && !section.text.includes('{{adapter}}'))
check('plugin: playbook path substituted',
  typeof section.text === 'string'
  && section.text.includes(join(ROOT, 'skills', 'poteto-mode', 'SKILL.md'))
  && !section.text.includes('{{potetoMode}}'))

const custom = stubContext()
await applyPlugin(custom, { order: 123, text: 'custom {{adapter}} text' })
check('plugin: config order honored', custom.sections[0]?.order === 123)
check('plugin: config text honored', custom.sections[0]?.text === `custom ${ADAPTER} text`)

const disabled = stubContext()
await applyPlugin(disabled, { enabled: false })
check('plugin: enabled=false skips the directive', disabled.sections.length === 0)
check('plugin: enabled=false still registers presets', disabled.registrations.length === 4)

const degraded = stubContext({ broken: ['poteto-agent', 'comment-sicko'] })
await applyPlugin(degraded, { enabled: false })
const degradedSpawn = degraded.registrations.find(definition => definition.id === 'pstack')
  ?.plugins.find(row => row.id === 'delegation')?.config.find(row => row.id === 'tool-subagent')
check('plugin: broken personas disable agent_preset instead of failing the mount',
  degradedSpawn?.config?.allowedAgentPresets === undefined && degradedSpawn?.config?.provider === 'spawn')

const partially = stubContext({ broken: ['comment-sicko'] })
await applyPlugin(partially, { enabled: false })
const partialSpawn = partially.registrations.find(definition => definition.id === 'pstack')
  ?.plugins.find(row => row.id === 'delegation')?.config.find(row => row.id === 'tool-subagent')
check('plugin: only healthy personas stay selectable',
  JSON.stringify(partialSpawn?.config?.allowedAgentPresets) === JSON.stringify(['poteto-agent']))

const headless = stubContext({ registry: false })
await applyPlugin(headless, {})
check('plugin: no preset service is not fatal', headless.registrations.length === 0 && headless.sections.length === 1)

for (const [label, config, pattern] of [
  ['enabled', { enabled: 'yes' }, /config\.enabled must be a boolean/],
  ['order', { order: 'far' }, /config\.order must be a finite number/],
  ['text', { text: '' }, /config\.text must be a non-empty string/],
  ['shape', [], /config must be an object/],
  ['config', null, /config must be an object/],
  ['triage shape', { reviewTriage: [] }, /config\.reviewTriage must be an object/],
  ['triage null', { reviewTriage: null }, /config\.reviewTriage must be an object/],
]) {
  let error
  try { await applyPlugin(stubContext(), config) } catch (caught) { error = caught }
  check(`plugin: rejects bad ${label}`, error instanceof TypeError && pattern.test(error.message))
}

// Warnings are the only diagnostic when a preset id is taken or breaks, and a
// context without a logger must not turn that into a crash.
const takenLog = { warnings: [], warn(message) { this.warnings.push(message) } }
const taken = stubContext({ known: ['pstack'], logger: takenLog })
await applyPlugin(taken, { enabled: false })
check('plugin: an existing preset id is left alone', !taken.registrations.some(definition => definition.id === 'pstack'))
check('plugin: an existing preset id warns', takenLog.warnings.some(line => line.includes('"pstack" already exists')))

const silentDuplicate = stubContext({ known: ['poteto-agent'] })
await applyPlugin(silentDuplicate, { enabled: false })
check('plugin: a taken id without a logger still registers the rest',
  silentDuplicate.registrations.map(definition => definition.id).join(',') === 'comment-sicko,pstack,review-triage')

const sessionLog = { warnings: [], warn(message) { this.warnings.push(message) } }
const brokenSession = stubContext({ broken: ['pstack'], logger: sessionLog })
await applyPlugin(brokenSession, { enabled: false })
check('plugin: a broken session preset warns with its reason',
  sessionLog.warnings.some(line => line.includes('"pstack" did not activate cleanly') && line.includes('failed to activate')))

const silentSession = stubContext({ broken: ['pstack'] })
await applyPlugin(silentSession, { enabled: false })
check('plugin: a broken session preset without a logger still settles', silentSession.registrations.length === 4)

const personaLog = { warnings: [], warn(message) { this.warnings.push(message) } }
const brokenPersona = stubContext({ broken: ['comment-sicko'], logger: personaLog })
await applyPlugin(brokenPersona, { enabled: false })
check('plugin: a broken persona warns by name',
  personaLog.warnings.some(line => line.includes('comment-sicko') && line.includes('agent_preset selection stays off')))

const lateLog = { warnings: [], warn(message) { this.warnings.push(message) } }
const lateRegistry = stubContext({ getService: false, logger: lateLog })
await applyPlugin(lateRegistry, { enabled: false })
check('plugin: a missing registry warns instead of registering',
  lateRegistry.registrations.length === 0 && lateLog.warnings.some(line => line.includes('no agentPresets service')))

const lateSilent = stubContext({ getService: false })
await applyPlugin(lateSilent, { enabled: true })
check('plugin: a missing registry without a logger is not fatal',
  lateSilent.registrations.length === 0 && lateSilent.sections.length === 1)

const zeroOrder = stubContext()
await applyPlugin(zeroOrder, { enabled: true, order: 0 })
check('plugin: order 0 is honored, not defaulted', zeroOrder.sections[0]?.order === 0)

// --- 6b. upstream byte gate (pure compare) ----------------------------------

const { compareTrees } = await import(pathToFileURL(join(ROOT, 'scripts', 'sync-upstream.mjs')).href)
const upstreamFiles = new Map([['README.md', 'upstream-readme'], ['skills/x/SKILL.md', 'same'], ['plugin.json', 'manifest']])
const expectations = { expectedMissing: ['plugin.json'], expectedChanged: ['README.md'] }

const clean = compareTrees(
  new Map([['README.md', 'port-readme'], ['skills/x/SKILL.md', 'same']]),
  upstreamFiles,
  expectations,
)
check('upstream gate: declared deltas pass', clean.failed === 0 && clean.extra.length === 0)

const drifted = compareTrees(
  new Map([['README.md', 'port-readme'], ['skills/x/SKILL.md', 'changed']]),
  upstreamFiles,
  expectations,
)
check('upstream gate: a content drift outside the list fails',
  drifted.unexpectedChanged.join(',') === 'skills/x/SKILL.md' && drifted.failed === 1)

const dropped = compareTrees(new Map([['README.md', 'port-readme']]), upstreamFiles, expectations)
check('upstream gate: a dropped file outside the list fails',
  dropped.unexpectedMissing.join(',') === 'skills/x/SKILL.md' && dropped.failed === 1)

const stale = compareTrees(
  new Map([['README.md', 'upstream-readme'], ['skills/x/SKILL.md', 'same']]),
  upstreamFiles,
  expectations,
)
check('upstream gate: an edited file that matches upstream is a stale expectation',
  stale.staleIdentical.join(',') === 'README.md' && stale.failed === 1)

const restored = compareTrees(
  new Map([['README.md', 'port-readme'], ['skills/x/SKILL.md', 'same'], ['plugin.json', 'manifest']]),
  upstreamFiles,
  expectations,
)
check('upstream gate: a file restored despite expectedMissing is a stale expectation',
  restored.staleRestored?.join(',') === 'plugin.json' && restored.failed === 1)

const extraFiles = compareTrees(
  new Map([['README.md', 'upstream-readme'], ['skills/x/SKILL.md', 'same'], ['docs/new.md', 'ours']]),
  upstreamFiles,
  { expectedMissing: ['plugin.json'], expectedChanged: [] },
)
check('upstream gate: extra files are informational, not failures',
  extraFiles.extra.join(',') === 'docs/new.md' && extraFiles.failed === 0)

// --- 7. transcript helper (multi-frame session log) --------------------------

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-pstack-verify-'))
try {
  const workspace = join(sandbox, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const slug = `--${resolve(workspace).replace(/:/g, '').replace(/[\\/]+/g, '-')}--`
  const sessionFolder = join(sandbox, '.dsh', 'sessions', slug, 'session-abc123')
  mkdirSync(sessionFolder, { recursive: true })
  const events = [
    { type: 'session', version: 4, id: 'session-abc123', createdAt: 0, cwd: workspace, agentPreset: 'pstack' },
    { type: 'user/message', seq: 1, data: { text: 'hello' } },
    { type: 'tool/call', seq: 2, data: { name: 'read' } },
  ]
  // One zstd frame per event, which is how the harness appends.
  writeFileSync(
    join(sessionFolder, 'session.v4.jsonl.zstd'),
    Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))),
  )
  const helper = join(ROOT, 'scripts', 'session-transcript.mjs')
  const runHelper = (...args) => execFileSync(process.execPath, [helper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(sandbox, '.dsh') },
  })
  const shown = runHelper('show', '--cwd', workspace)
  const shownLines = shown.trim().split('\n')
  check('transcript: decodes every frame', shownLines.length === events.length, `got ${shownLines.length}`)
  check('transcript: reads past the first frame', shown.includes('tool/call'))
  check('transcript: every line is still JSON', shownLines.every(line => { try { JSON.parse(line); return true } catch { return false } }))
  const listed = runHelper('list', '--cwd', workspace)
  check('transcript: list resolves the cwd slug', listed.includes('abc123') && listed.includes('preset=pstack'))
  const listedJson = JSON.parse(runHelper('list', '--cwd', workspace, '--json').trim())
  check('transcript: json list carries the cwd', listedJson.cwd === workspace || resolve(listedJson.cwd) === resolve(workspace))
  const tailed = runHelper('show', '--cwd', workspace, '--tail', '1')
  check('transcript: --tail keeps the last event', tailed.trim().startsWith('{"type":"tool/call"'))
  // A tail frame cut mid-write is the common append-only corruption: earlier
  // frames must survive, the tail is dropped with a stderr warning.
  const frames = events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  const { spawnSync } = await import('node:child_process')
  const runScriptStatus = (script, ...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: join(sandbox, '.dsh') },
  })
  const runHelperStatus = (...args) => runScriptStatus(helper, ...args)
  const tailFolder = join(sandbox, '.dsh', 'sessions', slug, 'session-tail4444')
  mkdirSync(tailFolder, { recursive: true })
  writeFileSync(
    join(tailFolder, 'session.v4.jsonl.zstd'),
    Buffer.concat([frames[0], frames[1], frames[2].subarray(0, 8)]),
  )
  const tailRun = runHelperStatus('show', '--cwd', workspace, '--session', 'tail4444')
  check('transcript: truncated tail keeps earlier frames', tailRun.status === 0
    && tailRun.stdout.includes('user/message') && !tailRun.stdout.includes('tool/call'),
  `status ${tailRun.status}, stdout ${JSON.stringify(tailRun.stdout)}`)
  check('transcript: truncated tail warns on stderr',
    tailRun.stderr.includes('warning: truncated tail frame dropped (8 bytes); 2 earlier frame(s) decoded'),
    tailRun.stderr)
  const headFolder = join(sandbox, '.dsh', 'sessions', slug, 'session-head5555')
  mkdirSync(headFolder, { recursive: true })
  writeFileSync(join(headFolder, 'session.v4.jsonl.zstd'), frames[0].subarray(0, 8))
  const headRun = runHelperStatus('show', '--cwd', workspace, '--session', 'head5555')
  check('transcript: a truncated first frame stays fatal',
    headRun.status !== 0 && headRun.stderr.includes('cannot decompress'),
    `status ${headRun.status}, stderr ${headRun.stderr}`)
  // Inter-frame garbage that happens to start with the frame magic must not be
  // treated as a truncated tail: everything behind it, including intact frames,
  // would be dropped with a misleading warning. The decoder must resync to the
  // next real frame and say "skipped" instead.
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const junkFolder = join(sandbox, '.dsh', 'sessions', slug, 'session-junk6666')
  mkdirSync(junkFolder, { recursive: true })
  const writeFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'tool/call', seq: 3, data: { name: 'write' } })}\n`))
  const junk = Buffer.concat([MAGIC, Buffer.from('inter-frame garbage that only looks like a frame header')])
  writeFileSync(
    join(junkFolder, 'session.v4.jsonl.zstd'),
    Buffer.concat([frames[0], frames[2], junk, writeFrame]),
  )
  const junkRun = runHelperStatus('show', '--cwd', workspace, '--session', 'junk6666')
  check('transcript: fake-magic garbage between frames does not drop later frames',
    junkRun.status === 0 && junkRun.stdout.includes('"name":"write"'),
    `status ${junkRun.status}, stdout ${JSON.stringify(junkRun.stdout)}`)
  check('transcript: fake-magic garbage warns skipped bytes, not truncated tail',
    junkRun.stderr.includes('skipped') && !junkRun.stderr.includes('truncated tail frame dropped'),
    junkRun.stderr)
  // Node realpaths the main entry but keeps argv[1] as the link path, so an
  // `import.meta.url === pathToFileURL(argv[1]).href` guard never matches through
  // a junction: the script would exit 0 with no output. Invoked through a link it
  // must still run. Windows junctions need no admin; POSIX falls back to a symlink.
  const linkPath = join(sandbox, 'scripts-link')
  let linkReady = false
  try {
    symlinkSync(join(ROOT, 'scripts'), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linkReady = true
  } catch (error) {
    if (error.code !== 'EPERM') throw error
  }
  if (linkReady) {
    const linkRun = runScriptStatus(join(linkPath, 'session-transcript.mjs'), 'show', '--cwd', workspace, '--session', 'abc123')
    check('transcript: runs through a junction/symlink to the scripts dir',
      linkRun.status === 0 && linkRun.stdout.includes('user/message'),
      `status ${linkRun.status}, stdout ${JSON.stringify(linkRun.stdout)}, stderr ${linkRun.stderr}`)
  } else {
    console.log('note: links unavailable here; the junction/symlink check was skipped')
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// --- 8. summary and transcript edge cases -----------------------------------

const sandbox2 = mkdtempSync(join(tmpdir(), 'dsh-pstack-edge-'))
try {
  const workspace = join(sandbox2, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const slug = `--${resolve(workspace).replace(/:/g, '').replace(/[\\/]+/g, '-')}--`
  const dsh = join(sandbox2, '.dsh')
  const sessionsDir = join(dsh, 'sessions', slug)
  const writeSession = (name, buffer) => {
    const folder = join(sessionsDir, `session-${name}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'session.v4.jsonl.zstd'), buffer)
  }
  const events = [
    { type: 'session', version: 4, id: 'session-edge0001', createdAt: 0, cwd: workspace, agentPreset: 'pstack' },
    { type: 'tool/call', seq: 2, data: { name: 'read', input: { path: 'skills/x/SKILL.md' } } },
    { type: 'approval/asked', seq: 3, data: { tool: 'write' } },
  ]
  writeSession('edge0001', Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))))

  const helper = join(ROOT, 'scripts', 'session-transcript.mjs')
  const summaryHelper = join(ROOT, 'scripts', 'session-summary.mjs')
  const { spawnSync } = await import('node:child_process')
  const runStatus = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dsh, ...env },
  })

  // A non-empty file without the zstd frame magic is not a session log: it must
  // fail loudly instead of printing nothing and exiting 0.
  writeSession('notz0002', Buffer.from('{"accidentally":"json"}\nplain text, not compressed'))
  const notz = runStatus(helper, ['show', '--cwd', workspace, '--session', 'notz0002'])
  check('transcript: a non-zstd file fails loudly',
    notz.status !== 0 && notz.stderr.includes('not a session log'),
    `status ${notz.status}, stderr ${notz.stderr}`)

  // An empty file stays benign: no output, success.
  writeSession('empty004', Buffer.alloc(0))
  const empty = runStatus(helper, ['show', '--cwd', workspace, '--session', 'empty004'])
  check('transcript: an empty file stays benign', empty.status === 0 && empty.stdout === '',
    `status ${empty.status}, stdout ${JSON.stringify(empty.stdout)}`)

  // Windows folds path case: the same workspace reached as C:\... vs c:\... must
  // still list. On other platforms this scenario cannot exist; skip without counting.
  if (process.platform === 'win32') {
    const lower = workspace.slice(0, 1).toLowerCase() + workspace.slice(1)
    const listed = runStatus(helper, ['list', '--cwd', lower])
    check('transcript: list matches the cwd case-insensitively on Windows',
      listed.status === 0 && listed.stdout.includes('edge0001'),
      `status ${listed.status}, stderr ${listed.stderr}`)
  }

  // Frames that lost the trailing newline must not glue two JSON events into one line.
  writeSession('nonl0003', Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', seq: 1 }))),
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', seq: 2 }))),
  ]))
  const glued = runStatus(helper, ['show', '--cwd', workspace, '--session', 'nonl0003'])
  const gluedLines = glued.status === 0 ? glued.stdout.split('\n').filter(line => line !== '') : []
  check('transcript: frames without trailing newlines stay separate JSON lines',
    glued.status === 0 && gluedLines.length === 2
    && gluedLines.every(line => { try { JSON.parse(line); return true } catch { return false } }),
    `status ${glued.status}, stdout ${JSON.stringify(glued.stdout)}`)

  // firstFrameText/allFramesText unit probes run in a child so a broken main
  // guard cannot kill this gate: the module must be import-safe and export the
  // frame decoders. A planted magic inside frame 1's compressed bytes (random
  // tails are stored raw) is a false frame boundary the decoders must cross.
  const probePath = join(sandbox2, 'probe-transcript.mjs')
  writeFileSync(probePath, String.raw`
const { pathToFileURL } = await import('node:url')
const mod = await import(pathToFileURL(process.argv[2]).href)
const { zstdCompressSync } = await import('node:zlib')
const { randomBytes } = await import('node:crypto')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const out = {}
const line1Text = JSON.stringify({ type: 'session', id: 'probe' }) + '\n'
const line2Text = JSON.stringify({ type: 'user/message', seq: 1 }) + '\n'
const line1 = Buffer.from(line1Text)
const line2 = Buffer.from(line2Text)
const tail = randomBytes(8 * 1024)
MAGIC.copy(tail, 4 * 1024)
const frame1 = zstdCompressSync(Buffer.concat([line1, tail]))
const frame2 = zstdCompressSync(line2)
out.pseudoMagicEmbedded = frame1.indexOf(MAGIC, 4) > 0
const both = Buffer.concat([frame1, frame2])
try {
  const first = mod.firstFrameText(both)
  out.firstFrame = first.startsWith(line1Text) && !first.includes(line2Text)
} catch (error) {
  out.firstFrame = 'threw: ' + error.message
}
try {
  const all = mod.allFramesText(both)
  out.allFrames = all.includes(line1Text) && all.includes(line2Text)
} catch (error) {
  out.allFrames = 'threw: ' + error.message
}
// slugFor must mirror DSH's projectKey exactly: separator runs collapse to one
// dash, safe [A-Za-z0-9._-] passes through, every other UTF-16 code unit
// escapes as ~XXXX, leading dashes strip, and the key caps at 251 chars.
try {
  const { join, resolve } = await import('node:path')
  const base = process.argv[3]
  const oldReadable = p => resolve(p).replace(/:/g, '').replace(/[\\/]+/g, '-')
  const prefix = oldReadable(base).replace(/^-+/, '')
  out.slugAscii = mod.slugFor(base) === '--' + prefix + '--'
  out.slugChinese = mod.slugFor(join(base, '中文目录')) === '--' + prefix + '-~4E2D~6587~76EE~5F55--'
  out.slugEmoji = mod.slugFor(join(base, 'ok', '\u{1F600}')) === '--' + prefix + '-ok-~D83D~DE00--'
  out.slugLong = mod.slugFor(join(base, 'a'.repeat(300))) === '--' + (prefix + '-' + 'a'.repeat(300)).slice(0, 251) + '--'
} catch (error) {
  out.slugError = error.message
}
process.stdout.write(JSON.stringify(out))
`)
  const probe = runStatus(probePath, [helper, workspace])
  let probeData = {}
  try { probeData = JSON.parse(probe.stdout || '{}') } catch { /* probe crashed; the checks below carry the detail */ }
  check('transcript: module import is side-effect free (main guard + decoder exports)',
    probe.status === 0 && probeData.pseudoMagicEmbedded === true,
    `status ${probe.status}, stderr ${probe.stderr.slice(0, 200)}`)
  check('transcript: firstFrameText crosses an in-frame pseudo magic', probeData.firstFrame === true,
    JSON.stringify(probeData.firstFrame))
  check('transcript: allFramesText crosses an in-frame pseudo magic', probeData.allFrames === true,
    JSON.stringify(probeData.allFrames))

  // slugFor must mirror DSH's projectKey byte-for-byte, or sessions recorded
  // under non-ASCII workspaces become unreachable. The fixture directory name is
  // hand-computed from the documented escapes, independent of the implementation.
  const chineseWs = join(workspace, '中文目录')
  mkdirSync(chineseWs, { recursive: true })
  const prefix = resolve(workspace).replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/^-+/, '')
  const chineseSlug = `--${prefix}-~4E2D~6587~76EE~5F55--`
  mkdirSync(join(dsh, 'sessions', chineseSlug, 'session-edge0901'), { recursive: true })
  writeFileSync(
    join(dsh, 'sessions', chineseSlug, 'session-edge0901', 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-edge0901', createdAt: 0, cwd: chineseWs, agentPreset: 'pstack' })}\n`)),
  )
  const chineseList = runStatus(helper, ['list', '--cwd', chineseWs])
  check('transcript: list finds sessions under a non-ASCII workspace slug',
    chineseList.status === 0 && chineseList.stdout.includes('edge0901'),
    `status ${chineseList.status}, stderr ${chineseList.stderr}`)
  if (process.platform === 'win32') {
    check('slug: ascii derivation unchanged on Windows', probeData.slugAscii === true,
      JSON.stringify(probeData.slugAscii ?? probeData.slugError))
  }
  check('slug: chinese path escapes per DSH projectKey', probeData.slugChinese === true,
    JSON.stringify(probeData.slugChinese ?? probeData.slugError))
  check('slug: astral chars escape per UTF-16 code unit', probeData.slugEmoji === true,
    JSON.stringify(probeData.slugEmoji ?? probeData.slugError))
  check('slug: readable segment truncates at 251 chars', probeData.slugLong === true,
    JSON.stringify(probeData.slugLong ?? probeData.slugError))

  // --- summary ---

  const bareKinds = runStatus(summaryHelper, ['--kinds'])
  check('summary: bare --kinds is a usage error, not a stack trace',
    bareKinds.status !== 0
    && bareKinds.stderr.includes('missing value for --kinds')
    && !bareKinds.stderr.includes('TypeError')
    && !bareKinds.stderr.includes('\n    at '),
    `status ${bareKinds.status}, stderr ${bareKinds.stderr.slice(0, 300)}`)

  const filtered = runStatus(summaryHelper, ['--cwd', workspace, '--session', 'edge0001', '--json', '--kinds', 'tools'])
  let payload = {}
  try { payload = JSON.parse(filtered.stdout || '{}') } catch { /* failure detail below */ }
  check('summary: --json honors --kinds filtering',
    filtered.status === 0 && 'tools' in payload && !('approvals' in payload) && !('files' in payload) && !('instructions' in payload),
    `status ${filtered.status}, stdout ${JSON.stringify(filtered.stdout).slice(0, 200)}`)

  const broken = runStatus(summaryHelper, ['--cwd', workspace], { DSH_HOME: join(sandbox2, 'missing') })
  check('summary: transcript failure carries context, no raw stack',
    broken.status !== 0
    && broken.stderr.includes('session-summary:')
    && broken.stderr.includes('session-transcript.mjs')
    && !broken.stderr.includes('\n    at '),
    `status ${broken.status}, stderr ${broken.stderr.slice(0, 300)}`)

  // One log with a corrupt header date must not throw a RangeError that kills
  // the whole list: the bad row keeps its raw value, every other session lists.
  writeSession('date0505', zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-date0505', createdAt: 'not-a-date', cwd: workspace, agentPreset: 'pstack' })}\n`)))
  const badDate = runStatus(helper, ['list', '--cwd', workspace, '--json'])
  const badRows = badDate.status === 0
    ? badDate.stdout.trim().split('\n').map(line => { try { return JSON.parse(line) } catch { return undefined } })
    : []
  check('transcript: list survives a corrupt createdAt header',
    badDate.status === 0
    && badRows.some(row => row?.sessionId === 'date0505' && row.createdAt === 'not-a-date')
    && badRows.some(row => row?.sessionId === 'edge0001'),
    `status ${badDate.status}, stderr ${badDate.stderr.slice(0, 200)}, stdout ${badDate.stdout.slice(0, 200)}`)

  // A --session prefix that hits several logs picks the newest; it must say so
  // instead of silently choosing.
  writeSession('pref0101', zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', seq: 1, data: { text: 'older prefix fixture' } })}\n`)))
  writeSession('pref0102', zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', seq: 2, data: { text: 'newer prefix fixture' } })}\n`)))
  const prefixRun = runStatus(helper, ['show', '--cwd', workspace, '--session', 'pref010'])
  check('transcript: --session prefix matching several warns and still shows the newest',
    prefixRun.status === 0
    && prefixRun.stderr.includes('2 sessions match prefix "pref010"')
    && prefixRun.stdout.includes('newer prefix fixture') && !prefixRun.stdout.includes('older prefix fixture'),
    `status ${prefixRun.status}, stderr ${prefixRun.stderr}, stdout ${prefixRun.stdout.slice(0, 120)}`)

  // Windows tool calls carry backslash paths; skills reads must still count.
  writeSession('sklbck06', Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-sklbck06', createdAt: 0, cwd: workspace, agentPreset: 'pstack' })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'tool/call', seq: 1, data: { name: 'read', input: { path: '.dsh\\skills\\win-skill\\SKILL.md' } } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'tool/call', seq: 2, data: { name: 'read', input: { path: 'skills/x/SKILL.md' } } })}\n`)),
  ]))
  const backslash = runStatus(summaryHelper, ['--cwd', workspace, '--session', 'sklbck06', '--json', '--kinds', 'skills'])
  let backslashSkills = []
  try { backslashSkills = JSON.parse(backslash.stdout || '{}').skills ?? [] } catch { /* failure detail below */ }
  check('summary: backslash skill paths count as skills',
    backslash.status === 0 && backslashSkills.includes('win-skill') && backslashSkills.includes('x'),
    `status ${backslash.status}, stdout ${backslash.stdout.slice(0, 200)}`)

  // The harness stamps approval/asked + approval/decided with one
  // ApprovalRequestId (interaction/user-approval), so interleaved asks pair by
  // id; an id-less decision still falls back to the single pending ask.
  writeSession('app0707', Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 'session-app0707', createdAt: 0, cwd: workspace, agentPreset: 'pstack' })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/asked', seq: 1, data: { id: 'ap-a', toolName: 'write' } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/asked', seq: 2, data: { id: 'ap-b', toolName: 'edit' } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/decided', seq: 3, data: { id: 'ap-b', outcome: 'allowed-once' } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/decided', seq: 4, data: { id: 'ap-a', outcome: 'rejected' } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/asked', seq: 5, data: { toolName: 'bash' } })}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'approval/decided', seq: 6, data: { outcome: 'allowed-once' } })}\n`)),
  ]))
  const paired = runStatus(summaryHelper, ['--cwd', workspace, '--session', 'app0707', '--json', '--kinds', 'approvals'])
  let approvals = []
  try { approvals = JSON.parse(paired.stdout || '{}').approvals ?? [] } catch { /* failure detail below */ }
  check('summary: approvals pair by id when events carry one',
    approvals.length === 3
    && approvals[0]?.asked?.id === 'ap-a' && approvals[0]?.decided?.id === 'ap-a' && approvals[0]?.decided?.outcome === 'rejected'
    && approvals[1]?.asked?.id === 'ap-b' && approvals[1]?.decided?.id === 'ap-b' && approvals[1]?.decided?.outcome === 'allowed-once'
    && approvals[2]?.asked?.toolName === 'bash' && approvals[2]?.decided?.outcome === 'allowed-once',
    `status ${paired.status}, approvals ${JSON.stringify(approvals).slice(0, 300)}`)
} finally {
  rmSync(sandbox2, { recursive: true, force: true })
}

// --- report ----------------------------------------------------------------

for (const line of failures) console.error(`FAIL  ${line}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s), ${checks.length} check(s) passed`)
  process.exit(1)
}
console.log(`ok — ${checks.length} checks across ${skillDirs.length} skills, 2 agents, 3 presets, adapter, manifest, patch, router`)