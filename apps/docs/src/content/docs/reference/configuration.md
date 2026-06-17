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
| `SELF_REPAIR_MAX_ATTEMPTS` | No    | `2`                      | Max self-repair cycles after a fix run whose tests fail (the worker re-runs the agent with the failure output). `0` disables the loop. Enters into the staleness invariant. |
| `SELF_REPAIR_TEST_TIMEOUT_MS` | No | `300000`                 | Timeout in ms (5') of each test-command re-run during self-repair. Enters into the staleness invariant. |
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
