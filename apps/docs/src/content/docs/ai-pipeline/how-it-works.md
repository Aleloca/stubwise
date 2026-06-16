---
title: How the pipeline works
description: "From the created ticket to the pull request: triage, fix in an ephemeral worktree and closing on merge."
---

When a ticket enters Stubwise, the AI pipeline can try to resolve it on its own,
opening a pull request that a human reviews before merging. Here's the full
path.

## From ticket to job

1. A **ticket is created** — by hand, from the SDK (error or feedback) or via API.
2. For each new ticket an **AI job** is enqueued in the `queued` state in the
   queue on Postgres.
3. The **worker atomically claims** the oldest job (`FOR UPDATE SKIP LOCKED`:
   two workers never take the same job) and moves it to `triaging`.

## Phase 1 — Triage

Triage is the **cheap** phase: it uses the **haiku** model and few turns, and
**doesn't touch the repository** (it runs in an empty directory). It decides
whether it's worth spending quota on the fix. It receives the ticket and the
list of the project's most recent tickets, and produces one of three decisions:

- **`fix`** — the ticket is an actionable bug or a small, well-defined feature,
  with enough context: the job advances to `fixing`.
- **`skip`** — the ticket is vague, not actionable or requires human judgment:
  the job closes with an `ai` comment explaining the reason.
- **`duplicate`** — same root cause as a recent ticket: the ticket is closed as
  a duplicate, with a comment annotating it.

If the model doesn't emit a valid decision, triage **retries once**; then the
job fails, with both outputs in the log.

:::note[Not every `fix` starts on its own]
On a `fix` decision, the fix advances automatically only if the per-ticket-type
rules allow it (auto-fix on and effort within the threshold). Otherwise the job
stays **held** and you start it by hand. See
[AI automation](/docs/ai-pipeline/automation/).
:::

## Phase 2 — Fix

On a `fix` decision, the **expensive** phase begins. The agent works in an
**ephemeral worktree** created on a **local git mirror** of the repository, on
the `stubwise/ticket-<number>` branch. The procedure the prompt asks the agent
to follow:

1. explore the code and **locate the root cause**;
2. if the repo allows it (a test framework is present), **write a test** that
   demonstrates the bug;
3. apply the **minimal fix**, without unrelated refactoring;
4. **run the repo's existing tests**;
5. write a report in **`STUBWISE_REPORT.md`** at the root, with four fixed
   sections: *Investigation process*, *Root cause*, *Solution*,
   *Rationale*.

Then the **worker** (not the agent) closes the loop:

- reads `STUBWISE_REPORT.md` as the PR body and **excludes it from the commit**;
- **commits** the changes with author `Stubwise AI <ai@stubwise>`;
- **pushes** the `stubwise/ticket-<number>` branch;
- **opens the pull request** with the report as the description;
- adds an `ai` comment to the ticket with the link to the PR and moves the
  ticket to **`in_review`**.

:::note[The agent doesn't commit and doesn't push]
The prompt explicitly forbids the agent from committing or pushing: the worker
does it. The agent, in headless mode, can modify files but has Bash denied apart
from an allowlist of test commands. See
[Security](/docs/ai-pipeline/security/) and
[Configuration](/docs/ai-pipeline/configuration/).
:::

## Closing on merge

When a human **merges the PR**, the git provider sends a webhook to Stubwise
(if you configured it on the project). Stubwise **verifies its HMAC signature**
and automatically moves the ticket to **`done`**. If the webhook isn't
configured, you move the ticket from the board yourself.

## Feedback loop

The pipeline isn't one-way: if a PR doesn't pan out, or if you want to guide the
AI, the ticket comes back into play without starting from scratch.

### Reopening on a rejected PR

When the PR opened by the pipeline is **closed without merge** (on GitHub: PR
*closed* not merged; on Bitbucket: `pullrequest:rejected`) and the ticket is in
`in_review`, Stubwise **reopens** it: the ticket goes back to `triaged`, the AI
job moves to the `pr_closed` state and a **system comment** annotates *"PR closed
without merge: &lt;url&gt; — ticket reopened, relaunch the fix whenever you
want"*. If you have configured notifications, the
[`job.pr_closed`](/docs/notifications/) event fires.

The action is **idempotent**: it acts only if the ticket is in `in_review`, so a
webhook delivered twice does no harm. The webhook the pipeline registers on the
provider also includes the PR rejection event, alongside the merge one.

### Relaunch with instructions

On the ticket detail, next to **"Start AI fix"**, there's **"Relaunch with
instructions"**: write a comment with your guidance (what to fix, where to look,
what to avoid), then relaunch. This relaunch enqueues the job **skipping
triage**, straight to the fix.

More generally, **all fixes** — including the automatic ones — include in the
prompt the latest **user** comments on the ticket (roughly the last 10), in a
**"team guidance"** block. This block is treated as **untrusted** input: it
steers the agent but **does not override the security rules**
(see [Security](/docs/ai-pipeline/security/)).

:::note[Plan approval]
For the most demanding fixes you can insert a step of **human plan approval**:
the AI plans, stops and waits for your go-ahead before writing code. You
configure it per ticket type in
[AI automation](/docs/ai-pipeline/automation/).
:::

## Deduplication

Identical errors do **not** generate a new ticket every time. The ingestion
computes a **fingerprint** of the error (type plus the first normalized stack
frames, or type plus the normalized message when the stack isn't usable):
errors with the same fingerprint in the same project collapse into a single
`ErrorGroup` tied to a single ticket, and each new occurrence **increments its
`occurrences` counter** without enqueuing a new job. This way the pipeline works
only once on a recurring bug.

## Per-project serialization

Jobs of **different projects** proceed in parallel (up to
`WORKER_CONCURRENCY`), but jobs of the **same project** are **serialized**: a
second concurrent fix on the same repo would wipe the not-yet-pushed refs of the
other during the mirror's `fetch --prune`. The worker queues the executions per
`projectId` in a chain of promises. (The deploy assumption is therefore a
**single worker**.)
