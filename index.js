/**
 * dsh-pstack 的 node 半边，三件事：
 *
 * 1. 注册 agent 预设：三个 pstack 预设（会话 + 两个委派），加上评审线程分诊的
 *    propose 预设；apply 预设只在 config.reviewTriage.apply 为 true 时注册。
 * 2. 把 Cursor 的 SessionStart hook 等价物注册成一条 system prompt 段落。
 * 3. 什么都不解析技能：技能由 cordis.patch.yml 里的 skill-filesystem 行装载。
 *
 * @module dsh-pstack
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSessionPreset, buildSubagentPresets, sessionPresetId, SUBAGENT_PRESET_IDS } from './presets.mjs'
import { buildReviewPresets } from './presets-review.mjs'

/** Stable Loader identity. */
export const name = 'pstack-router'

/**
 * Required Host capability: the prompt registry. `agentPresets` stays optional and is
 * read with ctx.get(), because Cordis object-form `inject` declares service keys,
 * not required/optional lists -- naming it here would make it mandatory.
 */
export const inject = ['systemPrompt']

/** Default placement: after the team policy, before per-tool guidance. */
const DEFAULT_ORDER = 700

/** Markers replaced with absolute paths of the adapter document and the playbook. */
const ADAPTER_PLACEHOLDER = '{{adapter}}'
const POTETO_MODE_PLACEHOLDER = '{{potetoMode}}'

const ADAPTER_PATH = fileURLToPath(new URL('./docs/harness/deepseek-harness.md', import.meta.url))
const POTETO_MODE_PATH = fileURLToPath(new URL('./skills/poteto-mode/SKILL.md', import.meta.url))
const ROUTER_PATH = new URL('./router.md', import.meta.url)
const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * Config for the routing directive and the optional apply preset.
 * @typedef {object} Config
 * @property {boolean} [enabled] Whether the routing directive is contributed at all.
 * @property {number} [order] Section sort order; defaults to 700.
 * @property {string} [text] Complete directive text, replacing router.md.
 * @property {{ apply?: boolean }} [reviewTriage] Register the writable review-triage preset.
 */

function assertConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('pstack-router: config must be an object')
  }
  const { enabled, order, text, reviewTriage } = config
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError('pstack-router: config.enabled must be a boolean')
  }
  if (order !== undefined && !Number.isFinite(order)) {
    throw new TypeError('pstack-router: config.order must be a finite number')
  }
  if (text !== undefined && (typeof text !== 'string' || text.trim() === '')) {
    throw new TypeError('pstack-router: config.text must be a non-empty string')
  }
  if (reviewTriage !== undefined) {
    if (reviewTriage === null || typeof reviewTriage !== 'object' || Array.isArray(reviewTriage)) {
      throw new TypeError('pstack-router: config.reviewTriage must be an object')
    }
    if (reviewTriage.apply !== undefined && typeof reviewTriage.apply !== 'boolean') {
      throw new TypeError('pstack-router: config.reviewTriage.apply must be a boolean')
    }
  }
}

let cachedDirective

function readDirective() {
  if (cachedDirective === undefined) cachedDirective = readFileSync(ROUTER_PATH, 'utf8')
  return cachedDirective
}

/** Register the pstack presets, replacing any revision this plugin registered before. */
async function registerPresets(ctx, reviewTriage) {
  const registry = ctx.get('agentPresets')
  if (registry === undefined) {
    // The registry activates independently of this plugin, so its service can still
    // be missing here. Callers pass a scope where it is already present.
    ctx.logger?.warn?.('dsh-pstack: no agentPresets service; pstack presets were not registered')
    return
  }

  const known = new Set((await registry.list()).map(row => row.id))
  const disposers = []
  const register = async definition => {
    if (known.has(definition.id)) {
      ctx.logger?.warn?.('dsh-pstack: agent preset "' + definition.id + '" already exists; leaving it alone')
      return
    }
    known.add(definition.id)
    disposers.push(await registry.register(definition))
  }

  // Children first: the session preset's allowlist names them, and a dangling id
  // would make the delegation tool fail to mount for every session.
  for (const definition of buildSubagentPresets({ root: PACKAGE_ROOT })) await register(definition)

  const roster = await registry.list()
  const healthy = SUBAGENT_PRESET_IDS.filter(id => {
    const row = roster.find(entry => entry.id === id)
    return row !== undefined && row.broken === undefined
  })
  if (healthy.length !== SUBAGENT_PRESET_IDS.length) {
    const broken = SUBAGENT_PRESET_IDS.filter(id => !healthy.includes(id))
    ctx.logger?.warn?.('dsh-pstack: presets ' + broken.join(', ') + ' did not activate; agent_preset selection stays off')
  }

  await register(buildSessionPreset({ root: PACKAGE_ROOT, personaAllowlist: healthy }))

  const review = buildReviewPresets({ root: PACKAGE_ROOT })
  for (const definition of review) {
    if (definition.id === 'review-triage-apply' && reviewTriage?.apply !== true) continue
    await register(definition)
  }

  for (const dispose of disposers) ctx.effect(() => dispose)

  const row = (await registry.list()).find(entry => entry.id === sessionPresetId)
  if (row?.broken !== undefined) {
    ctx.logger?.warn?.('dsh-pstack: session preset "' + sessionPresetId + '" did not activate cleanly: ' + String(row.broken))
  }
}

/** Register the pstack routing directive on ctx.systemPrompt. */
function registerRouter(ctx, config) {
  if (config.enabled === false) return
  const template = config.text ?? readDirective()
  const text = template
    .replaceAll(ADAPTER_PLACEHOLDER, ADAPTER_PATH)
    .replaceAll(POTETO_MODE_PLACEHOLDER, POTETO_MODE_PATH)
  ctx.systemPrompt.section({ name: 'pstack-router', order: config.order ?? DEFAULT_ORDER, text })
}

/** Mount order matters: the default session preset must exist before any session starts. */
export function apply(ctx, config = {}) {
  assertConfig(config)
  registerRouter(ctx, config)
  // The preset registry is provided by another plugin row, so its service does
  // not exist yet when this plugin activates. Sampling ctx.get() here returned
  // undefined and silently dropped every pstack preset for the whole run.
  // ctx.inject waits for the service instead: the callback runs only once the
  // registry is up, and never runs at all when there is no registry.
  ctx.inject(['agentPresets'], (child) => registerPresets(child, config.reviewTriage))
}

