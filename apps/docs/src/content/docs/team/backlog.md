---
title: Backlog discovery
description: "Feedback and feature requests distilled into a deduplicated backlog: AI intake, refinement sessions with a Claude Code agent, and conversion into tickets."
---

Not every ticket is a bug to fix. **Feedback and feature requests** deserve
collection and refinement, not a pull request: with the discovery backlog
enabled, they skip the fix pipeline and are **distilled into backlog items** —
deduplicated ideas you refine over time and convert into actionable tickets
when they're ready. The **Backlog** section (top navigation) is their home.

## Enabling it

The backlog is **off by default**. On the **project page**, an admin turns on
the **Discovery backlog** toggle: from then on, tickets classified as
*feedback* or *feature* are routed to backlog intake instead of the fix
pipeline — whatever their origin (SDK `captureFeedback`, the
[customer-service widget](/docs/integrations/widget/), manual tickets, the
inbound webhook, Slack), including tickets **reclassified by triage** after
birth.

The origin ticket is **closed automatically** with a comment linking the
backlog item, so the tracker stays clean.

## Intake and deduplication

For each routed ticket, a worker agent writes the item (title, description,
initial **effort/risk/urgency** estimates) — and embeddings keep the backlog
deduplicated:

- above the **merge threshold** (default similarity ≥ 0.90) the request is
  **absorbed into the existing item**, whose request counter grows
  (*"Requested N times"*);
- in the **grey zone** (default ≥ 0.78) the new item is created but flagged
  *"≈ similar to …"* so you can judge;
- you can always **Merge into…** another item manually.

Items created manually (**New item**) go through the same pipeline. On later
revisions the agent proposes **AI suggestions** for the metadata, which you
**Accept** or **Dismiss** — it never silently overwrites your estimates.

## Refining an item

Each item page shows two columns: on the left the **Design / Description**
document (with the original request), on the right the **refinement
session** card and the item's status — metadata, implementation plan and
linked tickets.

The way to work on an item is its **refinement session**, described below:
there is no separate chat, analysis session or deep dive. You can still edit
the document by hand.

An item moves from *new* to *refining* by itself when the **first message**
of a refinement session is sent.

## Refinement session

To work on an item, start its **refinement session**: a
conversation with a Claude Code agent *about that item*, which reads **all the
repositories of the project, read-only**, and writes the result straight into
the item. It is also listed in [Agent sessions](/docs/ai-pipeline/agent-sessions/).

**Who can use it.** Anyone who can work on the project's backlog, operators
(`member`) included: they start the session, write to the agent and can stop
its turn. It is the one kind of session where an operator writes to the agent.

**Starting and resuming.** On the item page (web and mobile app), press
**Start session** (or **Resume session** if one existed). A first message is
optional: if you write it, the agent starts right away; otherwise nothing runs
until you write. There is **one session per item**, with a continuous history:
resuming it continues the **same conversation**, not a new one.

**What the agent writes.** With dedicated tools, the agent saves:

- the **design** document and the **implementation plan**;
- the **title**, **effort**, **risk** (with its note) and **urgency**.

Every time the agent overwrites a value, the **previous one is kept** as a
revision on the item (revisions are stored, but cannot be browsed in the app
yet). The agent does not create, merge or delete items, does not
change the item's status (the only automatic change is *new* → *refining* on
the first message, made by Stubwise, not by the agent), and does not ask
button-style questions
(`ask_user`): it talks to you in the chat. The session view shows a panel with
the item's current design, plan and metadata, refreshed when the agent writes.

**States.** *working* (the agent is on a turn), *turn queued* (your message is
waiting for a free slot: instance-wide, only a few turns run at once), *ready*
(the session is open and idle, write to continue) and *ended*.

**Closing.** Press **Close session** whenever you want: it asks for
confirmation first, then cancels a turn in progress. An open session also closes by itself after a period of inactivity
(`BACKLOG_REFINE_IDLE_MINUTES`, default 30). Writing again resumes it. When the
item is **converted into a ticket or archived**, the session closes for good and
cannot be resumed.

**Budget.** If the instance's monthly AI budget is used up, a **member's**
message is **not delivered** (the transcript says so under the message); a
maintainer's message still goes through.

**Stopping.** **Stop** interrupts the current turn. If you stop before the agent
has read your message, the message is not delivered and shows **Resend**.

:::caution[A written plan is not an approved plan]
Saving a plan on the item changes nothing about approval. **Convert to task**
and the run that follows go through the usual plan-approval gate: an operator
cannot approve a plan, not even one refined in a session.
:::

## Outputs

When an item is ready:

- **Convert to task** creates an open ticket in the project and marks the item
  *converted* (the ticket stays linked);
- **Copy Markdown** / **Download .md** export the document (e.g. into your
  repo's `docs/`);
- **Archive** parks ideas you won't pursue (reversible with **Reopen**).

## From Claude Code

The backlog is also a first-class citizen of the
[Claude Code integration](/docs/integrations/claude-code-mcp/): from your
coding session you can consult items, create them from design docs, attach
designs and implementation plans, convert them into tickets and advance their
status — the web UI and the MCP tools work on the same data.

## Configuration

Worker environment variables (see the
[configuration reference](/docs/reference/configuration/)):

| Variable                           | Default  | Notes                                                                      |
| ---------------------------------- | -------- | -------------------------------------------------------------------------- |
| `BACKLOG_POLL_SECONDS`             | `20`     | Poll interval of the backlog job queue. `0` disables the poller.           |
| `BACKLOG_MERGE_THRESHOLD`          | `0.90`   | Similarity (0–1) above which intake merges into an existing item.          |
| `BACKLOG_SIMILAR_THRESHOLD`        | `0.78`   | Similarity above which an item is flagged "similar to". Must be ≤ merge.   |
| `BACKLOG_MODEL`                    | `sonnet` | Model of the backlog agent (intake + estimates).                           |
| `BACKLOG_AGENT_TIMEOUT_MS`         | `900000` | Timeout (15') of each backlog agent run.                                   |
| `BACKLOG_REFINE_MAX_TURNS`         | `15`     | Max agentic turns per refinement turn (old name `BACKLOG_CHAT_TURN_MAX_TURNS` still read, with a warning). |
| `BACKLOG_REFINE_IDLE_MINUTES`      | `30`     | Idle minutes before a refinement session is closed (resumable).            |
