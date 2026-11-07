# 移植对照（COMPATIBILITY）

本文件回答两件事：上游的每个构件按 DSH 插件规范落到了哪里，以及落不到的地方差在哪。上游来源见 [NOTICE.md](./NOTICE.md)。

## 0. 适配完成度

按 DSH 的能力边界逐格判定，不做能力声明上的美化：

| 维度 | 状态 | 落地机制 / 依据 |
| --- | --- | --- |
| 技能装载（上游 58 + 本移植新增 review-triage） | 完整 | pstack-skills 行 active；目录条目实测 |
| 用户 /名字 注入、模型侧跨技能调用 | 完整 | disable-model-invocation 原义生效；跨技能调用走 read 技能文件 |
| 子代理类型（poteto-agent / comment-sicko） | DSH 原生替换 | 两个 agent 预设 + subagent 的 agent_preset 白名单 |
| 只读子代理 | 强于上游 | comment-sicko 预设没有 write/edit 工具 |
| 会话启动路由（补 SessionStart） | 替代物 | 全局 systemPrompt 段落；enabled: false 可关 |
| 新会话默认带编排 | 完整（用户显式选择优先） | agent-preset-registry 的 default 指向 pstack；用户在预设下拉里选过别的，selectedDefault 会盖过它 |
| 模型路由（角色 → 模型） | DSH 原生替换 | subagent 的 provider/model/reasoning_effort + list_subagent_models |
| 评审线程 triage（Bugbot 消费端） | 新增能力 | skills/review-triage + scripts/review-triage.mjs；propose 预设默认可用，apply 预设由 reviewTriage.apply 开关 |
| transcript 读取与决策摘要 | DSH 原生替换 | scripts/session-transcript.mjs（多帧 zstd）+ scripts/session-summary.mjs（审批、注入指令、技能、工具、失败、文件） |
| 事件触发自动化 | DSH 原生有，本机不可用 | dsh-webhook + dsh-webhook-github 存在且官方有 github-review 示例；本部署无公网入口，故改为轮询 |
| 时间触发 | 受限 | schedule_create 取 title、prompt、rrule、target；没有事件触发 |
| Bugbot 本体、Cursor 规则匹配语义 | 不替换 | 前者是私有审查服务，后者在 DSH 概念里不存在；用一行说明跳过 |

一句话：技能层完整；编排层已换成 DSH 原生机制（预设、委派参数、随包工具）；新增了上游没有的评审线程 triage；剩下的不可替换项只剩 Bugbot 的审查本体与 Cursor 私有的规则匹配语义。

## 1. 清单：Agent Plugins 1.0.0 → DSH bundle

上游同时带两份清单（根 `plugin.json` 是 Agent Plugins 标准，`.cursor-plugin/plugin.json` 是 Cursor 封装）。DSH 只认 `package.json`，两份都不装载，因此本移植不携带它们，字段逐条落到 `package.json`：

| 上游字段 | DSH 落点 | 说明 |
| --- | --- | --- |
| `name: pstack` | `name: dsh-pstack` | 包名即 Loader 里的模块名；与已安装的 `pstack` 技能根重名会互相遮蔽 |
| `version: 0.15.36` | 同值 | 跟随上游版本号，便于 diff |
| `description` | 同值中文化 | 同时写进 `locale/*.json` 的 `meta.description`（插件管理器读的是 locale，不是 package.json） |
| `author` / `homepage` / `repository` / `license` | 同值 | `license: MIT` 必须是 SPDX 标识 |
| `keywords` | 保留并补 `dsh`、`deepseek-harness` | |
| `skills: "./skills/"` | `cordis.patch.yml` 的 `pstack-skills` 行 | DSH 没有「清单声明技能目录」字段，技能根由 `dsh-skill-filesystem` 的 `customSkillDirs` 提供 |
| `agents: "./agents/"` | 不给清单声明；改由适配文档与委派简报携带 | 见 §3 |
| `logo: assets/logo.png` | `icon.svg` + `exports["./icon"]` | 上游位图 361 KB；本移植另画了等义的矢量图标，避免把大图塞进插件图标位 |
| `category` / `tags` / `displayName` | `locale/*.json` 的 `meta.title` | DSH 侧可见面只有标题与描述 |
| 无 | `dsh.bundle.patch: "./cordis.patch.yml"` | DSH bundle 的入口声明 |
| 无 | `engines.dsh` / `engines.node` | 安装门禁 |

上游的 `hooks/`（Claude Code 专用 hook 清单）在上游 Cursor 包中并不存在，本移植也没有新增 Claude 风格 hook：DSH 的 hook 概念是 Event listener，绑定在插件上下文里，不是 YAML 钩子清单。

## 2. 技能：58 个目录，逐字节

