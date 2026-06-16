---
title: AI automation
description: "Always-on triage (type + effort + decision), per-ticket-type rules, auto/held gate and manual fix start."
---

Automation decides **whether and when** the AI pipeline tries to resolve a
ticket on its own. A first **triage phase always runs**; the **fix** starts
automatically only if the rules you set in **Settings → AI Automation** allow
it, otherwise the job stays **held** and you can start it by hand.

## Triage always runs

For every ticket that enters the queue, the pipeline runs a **triage** with the
cheap **haiku** model (see [How it works](/docs/ai-pipeline/how-it-works/)).
Triage does three things:

1. **Validates and re-classifies the type.** It doesn't trust the incoming type:
   it decides itself whether the ticket is `bug`, `feature`, `task` or
   `feedback`. It's the re-classified type that counts for the automation rules
   below.
2. **Estimates the effort**, on a scale from **1 to 5**, saved on the ticket:

   | Effort | Label        |
   | ------ | ------------ |
   | 1      | Trivial      |
   | 2      | Small        |
   | 3      | Medium       |
   | 4      | Large        |
   | 5      | Very large   |

3. **Decides** one of three actions: **`fix`** (actionable, worth trying),
   **`skip`** (vague or needing human judgment) or **`duplicate`** (same root
   cause as a recent ticket).

On `skip` and `duplicate` the job closes there, with an `ai` comment explaining
the reason. Only on `fix` does the gate come into play.

## Per-type rules (Settings → AI Automation)

In **Settings → AI Automation** (admin only) you configure, for each of the four
ticket types, these parameters:

- **Auto-fix** (on/off): whether the pipeline can start the fix on its own for
  that type.
- **Effort threshold** (`maxEffort`, 1–5): the maximum effort for which the fix
  starts automatically.
