# NOTICE — pstack 的 DeepSeek Harness 移植

本目录是 **第三方 MIT 内容的打包移植**：把 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) 重新打包为 DeepSeek Harness 插件（bundle）。技能正文、代理简报、使用指南与自动化素材逐字节保留；DSH 适配层是本移植新增的部分。

## 上游来源

| 项 | 值 |
| --- | --- |
| 上游仓库 | [cursor/plugins](https://github.com/cursor/plugins) |
| 上游目录 | `pstack/` |
| 上游版本 | `0.15.36`（`plugin.json` / `.cursor-plugin/plugin.json`） |
| 上游提交 | `2776ddd2355d6d6c8747d3964600f28daf62f049`（2026-11-05，`main`） |
| 上游作者 | Lauren Tan (poteto) |
| 上游许可 | MIT，© 2026 Lauren Tan（正文见 [`LICENSE`](LICENSE)） |
| 本移植 | DeepSeek Harness 打包层、`docs/harness/deepseek-harness.md`、`index.js` / `router.md`、README/COMPATIBILITY/NOTICE、`icon.svg` |

## 逐组件归属

| 路径 | 来源 | 本移植改动 |
| --- | --- | --- |
| `skills/`（58 个技能目录，535 个文件） | 上游 | 仅 `poteto-mode/SKILL.md` 正文插 1 段（3 行）；其余逐字节相同 |
| `agents/poteto-agent.md`、`agents/comment-sicko.md` | 上游 | 无 |
| `docs/guide/`（11 章 + 6 图） | 上游 | 无 |
| `docs/harness/claude-code.md` | 上游 | 无 |
| `automations/benny/`（12 个文件） | 上游 | 无 |
| `LICENSE` | 上游 | 无 |
| `package.json` / `cordis.patch.yml` / `index.js` / `router.md` | 本移植 | 新增 |
| `presets.mjs` / `presets/plan-mode.policy.md` | 本移植（含 DeepSeek Harness 内容） | 新增。三份预设中 `pstack` 会话预设的工具面镜像自 `@deepseek-ai/dsh-web-app` 的 `preset-standard`（v0.2.2-rc.1），`plan-mode.policy.md` 是该文件里 plan-mode 策略文本的逐字提取；两者随 DSH 的 MIT 许可（© 2026 DeepSeek）使用 |
| `scripts/session-transcript.mjs` | 本移植 | 新增（transcript 读取，多帧 zstd） |
| `automations/benny/dsh-scheduled-tasks.md` | 本移植 | 新增（Automations → `schedule_create` 映射） |
| `docs/harness/deepseek-harness.md` | 本移植 | 新增（Cursor → DSH 对照表） |
| `README.md` | 上游 | **替换**为中文打包说明（安装、配置项、依赖、目录）；上游原文的 Cursor 安装段不再适用 |
| `COMPATIBILITY.md` / `NOTICE.md` | 本移植 | 新增（移植对照 / 来源与改动清单） |
| `locale/en.json` / `locale/zh.json` / `icon.svg` | 本移植 | 新增 |
| `scripts/verify.mjs` / `scripts/verify-review.mjs` | 本移植 | 新增（静态 + 单测闸门，两段共 441 项） |
| `scripts/review-triage.mjs` | 本移植 | 新增（评审线程 triage：list/plan/record/draft/apply，幂等状态） |
| `scripts/session-summary.mjs` | 本移植 | 新增（会话决策摘要：审批、注入指令、技能、工具、失败、文件） |
| `skills/review-triage/SKILL.md` | 本移植 | 新增（把上游 bugbot-triage 规则变成可执行流程；上游无此技能） |
| `presets.mjs`（评审部分移出） | 本移植 | 见 `presets-review.mjs` |

上游的 `plugin.json`、`.cursor-plugin/plugin.json`、`assets/logo.png` 未随移植携带：前两者是 Cursor/Agent Plugins 的清单形态，DSH 只认 `package.json`；logo 位改用本移植自绘的 `icon.svg`（等义图形，不复制上游位图）。

## 上游技能内的第三方引用

上游技能正文提到少量 Cursor 内部能力（Bugbot、Automations、Plan mode、Cursor models）。这些是**引用**而非内嵌代码，本移植未携带任何 Cursor 私有实现；[`COMPATIBILITY.md`](COMPATIBILITY.md) 第 7 节逐条说明了对应关系与跳过方式。

`skills/statechart/` 目录内包含上游自带的 TLA+/Java 测试语料（`scripts/test/corpus/`），随上游 MIT 许可分发。

## 再分发条件

保留本文件与 [`LICENSE`](LICENSE) 中的全部版权声明与许可正文。修改过的文件须注明修改事实（上表已列）。上游作品名称与作者不得被用于暗示本移植由上游背书。

## 免责

上游与本移植均按 MIT「AS IS」提供。pstack 的技能会在用户仓库里执行读写与命令；技能文本本身不含凭据，也不含自动安装运行时的步骤。DSH 侧实际的沙箱与审批策略由 profile 决定，与本包无关。