| 项 | 上游 | DSH |
| --- | --- | --- |
| 目录形态 | `skills/<name>/SKILL.md` + `references/` + `playbooks/` + `scripts/` | 相同，未改一个字节 |
| frontmatter | `name` / `description` / `disable-model-invocation` / `icon` / `color` / `paths` | `name`、`description`、`disable-model-invocation` 被 DSH 原样解释；`icon`、`color`、`paths` 是 DSH 忽略字段，保留但无行为 |
| 模型可见性 | `disable-model-invocation: true` 让 `/poteto-mode`、`/bd` 等只能由用户发起 | 同语义：不进 `<available_skills>`，但 `/poteto-mode` 仍可注入 |
| 用户调用 | Cursor 斜杠命令，Claude Code 是 `/pstack:<name>` | `/poteto-mode`（无前缀，DSH 不重命名插件命令） |
| 技能互调 | 「跑 **how** 技能」= `Read <pstack>/skills/how/SKILL.md` | **读文件**：`read <pstack>/skills/<name>/SKILL.md`。不能用 `skill` 工具：59 个技能里 57 个带 `disable-model-invocation`，`skill` 会以 "not available for model invocation" 拒绝（实测），例外是 `setup-pstack` 与 `review-triage`。装载结果头部自带 `Base directory`，所以上游「把绝对路径塞进每个 prompt」的做法不需要改写路径 |
| 相对链接 | 相对 SKILL.md 解析 | 相同；DSH 的装载头已经给出基目录 |
| 目录刷新 | 插件重装 | 提供方开 `watch`，增删改在下一轮目录刷新，不必重启 |
| 重名优先级 | 同一名字只有一份 | DSH 按来源排优先级（项目 `.dsh/skills` 100 < 项目 `.agents/skills` 200 < 本包 `customSkillDirs` 300 < `~/.dsh` 400 < `~/.agents` 500），低者胜。本包与用户 `~/.agents/skills` 目前有 3 个同名技能（`setup-pstack`、`tdd`、`teach`），因此这 3 个在会话里解析到本包版本；项目里的同名技能仍然优先。 |

`skills/poteto-mode/SKILL.md` 是全包唯一被改的技能文件：正文顶部插入 3 行，要求进剧本前先读适配文档。改动理由见 §6。

## 3. 子代理：`agents/*.md` → 两个 agent 预设

上游把 `agents/*.md` 声明成 `subagent_type`，由宿主按类型注入系统提示。DSH 的对应物是 **agent 预设**：一份完整组合（人格、工具、压缩策略），可以由父代理在委派时按 `agent_preset` 选择。

- 落地方式：`presets.mjs` 生成三份 `PresetDefinition`，`index.js` 在装载时调 `ctx.agentPresets.register()` 注册：
  - `poteto-agent`：人格 = `agents/poteto-agent.md` 正文（去掉 frontmatter），工具面 = fs / 检索 / shell / jobs / skill / todo / web / present / 压缩；**不挂** `ask_user_question`（问题归父代理）、**不挂** 委派工具（深度 1）。
  - `comment-sicko`：人格 = `agents/comment-sicko.md` 正文，工具面 = 只读 fs（`write: false, edit: false`）/ 检索 / shell（`git diff`）/ skill / 压缩。
  - `pstack`：会话预设，见下条。
- 为什么这次不把人格塞进 brief：预设才是 DSH 的 per-type 机制。上游把「人格钉死」当作保证，brief 只能当约定。现在人格在预设里、工具面也在预设里，孩子不会因为 brief 写得松就跑偏。
- 只读比上游更硬：上游靠 `readonly: true` 加口头的「别改文件」，本移植的 `comment-sicko` 预设**根本不存在** `write`/`edit` 工具，孩子想做也做不到；`git status` 复核仍保留。
- 会话预设 `pstack`：`@deepseek-ai/dsh-web-app` 的 `preset-standard`（v0.2.2-rc.1）的一份镜像，只把 delegation 组换成带 `allowedAgentPresets: [poteto-agent, comment-sicko]` 的 `subagent`。工具面与 standard 一致，所以把它设为新会话默认不会让用户失去已有能力（含 plan mode、plugin manager）。
- 代价（明说）：standard 的上游变更需要跟着同步一次（`presets.mjs` 里的注释标了来源版本）。这是「用 DSH 编排」的入场费：DSH 预设没有继承，要改一个会话的工具面就得声明整份组合。若只想保留 minimal 也能跑，可把 `pstack` 预设的 `plugins` 收窄，但那就不是 standard 等价物了。

## 4. 会话启动路由：hook → system prompt 段落

