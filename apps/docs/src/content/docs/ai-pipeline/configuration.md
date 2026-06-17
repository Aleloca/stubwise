---
title: Pipeline configuration
description: Concurrency, staleness threshold, models and test commands allowed to the agent.
---

The AI pipeline is tuned with a few worker environment variables and with some
default parameters hardcoded in the pipeline. Here are the most important ones;
the complete list of variables is in the
[configuration reference](/docs/reference/configuration/).

## `WORKER_CONCURRENCY`

How many AI jobs the worker processes in parallel, **across different projects**.
Default **`2`** (allowed range 1–16). Jobs of the same project stay serialized
all the same (see [How it works](/docs/ai-pipeline/how-it-works/)).

Raise this value only together with the container's resource limits: each job
can clone and build a repo and run an agent for minutes. See the
[operational notes](/docs/getting-started/self-hosting/) on the deploy.

## `WORKER_STALE_MINUTES`

Minutes of inactivity beyond which a job in progress is considered **orphaned**
by a crashed worker and put back in the queue. Default **`150`**.

:::caution[Must exceed ~119 minutes with the defaults, or the worker won't start]
The staleness threshold must exceed the maximum time a legitimate job can take.
With the **defaults** (two-phase fix and self-repair both active): **fix
(planning 10' + execution 30' = 40') + self-repair (`SELF_REPAIR_MAX_ATTEMPTS`,
2, × (execution 30' + test 5') = 70') + 2× triage (2' each, for the retry) +
margin (5') ≈ 119 minutes**. The **self-repair loop** is what stretches the
worst case the most: each cycle re-runs the agent and re-runs the test command.
With `FIX_TWO_PHASE=false` the fix term drops to the 30' execution alone, and
with `SELF_REPAIR_MAX_ATTEMPTS=0` the self-repair term disappears. A value too
low would re-enqueue a long but still alive job, generating a **duplicate PR**
on the same project. The worker **checks this invariant on startup and refuses
to start (exit 1)** if it's violated: with `restart: unless-stopped` it would
end up in a crash loop. The default `150` satisfies the invariant; leave it
unless you have a precise reason to change it.
:::

The primary defense against false orphans is anyway the **heartbeat**: during
the fix the worker updates `lastActivityAt` every 60 seconds, well below the
staleness threshold. The invariant is the safety net against a broken
configuration.

## `MIRRORS_DIR`

Directory of the worker's **persistent git mirrors**. Default
`/var/stubwise/mirrors`. In the Docker deploy it's a volume mounted there: the
mirrors are rebuildable, but persisting them avoids a full re-clone on every job.
The fix worktrees are instead **ephemeral** and are removed at the end of the
job.

## Models

- **Triage**: the **`haiku`** model (the cheap phase), with few turns
  (default 10) and a 2-minute timeout.
- **Two-phase fix** (default, to reduce costs): the expensive phase does **only
  analysis**, the cheap one writes the code.
  - **Planning** — the **`opus`** model (`FIX_PLAN_MODEL`), **read-only**
    (`--permission-mode plan`): it analyzes the bug and produces a concrete plan
    (root cause, files to touch, change, test). It doesn't modify files.
    Up to 40 turns and a 10-minute timeout (`FIX_PLAN_TIMEOUT_MS`).
  - **Execution** — the **`sonnet`** model (`FIX_EXECUTE_MODEL`): it implements
    the plan, writes the regression test, runs the tests and writes the report.
    Up to 80 turns and a 30-minute timeout.
  - The usage of the two models is **recorded separately** (distinct
    `agent_runs` rows under the `fix` phase), so you see how much each one costs.
- With **`FIX_TWO_PHASE=false`** the fix reverts to a **single run** with
  `FIX_EXECUTE_MODEL` (historic behavior, for comparison/rollback).

These parameters are configurable via environment variables; the auth's model is
the one you authenticated the CLI with (API key or OAuth/MAX login, see
[Worker auth](/docs/getting-started/claude-setup/)).

## Content language

The language the AI **writes in** — its comments on tickets and pull requests
across triage, plan and fix, and the text of the
[notification](/docs/notifications/) messages — is the **content language** set
once per instance in **Settings** (`instance_settings.content_language`).
English is the default; Italian is also supported. This is an instance-wide
setting, separate from each user's per-account UI language; see
[Language & localization](/docs/getting-started/web-app/#language--localization).

## Commands allowed to the fix agent

In headless mode the agent runs with `--permission-mode acceptEdits`: it can
**modify files** but has **Bash denied** by default. Since the prompt asks it to
run the repo's tests, the worker grants it an **allowlist** of test commands
only:

```
Bash(npm test:*)
Bash(npm run test:*)
Bash(pnpm test:*)
Bash(pnpm run test:*)
Bash(npx vitest:*)
Bash(npx jest:*)
```

Everything else in Bash stays denied: the agent **cannot** do `git push` nor run
arbitrary commands. This allowlist is the default; see
[Security](/docs/ai-pipeline/security/) for the full rationale.
