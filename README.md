# dsh-pstack

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）移植版 **pstack**。内容是 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.15.36 的 Same-Bytes 移植：58 个工程技能、`poteto-mode` 主剧本与 23 个 playbook、24 条原则、2 份子代理定义、11 章使用指南，全部按原字节保留。

DSH 侧的适配有两块：一份 Cursor → DSH 对照文档，和一套 **DSH 原生编排**（会话预设 + 两个委派预设 + 模型路由 + transcript 工具），用来替换上游的 `subagent_type`、`pstack-models` 规则文件与 `agent-transcripts`。

> if you want to go fast, go deep first. pstack helps you write less, but higher quality code.

## 这是什么

pstack 在 Cursor 里是「技能包 + 子代理类型 + SessionStart hook」三件套。移植把每一件落到 DSH 的原生机制上：

| pstack 组件 | DSH 落点 |
| --- | --- |
| `skills/` 下的 59 个技能 | `@deepseek-ai/dsh-skill-filesystem` 技能提供方（文件系统扫描），进 `ctx.skills` 目录 |
| `/poteto-mode` 等斜杠入口 | 技能 frontmatter 的 `disable-model-invocation`，DSH 原样支持：用户可 `/名字` 调用，模型目录里隐藏 |
| `agents/poteto-agent.md`、`agents/comment-sicko.md` | 两个 **agent 预设**：人格来自这两份文件正文，工具面各自独立；`comment-sicko` 甚至没有 write/edit 工具 |
| `subagent_type: "poteto-agent"` 等 | `subagent` 的 `agent_preset` 参数，白名单由 `pstack` 会话预设在 `allowedAgentPresets` 里声明 |
| 每角色一个模型的 `pstack-models.mdc` | `subagent` 的 `provider` + `model` + `reasoning_effort` 参数；可用路由由 `list_subagent_models` 列出 |
| `~/.cursor/projects/*/agent-transcripts/` | `scripts/session-transcript.mjs`：按 cwd 推 slug、按帧解 zstd、`list` / `show` / `--grep` / `--tail` |
| `SessionStart` hook（会话启动注入路由） | `index.js` 注册的 `systemPrompt` 段落（可关） |
| `automations/benny/`（Cursor Automations） | DSH 定时任务（`schedule_create`），映射见 [automations/benny/dsh-scheduled-tasks.md](./automations/benny/dsh-scheduled-tasks.md) |

完整对照、逐条取舍与行为差异见 [COMPATIBILITY.md](./COMPATIBILITY.md)；会话内使用的工具名对照表见 [docs/harness/deepseek-harness.md](./docs/harness/deepseek-harness.md)。

### 适配完成度

| 层 | 状态 |
| --- | --- |
| 技能装载、用户 /名字 入口、disable-model-invocation 语义 | 完整（含新增的 review-triage） |
| 技能互调（read 技能文件）、技能写入根、脚本运行时 | 完整（bun 1.4.4 / node 24.21） |
| 子代理类型、只读子代理、模型路由、会话启动路由 | DSH 原生机制（预设 + 委派参数 + prompt 段落） |
| 评审线程 triage（Bugbot 的消费端） | 新增能力：propose 默认可用，apply 是配置开关 |
| transcript 读取与决策摘要 | DSH 原生：session-transcript / session-summary |
| 事件触发自动化 | DSH 有 webhook 机制，但本机无公网入口 → 轮询 |
| Bugbot 审查本体、Cursor 规则匹配语义 | 不替换，一行说明后跳过 |

逐格依据见 [COMPATIBILITY.md §0](./COMPATIBILITY.md)。

## 安装

用插件管理工具安装本目录（DSH bundle 安装会写 profile 的依赖与组合层，不要手写这些文件）：

```
plugin_manager action=install_bundle target=E:\Demo\cli-tools\dsh-pstack
```

或在 **设置 → 插件** 页面里安装。装好后：

- **新会话默认进入 `pstack` 预设**（与 shipped `standard` 同一套工具面 + pstack 委派）。想回到原来的 `standard`：在会话的预设下拉里选它，或在 `cordis.patch.yml` 里把 `agent-preset-registry` 的 `default` 改回 `standard`。
- 输入 `/poteto-help`，它会告诉你该用哪个技能；或输入 `/poteto-mode` 进主剧本；或直接依赖默认开启的路由指令。
- 委派时模型可传 `agent_preset: "poteto-agent"`（可写）或 `"comment-sicko"`（只读）。

卸载：`plugin_manager action=remove_bundle target=dsh-pstack`。

## 配置项

**pstack-router**（dsh-pstack 本体）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| enabled | true | 是否注入会话级路由指令 |
| order | 700 | 该 prompt 段落的排序位 |
| text | router.md | 整段替换指令文本；{{adapter}}、{{potetoMode}} 替换为绝对路径 |
| reviewTriage.apply | false | A2 开关：true 才注册可写的 review-triage-apply 预设。即使注册，脚本仍要求 PSTACK_REVIEW_APPLY=1 且 --yes |

**pstack-skills**（官方文件系统提供方，一个实例）