上游靠 `SessionStart` 之类的宿主钩子，在会话开始时注入一段路由指令；Cursor 侧靠 `/poteto-mode` 手动进入。DSH 没有 session-start 钩子，但有全局 `systemPrompt` 注册表。

- `index.js` 注册一条 `order: 700` 的段落，文本放在 `router.md`，内容逐句对应上游的 session-start 上下文：三条路由条件、小任务直接做、意图明确时直接进技能、用户指令优先。
- 文本里的 `{{adapter}}` 在装载时替换成 `docs/harness/deepseek-harness.md` 的绝对路径，解决「模型不知道插件装在哪」的问题。
- **默认开启**，与上游钩子默认开启一致；`config.enabled: false` 关闭。这是本移植唯一主动影响全局提示的行为，所以单独给出开关，并把它放在 team policy 之后、工具说明之前，避免压过用户自己的 `AGENTS.md`。
- 差异：段落每次装配都会参与，而不是只在会话首轮；内容恒定，代价是每轮固定几十个 token。

## 5. 自动化：`automations/benny/`

上游是 Cursor Automations（云端定时代理）的配置与提示词。DSH 的等价物是定时任务，映射写在 [automations/benny/dsh-scheduled-tasks.md](./automations/benny/dsh-scheduled-tasks.md)：

- `schedule_create` 取四个字段：`title`、`prompt`、`rrule`、`target`。`rrule` 是 RFC 5545 子集，一行 `DTSTART` 加一行 `RRULE`；`target` 取 `this_session`（投进当前会话）、`new_once`（每次复用同一个新会话）或 `new`（每次开新会话），上游那套 `after_seconds` / `daily` / `cron` 选择器不存在。事件触发仍由 webhook runtime 提供，需要公网入口；本机没有，所以 benny 的 DSH 映射改为轮询。
- `automations/benny/skills/` 下的 3 个技能**不在** `customSkillDirs` 里：上游 `plugin.json` 的 `skills` 只指向 `./skills/`，它们属于自动化子流程。要用时把该目录加成第二个技能根，或按 `FOR_AGENTS.md` 的指引创建成项目技能。
- 去掉的部分：云端沙箱（改 `git worktree`）、事件触发（DSH 只有时间触发，事件需手动或外部轮询）、automation 专用 bot 身份与运行历史（改看 DSH 会话日志，用 `scripts/session-transcript.mjs list --all`）。
- 保留的约束：定时运行拿不到交互审批，所以提示词要求「留分支 + 汇报」，不直接推 PR。

## 6. 被改写的文件

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `skills/poteto-mode/SKILL.md` | 正文第 11 行后插入 3 行（1 段） | 主剧本是入口，模型必须知道 Cursor 名字要按适配表翻译，否则会去找不存在的 `Task` / `subagent_type` / `~/.cursor/plugins` |
| 无其他技能改动 | — | 64 个技能文件、2 份代理、11 章指南、12 个自动化文件逐字节等于上游 v0.15.36 |

另外 `README.md` 被替换为中文打包说明（安装、配置项、依赖、目录、验证），上游原文的 Cursor 安装段与 marketplace 说明对本移植不适用；上游 `plugin.json`、`.cursor-plugin/plugin.json`、`assets/logo.png` 未携带，理由见 §1。

本移植新增的文件（都不覆盖上游）：

| 文件 | 作用 |
| --- | --- |
| `index.js` | 注册三个 agent 预设 + 路由段落 |
| `presets.mjs` | 三份预设组合的定义（`pstack` 会话预设是 shipped `preset-standard` 的镜像） |
| `presets/plan-mode.policy.md` | 从 shipped `preset-standard` 逐字提取的 plan-mode 策略文本，用来在新预设里挂同一个 `dsh-plan-mode` |
| `router.md` | 会话路由指令（等价上游 session-start 上下文） |
| `cordis.patch.yml` | bundle 补丁：插两行 + 把新会话默认预设指向 `pstack` |
| `scripts/session-transcript.mjs` | transcript 替换物：按 cwd 推 slug、按帧解 zstd |
| `scripts/verify.mjs` | 静态 + 单测闸门（381 项） |
| `scripts/sync-upstream.mjs` | 上游逐字节闸门：报出意外漂移与过期期望（需本地 checkout） |
| `docs/harness/deepseek-harness.md` | Cursor → DSH 对照表 |
| `automations/benny/dsh-scheduled-tasks.md` | Automations → `schedule_create` 映射 |
| `locale/*.json`、`icon.svg`、`README.md`、`COMPATIBILITY.md`、`NOTICE.md` | 打包层 |

`docs/harness/claude-code.md` 原样保留：它讲的是 Claude Code，但表格结构就是 DSH 适配文档的模板，保留它对读得懂上游的人有用。

