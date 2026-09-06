---
title: Environment variables
description: All the server, worker and deploy environment variables, with defaults and constraints.
---

All variables are validated on startup with Zod: the server and worker, if they
find a missing or invalid variable, exit with **a single message** listing them.
The `.env.example` file in the repository documents every variable.

## Server

| Variable         | Required | Default                   | Notes                                                                                 |
| ---------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Yes      | —                         | Postgres connection URL (`postgres://user:pass@host:5432/stubwise`).                  |
| `SESSION_SECRET` | Yes      | —                         | Secret to sign the sessions. **Minimum 32 characters.** `openssl rand -hex 32`.       |
| `ENCRYPTION_KEY` | Yes      | —                         | Key to encrypt the git credentials. **32 bytes in base64.** `openssl rand -base64 32`. |
| `PUBLIC_URL`     | Yes      | —                         | The instance's public URL, used for links and webhooks. Must match `DOMAIN`.          |
| `PORT`           | No       | `3000`                    | The server's listen port (1–65535).                                                   |
| `TRUST_PROXY`    | No       | `false`                   | Trust `X-Forwarded-*` behind a reverse proxy. The compose sets it to `true`.          |

:::note[`ENCRYPTION_KEY` is shared]
The worker's `ENCRYPTION_KEY` must be **the same as the server's**: the server
encrypts the projects' git credentials, the worker decrypts them. If they
differ, the worker can't decrypt the credentials and the fixes fail.
:::

## Worker

The worker reuses `DATABASE_URL` and `ENCRYPTION_KEY` (the same as the server),
plus:

