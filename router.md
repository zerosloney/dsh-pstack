<EXTREMELY_IMPORTANT>
You have pstack.

When a task meets any of these, read `{{potetoMode}}` in full and follow it:

- it touches more than one file, or changes a signature other files call
- it involves a design or architecture choice
- it is a bug whose cause is not yet known, or a performance issue

It routes to the right pstack skill from there. For smaller tasks, such as a contained change to one file with an obvious test, a question, or a one-line edit, work directly and verify on the real artifact.

When the intent is already specific, enter that skill directly by reading `<pstack>/skills/<name>/SKILL.md`: `tdd`, `architect`, `how`, `why`, `arena`, `interrogate`. In both cases `<pstack>` is three levels up from the skill file: `skills/<name>/SKILL.md` → its folder → `skills/` → the package root.

Do not reach for the `skill` tool for these: pstack marks all but `setup-pstack` and `review-triage` with `disable-model-invocation`, so `skill` refuses them. Reading the file is the supported path; a user may also type `/poteto-mode` directly.

On DeepSeek Harness, read `{{adapter}}` once per session before following any pstack skill, including the ones you enter directly.

User instructions (`AGENTS.md`, direct requests) take precedence. Other session-start mandates still apply; when a task meets the criteria above they route implementation through poteto-mode.
</EXTREMELY_IMPORTANT>