---
title: Roadmap, brief and decisions
description: "Where a project stands, in words: plain-language summaries of plans and pull requests, a project timeline, a weekly brief for people who don't read code, and a register of the decisions already taken."
---

Most of what Stubwise produces is written for whoever is about to touch the
code: a plan, a diff, a review. This section is the other half — **the same
work, told to everyone else**. Four things, and they are deliberately not the
same kind of thing:

- **"In brief" summaries** — two or three plain sentences on what a plan
  changes or what a pull request does, next to the technical text.
- **The Roadmap** — one page per project: open milestones and a merged
  timeline of everything that happened.
- **The weekly brief** — a written recap of the week, for people who don't read
  code.
- **The decision register** — the decisions already taken, and by whom.

The first three are **narrative**: generated, regenerable, and occasionally
wrong. The register is **fact**: it is never written by AI. That line matters
enough that it's worth stating up front — the brief is trustworthy *because*
the register it leans on isn't prose.

## "In brief" summaries

When the AI finishes planning a fix, it also writes a short summary of the
plan: what will change, in the language you'd use to explain it to someone who
doesn't work on the codebase. The same happens to a pull request when the
[automatic review](/docs/ai-pipeline/automation/#pr-review) runs.

You see them:

- on the **ticket page**, above the technical plan, under **In brief**;
- in the **inbox card** of a plan awaiting approval or a PR that just opened —
  placed between the notification text and the buttons, so it's read *before*
  you press Approve;
- in the **Slack DM** of the same notifications;
- in the [outgoing webhook](/docs/notifications/) payload, as `summary`;
- on the **Roadmap timeline**, on pull-request entries.

Summaries are **best effort**. If the run fails, times out, or the instance has
no usable AI provider, the summary simply isn't there and everything looks the
way it did before — the plan and the PR are unaffected. An admin can turn them
off instance-wide with `SUMMARIES_ENABLED=false`.

:::note[The summary always matches the plan it describes]
A plan's summary is written **before** the plan is parked for approval and
saved in the same write. There is no window in which you can read a plan next
to the summary of an older version of it — and rejecting a plan clears both.
:::

## The Roadmap

Every project has a **Roadmap** page: `Roadmap →` from the project page, or
from the project's Docs home.

It shows two things:

- **Open milestones**, each with its due date (or *overdue*) and progress as
  *n/m tickets done*;
- the **timeline**: tickets opened and closed, pull requests opened, merged or
  closed without merging (with the review verdict and the PR summary),
  milestones due and closed, [daily reports](/docs/team/activity/), decisions,
  and weekly briefs — merged into one chronological list.

A toolbar filters the timeline by type: *Tickets, Pull requests, Milestones,
Daily reports, Decisions, Weekly briefs*. Selecting nothing means no filter, so
the default view is the whole story.

The Roadmap is **read-only on purpose**. It's the page you open to understand
where things are, not a control panel: milestones are still created and closed
from the project page, and every entry links back to the thing it describes.

:::note[History before the upgrade]
Until this feature existed, closing a ticket by merging its pull request left
no recorded event — only tickets closed by hand from the web app did. A
one-shot backfill script reconstructs those missing events at deploy time, so
the timeline shows real history instead of starting empty. If your instance's
timeline looks suspiciously thin before a certain date, ask whoever runs it
whether the backfill was run.
:::

## The weekly brief

Once a week, Stubwise writes a **brief** for each enabled project: the recap
for the people who need to know how a project is doing without reading tickets,
diffs and pull requests.

### Enabling it

The brief is **off by default**. On the project form an admin turns on the
**Weekly brief** toggle. From then on the brief for the week just ended is
generated automatically, and lands in the inbox (and Slack, and push) as a
notification.

The schedule is **instance-wide**, not per project: which weekday and at what
local hour is set by the admin (`BRIEF_WEEKDAY`, `BRIEF_SEND_HOUR` — see the
[configuration reference](/docs/reference/configuration/)). The period follows
the day: if briefs go out on Friday, each one covers Friday→Thursday.

### What it contains

Four sections, always in the same order:

- **Where we are** — the state of the project in a few sentences.
- **What changed** — what actually moved in the period.
- **What is stuck** — work blocked on a decision, a limit, a review.
- **What we need from you** — the asks addressed to the reader.

It is written from the project's own record: the daily reports of the period,
the timeline events, what is currently blocked, the decisions taken in the
period, and the previous brief (so consecutive briefs read as a continuing
story rather than four disconnected paragraphs).

The instructions are strict about one thing in particular: **never invent
facts, and never guess numbers.** A section with no data says the data is
missing rather than filling the gap — an empty "What changed" is information,
and a plausible-sounding invented one is not.

### Reading and regenerating

Each brief has its own page: the period, the text, and **Copy as text**, which
copies the markdown so you can paste the brief into an email, a chat or a
status doc. Admins also get **Regenerate**, which rewrites the brief for the
same period — useful when a brief was generated while the week was still
settling, or when it came out empty.

In the **mobile app** the latest brief appears as a collapsible section on the
project screen; the full history stays on the web.

From Claude Code, the `get_project_brief` MCP tool returns the latest brief in
markdown — see [Claude Code (MCP)](/docs/integrations/claude-code-mcp/).

:::note[No AI provider, no text]
On an instance without a usable AI provider, the brief is still created and
closed cleanly — it simply has no text, and says so. It is not an error state
and nothing retries forever.
:::

## The decision register

The register answers a question that tickets and pull requests never answer
well: **"why is it like this?"** — and the closely related *"didn't we already
decide against that?"*

It fills itself as decisions get taken. Four origins:

- **Agent question** — someone answered a question the AI stopped to ask while
  planning ([how that works](/docs/notifications/#when-the-ai-asks-a-question));
- **Plan review** — a maintainer approved a plan, or rejected it with
  instructions (the instructions are the decision);
- **Pulse proposal** — someone pressed *Proceed* on a
  [pulse proposal](/docs/notifications/#the-pulse-on-idle-projects), choosing
  one item and implicitly setting the others aside;
- **By hand** — a decision taken outside Stubwise: in a call, in a chat, in a
  meeting.

The register lives under the project's Docs, as **Decision register**, with a
filter by origin. Each entry carries its title, the decision, the optional
context and consequences, who decided it, and the ticket it belongs to.
Decisions also appear on the Roadmap timeline, and are given to the project
chat as context.

Anyone who can see a project can **record** a decision by hand; editing one, or
marking it **superseded** by a newer one, is limited to its author and to
maintainers. Superseding never deletes: the old entry stays, flagged, with a
pointer to the one that replaced it. A decision that was later reversed is
still a thing that happened, and hiding it would make the register a worse
record, not a tidier one.

From Claude Code, `list_decisions` returns the register — the point being to
check it *before* proposing a solution, so nobody re-litigates an option the
team has already weighed and dropped.

:::caution[The register is never written by AI]
Every automatic entry is composed from fixed templates filled with data that
was already recorded — a question and its chosen answer, a plan verdict and its
instructions. **No model writes a decision, and none ever summarizes one.**
This is what lets you quote the register without re-verifying it, unlike the
brief, which is generated text and should be presented as such. It is enforced
by a dedicated test, not just by convention.
:::

## Configuration

Worker environment variables (see the
[configuration reference](/docs/reference/configuration/)):

| Variable             | Default           | Notes                                                                                     |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `SUMMARIES_ENABLED`  | `true`            | `false` disables the "in brief" summaries only. Everything else is unaffected.            |
| `SUMMARY_MODEL`      | `PR_REVIEW_MODEL` | Model of the summary runs. Empty falls back to the PR review model.                       |
| `BRIEF_POLL_MINUTES` | `15`              | Poll interval of the brief poller. `0` disables briefs instance-wide, manual ones included. |
| `BRIEF_WEEKDAY`      | `1`               | Day of the send window, `1` = Monday … `7` = Sunday. The covered period follows the day.  |
| `BRIEF_SEND_HOUR`    | `9`               | Local hour the window opens, in `PULSE_TIMEZONE` — the instance's only time zone.         |

The **Weekly brief** toggle is per project and off by default, so enabling the
feature on an instance sends nobody a brief until someone asks for it.
