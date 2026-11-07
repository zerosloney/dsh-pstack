# pstack in DeepSeek Harness

pstack skills use Cursor names. In DeepSeek Harness (DSH), read this file once per session before following any pstack skill — that includes the ones you enter directly with `/how`, `/why`, `/recall`, `/tdd`, without passing through `/poteto-mode` — then map each Cursor name with the tables below. `<pstack>` means the folder that holds `skills/` and `docs/`: the install root of this plugin, three directories above `skills/<name>/SKILL.md`.

## Orchestration this deployment provides

The plugin registers three agent presets with the Host preset registry:

| Preset | Role | Tool surface |
| --- | --- | --- |
| `pstack` | Session preset (the default for new sessions) | Same tools as `standard`, plus `subagent` / `subagent_fork` with pstack personas selectable through `agent_preset`. |
| `poteto-agent` | Delegate for implementation work | fs, search, shell, jobs, skill, todo, web, present, compaction. No `ask_user_question`, no nested delegation. |
| `comment-sicko` | Read-only comment review | fs with **no write and no edit tool**, search, shell (`git diff`), skill, compaction. |

That is the DSH replacement for Cursor's `subagent_type`: the same two personas, but as real compositions with their own tool surfaces and a hard read-only guarantee for the reviewer.

## Tools

