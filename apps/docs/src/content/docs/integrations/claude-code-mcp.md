---
title: Claude Code (MCP)
description: Connect Claude Code to your Stubwise backlog and tickets via the @stubwise/mcp server — consult the backlog, create and advance tickets, and attach design docs and implementation plans, all from your editor.
---

Stubwise ships an [MCP](https://modelcontextprotocol.io) server,
[`@stubwise/mcp`](https://www.npmjs.com/package/@stubwise/mcp), that lets
[Claude Code](https://claude.com/claude-code) talk directly to your Stubwise
instance. Once configured, Claude can read your **backlog** and **tickets**,
create and advance them, and push **design docs** and **implementation plans**
back into Stubwise — so the work you plan in your editor stays in sync with the
board your team sees.

The MCP server runs on each developer's machine (it is *not* part of the
`docker compose` stack). Every developer installs it once and authenticates with
their own **Personal Access Token**.

:::note[This is a different "Claude" than the AI pipeline]
This page is about **your** Claude Code (in your editor) reading and writing
Stubwise over the API. It is unrelated to
[Worker auth (Claude)](/docs/getting-started/claude-setup/), which configures the
`claude` CLI the **worker** uses to fix tickets. The two are independent.
:::

## How it works

- The MCP server uses the **stdio** transport: Claude Code launches it as a child
  process when a session starts and stops it when the session ends. You never
  run or babysit a server yourself.
- It is distributed as an npm package and started with `npx -y @stubwise/mcp`, so
  there is nothing to build locally — `npx` downloads and caches it.
- It authenticates to the Stubwise HTTP API with a **Personal Access Token**
  (PAT) sent as a Bearer token. The PAT inherits *your* permissions: the MCP can
  do exactly what you could do in the web app, nothing more.
- It reads which Stubwise **project** the current repository maps to from a small
  `.stubwise.json` file committed in the repo.

```
Claude Code ── stdio ──> @stubwise/mcp ── HTTPS (Bearer PAT) ──> Stubwise API
```

## Prerequisites

- **Node.js ≥ 22** (for `npx`).
- **Claude Code** installed.
- A Stubwise account on your instance, and the instance URL (e.g.
  `https://stubwise.example.com`).

## 1. Create a Personal Access Token

In the web app, open **Settings → Access tokens → Create token**. Give it a name
(for example `claude-code-laptop`) and, optionally, an expiration. The token —
`stw_pat_…` — is shown **once**: copy it now. You can revoke it any time from the
same page.

:::caution[Treat it like a password]
A PAT grants the same access as your account. Keep it out of your repositories —
put it in an environment variable or your Claude Code config, never in a
committed file. If it leaks, revoke it and create a new one.
:::

## 2. Add the MCP server to Claude Code

The simplest setup registers the server at **user scope**, so it is available in
every repository you open, with your token stored in Claude Code's local config
(not in any repo):

```bash
claude mcp add stubwise --scope user \
  -e STUBWISE_TOKEN=stw_pat_your_token_here \
  -e STUBWISE_URL=https://stubwise.example.com \
  -- npx -y @stubwise/mcp
```

`STUBWISE_URL` defaults to `http://localhost:3000` if omitted — set it to your
instance for anything other than local development.

Open (or restart) Claude Code and check the connection with **`/mcp`**: you
should see `stubwise · connected` with its tools.

:::tip[Team-wide, committed config]
Instead of (or in addition to) `--scope user`, you can commit a project-scoped
`.mcp.json` at the root of a repository so the whole team inherits the server on
clone:

```json title=".mcp.json"
{
  "mcpServers": {
    "stubwise": {
      "command": "npx",
      "args": ["-y", "@stubwise/mcp"],
      "env": {
        "STUBWISE_TOKEN": "${STUBWISE_TOKEN}",
        "STUBWISE_URL": "${STUBWISE_URL}"
      }
    }
  }
}
```

The `${STUBWISE_TOKEN}` / `${STUBWISE_URL}` placeholders are expanded from each
developer's environment, so the **token stays per-user and out of git** — only
the launch config is versioned.
:::

## 3. Install the commands and skill (recommended)

Stubwise provides three slash commands and a skill that make Claude use the tools
at the right moments. Fetch them into your user config so they work in every repo.
**You don't need to clone the Stubwise repository** — the server comes from npm,
and these files are downloaded directly:

```bash
mkdir -p ~/.claude/commands/stubwise ~/.claude/skills/stubwise
curl -fsSL https://raw.githubusercontent.com/Aleloca/stubwise/main/.claude/commands/stubwise/init.md \
  -o ~/.claude/commands/stubwise/init.md
curl -fsSL https://raw.githubusercontent.com/Aleloca/stubwise/main/.claude/commands/stubwise/start.md \
  -o ~/.claude/commands/stubwise/start.md
curl -fsSL https://raw.githubusercontent.com/Aleloca/stubwise/main/.claude/commands/stubwise/run.md \
  -o ~/.claude/commands/stubwise/run.md
curl -fsSL https://raw.githubusercontent.com/Aleloca/stubwise/main/.claude/skills/stubwise/SKILL.md \
  -o ~/.claude/skills/stubwise/SKILL.md
```

- **`/stubwise:init`** — links a repository to a Stubwise project.
- **`/stubwise:start`** — run this when you begin implementing a plan: it makes
  sure a ticket exists (converting a backlog item or creating a task), loads the
  finalized **design** and **implementation plan** onto it, and moves it to
  `in_progress` — before you touch the code.
- **`/stubwise:run`** — same preparation, but the implementation runs **on
  Stubwise**: after loading design and plan onto the ticket it calls
  `run_ticket`, and the worker does the work and opens a PR. Use `start` when you
  want Claude to write the code in your editor, `run` when you want to hand the
  job to Stubwise.
- **`stubwise` skill** — teaches Claude the everyday flows (below): move state on
  start/finish, attach designs and plans, keep the local doc's frontmatter linked
  to its Stubwise counterpart.

:::tip[Re-fetch after updates]
When the command or skill changes, re-run the relevant `curl` above and restart
Claude Code to pick up the new version.
:::

These are optional conveniences — the tools work without them — but they make the
experience much smoother.

## 4. Link a repository to a project

In a repository, run **`/stubwise:init`**. Claude lists your Stubwise projects,
asks which one this repo belongs to, then writes and commits a `.stubwise.json`
at the repo root:

```json title=".stubwise.json"
{ "project": "acme-web" }
```

Every developer who clones the repo inherits the association — no per-machine
setup beyond the token.

:::note[Monorepos and parent folders]
A Stubwise project can have several repositories. If you run `/stubwise:init`
from a folder that contains multiple git repos, it writes a `.stubwise.json` into
**each** repo root, so every one records which project it belongs to (they can
map to the same project or different ones).
:::

Without a natural-language command, you can also just ask:

> List the Stubwise projects, find the slug for "Acme Web", then create a
> `.stubwise.json` at the repo root with that slug and commit it.

## The tools

Once connected, Claude has these tools (names as exposed to Claude):

**Read**

| Tool | What it does |
|---|---|
| `list_projects` | List the Stubwise projects (id, slug, name). |
| `list_backlog` | List backlog items for the project (filter by status, urgency, text). |
| `get_backlog_item` | Full detail of one item, including its document, plan and original request. |
| `list_tickets` | List tickets (filter by status, type, priority, text). |
| `get_ticket` | Full detail of one ticket. |
| `list_proposals` | The open [pulse proposals](/docs/notifications/#the-pulse-on-idle-projects) addressed to **you**: idle projects, and the backlog items suggested to restart from. |

**Write**

| Tool | What it does |
|---|---|
| `create_ticket` | Create a `task` ticket from a title and body. |
| `create_backlog_item` | Create a new backlog item (async: it is processed by the intake pipeline). |
| `create_backlog_from_design` | Create a backlog item from a **finished design doc**: the document is stored verbatim and the AI only estimates the metadata. |
| `convert_backlog_to_ticket` | Turn a backlog item into a ticket (admin). |
| `set_ticket_status` | Move a ticket between `open`, `triaged`, `in_progress`, `in_review`, `done`, `closed`. |
| `run_ticket` | Start the AI run on a ticket (the same as **Run AI** in the web app). With a saved plan the worker executes *that* plan; pass `mode: "ai_plan"` to set it aside for that run and re-plan from scratch (the plan saved on the ticket is kept). |

**Design docs & implementation plans**

| Tool | What it does |
|---|---|
| `set_design` | Save a design doc onto an existing backlog item **or** ticket. It **replaces the main body** and preserves the original request separately. |
| `delete_design` | Remove the design and restore the original request as the body. |
| `set_plan` | Save (or regenerate) the implementation plan in its own dedicated field. |
| `delete_plan` | Clear the implementation plan. |

`get_backlog_item` and `get_ticket` also surface the current implementation plan
and the preserved original request.

## Typical flows

The `stubwise` skill drives these; you can also trigger them in plain language.

- **"What's in the backlog we could pick up?"** — Claude uses `list_backlog`
  (open items, by urgency) and summarizes what's worth starting.
- **"Is anything waiting for me?"** — at the start of a session Claude calls
  `list_proposals` and reports the open pulse proposals addressed to you, with
  the projects that have gone quiet. You start one from the web app or Slack.
- **Design/plan → backlog.** When you write a design or plan for something that
  isn't tracked yet, Claude creates a backlog item with `create_backlog_item` and
  links the local doc's frontmatter to it.
- **Attach a design to an existing item or ticket.** When you finalize a design
  doc starting *from* an existing backlog item or ticket, Claude calls
  `set_design`. This **replaces the body** with the design so the "current, agreed
  truth" is always the body — while the original request (the feedback the item
  was born from) is preserved and remains viewable. This is different from
  `create_backlog_item`, which makes a *new* item.
- **Save and regenerate the plan.** Claude calls `set_plan` to store the
  implementation plan in a dedicated field. To rewrite only the plan later (the
  code changed in the meantime), it calls `set_plan` again — the design is
  untouched.
- **Start executing a plan** — run **`/stubwise:start`**. It makes sure a ticket
  exists (converting the backlog item, or creating a `task`), loads the finalized
  **design** and **implementation plan** onto it, and moves it to `in_progress` —
  all before you touch the code. Running the command is the reliable way to do
  this: the skill also nudges Claude to do it, but an explicit command doesn't
  depend on Claude remembering mid-session. When the implementation is done, the
  ticket moves to `in_review`. Marking a ticket `done` is on-demand (you tell
  Claude once it's actually released — the release usually happens outside the
  editor session).

- **Hand the execution to Stubwise** — run **`/stubwise:run`** instead of
  `/stubwise:start`. It prepares the ticket the same way, then calls `run_ticket`
  so the **worker** implements the plan on the server and opens a PR. Nothing is
  written in your editor session.

:::tip[A saved plan can run the fix pipeline]
For a **ticket** that has a saved implementation plan, clicking **Run AI** in
Stubwise (or calling `run_ticket`) executes *that* plan directly — the pipeline
skips its own triage and planning and goes straight to the change. See
[How the AI pipeline works](/docs/ai-pipeline/how-it-works/).
:::

:::note[Roles: operator runs await maintainer approval]
Runs started by an **operator** (a `member`) always pass through the plan
approval gate: with a saved plan the job is created already waiting for
approval; without one it is queued but stops once the plan is ready. A
**maintainer** (an `admin`) approves — or rejects — from the web app or Slack,
and the execution then resumes on its own. There is no MCP tool for approving a
plan, so Claude reports the pending approval and stops there. A maintainer's own
run needs no approval.
:::

:::note[Proposals are read-only from the editor]
`list_proposals` is there so Claude can *tell you* what is waiting, not so it can
act on it. There is no MCP tool that starts a proposal — you pick one from the
inbox card in the web app or from the Slack DM, and Stubwise creates the ticket
and starts the run (which then waits for plan approval) on its own.

Two things worth knowing when you read the output: the list is **per recipient**,
so an empty result means *no proposal reached you*, not that the projects have
nothing to work on (that's `list_backlog`); and each proposal carries the
`backlogItemId` of the item behind it, which is what you pass to
`get_backlog_item` to read the whole thing before deciding.
:::

## Security

- A PAT authenticates as **you** and inherits your role. There are no granular
  scopes: an admin's token can do admin actions (like converting a backlog item);
  a member's token cannot.
- At rest the server stores only a **hash** of the token; the plaintext is shown
  once and never again.
- Revoke a token any time from **Settings → Access tokens**. Set an expiration
  for tokens you use in less trusted places.
- The token never lands in a repository: it lives in your environment or Claude
  Code's local config; `.stubwise.json` contains only a project slug.

## Troubleshooting

- **`/mcp` doesn't list `stubwise`, or shows an error** — check that
  `STUBWISE_TOKEN` and `STUBWISE_URL` are set for the environment Claude Code runs
  in, then restart Claude Code (the server is launched at session start).
- **A tool says the repo isn't linked** — run `/stubwise:init` (or create
  `.stubwise.json` by hand). Tip: the server reads `.stubwise.json` per call, so
  after `init` you can use the tools immediately — no restart needed.
- **401 / "token invalid or expired"** — the PAT was revoked or expired.
  Regenerate it in **Settings → Access tokens** and update `STUBWISE_TOKEN`.
- **403 on an action** — your account (and therefore your token) lacks permission
  for that operation; for example `convert_backlog_to_ticket` is admin-only.

## Updating

The server auto-updates: `npx -y @stubwise/mcp` always fetches the latest
published version. When a new version ships, restart Claude Code to pick it up.