## 7. 未移植 / 不可移植

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Cursor /add-plugin 与 marketplace 流程 | 跳过 | 换成 plugin_manager install_bundle |
| Cursor 斜杠前缀 | 不适用 | DSH 不加前缀 |
| Bugbot 的审查本体 | 不替换 | 私有服务；本移植只接管它产生的线程（见 §9） |
| 事件触发 Automations | 有条件可用 | DSH 有 webhook runtime 与 GitHub 适配器，需公网入口；本机没有，改用轮询 |
| environment: cloud / cloud_base_branch | 等价降级 | git worktree + 委派工具的 cwd |
| resume 子代理 | 等价 | send_message 继续同一个 child |
| bun 运行时（bootstrap.ts、watch-pr） | 环境相关 | 本机 bun 1.4.4 可用；缺运行时须报告而不是自装 |
| statechart 的 TLA+/Java 语料 | 保留 | 纯数据与脚本，工具链存在时才跑 |
| 上游 assets/logo.png | 替换 | 改为自绘 icon.svg |
| Cursor 规则文件匹配过程 | 不可替换 | DSH 没有 rule-file registry；已注入的 instructions 仍以 message 事件记录，可用 session-summary 读 |
| ~/.cursor/projects/*/agent-transcripts | 替换 | session-transcript.mjs：按 cwd 推 slug、按帧解 zstd、list/show/--grep/--tail；worktree-audit.sh 内的硬编码路径不在替换范围，降级与替代命令见适配文档 degraded 表 |
| ~/.cursor/rules/pstack-models.mdc | 替换 | 角色表写 ~/.dsh/AGENTS.md；实际路由由 subagent 的 provider+model 表达 |
| .cursor/skills/、~/.cursor/skills/ | 映射 | .dsh/skills/、~/.agents/skills/ |
| plugins/cache/ | 不存在 | 写入类技能改目标为 .dsh/skills 或 ~/.agents/skills |

## 8. 验证记录

编排层落地后（desktop profile，DSH 0.2.2-rc.1）：

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | install_bundle | applied；依赖与 bundles 均含 dsh-pstack |
| 2 | 装载状态 | pstack-router / pstack-skills 均 active |
| 3 | 技能目录 | setup-pstack 描述已是上游 0.15.36 原文，证明 customSkillDirs 压过 ~/.agents |
| 4 | 隐藏语义 | skill poteto-mode 报 not available for model invocation；未知名字报 unknown — 两句不同即证明前者在册 |
| 5 | 静态闸门 | node scripts/verify.mjs：381 项 |
| 6 | 评审闸门 | node scripts/verify-review.mjs：61 项 |
| 7 | 预设 config 对真 schema | 用 profile 内真实包逐个跑 Config：37 个通过，0 失败 |
| 8 | 委派能力 | spawn 的 capabilities.agentPreset=true；fork=false，故 fork 不带白名单 |
| 9 | 真实会话日志 | 1.42 MB / 698 帧 → 1263 行，100% 可 JSON.parse |
| 10 | 决策摘要 | session-summary 在真实日志上输出 session / approvals / instructions / tools；fixture 覆盖审批对、注入指令、技能读取、失败、文件 |
| 11 | review-triage 真实 GraphQL | plan/draft 对 cursor/plugins#1182、#1179 返回结构正确（0 线程），证明查询与分页路径可用 |
| 12 | gh 可用性 | gh 2.96.0，账号 zerosloney，scopes 含 repo |

生效时机：index.js、presets*.mjs、router.md 由 loader 在进程启动时加载，需重启 dsh；技能文件由 watch 实时刷新。

## 9. 评审线程 triage（A1 propose / A2 apply）

上游的 bugbot-triage.md 是一份决策规则（fix / dismiss / ask + 可累积的 skip patterns），但没有读取线程、回复、resolve 的工具。本移植补上这一半：

- skills/review-triage/SKILL.md：把规则变成可执行流程，并定义无人值守时 ask 的降级（留问题、不 resolve、不改编）。
- scripts/review-triage.mjs：inbox（列我的 PR 与未决线程）、plan（逐线程 JSON）、record（存判定与回复）、draft（可评审的 markdown）、apply（发回复 + resolve；ask 裁决只发回复、不 resolve）、state。
- 幂等：判定记录它所依据的 head SHA；head 变化即判为 stale，apply 跳过 stale 与已 apply 的线程。
- A1：review-triage 预设没有 write/edit，流程止于 draft。
- A2：review-triage-apply 预设由 cordis.patch.yml 的 reviewTriage.apply 控制注册；即使注册，脚本仍要求 PSTACK_REVIEW_APPLY=1 且 --yes。
- 事件源：本机无公网入口，用轮询（inbox）而不是 webhook。