| Cursor | DeepSeek Harness |
| --- | --- |
| `Task` | The delegation tool your preset exposes: `subagent` (fresh child) or `subagent_fork` (child inherits your context). On the `pstack` preset both exist. If neither is in your tool list, say so in one line and do the work in-process. |
| `Task` + `subagent_type: "poteto-agent"` | `subagent` with `agent_preset: "poteto-agent"`. The child reads `poteto-mode` itself; still pass the absolute path you hold in the brief. |
| `Task` + `subagent_type: "comment-sicko"` | `subagent` with `agent_preset: "comment-sicko"`. Its tool surface is already read-only; no "do not edit" instruction needed. Usually reached through the **no-comments** skill. |
| `subagent_type: "generalPurpose"` | Omit `agent_preset`: the child inherits the `pstack` preset, which is the pstack-shaped general delegate. |
| `readonly: true` | Use `comment-sicko` for review, or say "do not edit files" in the brief and check `git status` afterward. |
| `environment: "cloud"` / `cloud_base_branch` | Create a `git worktree` at the branch or commit, then pass its path as the delegation `cwd`. |
| `run_in_background: true` | Omit. Children are managed and notify you when they finish; keep working on independent steps instead of polling. |
| `resume` | `send_message` to the child's id. |
| `model: <cursor-slug>` | Pass `provider` and `model` together (see [Model routing](#model-routing)). |
| `AskQuestion` | `ask_user_question`. Reserve it for a genuine product or preference call; a fact you could observe is not the human's to answer. |
| Open a todolist | `todo_write` |
| Run another pstack skill (`/name`, "the **name** skill") | `read` the file: `<pstack>/skills/<name>/SKILL.md`. **Do not use `skill`**: all but `setup-pstack` set `disable-model-invocation`, so the tool refuses them. A user may still type `/name`. |
| `Read` | `read` (text) or `read_image` (images) |
| `Grep`, `Glob` | `grep`, `glob` |
| `Write`, `Edit`, `MultiEdit` | `write`, `edit` |
| `Shell` / `Bash` | `pwsh` on Windows, a bash tool elsewhere. Long commands go to a background job; collect with `job_output`, stop with `job_kill`. |
| `WebFetch`, `WebSearch` | `web_fetch`, `web_search` |
| `present`-style file delivery | `present` for complete deliverables; otherwise link files in the reply. |

`agent_preset` only exists when the session runs the `pstack` preset, because that preset is what sets `allowedAgentPresets`. Check your `subagent` schema before you use it. When the schema lists no `agent_preset`, say in one line that the session is not on the `pstack` preset, then delegate without a persona. The work still runs, without the shipped persona; `comment-sicko`'s read-only guarantee is gone with it, so a read-only job needs "do not edit files" in the brief instead.

## Model routing

Two mechanisms, no rule file required for correctness:

- **Per-delegation route**: `subagent` accepts `provider` and `model` **together**, plus an optional `reasoning_effort`. Omitting both makes the child inherit the parent's route; `inherit-parent` and `auto` from the Cursor rule mean exactly that — omit.
- **Discovery**: the `pstack` preset registers `list_subagent_models`, which lists the routes this session can actually use. Prefer that list over any remembered slug.

Role → model choices stay in the always-applied `~/.dsh/AGENTS.md`, inside a stable marker block, because DSH loads that file into every session (the equivalent of Cursor's `alwaysApply: true` rule):

```markdown
<!-- pstack-models:begin -->
# budget: large (xhigh)
feature, refactoring, bug fix: <provider>/<model>
how explorer: <provider>/<model>
how explainer: <provider>/<model>
arena runners: <provider>/<model>, <provider>/<model>
<!-- pstack-models:end -->
```

When `/setup-pstack` runs, write this block, not `~/.cursor/rules/pstack-models.mdc`. Keep the skill's one-line-per-role shape, take every value from `list_subagent_models`, and treat `inherit-parent` or `auto` as "omit the route". A role missing from the block falls back to the skill's literal default, which is a Cursor slug here, so say you are on the inherited route instead of passing it.

Rules that keep this honest:

- Never write a Cursor slug (`grok-4.7-xhigh-fast`, `claude-opus-5-5-xhigh`); DSH routes are `provider/model` ids from the profile's `settings.yaml`.
- A rejected route is not a reason to retry with a guess: omit `provider`/`model`, use the inherited route, and say so in one line.
- Do not write `~/.cursor/rules/`, and do not invent a `.dsh/rules/` directory: DSH has no rule-file registry.

## Paths and state

pstack names four Cursor locations. Every mention in a skill means the DSH location below; the shim wins over the skill's literal path.

| Skill says | Read and write here instead |
| --- | --- |
| `~/.cursor/projects/<workspace-slug>/agent-transcripts/` | `$DSH_HOME/sessions/<workspace-slug>/session-<id>/session.v4.jsonl.zstd`. Use the bundled helper instead of hand-decoding: `node <pstack>/scripts/session-transcript.mjs list` (metadata, newest first) and `show [--session <id>] [--grep <text>] [--tail <n>]` (decompressed JSONL). Keep the skill's boundary rule: read only the active workspace, never other slugs. |
| a `.jsonl` transcript path | The helper above. The file is a chain of zstd frames — one per event — so a plain single-shot zstd decode returns only the header. |
| `.cursor/skills/<name>/` or `~/.cursor/skills/<name>/` | Project skills: `.dsh/skills/<name>/`. Personal skills: `~/.agents/skills/<name>/`. Both are scanned live. Never write under `plugins/cache/` or `~/.cursor/`. |
| `~/.cursor/rules/pstack-models.mdc` | The `pstack-models` block in `~/.dsh/AGENTS.md` (see [Model routing](#model-routing)). |

## Subagent briefs

When a skill tells you to spawn a named subagent, the preset supplies the persona and the tools; your brief supplies the job. Still do these three things:

1. Name the goal, the acceptance check, and the smallest change you expect (poteto-mode's rule).
2. Pass the absolute skill paths you already hold; the child starts with no context.
3. Say whether the child may edit. `comment-sicko` cannot, and `poteto-agent` can.

A child that skips its first read drifts the way upstream warns `generalPurpose` does — the persona is in the preset, but the playbook is in the skill, so the brief must point at it.

## Review triage

Cursor ships Bugbot, a review bot whose comments pstack triages in its Babysit playbook. DSH has no Bugbot, but the triage half is now a first-class capability:

- The rubric is unchanged: skills/poteto-mode/references/bugbot-triage.md.
- The loop is skills/review-triage/SKILL.md plus scripts/review-triage.mjs: inbox lists your PRs and unresolved threads; plan prints one JSON object per thread; record stores fix / dismiss / ask with a reason and a reply; draft produces the reviewable file; apply posts and resolves.
- Two presets carry it: review-triage (propose: no write or edit tools) and review-triage-apply (writable, registered only when the bundle config sets reviewTriage.apply: true). Apply also requires PSTACK_REVIEW_APPLY=1 and --yes.
- Polling, not webhooks. This deployment has no public ingress, so nothing calls you. Run inbox at the start of a babysit pass, or from a session that is already open.
- Producing reviews is out of scope. Bugbot, Copilot review and CodeRabbit are reviewers; this loop only consumes their threads. Run interrogate or code-review on the branch to produce reviews, then triage what comes back.

## Event-triggered automation

DSH does ship the mechanism Cursor calls Automations: @deepseek-ai/dsh-webhook plus @deepseek-ai/dsh-webhook-github turn signed GitHub deliveries into root Sessions, and the shipped github-review overlay is a working example. It needs a public HTTPS ingress and a GitHub webhook subscription; this deployment has neither.

- Do not promise event-driven runs.
- A time trigger is `schedule_create`, which takes `title`, `prompt`, an RFC 5545 `rrule` (one DTSTART line, then one RRULE line), and a `target`: `this_session` reminds the current Session, `new_once` reuses one new Session for every delivery, `new` opens a fresh Session each time. The Cursor-era selector list (`after_seconds`, `daily`, `cron`) is not part of the tool.
- Without ingress, poll: run review-triage inbox when a session is open, or let a Windows scheduled task run it and write a file the next session reads.

## What stays degraded

State the one-line note and continue; do not improvise a substitute.

| Area | Affected skills | Why, and what to do |
| --- | --- | --- |
| Install and marketplace prose | poteto-help, docs/guide/01-setup.md | They describe Cursor's /add-plugin and Claude Code's /plugin install. On DSH the answer is plugin_manager (install_bundle / remove_bundle) or Settings then Plugins. |
| Cursor-only help prose | poteto-help | Its Custom Modes, `/loop`, `cursor-team-kit`, and `cursor.com` links have no DSH counterpart. Answer with this harness's surfaces: `/poteto-mode` per task, `schedule_create` for repeats, `plugin_manager` for other plugins. |
| Review-bot production | none | Nothing here writes reviews. Bugbot, Copilot review and CodeRabbit are reviewers; this loop consumes their output. |
| Event-driven automation | automations/benny | Needs public ingress (see above). Poll instead; benny's DSH mapping has the poll commands. |
| Cursor-only host semantics | recall, reflect, show-me-your-work | DSH records approval/asked, approval/decided, model/selection, agent-preset/selected, workspace/changes and agent-instructions messages. It does not record which Cursor rule files matched, because that concept does not exist here. Read what exists with scripts/session-summary.mjs instead of claiming data is missing. |
| Plugin cache edits | reflect, create-verification-skill, automate-me | plugins/cache/ does not exist here. Write the new skill to .dsh/skills/ or ~/.agents/skills/. |
| Worktree-audit transcript signal | poteto-mode (worktree-cleanup playbook) | `scripts/worktree-audit.sh` greps `~/.cursor/projects/*/agent-transcripts` for plain JSONL, so on DSH its LAST_CHAT column stays `-` and the `verify-recent-chat` bucket never fires. Supply the signal yourself: before bucketing a worktree as safe, grep recent sessions for its path — `node <pstack>/scripts/session-transcript.mjs show --grep "<worktree-path>"` — and treat an unknown history as recent. |
| External plugin skills and Cursor built-ins | poteto-mode playbooks, automate-me, reflect, poteto-help | `/deslop`, `control-cli` and `control-ui` ship in the cursor-team-kit plugin; `/create-skill`, `/loop` and `/autopilot` are Cursor built-ins. None exist here. Say so in one line and continue: unslop covers deslop's job, and a new skill is a SKILL.md written to `.dsh/skills/` or `~/.agents/skills/`. |
| make-bot-ui routine plumbing | make-bot-ui | Its `update_state` / `SendToUser` calls and the `api2.cursor.sh` webhook are Cursor routine automation. On DSH a button that wakes an agent is `schedule_create` with `target: this_session`, or the webhook runtime when a public ingress exists. |

## Reply style

The playbooks push long reports. DSH renders Markdown in the Web UI, so keep that: headings, tables, and fenced code stay. Do not emit terminal-only decoration, and do not call a tool merely to prove a diff view exists.