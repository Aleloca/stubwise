---
title: Self-hosting with Docker Compose
description: Install Stubwise on your own server in a few minutes with Docker Compose, from the secrets to the first login.
---

Stubwise self-hosts with Docker Compose. The stack runs in **four
containers**:

- **`postgres`** — the database (tickets, projects, users, job queues);
- **`server`** — the Fastify API; it **applies the database migrations on
  startup**;
- **`worker`** — the AI pipeline (requires `git` and the `claude` CLI); it
  starts only after the server is healthy;
- **`caddy`** — serves the static web app and the documentation, and acts as a
  reverse proxy to the server, with automatic HTTPS.

:::note[The AI is optional]
If you don't authenticate the `claude` CLI in the worker, the issue tracker
works all the same: errors, feedback, tickets, board and comments stay fully
operational. Only the AI jobs stay queued or fail, without affecting the rest.
See [Worker auth](/docs/getting-started/claude-setup/).
:::

## Prerequisites

- **Docker** with **Docker Compose v2** (the `docker compose` command).
- A **domain** pointing at the host, if you want automatic HTTPS via Let's
  Encrypt. To try it locally, `localhost` or `:80` are enough.

## 1. Configure the environment

Clone the repository and copy the example file:

```bash
git clone https://github.com/Aleloca/stubwise.git
cd stubwise
cp .env.example .env
```

Generate the secrets once:

```bash
openssl rand -hex 32      # -> SESSION_SECRET (min. 32 characters)
openssl rand -base64 32   # -> ENCRYPTION_KEY (32 bytes in base64)
openssl rand -hex 24      # -> POSTGRES_PASSWORD (any strong password)
```

In `.env`, fill in at least these values from the **DEPLOY** section:

| Variable            | Value                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | The database password (required for the deploy).                                                        |
| `DATABASE_URL`      | Must point at the compose `postgres` service and match the user/password/db (see below).                |
| `SESSION_SECRET`    | The secret generated above with `openssl rand -hex 32`.                                                 |
| `ENCRYPTION_KEY`    | The key generated above with `openssl rand -base64 32`.                                                 |
| `DOMAIN`            | The public domain (e.g. `stubwise.example.com`), or `localhost` / `:80` to try it locally.              |
| `PUBLIC_URL`        | The public URL **consistent with `DOMAIN`**, e.g. `https://stubwise.example.com`.                       |

Example `DATABASE_URL` for the deploy (host = `postgres`, **not**
`localhost`, because it points at the compose service):

```bash
DATABASE_URL=postgres://stubwise:YOUR_PASSWORD@postgres:5432/stubwise
```

:::caution[`PUBLIC_URL` must match `DOMAIN`]
`PUBLIC_URL` is the URL Stubwise uses to build the links in comments and the
webhook URLs it delivers to the git provider. If it doesn't match `DOMAIN`, the
PR links and the webhook endpoints come out broken. In production use
`https://<DOMAIN>`.
:::

The complete list of variables, server and worker, is in the
[configuration reference](/docs/reference/configuration/).

## 2. Start

```bash
docker compose up -d --build
```

The server applies the database migrations on startup; the worker and Caddy
wait for it to be healthy. Once it's up, open `https://DOMAIN` in the browser.

## 3. Initial setup from the UI

1. On first open you create the **admin** user: the first to register is the admin.
2. You create a **project**. From the project page you find:
   - the **DSN** to configure the SDK in your app (see
     [SDK installation](/docs/sdk/installation/));
   - the URL and the git **webhook secret** to set on the provider
     (GitHub/Bitbucket) to close tickets when the PR is merged;
   - the repo's **git credentials** that the worker will use to clone and open
     PRs (they are encrypted at rest with `ENCRYPTION_KEY`).

The full tour of the UI is described in [The web app](/docs/getting-started/web-app/).

## Operational notes

A few useful details for those running Stubwise in production.

### The server is single-replica

The server applies the migrations on startup **without an advisory lock**: don't
scale it to multiple replicas, otherwise two processes would try to apply the
migrations at the same time. A single replica is enough for a self-hosted
deploy.

### Worker resource limits

An agent fix can last up to ~30 minutes and clone/build large repositories. The
compose imposes **conservative and adjustable** caps on the worker container:

```yaml
mem_limit: 4g
cpus: 2
```

Without caps, a runaway run would starve `postgres` and `caddy` on the same
host. Raise or lower these values based on the machine and on
`WORKER_CONCURRENCY` (see [pipeline configuration](/docs/ai-pipeline/configuration/)).

### Log rotation

The containers use the `json-file` driver with rotation already configured (`max-size:
10m`, `max-file: 3`, so ~30 MB per service): without it, the logs would grow
until they fill the host's disk.

## Backup

The persistent data lives in two Docker volumes:

- **`pgdata`** — the database (tickets, projects, users, job queues): it's the
  unrecoverable data, it goes in the backup.
- **`mirrors`** — the git mirrors of the project repositories: rebuildable from
  scratch, but the backup avoids a full re-clone.

Database dump:

```bash
docker compose exec postgres pg_dump -U stubwise stubwise > backup.sql
```

## Updates

```bash
git pull
docker compose up -d --build
```

New migrations are applied by the server on startup.
