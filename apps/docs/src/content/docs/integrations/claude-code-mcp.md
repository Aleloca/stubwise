---
title: Claude Code (MCP)
description: Connect Claude Code to your Stubwise backlog and tickets with the stubwise plugin — the @stubwise/mcp server, the /stubwise:* commands and the skill, installed and updated together.
---

Stubwise ships an [MCP](https://modelcontextprotocol.io) server,
[`@stubwise/mcp`](https://www.npmjs.com/package/@stubwise/mcp), that lets
[Claude Code](https://claude.com/claude-code) talk directly to your Stubwise
instance. It serves two kinds of people:

- **Developers** working in a linked repository: Claude reads your **backlog**
  and **tickets**, creates and advances them, and pushes **design docs** and
  **implementation plans** back into Stubwise.
- **Non-technical collaborators**, with no repository at all: Claude answers
  questions from the project's Docs, files **bugs** and **requests** for you
  and tells you how they are going. This is the simple path described in
  [Claude Code for collaborators](/docs/getting-started/claude-code/); this
  page is the reference behind it.

Everything ships as one **Claude Code plugin**, `stubwise`: the MCP server, three
slash commands and a skill, installed and updated together. The plugin runs on
each person's machine (it is *not* part of the `docker compose` stack). Everyone
installs it once and authenticates with their own **Personal Access Token**.

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
- It is distributed as an npm package and the plugin starts it with
  `npx -y @stubwise/mcp@<version>`, so there is nothing to build locally —
  `npx` downloads and caches it. The plugin **pins the exact version** of the
  server it was released with, so updating the plugin also updates the server.
- It authenticates to the Stubwise HTTP API with a **Personal Access Token**
  (PAT) sent as a Bearer token. The PAT inherits *your* permissions: the MCP can
  do exactly what you could do in the web app, nothing more.
- **Developers**: it reads which Stubwise **project** the current repository
  maps to from a small `.stubwise.json` file committed in the repo.
  **Collaborators**: there is no repository, so Claude works out which project
  you mean, then **always asks you to confirm** it.
- **Docs answers are retrieval only.** The server returns the passages of the
  project's Docs that match the question; it generates nothing. The answer is
  written by *your* Claude from those passages, citing the page.

```
Claude Code ── stdio ──> @stubwise/mcp ── HTTPS (Bearer PAT) ──> Stubwise API
```

## Prerequisites

- **Node.js ≥ 22** (for `npx`).
- **Claude Code** installed.
- A Stubwise account on your instance.

## 1. Set up from the web app (recommended)

In Stubwise, open **Settings → Claude Code** and create the token. The page
shows **one command**: copy it and paste it into the Terminal on macOS or Linux,
or into PowerShell 7+ on Windows (it does not work in Windows PowerShell 5.1,
the preinstalled one). It does three things, in this order:

```bash
claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins \
  && claude plugin install stubwise@stubwise \
  && npx -y @stubwise/mcp setup --url <instance-url> --token <token>
```

- the first two commands add the marketplace and install the plugin (see
  [step 2](#2-the-plugin));
- `setup` **checks the token** against the instance (`/api/auth/me`) and, only
  if it works, saves the URL and token in `~/.config/stubwise/config.json`
  (readable only by you; set `STUBWISE_CONFIG` to use another path). It prints
  `Configurato come <email> su <url>`;
- then `setup` **turns on automatic updates** for the `stubwise` marketplace
  (see [Updating](#updating)) and says so. That is why it runs last: it needs
  the marketplace the first command has just added. Pass `--no-auto-update` to
  skip this step.

Running the whole command again is safe: with the marketplace and the plugin
already there, the first two commands just say so and `setup` runs anyway.

Then restart Claude Code. The page creates a token named **Claude Code**.

:::caution[Treat it like a password]
A PAT grants the same access as your account, and **the command contains it**:
it is shown once, and it ends up in your **shell history**. Keep it out of
repositories and chats. If it leaks, revoke it in **Settings → Access tokens**
and generate a new command.
:::

### Manual alternative: environment variables

Instead of the file you can create a token yourself (**Settings → Access
tokens → Create token**, shown once) and set two variables:

- `STUBWISE_TOKEN` — your PAT;
- `STUBWISE_URL` — your instance (defaults to `http://localhost:3000`, only
  useful for local development).

Export them in your shell profile, or put them in the `env` block of your
**user** Claude Code settings, `~/.claude/settings.json` (never a settings file
inside a repository):

```json title="~/.claude/settings.json"
{
  "env": {
    "STUBWISE_TOKEN": "stw_pat_your_token_here",
    "STUBWISE_URL": "https://stubwise.example.com"
  }
}
```

**Precedence: environment > config file > default.** The file is only read when
one of the two variables is missing, so a broken file does not stop a setup that
has both in the environment.

## 2. The plugin

The command above already installs it. To do it by hand, from a terminal add the Stubwise marketplace and install the plugin:

```bash
claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins
claude plugin install stubwise@stubwise
```

`--sparse` checks out only the two folders the plugin needs instead of the
whole Stubwise repository. Then start (or restart) Claude Code and check the
connection with **`/mcp`**: the plugin's `stubwise` server should be listed as
connected, with its tools.

:::tip[From inside Claude Code]
`/plugin install stubwise --marketplace Aleloca/stubwise` adds the marketplace
and opens the plugin, so you can pick the install scope. `--sparse` is only
documented for the terminal command, so this way may fetch the whole repository.
:::

The plugin brings:

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
- **the MCP server** — `npx -y @stubwise/mcp@<version>`, the exact version
  released with the plugin; nothing to build locally.

:::note[Tool names]
Tools from a plugin's MCP server are named `mcp__plugin_stubwise_stubwise__<tool>`.
If you had permission rules for the old `mcp__stubwise__<tool>` names, update
them.
:::

## 3. Link a repository to a project (developers)

This step is **only for developers** working inside a repository; collaborators
skip it. In a repository, run **`/stubwise:init`**. Claude lists your Stubwise projects,
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

Once connected, Claude has these tools (names as exposed to Claude). Project
tools take the project from the repo's `.stubwise.json` or from a `project`
slug Claude passes after you confirmed it.

**Read**

| Tool | What it does |
|---|---|
| `list_projects` | List the Stubwise projects (name, description, slug, id). |
| `list_backlog` | List backlog items for the project (filter by status, urgency, text). |
| `get_backlog_item` | Full detail of one item, including its document, plan and original request. |
| `list_tickets` | List tickets (filter by status, type, priority, text). |
| `get_ticket` | Full detail of one ticket. |
| `list_proposals` | The open [pulse proposals](/docs/notifications/#the-pulse-on-idle-projects) addressed to **you**: idle projects, and the backlog items suggested to restart from. |
| `list_mail_proposals` | The open proposals born from your mail or calendar, addressed to **you** (only the mailbox owner sees them, never an admin). Read-only: you confirm them from the inbox. |
| `get_project_brief` | The latest [weekly brief](/docs/team/roadmap-briefs-decisions/) of a project, as generated narrative. Empty if the project has none yet. |
| `list_decisions` | The project's decision log (facts decided by people, never written by AI); superseded decisions are marked. |

**Docs**

| Tool | What it does |
|---|---|
| `search_project_docs` | Search the project's Docs (all its repositories) and return the matching passages with page title, repository and slug. It generates no answer. |
| `read_doc_page` | Read a whole Docs page (by repository id and slug from the search); very long pages are cut at 30,000 characters. |

**Write**

| Tool | What it does |
|---|---|
| `create_ticket` | Create a ticket from a title and body. `type` is `bug`, `feature`, `task`, `feedback` or `review` (default `task`); optional priority. |
| `create_backlog_item` | Create a backlog item from raw feedback or an idea. Async: the intake pipeline summarizes it, and it may be **merged into a similar open item** (Claude tells you which). If the project's backlog is off, it opens a **`feature` ticket** instead and says so. |
| `create_backlog_from_design` | Create a backlog item from a **finished design doc**: the document is stored verbatim and the AI only estimates the metadata. |
| `convert_backlog_to_ticket` | Turn a backlog item into a ticket (admin). |
| `set_ticket_status` | Move a ticket between `open`, `triaged`, `in_progress`, `in_review`, `done`, `closed`. |
| `run_ticket` | Start the AI run on a ticket (the same as **Run AI** in the web app). With a saved plan the worker executes *that* plan; pass `mode: "ai_plan"` to set it aside for that run and re-plan from scratch (the plan saved on the ticket is kept). On a `review` ticket it is refused (`review_ticket_not_runnable`): to have Stubwise fix a PR opened by someone else, a maintainer [hands it over](/docs/ai-pipeline/automation/#handing-a-pr-opened-by-someone-else-to-stubwise) from the ticket. |

**Your requests**

| Tool | What it does |
|---|---|
| `my_requests` | The bugs and requests **you** filed, with a status in plain words (received, being evaluated, in progress, in verification, released, archived, closed) and the team's latest comments on the ticket (also on the ticket a request was turned into). Open ones by default; `status: "all"` adds the concluded ones; optionally one project. |

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

The `stubwise` skill drives the developer flows, and the server's own
instructions drive the collaborator ones (so they work even without the skill);
you can trigger all of them in plain language.

**Collaborators**

- **Asking how something works.** Claude confirms the project, calls
  `search_project_docs` (and `read_doc_page` if the passages are not enough),
  then writes the answer itself and cites the page. If the Docs do not cover
  it, it says so instead of guessing.
- **Reporting a bug.** Claude asks **one question at a time** (what you were
  doing, what you expected, what happened, where and since when), checks the
  Docs, shows a **draft** (title and text) and opens it with `create_ticket`
  as a `bug` only after you confirm.
- **Requesting a feature or a change.** Same conversation, but first Claude
  tells **rule from bug from request**: if what you saw is documented
  behaviour, it explains the rule and asks whether that is what you meant —
  nothing is opened if the explanation is enough; if you need something
  different, it files a **request** that quotes the current rule it clashes
  with. It uses `create_backlog_item`: the request may be **merged** into a
  similar open one (Claude tells you, and you still find it among yours), and
  if the project's backlog is off it becomes a **`feature` ticket**. Either
  way the **maintainers are notified** (inbox card and push, `request.created`)
  when a member opens a bug or request.
- **Following your requests.** "What are my requests?" calls `my_requests`.
  Claude cannot change a request's status or nudge it; to add something, open
  a new report or write to the maintainer.

**Developers**

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
- The token never lands in a repository: it lives in your environment, your
  user Claude Code settings or `~/.config/stubwise/config.json` (mode 0600); `.stubwise.json` contains only a project slug.

## Troubleshooting

- **`/mcp` doesn't list the Stubwise server, or shows an error** — check that
  the plugin is installed and enabled (`claude plugin list`), and that the
  token and URL are configured — by the command from **Settings → Claude Code**
  (`~/.config/stubwise/config.json`) or by `STUBWISE_TOKEN`/`STUBWISE_URL` in
  the environment Claude Code runs in; then restart Claude Code (the server is
  launched at session start).
- **"I don't know which project you mean"** (the tool asks to name the
  project) — there is no `.stubwise.json` and no project was given. For
  collaborators Claude then lists the projects and asks you; for a developer,
  run `/stubwise:init` (or create `.stubwise.json` by hand). The server reads
  `.stubwise.json` per call, so after `init` no restart is needed.
- **401 / "token invalid or expired"** — the PAT was revoked or expired.
  Generate a new command in **Settings → Claude Code** and run it again (if you
  use environment variables, update `STUBWISE_TOKEN` instead).
- **"Stubwise is not configured yet"** (the server won't start) — neither the
  environment nor `~/.config/stubwise/config.json` has a token: run the
  command from **Settings → Claude Code**.
- **"The configuration file … is not readable" / "doesn't have the expected
  shape"** — `~/.config/stubwise/config.json` (or the path in `STUBWISE_CONFIG`)
  is broken JSON or lacks `url`/`token` strings: fix it or run `setup` again.
- **`setup` fails** — it prints why: an invalid address (it must start with
  `https://` or `http://`), a token Stubwise does not recognize (expired or
  pasted incomplete — generate a new command), the server answering with an
  error, the address unreachable, or the file not writable.
- **`my_requests` says "this Stubwise instance needs updating"** — the server
  is older than the plugin and cannot tell your requests from others', so it
  refuses to list them. Whoever runs the instance must update it; meanwhile
  see your requests on the Stubwise site.
- **403 on an action** — your account (and therefore your token) lacks permission
  for that operation; for example `convert_backlog_to_ticket` is admin-only.

## Updating

Skill, commands and server are versioned together: every Stubwise release of
the plugin carries all three, and the plugin pins the exact version of the MCP
server, so a plugin update also brings the new server.

**If you installed from Settings → Claude Code, updates arrive on their own.**
The command turns on Claude Code's automatic updates for the `stubwise`
marketplace. Claude Code checks for a new version in the background **after the
first message of a session**; the download takes up to about **ten minutes**,
and the new version is active **when you restart Claude Code** or run
**`/reload-plugins`** (Claude Code tells you when there is something to
reload). The check is skipped when `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (unless
`FORCE_AUTOUPDATE_PLUGINS=1`); see
[Keep plugins updated](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated)
in the Claude Code documentation.

:::note[Installed before automatic updates?]
If you set up the plugin before this version, automatic updates are still off:
generate a new command in **Settings → Claude Code** and run it **once more**.
The same applies if you run `claude plugin marketplace add` again by hand: it
rewrites the marketplace entry and turns automatic updates off, while the full
command turns them back on at the end.
:::

**To turn them on by hand** (for example if `setup` says it could not): in
Claude Code, **`/plugin`** → **Marketplaces** → `stubwise` → **Enable
auto-update**. `setup` only changes an existing `stubwise` entry in your user
Claude Code settings (`~/.claude/settings.json`, or the folder in
`CLAUDE_CONFIG_DIR`): if it finds none, or the file is not valid JSON, it leaves
the file alone and prints these same steps.

**To update right away**, from a terminal:

```bash
claude plugin marketplace update stubwise
claude plugin update stubwise@stubwise
```

then restart Claude Code. Inside a session, the same is **`/plugin`** →
**Marketplaces** → `stubwise` → **Update marketplace**, which also updates the
plugins installed from it.

**You will be told if you fall behind.** The MCP server knows the latest plugin
version. Once per session, at the end of the first tool answer, Claude relays a
plain-words note when:

- your plugin is older than the latest (it names both versions and gives the
  two commands above: close Claude Code, run them in a terminal, restart);
- the server runs **without the plugin** (a hand-made `.mcp.json` or
  `claude mcp add`): it suggests redoing the setup from **Settings → Claude
  Code**, or the install commands plus removing the old entry;
- an old manual copy of the skill or commands is still in `~/.claude`: it lists
  the folders to delete (Claude can do it for you if you ask).

## If you used the manual setup

Before the plugin, the server was added by hand (`claude mcp add` or a
`.mcp.json` entry) and the commands and skill were downloaded into `~/.claude`.
Those copies don't update, and next to the plugin they get in the way: two
`stubwise` servers, and old commands that collide with `/stubwise:*`. After
installing the plugin:

1. Remove the old server: `claude mcp remove stubwise` (add `--scope user` if
   that's where you added it), or delete the `stubwise` entry from the
   `.mcp.json` where you put it. If you passed the token with `-e` there, set
   `STUBWISE_TOKEN`/`STUBWISE_URL` as in [step 1](#manual-alternative-environment-variables)
   first: the plugin reads them from the environment.
2. Delete the downloaded copies:
   ```bash
   rm -rf ~/.claude/skills/stubwise ~/.claude/commands/stubwise
   ```
3. Restart Claude Code.

The MCP server reminds you of steps 1 and 2 if it finds them undone.
