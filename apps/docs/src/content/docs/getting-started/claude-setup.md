---
title: Worker auth (Claude)
description: Configure the Claude credentials for the AI pipeline from Settings → AI providers, with an ordered credential chain, failover and usage monitoring.
---

The AI pipeline is run by the **worker**, which invokes the `claude` CLI in
headless mode to triage and fix tickets. For it to work, the worker needs at
least one valid **Claude credential**. You configure these in the web app, under
**Settings → AI providers**.

:::note[The AI is optional]
Without a valid credential the rest of Stubwise still works: the issue tracker
(projects, tickets, board, comments, error ingestion) is fully operational. Only
the AI jobs stay queued or fail — the pipeline is disabled, silently and with no
side effects on the tracker.
:::

## The credential chain

**Settings → AI providers** holds an **ordered chain of credentials**. The
worker tries them **top to bottom**; the first one is the preferred credential.
Each entry is one of two types:

- **API key** — a key created in the
  [Anthropic Console](https://console.anthropic.com/) (it starts with
  `sk-ant-…`). Injected into the CLI as `ANTHROPIC_API_KEY`.
- **Account** — a long-lived OAuth token tied to a Claude subscription
  (e.g. Claude MAX). Injected into the CLI as `CLAUDE_CODE_OAUTH_TOKEN`.

To add a credential, click **New AI provider**, pick the type, give it a label
(e.g. `Console production`) and paste the secret. Secrets are **write-only**:
they're encrypted at rest and never shown again. To change a secret, delete the
provider and create it again. You can **reorder** entries (move up/down),
**enable/disable** them, and **delete** them.

### How to get each secret

- **API key**: in the [Anthropic Console](https://console.anthropic.com/), go to
  **API keys**, create a key and copy it. Paste it into a provider of type
  **API key**.
- **Account**: on a machine **with a browser**, run:

  ```bash
  claude setup-token
  ```

  Complete the login in the browser; the command prints a long-lived OAuth
  token. Copy it and paste it into a provider of type **Account**. You only run
  this on your own machine — the worker container does not need a browser.

## Failover

The worker walks the chain in order. When a credential **hits its usage / rate
limit**, the worker **fails over to the next** enabled credential and retries
the job. If **all** credentials in the chain are exhausted, the job is put in
**`held`** (paused, not failed) and is **retried automatically after the limit
resets**. A disabled or undecryptable credential is skipped without blocking the
others.

## Backward compatibility (env fallback)

If the credential chain is **empty**, the worker falls back to the **historic
environment-based behavior**: whatever auth the `claude` CLI already has in the
container is used. That means:

- an `ANTHROPIC_API_KEY` set in the worker's environment, or
- an OAuth/MAX login persisted in the `claude-config` Docker volume
  (`CLAUDE_CONFIG_DIR=/home/worker/.claude`), set up once with
  `docker compose exec worker claude login`.

So an existing deployment that authenticated via env keeps working unchanged:
the chain is an opt-in layer on top, and the env path is the fallback.

:::caution[Don't leave `ANTHROPIC_API_KEY` set to empty when relying on OAuth]
An `ANTHROPIC_API_KEY=""` that reaches the `claude` CLI can sabotage a valid
OAuth login. The compose **omits** the variable when it's not set (it uses
`${ANTHROPIC_API_KEY}` without a default), and the worker discards empty strings
from the environment passed to the CLI. To use the env-based OAuth login, just
leave the `ANTHROPIC_API_KEY=` line empty in `.env`.
:::

## Usage & costs

The web app exposes two complementary views:

- **Usage & costs** aggregates the **tokens and cost** consumed by the AI jobs,
  so you can see how much the pipeline is spending.
- For **Account** credentials, the worker also performs a **best-effort** read
  of the **remaining subscription usage** (the 5-hour **session** window and the
  **weekly** window) by scraping the CLI's `/usage` output. This is shown next to
  the provider in **Settings → AI providers**.

Because `/usage` is a CLI surface that can change, the read is best-effort: if
the deterministic parser can no longer recognize the output, the app shows a
**diagnostic banner** with the raw text, and the parser in
`apps/worker/src/agent/usage-parser.ts` needs updating. Usage reading never
affects whether jobs run — it only informs.

:::caution[Terms of Service: multiple accounts]
Chaining **two or more Account credentials to get past usage limits is
discouraged by Anthropic** and may lead to **account suspension**. For
production automation Anthropic recommends an **API key**, which is the safer
choice for additional capacity. Using multiple subscriptions is ultimately the
administrator's decision and at their own risk; the app shows a warning when more
than one Account credential is configured.
:::

## What the subprocess sees (and doesn't see)

The worker does **not** pass the entire environment to the `claude` CLI: it
builds an explicit **allowlist**. Only these reach the subprocess:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`;
- `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`;
- all variables starting with `ANTHROPIC_` or `CLAUDE_`.

When the worker injects a credential from the chain it also avoids mixing auths:
for an **API key** it strips any inherited `CLAUDE_CODE_OAUTH_TOKEN`, and for an
**Account** it strips any inherited `ANTHROPIC_API_KEY`.

In particular, the master secrets **never** reach the CLI:
`ENCRYPTION_KEY`, `DATABASE_URL` and `SESSION_SECRET` are in a denylist that
takes absolute precedence. This is a defense against prompt injection: the
prompt contains untrusted ticket content and the agent can run commands (the
tests), so it must never be able to exfiltrate the keys that encrypt the git
credentials of all the projects. See
[Pipeline security](/docs/ai-pipeline/security/).

## Verify

After configuring at least one credential, create a test ticket (manual, from
the web app or via SDK) on a project with valid git credentials and watch the AI
job timeline in the ticket detail: you should see the triage start. If no
credential is usable, the job fails with an authentication error visible in the
job log; if every credential is rate-limited, the job goes to `held` and retries
after the reset.
