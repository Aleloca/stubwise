---
title: Environments and the release queue
description: "Where Stubwise's other repositories run, and one page that shows every open pull request — with the single action it offers: merging."
---

Everything else in Stubwise stops at a pull request. This is the one page
where a maintainer can go one step further — **merging** it — and the one
place Stubwise keeps a record of *where* a project's repositories run, so
that step can be taken with the full picture in view.

Two things, and they're deliberately not the same kind of thing:

- **Environments** — a project's own record of where `test`, `staging` and
  `production` live. Stubwise never runs or deploys to any of them.
- **The release queue** (`/release`) — every open pull request across every
  repository Stubwise knows about, with the facts a maintainer needs before
  merging, and the merge button itself.

Both are **admin-only**. An operator's read-only access, described in
[Working without writing code](/docs/team/no-code-workflow/), stops here on
purpose — mirroring the other half of that page's role split: an operator
can never approve their own plan, and can never release anything either.

## Environments

Every project has an **Environments** section (project page → Environments).
Each entry is just a record: a name, a kind (`test`, `staging` or
`production`), an optional URL, and an optional link to a
[monitored server](/docs/monitoring/). None of that makes Stubwise touch the
environment in any way — **Stubwise never executes or deploys anything**.
Linking an environment to a server only lets Stubwise *read* what that server
reports, never act on it.

When an environment is linked to a server, and the [monitoring
agent](/docs/monitoring/agent-install/) there reports a running container
whose name matches the environment's name, the row shows what's currently
deployed — image and, when the agent can determine it, the commit it was
built from. It's informational only: a mismatch or a missing entry just means
Stubwise doesn't know, never that something is wrong.

Every project starts with one environment it didn't have to create: **`test`**
— it exists from the moment the project does, and it can't be deleted. This
is the one environment a repository's env file variables (project page →
repository → Environment variables) are actually *used* for: it's the only
one the automated fix pipeline ever reads when it runs your tests in a
worktree. Variables on `staging` or `production` are stored for a human to
read and compare — never for the pipeline to touch. That's not a convention
the UI merely suggests: the pipeline's code only ever knows how to ask for
`test`, and refuses anything else outright.

## The release queue

`/release` lists **every open pull request** on every repository connected to
a project you maintain — regardless of where it came from. A pull request
gets the same review whether Stubwise opened it or a person did, so the queue
doesn't sort by origin either; showing only "Stubwise's" PRs would make the
page tell half the story.

Each row carries five facts, kept deliberately separate rather than folded
into one traffic light:

- **Review** — the verdict from Stubwise's [automatic
  review](/docs/ai-pipeline/automation/#pr-review), when there is one.
- **Checks** — what the provider (GitHub or Bitbucket) reports *right now*
  for that pull request's CI. This is read live, not from anything stored.
- **Tests** — what the fix pipeline's own test run reported *when it opened
  the PR*. This is a different fact from Checks: one is what the pipeline saw
  in its own container before opening the PR, the other is what the
  provider's pipeline says today. They can disagree, and both are worth
  seeing.
- **Risk** — a plain rule, not a judgement: **high** if the change touches a
  migration, an environment or secrets file, a lockfile, or CI/deploy
  configuration; **medium** if it spans more than one repository; **low**
  otherwise. The row always shows *why*, in one line — it's a rule precisely
  so that "why" is always answerable without guessing.
- **Already on staging?** — whether the PR's commit is already what's running
  on a linked `staging` or `production` environment, read from the same
  monitoring data as the Environments section. This is a conservative,
  exact-match check: a missing badge means "not known to be there yet", never
  a claim that it definitely isn't.

### Releasing

The **Release** button asks for a second confirmation before doing anything —
merging is the one action this page can take, and it deserves the same
"are you sure" any irreversible action gets. Once confirmed, Stubwise merges
the pull request through the provider's API, the same way merging it by hand
on GitHub or Bitbucket would work. Nothing else happens on Stubwise's side:
the webhook that already closes a ticket and notifies people when a PR merges
— present since the pull request automation shipped — fires exactly the same
way, whether the merge came from a person clicking on the provider or from
this button.

A release can fail, cleanly, in a few distinct ways: the checks read as red,
the pull request turns out to already be closed, the provider reports it
can't be merged (typically unresolved conflicts), or the connected git
account no longer has permission to merge. Each shows its own message —
never a generic "something went wrong".

:::note[This is still not a deploy]
Releasing merges code. It does not run anything, on any environment, ever.
What happens *after* a merge — a deploy, a restart, a rollout — stays exactly
where it always was: outside Stubwise, in the hands of whoever runs your
infrastructure. The Environments section above exists so a maintainer can see
where things run before deciding to merge, not so Stubwise can decide to run
them.
:::

## Who sees what

Both the environments list and the release queue require the **admin**
(maintainer) role — this mirrors the other operator boundary described in
[Working without writing code](/docs/team/no-code-workflow/): an operator
can't approve their own plan, and can't release anything either. Unlike
Monitor and Repositories (which an operator can still open directly by URL,
read-only), the release queue's restriction isn't just hidden from the menu —
the server itself refuses the request for anyone but a maintainer.
