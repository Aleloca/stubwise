# Stubwise

Connect your repos. Stubwise **documents**, **plans**, **fixes** and
**watches** them.

Stubwise is a self-hosted, open-source platform built around your
repositories, with an AI worker (powered by the
[Claude Code](https://claude.com/claude-code) CLI) that works for your team in
the background:

- **documents** — Confluence-like docs and dated release notes generated from
  your code, refreshed on every push, with vector search and a RAG chat
  grounded by per-repository knowledge graphs;
- **plans** — user feedback distilled into a deduplicated backlog, refined in
  chat and synced with Claude Code via MCP;
- **fixes** — a complete issue tracker where errors captured by the SDKs
  become tickets, and the worker proposes the fix as a pull request a human
  reviews and merges;
- **watches** — daily AI activity reports from your commits, server monitoring
  with a push agent, and notifications on the events you care about.

All on **your** infrastructure, with **your** data. Every capability is an
opt-in toggle per project or repository — and without authenticating the AI,
Stubwise still works as a complete self-hosted issue tracker.

> Status: young project. The core (ingestion, ticketing, AI pipeline,
> self-hosting) is complete and tested; issues and contributions are welcome.

**📖 Documentation: <https://aleloca.github.io/stubwise/>**

## Features

### Document — living docs

- **AI-generated documentation** for each connected repository: a
  Confluence-like "Docs" section with technical, functional and product pages,
  kept up to date incrementally on every push — plus release notes collected
  into a dated changelog.
- **Vector search and RAG chat** over your docs and code, powered by pgvector
  and local embeddings (Ollama, `bge-m3`) — nothing leaves your
  infrastructure.
- **Knowledge graphs** (optional, per repository): the worker builds a code
  knowledge graph that enriches chat answers with the relevant subgraph and
  code snippets.

### Plan — backlog & Claude Code

- **Backlog discovery**: feedback and feature-request tickets are distilled into
  deduplicated backlog items (embedding-based merge), refined via chat — with
  optional read-only code-analysis sessions and technical deep dives — and
  converted into actionable tickets.
- **Claude Code integration**: the [`@stubwise/mcp`](https://www.npmjs.com/package/@stubwise/mcp)
  MCP server exposes backlog and tickets as tools — consult the backlog, attach
  designs and implementation plans, convert items into tickets and advance
  their status without leaving your coding session.

### Fix — ticketing & intake

- **Error capture SDKs** for browser and Node.js, with automatic breadcrumbs,
  release and environment tagging. The SDK also collects explicit **user
  feedback** (`captureFeedback`) and creates **structured tickets**
  programmatically (`createTicket`).
- **Fingerprint deduplication**: similar errors collapse into a single group and
  a single ticket — no noise.
- **Full ticketing**: list, detail, comments, status transitions and a Kanban
  board.
- **Attachments** on tickets, stored on an S3-compatible bucket.
- **Milestones**: group a project's tickets into milestones with a due date and
  completion progress.
- **Saved views**: save a combination of ticket-list filters as a private or
  team-shared view and re-apply it in one click.
- **Inbound channels beyond the SDK**: manual tickets, an inbound webhook and
  Slack (`/stubwise` slash command and a "Create Stubwise ticket" message
  action).
- **Customer-service widget**: an embeddable chat widget (`/widget.js`) that
  answers from your docs via RAG and can open tickets from user reports.
  Multiple widgets per project, per-widget keys, path filters and daily caps.

### Fix — AI pipeline

- **Automatic triage** of incoming tickets, and — when it makes sense — a pull
  request with a proposed fix, opened on your git provider.
- **Two-phase fix** to keep costs down: a strong model plans in read-only mode,
  a cheaper model executes the plan. **Self-repair**: the worker runs the
  repository's tests itself and loops the failure output back to the agent
  before committing.
- **Human-in-the-loop controls**: automation gates, plan approval, per-ticket
  and monthly cost budgets, held jobs.
- **Automatic PR review**: opened/updated pull requests get an AI review with a
  verdict, comments and notifications (off by default).
- **Usage-limit aware**: when the AI provider hits its usage limit, running work
  is paused and resumed automatically instead of failing.
- **Provider chain**: configure multiple AI credentials (API keys or
  subscription accounts) with ordered failover, testable from the UI and
  pinnable per project.
- **Usage dashboard**: AI consumption broken down by day, model, project and
  provider.

### Watch — reports, monitoring & alerts

- **Daily activity reports**: an AI-written description for every commit of the
  day, rolled up into per-project and per-developer summaries.
- **Server monitoring**: a lightweight agent container
  (`alelocadev/stubwise-agent`) runs on each of your hosts and **pushes** host
  metrics, Docker/PM2 service discovery and explicit checks to Stubwise — no
  third-party service, no inbound ports on the monitored hosts. The Monitor
  section shows per-server charts, services, disks and checks, with alert
  thresholds wired into your notification channels.
- **Notifications**: an outgoing webhook (Slack, Discord or generic JSON) on the
  key events — new ticket, PR opened/closed, held job, plan to approve, failed
  fix, and more.

### Platform

- **Team management**: invites, admin/member roles, and per-member linking of
  git, Bitbucket and Slack identities (used by activity reports and Slack).
- **Pluggable git providers**: GitHub and Bitbucket Cloud included; merged-PR
  webhooks close the ticket.
- **Fully self-hostable**: one Docker Compose stack, automatic HTTPS via Caddy,
  no data leaving your infrastructure.
- **i18n**: English and Italian UI.
- **Open source (MIT)**, end-to-end TypeScript monorepo.

## Screenshots

<!-- TODO: add screenshots of the board and ticket detail in docs/assets/
     and link them here, e.g.: ![Kanban board](docs/assets/board.png) -->

_Screenshots coming soon. For now, the UI is explorable by starting the stack
(see below)._

## Architecture

```text
   your users' app          your team                 your hosts
        │ errors/feedback       │ browser                 │ metrics
        ▼                       ▼                         ▼
  ┌───────────────┐   ┌──────────────────┐   ┌─────────────────────┐
  │ @stubwise/sdk │   │  SPA + /guide +  │   │  @stubwise/agent    │
  │ + widget.js   │   │  /widget.js      │   │  (per-host container)│
  └───────┬───────┘   └────────┬─────────┘   └──────────┬──────────┘
          │                    │                        │
          ▼                    ▼                        ▼
        ┌─────────────────────────────────────────────────┐
        │                     Caddy                       │
        │        (HTTPS, static assets, reverse proxy)    │
        └───────────────────────┬─────────────────────────┘
                                ▼
                        ┌───────────────┐     ┌────────────────────┐
                        │    server     │────▶│ Postgres (pgvector)│
                        │ (Fastify API, │ SQL │ tickets, docs,     │
                        │  migrations)  │◀────│ embeddings, queues │
                        └───┬───────┬───┘     └─────────┬──────────┘
                            │       │                   │ queue polling
              MCP (graphs)  │       │ embeddings        ▼
                            ▼       ▼           ┌──────────────────┐
                     ┌──────────┐ ┌────────┐    │      worker      │
                     │ graphify │ │ ollama │◀───│ (AI pipeline:    │
                     └──────────┘ └────────┘    │  triage, fix,    │
                                                │  docs, reports…  │
                                                │  via claude CLI) │
                                                └────────┬─────────┘
                                                         │ clone / push / PR
                                                         ▼
                                              GitHub / Bitbucket (repos)
```

The production stack runs six containers:

- `postgres` — PostgreSQL 17 with pgvector (tickets, docs, embeddings, durable
  job queues).
- `ollama` — local embedding model (`bge-m3`) behind an OpenAI-compatible API.
- `server` — Fastify API; applies database migrations on startup.
- `worker` — the AI pipeline (triage, fixes, docs generation, backlog intake,
  activity reports, knowledge-graph builds); needs git and the `claude` CLI.
- `graphify` — MCP server over the knowledge graphs (internal network only).
- `caddy` — serves the static web app, the documentation site (`/guide`) and
  the widget bundle (`/widget.js`), and reverse-proxies the API with automatic
  HTTPS.

The monorepo (pnpm, Node 22):

- `apps/server` — Fastify API: auth, ticketing, ingestion, docs, backlog,
  monitoring, OpenAPI.
- `apps/web` — React web app (TanStack Router/Query, Tailwind).
- `apps/worker` — AI pipeline on top of the `claude` CLI.
- `apps/docs` — documentation site (Astro Starlight), served at `/guide`.
- `packages/sdk` — browser/Node SDK (published to npm).
- `packages/shared` — domain Zod schemas and types (published to npm).
- `packages/mcp` — [`@stubwise/mcp`](https://www.npmjs.com/package/@stubwise/mcp),
  the MCP server for Claude Code (published to npm).
- `packages/widget` — embeddable customer-service widget (IIFE bundle).
- `packages/agent` — the monitoring agent that runs on your hosts.
- `packages/db` — Drizzle schema and migrations (Postgres + pgvector).
- `packages/docs-engine` — the docs-generation engine.
- `packages/embeddings` — embedding client (OpenAI-compatible APIs).
- `packages/git` — `GitProvider` abstraction (GitHub, Bitbucket).
- `packages/notifications` — outgoing webhook formats and dispatch.
- `packages/i18n` — translation catalog (English, Italian).

## Quick start (self-hosting with Docker Compose)

### Prerequisites

- Docker with Docker Compose v2 (`docker compose`).
- A domain pointing at the host, if you want automatic HTTPS.

### 1. Configure the environment

```bash
git clone https://github.com/Aleloca/stubwise.git
cd stubwise
cp .env.example .env
```

Generate the secrets and fill them into `.env` (the `DEPLOY` section):

```bash
openssl rand -hex 32       # -> SESSION_SECRET
openssl rand -base64 32    # -> ENCRYPTION_KEY
openssl rand -hex 24       # -> POSTGRES_PASSWORD (a strong password)
```

- `POSTGRES_PASSWORD`: the database password.
- `DATABASE_URL`: must point at the compose `postgres` service and match
  user/password/db, e.g. `postgres://stubwise:THE_PASSWORD@postgres:5432/stubwise`.
- `SESSION_SECRET` and `ENCRYPTION_KEY`: the two secrets generated above.
- `DOMAIN`: the public domain (e.g. `stubwise.example.com`). For local testing
  use `localhost` (self-signed TLS) or `:80` (plain HTTP).
- `PUBLIC_URL`: the public URL matching `DOMAIN`, e.g.
  `https://stubwise.example.com`.

### 2. Start the stack

```bash
docker compose up -d --build
```

The server applies database migrations on startup; the worker only starts once
the server is healthy. Then open `https://DOMAIN` in your browser.

### 3. Pull the embedding model (once)

Vector search, the RAG chats and the widget need the embedding model. Download
it once after the first `up` (the `ollama` volume persists it across restarts):

```bash
docker compose exec ollama ollama pull bge-m3
```

Until the model is present, embedding calls fail and docs generation errors
out; everything else keeps working.

### 4. Initial setup from the UI

1. On first open you create the **admin** user (the first registered user is
   admin).
2. Create a **project**. From the project page you'll find:
   - the **DSN** to configure the SDK in your app (see below);
   - the endpoint and **git webhook secret** to set on your provider
     (GitHub/Bitbucket) so merged PRs close the ticket;
   - the **git credentials** of the repository the worker will use to clone and
     open PRs (encrypted with `ENCRYPTION_KEY`).

Several features are opt-in per project or per repository from the UI: docs
generation, backlog discovery, daily activity reports, PR review, knowledge
graphs and the customer-service widget.

### 5. Worker auth (claude CLI)

The worker invokes the `claude` CLI for triage, fixes and docs generation, so
it needs authentication. Pick **one** of the two options.

**a) API key (recommended in production).** Set `ANTHROPIC_API_KEY` in `.env`
and restart the worker:

```bash
docker compose up -d worker
```

**b) OAuth/Max login.** Leave `ANTHROPIC_API_KEY` empty and log in
interactively inside the container; the token persists in the `claude-config`
volume (mounted at `CLAUDE_CONFIG_DIR=/home/worker/.claude`), so it survives
restarts and rebuilds:

```bash
docker compose exec worker claude login
```

### Backups

Persistent data lives in the Docker volumes:

- `pgdata`: the database (tickets, projects, users, docs, embeddings, job
  queues).
- `mirrors`: the git mirrors of the projects' repositories (rebuildable, but a
  backup avoids a full re-clone).
- `graphs`: the generated knowledge graphs (rebuildable).
- `ollama`: the downloaded embedding model (re-downloadable).

Example database dump:

```bash
docker compose exec postgres pg_dump -U stubwise stubwise > backup.sql
```

### Updates

```bash
git pull
docker compose up -d --build
```

New migrations are applied by the server on startup.

## Quick start (SDK)

Install the SDK in your application and initialize it with the DSN from the
project page. From then on, unhandled errors become tickets on your instance,
deduplicated by fingerprint.

Browser:

```js
import { init, captureError } from "@stubwise/sdk/browser";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",          // optional: attached to every event
  environment: "production", // optional
});

// global errors + breadcrumbs are captured automatically; or manually:
try {
  doSomethingRisky();
} catch (err) {
  captureError(err);
}
```

Node.js:

```js
import { init } from "@stubwise/sdk/node";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",
  environment: "production",
});
// registers listeners on uncaughtException / unhandledRejection by default
```

Beyond error capture, the SDK exposes `captureFeedback` (explicit user
feedback, which can feed backlog discovery) and `createTicket` (structured
tickets created programmatically).

The DSN's ingestion key is designed to live in client-side code: it can only
*send* events, not read tickets. Details, options and Express/Fastify helpers
are in the SDK documentation.

## Claude Code integration (MCP)

The [`@stubwise/mcp`](https://www.npmjs.com/package/@stubwise/mcp) package
exposes your Stubwise backlog and tickets as MCP tools, so Claude Code can
create backlog items from design docs, convert them into tickets and advance
their status while you work. Configure it with a Personal Access Token from
your Stubwise settings:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "stubwise": {
      "command": "npx",
      "args": ["-y", "@stubwise/mcp"],
      "env": {
        "STUBWISE_URL": "https://stubwise.example.com",
        "STUBWISE_TOKEN": "stw_pat_..."
      }
    }
  }
}
```

See the [integration guide](https://aleloca.github.io/stubwise/integrations/claude-code-mcp/)
for the full tool list.

## Documentation

The documentation site (Astro Starlight) is published at
**<https://aleloca.github.io/stubwise/>** and covers self-hosting,
configuration, the SDK, the AI pipeline, the Docs section, monitoring,
notifications and the API reference. It lives in `apps/docs`; to read it
locally:

```bash
pnpm --filter @stubwise/docs dev
```

On a deployed stack it's served by Caddy under `/guide` (the `/docs` path is
the SPA's "Docs" section — the per-project AI-generated documentation).

Project documents: [designs and implementation plans](docs/plans/).

## Contributing

Development setup, conventions, how to add a new `GitProvider` and the release
process are in [CONTRIBUTING.md](CONTRIBUTING.md). For reports, use the
[issue templates](.github/ISSUE_TEMPLATE/).

## License

[MIT](LICENSE) © Stubwise contributors.
