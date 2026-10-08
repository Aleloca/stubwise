---
title: AI automation
description: "Always-on triage (type + effort + decision), per-ticket-type rules, auto/held gate, manual fix start and automatic PR review."
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
   below. The fifth type, `review`, is **reserved**: triage never assigns it —
   it's used only by the tickets the [PR review](#pr-review) automation creates.
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

In **Settings → AI Automation** (admin only) you configure, for each ticket
type, these parameters:

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
| `review`   | off      | —                |

The idea: let the AI handle bugs and small tasks on its own, and keep features
and feedback for human review. The `review` type is seeded with auto-fix **off**
on purpose: the tickets created by the [PR review](#pr-review) automation must
not trigger the fix pipeline in turn (it would loop — a review opens a ticket,
the ticket opens a PR, the PR gets reviewed…).

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

## Install command

Before the agent touches the code, and before the self-repair test loop, the
worker installs the repo's dependencies **once** in the ephemeral worktree.
Without this, the repo's own tests would fail with "command not found" (exit
127) because nothing is installed yet. Which command it runs is, per project,
either:

- the project's optional **"Install command"** field (Settings → Project, and
  the new-project wizard), or
- **auto-detected** when that field is empty, from the lockfile present in the
  repo:

  | Lockfile             | Command                          |
  | -------------------- | -------------------------------- |
  | `pnpm-lock.yaml`     | `pnpm install --frozen-lockfile` |
  | `yarn.lock`          | `yarn install --frozen-lockfile` |
  | `package-lock.json`  | `npm ci`                         |
  | none (but a `package.json` exists) | `npm install`      |

Leave it empty for a standard JS project; set it for a custom command (for
example a monorepo that needs `pnpm install --filter ...`, or a non-JS toolchain
like `pip install -r requirements.txt`). If there's no `package.json` and no
override, there's nothing to install and the step is skipped. The install has
its own timeout, the `INSTALL_TIMEOUT_MS` worker variable (default 10 minutes);
see [Configuration](/docs/reference/configuration/).

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

## Environment files

Most repos need configuration to install and test: a `.env` at the root, an
`apps/web/.env.local`, an API token expected by the test suite. You declare
these **per project** in **Settings → Project** as one or more **environment
files**, each identified by its path in the repo (for example `.env` or
`apps/web/.env.local`) and made of **key/value** variables.

- **Smart import** — rather than retyping variables one by one, you **upload a
  `.env` file** or **paste its contents** and Stubwise parses it, extracting the
  variables (it understands the usual `KEY=value` lines, comments and quoting),
  encrypting them and saving them under the file you chose. It's the fastest way
  to seed a file from an existing local `.env`.
