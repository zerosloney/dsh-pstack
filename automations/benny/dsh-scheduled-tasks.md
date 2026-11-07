# benny on DeepSeek Harness: Cursor Automations → scheduled tasks

Upstream `automations/benny/` is a Cursor **Automations** setup: a cloud agent that fires on a schedule, triages incoming issue reports, and opens a reproduction branch when a report looks actionable. DeepSeek Harness has no cloud automations, but it has scheduled tasks that deliver a prompt into a Session, either the calling one or a new one they open, which is the same shape: trigger → prompt → agent run.

This file maps the upstream configuration onto `schedule_create`, and says which parts still need a human.

## What carries over unchanged

| Upstream file | Use it as |
| --- | --- |
| `templates/triage-automation-prompt.md` | The `prompt` of the triage scheduled task. |
| `templates/reproduce-automation-prompt.md` | The `prompt` of the reproduce scheduled task. |
| `skills/triage-issue-reports/SKILL.md` | The routing rules the prompt names; install it before scheduling. |
| `skills/reproduce-and-fix-issues/SKILL.md` (+ `references/`) | The reproduction procedure; install it before scheduling. |
| `skills/setup-benny/SKILL.md` | Interactive setup. Run it once by hand; it asks the questions a scheduled task cannot. |
| `config.example.yaml` | The values to translate into `schedule_create` fields and the skill's configuration. |
| `FOR_AGENTS.md` | Read it once per session that touches benny. |

`automations/benny/skills/` is **not** in this plugin's skill root: upstream's `plugin.json` only points `skills` at `./skills/`, so these three skills are automation sub-steps, not session skills. To use them in DSH, either copy them under `.dsh/skills/` or point another `customSkillDirs` root at `automations/benny/skills/`.

## The schedule, correctly

`schedule_create` takes four fields: `title`, `prompt`, `rrule`, and `target`.

The `rrule` is an RFC 5545 subset: one `DTSTART` line (UTC suffixed with `Z`, or a `TZID`) and one `RRULE` line, separated by a newline.

`target` decides where the prompt lands. `this_session` reminds the calling Session. `new_once` reuses one new Session for every delivery. `new` opens a different new Session each time.

The older selector list (`after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, `cron`) is not part of the tool.

With `target: this_session` it is "remind this long-lived session to run triage", nothing more.

For a fresh Session per occurrence, use `target: new` or `target: new_once`. Each delivery carries only the prompt, so it must stand alone.

For an event trigger, a new issue rather than a clock, there are two honest options:

1. Webhook ingress. @deepseek-ai/dsh-webhook plus @deepseek-ai/dsh-webhook-github create root Sessions from signed GitHub deliveries, and the shipped github-review overlay is a working example. It needs a public HTTPS ingress, a webhook secret and a GitHub subscription. This deployment has none, so do not promise it.
2. Polling. Without ingress, decide on demand: node <pstack>/scripts/review-triage.mjs inbox lists what needs attention. A Windows scheduled task can run it and leave a file the next session reads:

       schtasks /create /tn pstack-inbox /tr "node <pstack>/scripts/review-triage.mjs inbox" /sc daily /st 08:00

Whichever route you take, the prompt still has to be self-contained and must end with report, do not push.

## What has no equivalent

| Upstream | DSH |
| --- | --- |
| Cursor's automation trigger UI (event-based, e.g. on new issue) | `schedule_create` is time-based only; event delivery needs `dsh-webhook` behind a public ingress. Without it, run the triage prompt manually or poll from a script and open a session. |
| Cloud sandbox with a pre-provisioned toolchain | The local checkout plus `git worktree`. |
| Bot identity and installed GitHub app | Whatever git/`gh` authentication the machine already has. |
| Automation run history | DSH session logs: `node <pstack>/scripts/session-transcript.mjs list --all`. |

## Verify before trusting it

1. Install the two skills, then run the triage prompt once **by hand** in a session and check the output.
2. Create the schedule with a near-future `DTSTART`, wait for one occurrence, and read that session's log:
   `node <pstack>/scripts/session-transcript.mjs list --json` then `show --session <id>`.
3. Only then move `DTSTART` to the real time.