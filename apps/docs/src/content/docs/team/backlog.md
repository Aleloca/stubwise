---
title: Backlog discovery
description: "Feedback and feature requests distilled into a deduplicated backlog: AI intake, refinement chat with code-analysis sessions, deep dives, and conversion into tickets."
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

Each item has a **Design / Description** document, the original request, its
metadata, linked tickets, and a **refinement chat**:

- **DOCS mode** (default): a RAG chat over the project's documentation, with
  sources.
- **CODE mode**: press **Start analysis session** and pick a repository — a
  read-only agent session investigates the actual code and keeps its context
  across turns (*"Investigating the code…"*). Close it with **Close session**;
  idle sessions expire on their own.
- **Update document**: synthesizes what emerged in the chat into the Design
  document (it tells you if there's *"Nothing new to synthesize"*).
- **Deep-dive analysis**: pick a repository and the agent runs a deeper
  investigation on a read-only worktree, writing a **technical analysis**
  section into the document (it takes a few minutes).

:::note[Chat requires an API-key provider]
The refinement chat streams through the API and needs an **API-key** AI
provider in the chain (a subscription `account` credential is not enough). See
[Worker auth](/docs/getting-started/claude-setup/).
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
| `BACKLOG_MODEL`                    | `sonnet` | Model of the backlog agent (intake + deep dive).                           |
| `BACKLOG_AGENT_TIMEOUT_MS`         | `900000` | Timeout (15') of each backlog agent run.                                   |
| `BACKLOG_CHAT_TURN_POLL_SECONDS`   | `2`      | Fast poller of code-session chat turns. `0` disables turn processing.      |
| `BACKLOG_CHAT_SESSION_TTL_MINUTES` | `30`     | Idle minutes before an analysis session is closed (worktree removed).      |
| `BACKLOG_CHAT_TURN_TIMEOUT_MS`     | `300000` | Timeout (5') of the agent run for one chat turn.                           |
| `BACKLOG_CHAT_TURN_MAX_TURNS`      | `15`     | Max agentic turns per chat turn.                                           |