- **Encrypted at rest, masked in the UI** — values are encrypted with the same
  **AES-256-GCM** scheme used for the projects' git credentials (see
  [Security](/docs/ai-pipeline/security/#credentials-encrypted-at-rest)) and are
  **never returned to the client** in clear text. After saving, the web app
  shows them **masked**: you can replace a value, but you can't read it back.
- **Materialized in the worktree** — right before the [Install
  command](#install-command) and the [Test command](#test-command-for-self-repair)
  run, the worker **recreates each file** at its path in the ephemeral worktree
  and **injects the variables into the process environment** of install and
  test. So the repo's own tooling and tests see exactly the configuration they
  expect, both as files on disk and as `process.env` entries.
- **Never committed to the PR** — the materialized files are **excluded from
  staging**: they exist only for the duration of install and test in the
  worktree and **never end up in the pull request**. The secrets don't leak into
  the diff, the branch or the git history.

Environment files are **admin-only**: only administrators can view the list,
add or remove files, import variables or edit values. They sit alongside the
install and test commands as the third piece of per-project setup the
self-repair loop depends on.

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

## PR review

Beyond fixing tickets, Stubwise can **review pull requests**: on every PR
**opened or updated** on a connected repository, a **read-only** AI agent
checks out the PR's head, reads the **diff** against the target branch and
navigates the surrounding codebase, judging correctness, regressions, security
and consistency with the repo's conventions. It then posts a **comment on the
PR** with a **verdict** — *approval suggested* or *changes requested* — and the
analysis, with findings pinned to specific files and lines. The comment is
**sticky**: each new review of the same PR **updates it in place**, so the PR
never fills up with stale AI comments.

It runs on **every** PR, including the ones Stubwise itself opens
(`stubwise/ticket-N` branches): a second pair of eyes on the fix pipeline.
Close pushes are **debounced** (~90 seconds): several pushes in a row collapse
into a single review of the final head, and a push landing while a review is
running queues a fresh review on the updated head.

The review agent **never modifies anything**: it runs in plan (read-only)
mode and does not execute the repo's tests (that's what the repo's own CI is
for). Changes to a PR opened by Stubwise are made by a separate step, the
[correction loop](#pr-correction-loop) below. Events authored by Stubwise's own
accounts — including the reviewer account's *Request changes* — are discarded
by the webhook, so the review can never re-trigger itself.

### Where the review lands in Stubwise

Besides the comment on the PR, every review is recorded in the ticketing
system:

- **PR opened by Stubwise** → the analysis is added as an **`ai` comment on the
  existing ticket** the PR belongs to.
- **External PR** (opened by a human or by another tool) → Stubwise creates a
  **ticket of type `review`** (titled after the PR, linking to it) and puts the
  analysis there. The ticket **closes itself** when the PR is merged or
  declined — no manual bookkeeping.

Each re-review adds a **new comment** on the ticket, so the ticket keeps the
full history even though the PR comment is always the latest version. The cost
of each review is tracked in the ticket's **AI usage** panel like every other
agent run.

### Enabling it

PR review is **off by default**. In **Settings → AI Automation**, the **PR
review** section has:

- the global **on/off toggle** (instance-wide, all connected repositories);
- an optional **"Max cost per review ($)"** cap: if a single review exceeds it,
  the review is marked failed and its result is **discarded** (nothing is
  published). Empty = no cap. Reviews also respect the instance's
  [monthly budget](#cost-budget): once it's exhausted, reviews stop running.

The trigger is the **repository webhook**: only repositories whose webhook is
configured get reviews, which is also the natural per-repo filter.

:::caution[Bitbucket repositories configured before this version]
The Bitbucket webhook subscribes to an explicit list of events, and PR
**created/updated** were added with this feature. For Bitbucket repositories
whose webhook was configured **before** this version, open the repository page
and re-run the automatic webhook configuration (**Reconfigure**) to register
the PR events. GitHub webhooks already receive all `pull_request` events and
need nothing.
:::

If you want to be alerted when a review completes, turn on the **"PR review
completed"** event in **Settings → Notifications**: the
[`review.completed`](/docs/notifications/) notification carries the verdict and
the links to the PR and the ticket.

### Tuning (worker variables)

Four worker environment variables govern the review runs — model, poll
interval, turn and time limits. The defaults (model `sonnet`, poll every 60
seconds, 50 turns, 15-minute timeout) are fine for most instances; setting
`PR_REVIEW_POLL_SECONDS=0` disables the poller entirely. See the
[configuration reference](/docs/reference/configuration/) for the full table.

## PR correction loop

A review that finds problems is only half the job. On pull requests **opened by
Stubwise** (`stubwise/ticket-N` branches), Stubwise also **applies** the review:
it pushes corrections to the **same PR** and reviews it again, until the review
approves or a cap is reached. PRs written by people are not touched unless a
maintainer **hands one over** explicitly (see [Handing a PR opened by someone
else to Stubwise](#handing-a-pr-opened-by-someone-else-to-stubwise)): until
then the review keeps commenting on them as before, and Stubwise never pushes
to someone else's branch.

### How a round works

1. The fix opens the PR and the review starts right away.
2. **Review approves** → the PR is marked approved (see
   [status and PR state](#review-status-and-pr-state)). Merging is up to a
   person.
3. **Review requests changes** and the automatic rounds are below the cap →
   Stubwise queues a **correction**: the agent works on the PR's own branch,
   reads the latest review, applies it, and the worker pushes the new commits
   **forward** onto the same branch. Then the review runs again, and you are
   back at step 2.
4. **Review still requests changes at the cap** → the loop stops and you get a
   notification: *changes still requested (automatic corrections: N); the
   automatic cycle has stopped*. The PR stays open.

A correction **does not redesign**: no new plan, no new PR. It applies the
feedback and writes its report as a comment on the ticket (*Corrections pushed
to the pull request*).

### The cap

Each project has a **Maximum number of automatic corrections** per series, set
by an admin on the project form: from **0 to 10**, default **3**. `0` turns the
automatic loop off — **manual corrections only**: reviews still run and still
say what they found, but only a person can start a correction.

The count is per PR and restarts whenever a **person** asks for a correction:
three automatic rounds, a manual request, then the automatic rounds start again
from one.

### Asking for a correction yourself

There are two ways, and both reset the count:

- the **Request changes** button in Stubwise — under each PR on the ticket, on the web and in the
  [mobile app](/docs/getting-started/mobile-app/) — with an optional **Note for
  the agent** (*"rename the test too"*); the latest review is always included.
  Anyone who can start a run on the ticket can use it, maintainer or operator,
  and it goes through **no plan approval**: a correction works on a PR whose
  plan was already approved (or started by a maintainer). It does respect the
  [cost budget](#cost-budget) unless a maintainer presses it — see [What stops
  the loop](#what-stops-the-loop). The button is available only while the PR is
  open, and is greyed out while a correction is already queued and while
  another job on the ticket is running or on hold: there is **one job per
  ticket** at a time.
- a *Request changes* review on the PR itself, on Bitbucket or GitHub. People with
  permission on the repository can restart the loop, whether or not they have a
  Stubwise account; Stubwise records who asked (the linked user, or the
  platform login). On GitHub that means people with **write access to the
  repository** — the *write*, *maintain* or *admin* role, directly or through
  an organization team (members whose organization membership is private
  count too); *triage* and *read* don't. Reviews and comments from anyone
  else — on a public repository, anyone can leave one — are ignored and never
  reach the agent. Reviews from bots and GitHub Apps usually don't count
  either, and neither do Stubwise's **own accounts** (the main one and the
  reviewer): their events are discarded before anything is written. The review
  text and its line comments are sent to the agent together with the latest AI
  review. **Plain comments on the PR don't start anything**: the signal is
  *Request changes*. Neither does a comment on the ticket — a ticket comment is
  read by the *next* correction, it doesn't start one.

When a *Request changes* from the platform doesn't start a correction, it is
never silent: a **system comment on the ticket** says who asked, on which PR,
and why — the account has no write access (*Changes requested on PR #N by an
account without permission: no correction was started*), Stubwise couldn't
verify the permission (typically the main git account's token can't read the
repository's collaborators: fix the token), or Stubwise couldn't tell who its
own accounts are (see [Tokens](#tokens-what-each-account-needs)). One comment
per PR and reason, not one per event: a new one appears only after a request
from the platform has gone through in the meantime. If the request is valid, a maintainer
can ask for it with the **Request changes** button on the ticket, in Stubwise.

If you request changes on the platform **while a correction is running**,
nothing is lost: your request waits and runs **instead of** the next review, as
soon as the current work on the ticket finishes. Several requests in the
meantime merge into one.

Under each PR, the ticket shows where the loop is, e.g. *Round 2 of 3 ·
correction in progress*, *Waiting for the review*, *Approved by the review ·
ready to merge*, *Cycle stopped after 3 automatic corrections*, or *Changes
requested by mario.rossi on Bitbucket · queued · starts when the current work
on the ticket finishes*.

### What stops the loop

- the PR is **merged or closed** — queued corrections are cancelled, and a
  running one doesn't push;
- the **cap** is reached;
- a review **fails** in the middle of an automatic series (an error, its cost
  cap, an unreadable answer) — no correction ever starts from a review without
  a verdict, and you get an *Automatic PR corrections stopped* notification;
- the [cost budget](#cost-budget) is exhausted, or the provider's usage limit
  is hit — the correction is **held**, like a fix, and the line under the PR
  says why: *Correction on hold · budget exhausted*, or *Correction on hold ·
  provider usage limit reached, it resumes by itself*;
- PR review is turned **off** for the instance: manual corrections still work,
  but after their push nobody reviews the PR.

### The budget, and who can override it

Unlike starting a fix by hand, asking for a correction **does not bypass the
budget** for everyone: overriding it is a spending decision, and only a
**maintainer** makes it. The automatic loop, a *Request changes* on the
platform (anyone with write access can press it, even without a Stubwise
account) and the Stubwise **Request changes** button **pressed by an operator**
all stop at the budget; the same button **pressed by a maintainer** goes past it.

A held correction is resumed with **Resume correction**, under the PR on the
ticket (web and app). While a correction is on hold, **Start AI fix** and
**Relaunch with instructions** disappear from the ticket: relaunching would
start a brand-new fix from the default branch instead of finishing the
correction.

- **Held for the budget** → only a maintainer can resume it. An operator sees
  *Correction on hold · budget exhausted · ask a maintainer to resume it* and
  no button: ask a maintainer. If an operator tries anyway from a stale page,
  Stubwise refuses (*only a maintainer can resume it: ask one*) and changes
  nothing.
- **Held for the provider's limit** → it resumes by itself when the limit
  resets; anyone who can run the ticket can also resume it by hand.

If the correction is no longer on hold when you press **Resume correction** —
the PR was merged in the meantime, say — nothing starts and the ticket reloads
(*This correction is no longer on hold*).

When a correction produces **no changes**, it still counts as a round, and you
get notified with the agent's answer — often the review asked for something
that wasn't right. When the **push is rejected** because someone pushed to the
branch in the meantime, the correction fails with a clear message: Stubwise
**never force-pushes**, and the next request starts from the updated branch.

### Handing a PR opened by someone else to Stubwise

A PR opened by a person — or by another tool — gets its review on a ticket of
type `review` (see [where the review lands](#where-the-review-lands-in-stubwise)).
If you want Stubwise to **apply** that review too, a **maintainer** can hand the
PR over: on the review ticket, in the **Corrections by Stubwise** panel (web)
or in the same section of the [mobile app](/docs/getting-started/mobile-app/),
press **Let Stubwise fix it**. Operators see the panel but not the button.

Before you confirm, the panel shows **the branch Stubwise's commits will go
to**, as read from the platform. You can add a **note for the first
correction** (*"keep the existing tests as they are"*).

When you confirm:

1. Stubwise leaves a **comment on the PR**: a maintainer asked it to fix the PR
   following the review, its commits will go to that branch, and whoever works
   on it should **pull them before pushing**.
2. The **first correction** starts from the latest review's findings plus your
   note. If the latest review **approved** the PR, nothing starts: there is
   nothing to correct, and the panel says so. The cycle starts at the next
   request for changes.
3. From then on it is the [usual cycle](#how-a-round-works): review, correction,
   review again, up to the project's [cap](#the-cap), within the
   [budget](#the-budget-and-who-can-override-it).

On a handed-over PR, the **Request changes** button in Stubwise and **Resume
correction** are for **maintainers only**: the branch belongs to a person, and
what goes on it is decided by whoever handed it over. Operators keep both on
PRs that Stubwise opened for its own tickets. A *Request changes* review on the
platform still works as described above: it is filtered by write access on the
repository.

**What Stubwise refuses to hand over**, checked against the platform when you
press the button (and shown on the button, greyed out, when already known):

- a PR **from a fork** — or one where the platform doesn't say where the branch
  lives: the push would land on a branch of the same name in *your*
  repository;
- a PR on a **`stubwise/…` branch**, on the **default branch** or on the PR's
  own **base branch**;
- a PR on a **protected branch** of the repository (below);
- a closed PR.

Stubwise **never force-pushes**, here as everywhere. If someone pushes to the
branch while a correction is running, Stubwise's push is **rejected** and the
correction fails saying so; the next one starts from the updated branch. Before
pushing, Stubwise checks again that the PR is still open, still on the same
branch and not from a fork; if anything changed, nothing is pushed.

**Giving it back.** **Stop correcting** (maintainers only) ends the hand-over:
queued corrections are cancelled, a running one stops before pushing, the
commits already pushed **stay** on the branch, and Stubwise leaves a comment on
the PR saying it stopped. **Closing or merging the PR** gives it back too, on
its own. If the PR is reopened later, it is **not** handed over again: a
maintainer has to press the button again.

#### Protected branches

Each repository has a list of **protected branches** that Stubwise never pushes
to, not even on a handed-over PR. An admin sets it in the repository form,
**Protected branches**, one per line: an exact name (`develop`, `staging`) or a
prefix with a trailing `*` (`release/*` matches `release/1.2`). An empty list —
the default — protects nothing beyond the rules above.

A PR on a protected branch can't be handed over. If a branch becomes protected
**after** its PR was handed over, Stubwise stops there: **Request changes**,
**Resume correction**, the automatic rounds and a *Request changes* from the
platform don't start anything (the platform one leaves a comment on the ticket
saying why). Under the PR the ticket shows *This PR's branch is protected on this
repository: Stubwise does not push to it*. A correction already running stops
before pushing, with the same reason. To go on, remove the branch from the
list, or **stop correcting** the PR.

### In the inbox

Every review still arrives in the inbox as a *PR review* card (*Review
completed* in the app). Its tone tells you
whether something needs you: the card is **highlighted** when the review asks
for changes, when the loop stopped at the cap, or when a review failed and
stopped the loop; it stays **neutral** when the review approves. The same rule
applies on the web and in the app.

### Review status and PR state

After every review and during every correction, Stubwise writes a **commit
status** named `stubwise-review` on the PR's head: *in progress* while it
reviews or corrects, then *changes requested* or *approved*.

To make the review **required for merging**, add `stubwise-review` to the
branch's rules:

- **GitHub** — *Settings → Branches → Branch protection rule* (or a ruleset) →
  *Require status checks to pass* → add `stubwise-review`.
- **Bitbucket** — *Repository settings → Branch restrictions* → *Merge checks*
  → require passing builds (the status appears there as a build).

The main git account's token needs permission to write statuses: on GitHub a
fine-grained token needs **Commit statuses: Read and write** on top of the
permissions it already has; on Bitbucket the `write:repository:bitbucket`
scope already covers it. Statuses are best-effort: if writing one fails, the loop goes on and
the truth stays in Stubwise.

:::note[Merging from the release queue]
The [release queue](/docs/team/release-queue/) doesn't count `stubwise-review`
among the PR's checks — on Bitbucket, where the status would show up as a
build, it is filtered out; on GitHub it was never among the checks the queue
reads. The queue already shows the review's verdict in its own column, marked
**stale** when it was given on an earlier version of the PR. A PR whose review
asks for changes can still be merged from the queue by a maintainer, who sees
the verdict next to it. Making the review mandatory is done in the branch
rules on the platform (above), and only there.
:::

### The reviewer account (optional)

Out of the box the review comments with the same account that opened the PR.
That works, but the PR's own **review state** can't be set: GitHub doesn't let
the author approve or request changes on their own PR. With a separate
**reviewer account**, the review also sets the real state — *Approve* or
*Request changes* on Bitbucket, an `APPROVE` / `REQUEST_CHANGES` review on
GitHub — so the PR page shows it like any human review.

To set it up:

1. On the platform, create the account (e.g. `pr-review@your-company.com`) and
   give it **write access** to the repositories it will review.
2. Create a token for it with the [reviewer's
   permissions](#tokens-what-each-account-needs).
3. In Stubwise, register it among the **git accounts**, then open the
   repository form and pick it as the **Review account (optional)**.

Saving checks that the reviewer:

- is a **different account** from the main one — and not a second token of the
  same platform user (*The two accounts belong to the same user on the
  platform*);
- is on the **same platform** as the main account and, on Bitbucket, in the
  **same workspace**;
- can read the repository's **pull requests** through the platform's API —
  the reviewer never pushes, merges or manages webhooks, so those aren't
  checked (and a Bitbucket reviewer doesn't need a Bitbucket username: the API
  token works with the Atlassian email). On GitHub this check also needs
  **write access**: without it Stubwise refuses with *The review account has
  no write access to the repository* — a reviewer that can only read can
  neither approve nor request changes;
- on Bitbucket, has the [reviewer's scopes](#tokens-what-each-account-needs)
  on its **token** (read from the same API response, no extra call): a missing
  scope is refused and named. If Bitbucket doesn't declare the scopes — an app
  password, for example — they're *not verifiable* and saving goes ahead;
- can tell Stubwise who it is on the platform.

:::note[Token scopes are not repository permissions]
On Bitbucket these are the scopes of the **token**, not the user's permission
on the repository: since Bitbucket removed the permissions endpoint
(CHANGE-2770) write access to the repository can't be verified. A reviewer
with read-only access — even with a token that has `write:pullrequest` —
passes the checks and is found out at the first verdict, with a line saying
the verdict wasn't submitted.
:::

If the main account is later changed so that the reviewer no longer matches
its platform or workspace, the form shows the reviewer as *no longer valid*.

:::caution[Pull requests: read and write]
Saving can verify that the token **reads** pull requests, not that it can
**write** them. A token with pull requests in read-only passes the check and
fails at the first approve: the review then falls back to a comment from the
main account, with a line saying the verdict wasn't submitted because the
reviewer account lacks the required permissions. On Bitbucket the token's
scopes are checked, so this mostly concerns GitHub and Bitbucket app
passwords. Give the token write on pull requests from the start.
:::

#### A default reviewer for a platform or workspace

Instead of picking the reviewer repository by repository, an administrator can
mark one git account as the **default reviewer**: in **Settings → Git
accounts** (admin only), tick **Default reviewer** on that account.
Repositories on the same platform — on Bitbucket, in the same **workspace** —
that have no review account of their own then use it.

- **One per platform, or per Bitbucket workspace.** On GitHub the workspace
  plays no part. Ticking the box on a second account of the same platform or
  workspace asks first (*This replaces … as the default reviewer.*) and then
  takes the place of the previous one.
- **Which reviewer wins.** The **Review account (optional)** chosen in the
  repository form always wins; only when it is left on *Default — the default
  reviewer, if there is one* does the default apply. The main account is never
  the reviewer: on a repository where the default reviewer **is** the main
  account, the default doesn't apply and the review comments with the main
  account. Under the field the form says which case applies: *Reviewer:
  default (…)*, *Reviewer: none — the default (…) is the main account of this
  repository*, or *Reviewer: none — the review comments with the main
  account*.
- **What is checked when you set it.** On the account itself, and blocking: a
  Bitbucket account needs its workspace, its credentials must be readable, the
  token must have the [reviewer's scopes](#tokens-what-each-account-needs) and
  Stubwise must be able to read who the account is on the platform. Per
  repository, without blocking: the account is set anyway, and a list
  (*Set — but check these repositories:*) names the repositories where it
  failed the same checks as an explicit reviewer (pull requests through the
  API, on Bitbucket the token's scopes, identity) or where it is the main
  account, so the default doesn't apply. Where the checks failed the review
  **still tries** with the default reviewer; if the verdict can't be
  submitted, the comment comes from the main account with a line saying so.
  Give the account access there, or choose a review account in the repository
  form.
- **Saving a repository** that falls back on the default reviewer checks it on
  that repository too, and warns without blocking: *Saved, but the default
  reviewer didn't pass the checks on this repository…*.
- **Moving it.** The workspace of the default reviewer can't be changed while
  it is the default: untick it first.

Like an explicit reviewer, the default reviewer's own *Request changes* on a
Stubwise PR is recognised as Stubwise's and never restarts the loop.

### Tokens: what each account needs

| Account  | GitHub (fine-grained personal access token) | Bitbucket (API token) |
| -------- | ------------------------------------------- | --------------------- |
| Main     | Contents, Pull requests and Webhooks: Read and write, plus **Commit statuses: Read and write** | `read:repository:bitbucket`/`write:repository:bitbucket`, `read:pullrequest:bitbucket`/`write:pullrequest:bitbucket`, `read:webhook:bitbucket`/`write:webhook:bitbucket`, plus **`read:user:bitbucket`** |
| Reviewer | **Contents: Read and write** and **Pull requests: Read and write** | `read:repository:bitbucket`/**`write:repository:bitbucket`**, `read:pullrequest:bitbucket`/**`write:pullrequest:bitbucket`** and **`read:user:bitbucket`** |

The reviewer only needs to **write**, never to administer the repository (it
doesn't manage webhooks). On Bitbucket give it the `read:` scope next to each
`write:` one: it is not yet verified that a `write:` scope includes its
`read:`, so until it is, grant both.

The Bitbucket names above are the scopes of an **API token**, the credential
Stubwise expects. A legacy **app password** still works, with the same
permissions under their app-password names: *Repositories: Write*, *Pull
requests: Write*, *Webhooks: Read and write* (main only) and *Account: Read*
(the equivalent of `read:user:bitbucket`).

**Validate** (in **Settings → Git accounts**) checks these scopes on Bitbucket.
It compares the scopes the token was actually granted with the ones the
account's **role** needs, and Stubwise works the role out itself: an account
that is the main account of some repository needs the main account's scopes,
webhooks included; an account that only reviews — the review account of some
repository, the default reviewer that applies to one, or simply an account
ticked as **Default reviewer** — needs the reviewer's scopes, without webhooks;
an account not used yet is checked against the main account's set, the
strictest. Each group of scopes (repository and pull requests, identity,
webhooks) is a line in the result, naming what is missing. With an **app
password**, Bitbucket doesn't say which permissions the credential has: the
scopes are reported as **not verifiable**: the line passes, and it lists
what to check by hand — it doesn't claim the permissions are there. On GitHub
Validate is unchanged.

On GitHub the main account's token also decides who may restart the loop: it
reads the permission of a reviewer who isn't an owner, member or collaborator
of the repository (for example a member whose organization membership is
private). That needs **Metadata: Read** on the repository (a classic token:
the `repo` scope). If the token can't read it, the ticket says the permission
couldn't be verified and the correction doesn't start.

Both tokens on GitHub must belong to a **user**: a GitHub App installation
token can't tell Stubwise who it is, so it's refused as a reviewer, and as the
main account every *Request changes* is ignored.

:::caution[Bitbucket: the `read:user:bitbucket` scope]
To recognise its own events, Stubwise asks the platform who each account is.
On Bitbucket this needs the **`read:user:bitbucket`** scope on **both** the
main account's token and the reviewer account's token. Tokens created before
the correction loop usually lack it:

- on the **main** account, the repository is still saved, but the form warns
  *Saved, but Stubwise can't read who the main account is on the platform:
  every "Request changes" made on the PR will be ignored (the ticket will say
  so)* — on creation and on every save — and every *Request changes* made on
  Bitbucket is ignored (Stubwise plays safe), with a comment on the ticket
  explaining it;
- on the **reviewer**, saving is refused (*Stubwise can't read who the review
  account is on the platform*).

Until you regenerate the tokens with that scope, the **Request changes** button
on the ticket, in Stubwise, remains the only way to ask for a correction. On GitHub nothing changes:
any personal access token can read its own identity.
:::

:::caution[Repositories whose webhook was configured before this version]
The webhook must also receive the *changes requested* events (Bitbucket
`pullrequest:changes_request_created`, GitHub `pull_request_review`). An
administrator re-syncs the repositories once after upgrading (see
[Self-hosting](/docs/getting-started/self-hosting/#updates)); for a single
repository, re-run the automatic webhook configuration from its page
(**Reconfigure**). Until then, the button on the ticket works but *Request
changes* on the platform doesn't reach Stubwise.
:::