| Variable                | Required | Default                  | Notes                                                                                      |
| ----------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | Yes      | —                        | Like the server.                                                                           |
| `ENCRYPTION_KEY`        | Yes      | —                        | **The same as the server** (see above). 32 bytes in base64.                                |
| `MIRRORS_DIR`           | No       | `/var/stubwise/mirrors`  | Directory of the persistent git mirrors.                                                   |
| `WORKER_CONCURRENCY`    | No       | `2`                      | Jobs in parallel across different projects (1–16).                                         |
| `WORKER_STALE_MINUTES`  | No       | `150`                    | Minutes of inactivity beyond which a job is orphaned. With the defaults it **must exceed ~119'** or the worker won't start. |
| `FIX_TWO_PHASE`         | No       | `true`                   | Two-phase fix: planning (strong model, read-only) + execution (cheap model). `false` = single run. |
| `FIX_PLAN_MODEL`        | No       | `opus`                   | Model of the planning run (analysis + plan, no changes).                                   |
| `FIX_EXECUTE_MODEL`     | No       | `sonnet`                 | Model of the execution run (writes the fix, the test and the report).                      |
| `FIX_PLAN_TIMEOUT_MS`   | No       | `600000`                 | Planning run timeout in ms (10'). Enters into the staleness invariant.                     |
| `AGENT_QUESTION_MAX_ROUNDS` | No   | `5`                      | How many [questions the AI may ask](/docs/notifications/#when-the-ai-asks-a-question) while planning a single fix, answered ones included. Past the ceiling it decides on its own and writes the choice into the plan. Minimum `1`; only runs that plan can ask. |
| `INSTALL_TIMEOUT_MS`    | No       | `600000`                 | Timeout in ms (10') of the dependency install run in the worktree, before the fix and the tests. Runs **once** per job, so it enters the staleness invariant as a single addend (not per attempt). |
| `SELF_REPAIR_MAX_ATTEMPTS` | No    | `2`                      | Max self-repair cycles after a fix run whose tests fail (the worker re-runs the agent with the failure output). `0` disables the loop. Enters into the staleness invariant. |
| `SELF_REPAIR_TEST_TIMEOUT_MS` | No | `300000`                 | Timeout in ms (5') of each test-command re-run during self-repair. Enters into the staleness invariant. |
| `PR_REVIEW_POLL_SECONDS` | No      | `60`                     | Poll interval in seconds of the [PR review](/docs/ai-pipeline/automation/#pr-review) queue. `0` disables the poller. |
| `PR_REVIEW_MODEL`       | No       | `sonnet`                 | Model of the PR review agent (read-only analysis on every PR push: keep it cheap). |
| `PR_REVIEW_MAX_TURNS`   | No       | `50`                     | Max agentic turns per review run (bounds cost and duration).                               |
| `PR_REVIEW_TIMEOUT_MINUTES` | No   | `15`                     | Timeout in **minutes** of a review run. Must stay **below `WORKER_STALE_MINUTES`**, or the stale recovery would fail reviews still alive. |
| `LIMIT_RESUME_POLL_MINUTES` | No   | `5`                      | Poll interval in **minutes** of the [limit resume poller](/docs/documentation/autogenerated/#pause-on-usage-limit): resumes paused Docs generations and requeues jobs held for a provider usage limit. `0` disables the poller (manual **Resume now** only). |
| `LIMIT_RESUME_HEADROOM_PERCENT` | No | `95`                   | Headroom threshold (1–100): an `account` provider with a **fresh** usage snapshot is usable again when its session usage is **below** this percent (and the weekly window isn't exhausted). Default 95 = resume with at least 5% of the session free. |
| `LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES` | No | `60`          | Time fallback in **minutes**: for `api_key` providers (no usage snapshot) or stale/unreadable snapshots, resume when the pause has lasted longer than this. Guarantees nothing stays stuck forever. |
| `DATABASE_POOL_MAX`     | No       | `10`                     | Worker Postgres pool size. Raise it in proportion to `WORKER_CONCURRENCY`; stay below Postgres `max_connections` (default 100). |
| `USAGE_POLL_MINUTES`    | No       | `5`                      | Poll interval of the **usage snapshot** task for `account` providers (runs the free `/usage` command). Separate, best-effort task. `0` disables it. |
| `CREDENTIAL_TEST_POLL_SECONDS` | No | `5`                      | Poll interval of the credential **Test** button queue (Settings → AI providers): runs a minimal `claude -p` with the credential. Separate, best-effort task. `0` disables it. |
| `NOTIFY_POLL_SECONDS`   | No       | `5`                      | Poll interval of the [notification](/docs/notifications/) delivery outbox: claims the due deliveries and sends them on their channel (instance webhook, Slack DM). Short on purpose — a notification must arrive right away. Separate, best-effort task. `0` disables it (deliveries pile up unsent). |
| `PUSH_RELAY_URL`       | No       | the public relay (see note) | Where to send mobile [push notifications](/docs/getting-started/mobile-app/#notifications) for delivery to APNs/FCM. **Three forms, not two**: unset → the public relay we operate (`https://push.stubwise.thecove.it`, `DEFAULT_PUSH_RELAY_URL` in `@stubwise/notifications`) — works with no setup; **empty string** (`PUSH_RELAY_URL=`) → push disabled instance-wide, the safe rollback switch; a URL → that relay instead (self-operated). The instance never holds APNs/FCM keys either way — only the relay does. |
| `ANTHROPIC_API_KEY`     | No       | —                        | Auth of the `claude` CLI (via API key). Alternative: OAuth/MAX login. See below.           |
| `CLAUDE_CONFIG_DIR`     | No       | —                        | Config home of the `claude` CLI. In the compose it's `/home/worker/.claude` (persistent volume). |

The `ANTHROPIC_*` and `CLAUDE_*` variables are forwarded to the `claude`
subprocess; the master secrets (`ENCRYPTION_KEY`, `DATABASE_URL`,
`SESSION_SECRET`) **are not**. See [Worker auth](/docs/getting-started/claude-setup/)
and [Security](/docs/ai-pipeline/security/).

:::caution[`WORKER_STALE_MINUTES` has an invariant]
With the defaults it must exceed **fix (planning 10' + execution 30' = 40') +
self-repair (2 × (execution 30' + test 5') = 70') + 2× triage (2' each = 4') +
margin (5') ≈ 119 minutes**. With `FIX_TWO_PHASE=false` the fix term drops to
the 30' execution alone, and with `SELF_REPAIR_MAX_ATTEMPTS=0` the self-repair
term disappears. The worker checks this condition on startup and **exits (exit
1)** if it's violated. The default `150` satisfies the invariant; leave it
unless you have precise reasons. See [Pipeline configuration](/docs/ai-pipeline/configuration/).
:::

## Embeddings (server & worker)

Vector search, the RAG chats and backlog deduplication use an
OpenAI-compatible embedding API — the compose ships a local
[Ollama](/docs/getting-started/self-hosting/) with `bge-m3` (1024 dimensions).

| Variable             | Required | Default                    | Notes                                                                                   |
| -------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `EMBEDDING_BASE_URL` | No       | `http://ollama:11434/v1`   | OpenAI-compatible base URL (compose default).                                            |
| `EMBEDDING_MODEL`    | No       | `bge-m3`                   | Embedding model (1024 dim). Switching to a different dimension requires a DB migration.  |
| `EMBEDDING_API_KEY`  | No       | —                          | Only if the endpoint requires `Authorization` — Ollama doesn't, leave it empty.          |

## Docs generation (worker)

See [Autogenerated docs](/docs/documentation/autogenerated/).

| Variable                      | Required | Default  | Notes                                                                                        |
| ----------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------- |
| `DOC_GENERATION_MODEL`        | No       | `opus`   | Model of the agent that writes the pages (orientation/explore/synthesize). Strong by default. |
| `DOC_MAX_DEPTH`               | No       | `6`      | Max depth of the recursive DAG: nodes at this depth become leaves (discarded children are logged). Anti-runaway safeguard, not a cost cap. |
| `DOC_MAX_NODES`               | No       | `400`    | Cap on the total DAG nodes per generation (each node is one agent run). Excess children are cut and logged. |
| `DOC_AGENT_TIMEOUT_MS`        | No       | `480000` | Timeout (8') of each docs agent call; a hung call is retried once then failed without blocking the rest of the DAG. |
| `DOC_PRODUCT_MAX_PAGES`       | No       | `12`     | Page budget **per public product surface** (root + journey guides + FAQ). `0` disables the product phase. |
| `DOCS_AUTOUPDATE_POLL_SECONDS`| No       | `60`     | Poll interval of the docs auto-update poller (release entries on push, with debounce). `0` disables it. |
| `DOCS_AUTOUPDATE_MAX_PAGES`   | No       | `10`     | Cap of pages refreshed in place per push (pages whose `sourcePath` is touched by the diff); the rest is flagged as truncated in the release entry. `0` = release entry only. |

## Backlog discovery (worker)

See [Backlog discovery](/docs/team/backlog/).

| Variable                           | Required | Default  | Notes                                                                      |
| ---------------------------------- | -------- | -------- | -------------------------------------------------------------------------- |
| `BACKLOG_POLL_SECONDS`             | No       | `20`     | Poll interval of the backlog job queue. `0` disables the poller.           |
| `BACKLOG_MERGE_THRESHOLD`          | No       | `0.90`   | Similarity (0–1) above which intake merges a request into an existing item. |
| `BACKLOG_SIMILAR_THRESHOLD`        | No       | `0.78`   | Similarity above which an item is flagged "similar to". Must be ≤ the merge threshold. |
| `BACKLOG_MODEL`                    | No       | `sonnet` | Model of the backlog agent (intake + deep dive).                           |
| `BACKLOG_AGENT_TIMEOUT_MS`         | No       | `900000` | Timeout (15') of each backlog agent run.                                   |
| `BACKLOG_CHAT_TURN_POLL_SECONDS`   | No       | `2`      | Fast poller of the code-analysis chat turns. `0` disables turn processing. |
| `BACKLOG_CHAT_SESSION_TTL_MINUTES` | No       | `30`     | Idle minutes before an analysis session is swept (worktree removed).       |
| `BACKLOG_CHAT_TURN_TIMEOUT_MS`     | No       | `300000` | Timeout (5') of the agent run for one chat turn.                           |
| `BACKLOG_CHAT_TURN_MAX_TURNS`      | No       | `15`     | Max agentic turns per chat turn.                                           |

## Proactive pulse (worker)

See [the pulse on idle projects](/docs/notifications/#the-pulse-on-idle-projects).
These variables set the **instance-wide** schedule; the pulse itself is enabled
**per project** (off by default), together with its own cadence in days.

| Variable               | Required | Default | Notes                                                                                                     |
| ---------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `PULSE_POLL_MINUTES`   | No       | `15`    | Poll interval in **minutes** of the pulse poller. `0` disables the feature for the whole instance — no project sends a pulse, whatever its toggle says. Shorter than the send window on purpose, so a skipped tick still meets it. |
| `PULSE_TIMEZONE`       | No       | `UTC`   | IANA time zone of the send window (e.g. `Europe/Rome`). It is the **only** time zone in Stubwise: everything else is UTC. An invalid value **stops the worker from starting** — deliberately, since silently falling back to UTC would send every pulse at the wrong hour forever. |
| `PULSE_SEND_HOUR`      | No       | `9`     | Local hour (`0`–`23`, in `PULSE_TIMEZONE`) at which the send window opens. The window is one hour long.    |
| `PULSE_WEEKDAYS_ONLY`  | No       | `true`  | `true` = no pulse on Saturday and Sunday. It's a standup, not an alert.                                    |

## Plugin registry (worker)

See [Plugins and skills](/docs/ai-pipeline/plugins/). The registry is
instance-wide and managed from the UI; these variables only tune where the
plugins are materialized and how often the queue is drained.

| Variable               | Required | Default    | Notes                                                                                                     |
| ---------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `PLUGINS_DIR`          | No       | `/plugins` | Root of the plugins volume: the worker materializes `<PLUGINS_DIR>/<slug>/<sha>/`. **Only the worker mounts it** — the server reads the inventory from the database — and the path must match the mount in the compose. |
| `PLUGIN_POLL_SECONDS`  | No       | `20`       | Poll interval of the `plugin_jobs` queue (materialization + smoke run). `0` freezes the registry: nothing is fetched and no smoke test runs. ⚠️ It does **not** take plugins out of the runs — plugins already materialized keep being loaded. To stop one, disable it on the projects or remove it from the registry. |

## Daily activity reports (worker)

See [Daily activity reports](/docs/team/activity/).

| Variable                               | Required | Default | Notes                                                                 |
| -------------------------------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `DAILY_REPORT_POLL_MINUTES`            | No       | `15`    | Poll interval of the report poller. `0` disables it.                   |
| `DAILY_REPORT_MAX_AUTHORS_PER_PROJECT` | No       | `25`    | Max authors per project for the AI summaries (beyond: raw data only).  |
| `DAILY_REPORT_RETENTION_DAYS`          | No       | `90`    | Days of retention before old reports are cleaned up.                   |

## Code knowledge graph

See [Code graph (graphify)](/docs/documentation/code-graph/). Build side
(worker):

| Variable                      | Required | Default    | Notes                                                                     |
| ----------------------------- | -------- | ---------- | -------------------------------------------------------------------------- |
| `GRAPHS_DIR`                  | No       | `/graphs`  | Root of the shared graphs volume: the worker writes `<GRAPHS_DIR>/<repositoryId>/graphify-out/`, the server mounts it read-only. |
| `GRAPH_POLL_SECONDS`          | No       | `20`       | Poll interval of the graph build queue. `0` disables automatic builds.     |
| `GRAPH_BUILD_TIMEOUT_MINUTES` | No       | `20`       | Timeout of **each** graphify CLI invocation (extract, clustering, export). |
| `GRAPH_LABEL_ENABLED`         | No       | `true`     | Community labeling via the claude-cli backend. `false` = valid graph with placeholder names. |
| `GRAPHIFY_BIN`                | No       | `graphify` | The graphify CLI binary (name in `PATH` or absolute path).                 |

Retrieval side (server), used by the internal chats:

| Variable                  | Required | Default                      | Notes                                                                  |
| ------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------- |
| `GRAPHIFY_MCP_URL`        | No       | `http://graphify:8080/mcp`   | The graphify MCP server. **Empty string = graph retrieval off** (chats fall back to RAG only). |
| `GRAPH_CHAT_TOKEN_BUDGET` | No       | `1200`                       | Token budget of the subgraph per question (split across repos in project chats). |
| `GRAPH_CHAT_SNIPPET_MAX_CHARS` | No  | `6000`                       | Overall cap of code characters attached to an answer.                  |
| `GRAPH_CHAT_SNIPPET_NODES` | No      | `6`                          | Max subgraph nodes turned into code snippets.                          |

## Deploy (Docker Compose)

These apply only to `docker compose up` (see `docker-compose.yml` and the
[self-hosting](/docs/getting-started/self-hosting/) guide):

| Variable            | Required     | Default    | Notes                                                                                 |
| ------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Yes          | —          | Password of the Postgres user in the container.                                       |
| `POSTGRES_USER`     | No           | `stubwise` | Postgres user.                                                                        |
| `POSTGRES_DB`       | No           | `stubwise` | Database name.                                                                        |
| `DOMAIN`            | Yes (deploy) | `localhost` | Domain served by Caddy. FQDN → automatic HTTPS; `localhost` → self-signed TLS; `:80` → HTTP only. |

For the deploy, `DATABASE_URL` must point at the compose `postgres` service
(host `postgres`, not `localhost`) and match `POSTGRES_USER`/`PASSWORD`/`DB`:

```bash
DATABASE_URL=postgres://stubwise:YOUR_PASSWORD@postgres:5432/stubwise
```

And `PUBLIC_URL` must be consistent with `DOMAIN` (e.g. `https://<DOMAIN>` in
production), otherwise the PR links and the webhook URLs come out broken.
