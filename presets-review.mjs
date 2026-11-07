/**
 * 评审线程 triage 的两个委派预设。
 *
 * propose（默认可用）：没有 write/edit 工具，只分类与起草回复。
 * apply（A2 开关）：可写，并允许 review-triage.mjs 的 apply 子命令发送回复、resolve 线程。
 * 是否注册 apply 预设由 cordis.patch.yml 的 pstack-router.config.reviewTriage.apply 决定。
 *
 * @module dsh-pstack/presets-review
 */
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Shell tools follow the platform, like the shipped presets. */
function shellRows() {
  return [
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: WINDOWS },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !WINDOWS },
  ]
}

/** Read the procedure and the rubric before classifying anything. */
function personaOf(root, mode) {
  const skill = join(root, 'skills', 'review-triage', 'SKILL.md')
  const rubric = join(root, 'skills', 'poteto-mode', 'references', 'bugbot-triage.md')
  const stop = mode === 'apply'
    ? 'You may post replies and resolve threads, and only through the review-triage tool.'
    : 'You have no write or edit tools: classify, draft, and stop. Do not post anything.'
  return [
    'You triage pull-request review threads into fix, dismiss or ask.',
    'Read ' + skill + ' first, then the rubric at ' + rubric + '.',
    stop,
    'Cite the thread id and the verdict for every decision.',
  ].join(' ')
}

/**
 * Build both review presets; the caller decides whether to register apply.
 * @param {{ root: string }} options
 * @returns {Array<object>} Preset definitions.
 */
export function buildReviewPresets({ root }) {
  const shared = (mode) => {
    const writable = mode === 'apply'
    return [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaOf(root, mode) } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      ...shellRows(),
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs',
        config: writable ? {} : { read: true, readImage: false, write: false, edit: false },
      },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
      // Compaction provides a service, so it needs an isolated realm; a bare
      // row leaks the service into the preset root and the mount is rejected.
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true },
        config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }],
      },
    ]
  }
  return [
    {
      id: 'review-triage',
      name: 'Review triage (propose)',
      description: '只读评审线程分诊：分类 fix/dismiss/ask 并起草回复，不改代码、不发评论。',
      order: 30,
      plugins: shared('propose'),
    },
    {
      id: 'review-triage-apply',
      name: 'Review triage (apply)',
      description: '可写评审线程分诊：在 propose 之上允许修改代码、发送回复并 resolve 线程（需 PSTACK_REVIEW_APPLY=1）。',
      order: 31,
      plugins: shared('apply'),
    },
  ]
}