| 字段 | 值 | 含义 |
| --- | --- | --- |
| providerName | pstack | 与 profile 已有实例区分 |
| includeDefaultRoots | false | 只贡献本包的技能根 |
| watch | true | 技能目录被监视 |
| customSkillDirs | 包根/skills | 装载时由 !!js 解析 |

**agent-preset-registry**（覆盖 default）

| 字段 | 值 | 含义 |
| --- | --- | --- |
| default | pstack | 新会话默认预设；selectedDefault（用户在下拉里的选择）优先 |

五个 agent 预设由 presets.mjs 与 presets-review.mjs 定义，index.js 在装载时注册；要改工具面就改这两个文件。

## 目录结构

```
dsh-pstack/
├── package.json              # DSH bundle 清单
├── cordis.patch.yml          # 组合层补丁：插两行 + 默认预设 + reviewTriage 开关
├── index.js                  # 注册预设 + 路由段落
├── presets.mjs               # 会话预设 + 两个委派预设
├── presets-review.mjs        # 评审线程 triage 的两个预设（propose / apply）
├── presets/plan-mode.policy.md
├── router.md                 # 路由指令文本
├── skills/                   # 上游 58 个技能（逐字节）+ review-triage（本移植新增）
├── agents/                   # 2 份子代理定义（正文进预设）
├── docs/
│   ├── guide/                # 11 章指南 + 6 张配图
│   └── harness/
│       ├── claude-code.md
│       └── deepseek-harness.md   # Cursor → DSH 对照表
├── automations/benny/        # 上游素材 + dsh-scheduled-tasks.md
├── scripts/
│   ├── verify.mjs / verify-review.mjs   # 两段闸门（405 + 85 项）
│   ├── sync-upstream.mjs                # 上游逐字节闸门（需本地 checkout）
│   ├── review-triage.mjs                # 评审线程 triage
│   ├── session-transcript.mjs           # 会话日志读取（多帧 zstd）
│   └── session-summary.mjs              # 决策摘要
├── locale/{en,zh}.json
├── icon.svg
├── COMPATIBILITY.md / NOTICE.md / README.md / LICENSE
```

## 依赖声明

- **npm 依赖：无。** 只用 Node 内置模块（`node:fs`、`node:path`、`node:module`、`node:zlib`、`node:url`），Node ≥ 22.19。
- **Host 能力**：`systemPrompt` 必需（路由段落）；`agentPresets` 可选 —— headless/SDK 组合没有预设注册表时，插件只注册路由并告警，不报错。
- **随 dsh 发行的包**：`@deepseek-ai/dsh-skill-filesystem`（技能装载）、`@deepseek-ai/dsh-tool-skill`、`@deepseek-ai/dsh-subagent`/`-spawn-in-process`、以及三个预设里用到的工具包，全部由 harness 自带，本包不重复声明。
- **engines**：`dsh >=0.2.0-rc.0 <0.3.0-0`，`node >=22.19`。

## 与上游的差异

内容差异只有一处；其余逐字节相同（[NOTICE.md](./NOTICE.md) 有完整清单）：

1. `skills/poteto-mode/SKILL.md` 顶部插入一段（3 行）：进剧本前先读适配文档。
2. `README.md` 换成本文件；新增 `docs/harness/deepseek-harness.md`、`index.js`、`presets.mjs`、`router.md`、`scripts/`、locale、图标、对接文档。

需要留意的是**编排层不是逐字节移植**：`pstack` 会话预设是 shipped `preset-standard`（`@deepseek-ai/dsh-web-app` v0.2.2-rc.1）的一份镜像，只改了 delegation 组。DSH 的预设没有继承，要改会话工具面就得声明整份组合；上游一改 standard，`presets.mjs` 需跟着同步一次（文件里有版本注释）。

## 验证

```
node scripts/verify.mjs          # 405 项：技能契约、预设组合、补丁、插件行为、适配文档
node scripts/verify-review.mjs   # 85 项：review-triage 技能、工具自检、预设矩阵、摘要视图
node scripts/sync-upstream.mjs --upstream <dir>/pstack   # 与上游逐字节比对，需先 clone
```

`npm test` 跑前两条命令；上游字节契约不在 `npm test` 内，必须带本地上游 checkout 跑 `npm run verify:upstream -- --upstream <dir>/pstack`。

会话里确认：

- 新会话的预设下拉应出现 pstack、poteto-agent、comment-sicko、review-triage（apply 开关打开时再加 review-triage-apply）；
- 工具面应出现 subagent 与 subagent_fork；
- /poteto-help 给出路由建议；poteto-mode 只对用户可见；
- 评审线程：node scripts/review-triage.mjs inbox，再 plan / record / draft；
- 读历史对话：node scripts/session-transcript.mjs list | show，或 node scripts/session-summary.mjs 看决策摘要。

## 许可

上游作品 © 2026 Lauren Tan (poteto)，MIT。`presets/plan-mode.policy.md` 与 `pstack` 预设的工具面镜像自 DeepSeek Harness（MIT，© 2026 DeepSeek）。本移植的打包层与适配文档见 [NOTICE.md](./NOTICE.md)。再分发需保留 [LICENSE](./LICENSE) 与 NOTICE 中的全部版权声明。