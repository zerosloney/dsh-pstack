---
name: review-triage
description: Triage pull-request review threads (Cursor Bugbot, Copilot review, or human reviewers) into fix, dismiss or ask, draft the replies, and - only when the session is allowed to apply - post and resolve them. Use for /review-triage, review inbox, triage the review comments, or when babysitting a pull request.
---

# Review triage

This skill is the executable half of the rubric in ../poteto-mode/references/bugbot-triage.md.
Read that first: it defines fix, dismiss and ask, the confidence ladder for skip patterns, and the risk boundary (data, security, privacy, auth, billing, migration, idempotency, race).
When this file and the rubric disagree, the rubric wins.

Resolve paths from this file: the package root is three levels above skills/review-triage/SKILL.md, and the tool lives under its scripts/ directory.

## When to use

- A pull request carries review-bot or human threads nobody answered.
- The user says triage, review inbox, babysit, or asks what is left on a PR.
- You are a review-triage session started for exactly this.

## The loop

1. Find the work:

       node <pstack>/scripts/review-triage.mjs inbox --limit 10

   It lists your open PRs with the number of unresolved threads and threads that have no verdict yet.

2. Read the threads of one PR:

       node <pstack>/scripts/review-triage.mjs plan --pr 42 --repo owner/name

   One JSON object per unresolved thread: threadId, path, line, author, body, headSha, and the verdict already recorded, if any. A thread whose recorded sha differs from headSha is stale and must be re-classified.

3. Classify every thread against the rubric, then record it:

       node <pstack>/scripts/review-triage.mjs record --pr 42 --repo owner/name --thread THREAD --verdict fix --reason "real null deref on an empty list" --reply "Fixed in SHA."

   One verdict per thread. A verdict without a reason is not a verdict.

4. Produce the reviewable artifact:

       node <pstack>/scripts/review-triage.mjs draft --pr 42 --repo owner/name --out triage-42.md

   The draft groups threads by verdict and shows the reply for each. Propose mode ends here: hand the file to the user and stop.

## Apply mode

Only when the session exposes write and edit tools and the user asked you to apply:

       PSTACK_REVIEW_APPLY=1 node <pstack>/scripts/review-triage.mjs apply --pr 42 --repo owner/name --yes

Apply posts each recorded reply and resolves the thread, unless its verdict is ask. It skips threads that are already applied, stale against the current head, or missing a reply, and it refuses to run without both the environment flag and --yes. That guard is deliberate: posting to a pull request is an outward-facing action.

In propose mode you have no write or edit tools. Do not work around that with a shell command; the absence is the point.

## Unattended runs

A scheduled or delegated run has no user to ask, but the rubric asks on a novel, high-severity or ambiguous thread. Under no user:

- Record ask, phrase the reply as a question to the PR author, and do not resolve the thread.
- Do not edit code for an ask verdict.
- Say in the summary which threads are waiting on a human.

## Boundaries

- One pull request per pass. Do not mix verdicts across PRs.
- Never resolve a thread you did not answer, and never answer with done and no commit.
- Never edit code in propose mode.
- Never invent a commit SHA in a reply. If the fix is not committed, say what you will change and record fix only after the commit exists.
- State lives under DSH_HOME/review-triage/owner__name/pr-N.json; read it with the state subcommand instead of opening it by hand.

## What this does not replace

Bugbot, Copilot review and CodeRabbit are reviewers. This loop consumes their output; it does not produce reviews.
To produce reviews, run the interrogate or code-review skill on the branch first, then triage what comes back.

