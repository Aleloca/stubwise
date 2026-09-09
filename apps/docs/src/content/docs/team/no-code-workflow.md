---
title: Working in Stubwise without writing code
description: The complete path for a non-technical operator — from an idea to a released change — what each stopping point means, and the two things only a maintainer does.
---

This guide is for **operators** (the `member` role): people who move projects
forward from ideas to shipped changes without ever opening an editor. It walks
the whole path an idea takes through Stubwise, explains every point where the
system stops and waits for a person, and names the two decisions that stay
with a maintainer (the `admin` role) on purpose.

Nothing here requires reading code, a terminal, or a PR diff.

## The path, start to finish

1. **An idea arrives.** Feedback, a feature request, or your own note becomes
   a [backlog item](/docs/team/backlog/) — deduplicated against existing
   ones, with an estimated effort/risk/urgency.
2. **You refine it in chat.** The default mode reads the project's
   documentation; **Start analysis session** switches to a mode where the
   agent actually investigates the code (read-only) and can, if it needs to,
   **ask you a question** — see [When the agent asks you something](#when-the-agent-asks-you-something)
   below.
3. **Convert to task**, once the item is ready. This opens a ticket linked to
   the backlog item.
4. **Start the fix**, from the ticket. The agent plans first, then — unless a
   maintainer has already cleared the way (see [Pre-approved plans](#pre-approved-plans)
   below) — **stops and waits for a maintainer to approve the plan** before
   touching any code.
5. **The fix runs**, opens a pull request, and the ticket moves to
   *in review*.
6. **A maintainer releases it.** Merging and deploying always happen outside
   Stubwise, by someone with access to the git provider and the
   infrastructure — see [Two things only a maintainer does](#two-things-only-a-maintainer-does).

At every step, one line on the page tells you exactly what to do next.

## The line that always tells you what's next

Under a backlog item — and once it becomes a ticket — a single line answers
"what now?": *"Idea to clarify"*, *"Ready: shall I turn it into a task?"*,
*"Plan ready, waiting for a maintainer to approve it"*, *"Change ready —
releasing it is up to a maintainer"*, and so on.

This line is **computed, never written by the AI**: it comes from a fixed
table that maps the item's and the job's current status to one of a small,
known set of phrases. A wrong guess about what to do next would be worse than
no phrase at all, so nothing here is generated — it's read off state that
already exists on the page.

## When the agent asks you something

While investigating the code (in **CODE** mode — the DOCS chat stays free
text), the agent can hit a fork it shouldn't guess at: which of two approaches
to take, which of two similarly-named things you mean, and so on. When it
does, a panel appears in the conversation with the question, a short list of
options (one sometimes marked *recommended*), and an **Other…** choice for a
free-text answer.

You always have a way out:

- **Not now** dismisses the question without answering. The agent's
  investigation pauses; nothing is lost, and you can pick the conversation
  back up later.
- Answering resumes the same investigation from where it stopped — the agent
  doesn't restart from scratch.

A question is always anchored to the backlog item it came from, and closes on
its own if you convert the item to a task or archive it — it never blocks the
conversation forever, and it never asks about production, only about the work
in front of it.

## When something needs a maintainer

Some stops on the way need more than an answer from you — a plan whose cost
crosses a threshold, a run paused by the instance's budget, an unexpected
error. The AI activity panel on the ticket names the state in plain words
(*Waiting to start*, *Plan to approve*, *Waiting for an answer*…), not the
internal queue names a developer would read.

When a run **fails**, look for the short *"In brief"* note above the
technical log: three plain-language sentences on what the agent was trying to
do, what went wrong, and whether a maintainer needs to step in. It's
best-effort — generated *after* you've already been notified, never before —
so it can be missing on an older or unlucky run; the technical log is always
there underneath it either way.

## Two things only a maintainer does

Two decisions stay with a maintainer, on every ticket, whatever else this
phase opened up:

- **Approving a plan.** An operator can start a fix, read the plan, and
  answer the agent's questions — but only a maintainer can approve or reject
  the plan the fix will actually execute (or clear one in advance, see
  below). This isn't a setting to turn off: it's a fixed property of the
  `member` role.
- **Releasing to production.** Stubwise opens pull requests; it never merges
  or deploys them. That step happens outside the app entirely, wherever your
  team already reviews and ships code — there is no button in Stubwise for
  it, for anyone.

## Pre-approved plans

A maintainer can **approve a ticket's plan in advance**, from the ticket page
(**Approve plan in advance**), so that when an operator starts the fix it
runs straight through instead of stopping to wait. This only ever applies to
the *exact* plan a maintainer read: if the plan changes for any reason — a
rejection with new instructions, a fresh run, anything — the approval quietly
stops applying, and the next run waits as usual. Nothing needs to be manually
cleared; the fine print is checked automatically.

A run that the system itself proposed (from a [pulse](#finding-your-way-around)
suggestion) always stops for approval, pre-approved or not — nobody has read
a plan yet when a proposal is accepted, so there's nothing to have cleared in
advance.

## Finding your way around

The menu doesn't show **Monitor** or **Repository** — they're about server
infrastructure and connected git repositories, and an operator's day-to-day
never touches them. They aren't locked, though: a link someone sends you (or
one a monitoring alert includes) still opens the page, read-only, exactly as
before. Hiding them from the menu is about not making you wonder what
they're for — it isn't about permission.

**Settings** stays in the menu for everyone: past **Account**, **Access
tokens** and **Google** it quietly shows nothing else to an operator, because
those three are the only settings that are actually yours.

The **Projects** page shows, next to each project, one line on what's
happening in it right now — waiting on you, actively running, gone quiet for
a few days, or all caught up — the same pulse summary the
[mobile app](/docs/getting-started/mobile-app/) has always shown.