- **Plan approval from effort ≥** (`Never`, or 1–5): the threshold beyond which
  the fix stops to have a human approve the plan before writing code. See
  [Plan approval](#plan-approval) below.
- **Max cost per ticket ($)**: a per-type cap on the real AI cost a single
  ticket may run up. Empty = no cap. See [Cost budget](#cost-budget) below.

The seeded default values are:

| Type       | Auto-fix | Effort threshold |
| ---------- | -------- | ---------------- |
| `bug`      | on       | ≤ 3 (Medium)     |
| `task`     | on       | ≤ 2 (Small)      |
| `feature`  | off      | —                |
| `feedback` | off      | —                |

The idea: let the AI handle bugs and small tasks on its own, and keep features
and feedback for human review.

## The gate: starts on its own or stays held

When triage decides **`fix`**, the fix starts **automatically only if**:

- the (re-classified) type has **auto-fix ON**, **and**
- the estimated effort is **≤ the threshold** of that type.

If both conditions hold, the job advances to `fixing` and proceeds on its own.

Otherwise the job stays **held**: the ticket goes to the `triaged` state, with
an `ai` comment explaining why it didn't start (auto-fix off, or effort above
threshold). Nothing is lost: the triage has already been done and the ticket
carries the estimated type and effort. A held job also fires the
[`job.held`](/docs/notifications/) event if you have configured notifications.

### An example

With the default for bugs (auto-fix on, threshold 3):

- **a bug at effort 3** falls within the threshold → the fix **starts on its own**;
- **a bug at effort 4** exceeds the threshold → the job **stays held**, in the
  `triaged` state, awaiting a human decision.

## Manual start: "Start AI fix"

On the detail of a ticket that stayed **held**, the **"Start AI fix"** button
appears: you launch it by hand and the fix starts **bypassing the gate** (it
ignores auto-fix and threshold). It's the way to give the go-ahead case by case,
without loosening the general rules — useful for a feature you've assessed
yourself, or for a large bug you still want the AI to attempt.

## Plan approval

For each ticket type you can require that, **beyond a certain difficulty**, a
human approve the AI's plan before it touches the code. You set it with the
**"Plan approval from effort ≥"** threshold: `Never` (default: no gate), or a
value from **1 to 5**.

If the threshold is set for the ticket's type and **the estimated effort reaches
it**, the fix runs **only the planning phase** (Opus, read-only) and then
**stops**:

- the **plan** is saved and shown as an `ai` comment on the ticket;
- the job goes to the **`awaiting_plan_approval`** state;
- the ticket moves to **`in_progress`**;
- the [`job.plan_review`](/docs/notifications/) event fires (if configured).

On the ticket detail the **Approve** / **Reject** buttons appear:

- **Approve** → the job resumes in **execution mode**, using **exactly the
  approved plan** (Sonnet executes, no re-planning), then commit, push and PR as
  usual.
- **Reject** → the job **goes back to planning** (the saved plan is discarded)
  incorporating your comments as guidance, and **stops again** awaiting
  approval. To steer the new planning, **write a comment** with what to fix
  **before** pressing Reject.

:::note[Orthogonal to the manual start]
The approval gate is **independent** of how the fix started: a risky fix
requires plan approval **even if you started it by hand** with "Start AI fix".
The two thresholds have different purposes: `maxEffort` decides whether the fix
starts on its own, "Plan approval from effort ≥" decides whether the fix stops
to have the plan reviewed.
:::

## Cost budget

Beyond the effort gate, you can cap the pipeline on the **real cost** of the AI
work (tokens × model, tracked per job). There are two ceilings, and both are
**checked before the fix starts and again inside the self-repair loop**, before
spending on another repair attempt:

- **Per ticket, per type** — the **"Max cost per ticket ($)"** field in
  **Settings → AI Automation**, next to auto-fix / effort / plan approval, one
  value for each type (`bug`, `feature`, `task`, `feedback`). It caps the total
  cost summed across all the AI runs of a single ticket. Empty = no cap.
- **Monthly, instance-wide** — the **"Monthly budget ($)"** field in
  **Settings** (content / notifications area), a single global value. It caps the
  cost summed across **all** jobs of the **current calendar month**. Empty = no
  cap.

When a ceiling would be exceeded, the job does **not** fail: it goes to the
`held` state with an `ai` comment explaining the overage, and a **"budget
exceeded (job held)"** notification fires (the
[`job.budget_held`](/docs/notifications/) event). Nothing already spent is lost
and the ticket keeps its triage.

:::note[Manual start overrides the budget]
Starting the fix by hand — **"Start AI fix"** or relaunch — **bypasses both
ceilings**, exactly as it bypasses the auto-fix gate: a human has decided the
spend is worth it. The budget only ever holds back **automatic** work.
:::

## Test command for self-repair

Before opening a PR, the worker runs the repo's tests itself and loops with the
agent until they pass (see
[Self-repair](/docs/ai-pipeline/how-it-works/#self-repair-the-worker-verifies-the-tests)).
Which command it runs is, per project, either:

- the project's optional **"Test command"** field (Settings → Project, and the
  new-project wizard), or
- **auto-detected** when that field is empty: the `package.json` `test` script,
  run with the package manager inferred from the lockfile in the repo.

Leave it empty for a standard JS project; set it for a custom command (for
example `pnpm run test:ci`). If no command can be resolved (no `test` script, or
a non-JS repo), self-repair is simply skipped and the PR opens as usual.

## How it ties to the two-phase fix and to costs

Once the fix starts — automatically or by hand — it follows the normal pipeline.
By default the fix is **two-phase** to contain costs: **Opus plans read-only**
and **Sonnet executes** (writes the code, the tests and the report). The detail
of the procedure is in [How it works](/docs/ai-pipeline/how-it-works/);
the `FIX_*` variables that govern models, timeouts and the two-phase toggle are
in [Configuration](/docs/ai-pipeline/configuration/).

The **tokens and the cost** are tracked **per ticket** and **per model**
(distinct `agent_runs` rows for triage, planning and execution): on the ticket
detail the **"AI usage"** panel shows how much each stage cost. So the estimated
effort isn't just a filter for the gate, but also a lens to read the spend
after the fact.
