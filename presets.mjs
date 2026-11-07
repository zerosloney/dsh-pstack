/**
 * pstack 编排的 DSH 落地：三个 agent 预设。
 *
 * - `poteto-agent`：委派工人，对应上游 `subagent_type: "poteto-agent"`。
 * - `comment-sicko`：只读评委，对应上游 `subagent_type: "comment-sicko"`；只读由
 *   工具面强制（没有 write/edit），不靠 brief 自律。
 * - `pstack`：会话预设。`@deepseek-ai/dsh-web-app` 的 `preset-standard` 的一份镜像
 *   （v0.2.2-rc.1），只把 delegation 组换成带 pstack 子预设白名单的版本。
 *
 * 先注册两个子预设、确认能激活，再注册会话预设：会话预设的白名单引用它们，
 * 引用不存在的预设会让 `subagent` 在 Agent 挂载时直接失败。index.js 负责这个顺序。
 *
 * @module dsh-pstack/presets
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'
const SESSION_PRESET_ID = 'pstack'

/** The two pstack personas, exposed to the delegation tool as `agent_preset`. */
export const SUBAGENT_PRESET_IDS = ['poteto-agent', 'comment-sicko']

/** Id of the session preset this bundle installs. */
export const sessionPresetId = SESSION_PRESET_ID

/** Strip the YAML frontmatter from a shipped agent brief. */
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (match === null ? text : text.slice(match[0].length)).trim()
}

/** Child rows keep deployment predicates until the plugin activates. */
const jsonExpr = source => ({ __jsExpr: source })

/** Shell tools follow the platform, like the shipped preset. */
function shellRows() {
  return [
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: WINDOWS },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !WINDOWS },
  ]
}

/** Long-run compaction, optionally with the command and the tool-result pruner. */
function compaction({ pruner }) {
  const config = [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }]
  const isolate = { compaction: true }
  if (pruner) {
    config.push(
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    )
    isolate.toolResultPruner = true
  }
  return { id: 'compaction', name: 'cordis:group', group: true, isolate, config }
}

const personaOf = (root, file) => stripFrontmatter(readFileSync(join(root, 'agents', file), 'utf8'))

/**
 * The two delegation presets.
 * @param {{ root: string }} options
 * @returns {Array<object>} Preset definitions for `poteto-agent` and `comment-sicko`.
 */
export function buildSubagentPresets({ root }) {
  return [
    {
      id: 'poteto-agent',
      name: 'poteto-agent',
      description: 'pstack 委派工人：先整份读 poteto-mode 再动手，工具面覆盖实现、检索、验证；不向用户提问、不再向下委派。',
      order: 20,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaOf(root, 'poteto-agent.md') } },
        { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        ...shellRows(),
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
        { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
        compaction({ pruner: true }),
      ],
    },
    {
      id: 'comment-sicko',
      name: 'comment-sicko',
      description: 'pstack 只读评审批次：没有 write/edit 工具，读 diff、点名该删什么。',
      order: 21,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaOf(root, 'comment-sicko.md') } },
        { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
        ...shellRows(),
        // Read-only is enforced by the tool surface, not by the brief.
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: false, write: false, edit: false, applyPatch: false } },
        { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        compaction({ pruner: false }),
      ],
    },
  ]
}

/**
 * The session preset: standard's tool surface plus pstack delegation.
 * @param {{ root: string, personaAllowlist?: readonly string[] }} options
 *   `personaAllowlist` is omitted when the child presets did not activate, which
 *   disables model-side `agent_preset` selection instead of failing the mount.
 * @returns {object} Preset definition for `pstack`.
 */
export function buildSessionPreset({ root, personaAllowlist = SUBAGENT_PRESET_IDS }) {
  const planModePolicy = readFileSync(join(root, 'presets', 'plan-mode.policy.md'), 'utf8').trim()
  const allowlist = [...personaAllowlist]
  const plugins = [
    // Same persona line as the shipped standard preset: pstack lives in the skills, not the prompt.
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    ...shellRows(),
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    // Local skills stay available next to the plugin's own provider.
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: planModePolicy } }],
    },
    compaction({ pruner: true }),
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelection: true,
            modelDiscovery: true,
            // No standing default: an omitted `agent_preset` inherits this session's
            // preset, which is what an ordinary delegate should get. The allowlist
            // only adds the two pstack personas as model-selectable choices.
            ...(allowlist.length === 0 ? {} : { allowedAgentPresets: allowlist }),
          },
        },
        { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    // Profile management only exists in profile deployments; the expression runs at activation.
    { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: jsonExpr("!ctx.get('profileContext')") },
    { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
  ]
  return {
    id: SESSION_PRESET_ID,
    name: 'pstack',
    description: 'pstack 编排：58 个 pstack 技能 + poteto-agent / comment-sicko 两个委派预设（与 standard 同一套工具面）。',
    order: 2,
    plugins,
  }
}

/**
 * All three presets, child presets first.
 * @param {{ root: string }} options
 * @returns {Array<object>} Preset definitions accepted by `ctx.agentPresets.register`.
 */
export function buildPresets({ root }) {
  return [...buildSubagentPresets({ root }), buildSessionPreset({ root })]
}