---
title: Worker auth (Claude)
description: Authenticate the Claude CLI in the worker to enable the AI pipeline, via API key or OAuth/MAX login.
---

The AI pipeline is run by the **worker**, which invokes the `claude` CLI in
headless mode to triage and fix tickets. For it to work, the CLI must be
**authenticated**. You have two ways: choose **one**.

:::note[The AI is optional]
Without authentication the rest of Stubwise still works: the issue tracker
(projects, tickets, board, comments, error ingestion) is fully operational. Only
the AI jobs stay queued or fail — the pipeline is disabled, silently and with no
side effects on the tracker.
:::

## Way a) API key (recommended in production)

Set `ANTHROPIC_API_KEY` in `.env` and restart the worker:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
docker compose up -d worker
```

It's the simplest and most robust way for an unattended deploy.

## Way b) OAuth/MAX login

If you prefer to use a subscription (e.g. Claude MAX) via OAuth login, **leave
`ANTHROPIC_API_KEY` empty** and run the interactive login inside the container:

```bash
docker compose exec worker claude login
```

The token persists in the `claude-config` Docker volume, mounted at
`CLAUDE_CONFIG_DIR=/home/worker/.claude`: it survives restarts and rebuilds, so
the login is done only once.

:::caution[Don't leave `ANTHROPIC_API_KEY` set to empty if you use OAuth]
An `ANTHROPIC_API_KEY=""` that reaches the `claude` CLI can sabotage a valid
OAuth login. The compose is already written to **omit** the variable when it's
not set (it uses `${ANTHROPIC_API_KEY}` without a default), and the worker
discards empty strings downstream from the environment passed to the CLI. To use
OAuth, then, just leave the `ANTHROPIC_API_KEY=` line empty in `.env`.
:::

## What the subprocess sees (and doesn't see)

The worker does **not** pass the entire environment to the `claude` CLI: it
builds an explicit **allowlist**. Only these reach the subprocess:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`;
- `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`;
- all variables starting with `ANTHROPIC_` or `CLAUDE_`.

In particular, the master secrets **never** reach the CLI:
`ENCRYPTION_KEY`, `DATABASE_URL` and `SESSION_SECRET` are in a denylist that
takes absolute precedence. This is a defense against prompt injection: the
prompt contains untrusted ticket content and the agent can run commands (the
tests), so it must never be able to exfiltrate the keys that encrypt the git
credentials of all the projects. See
[Pipeline security](/docs/ai-pipeline/security/).

## Verify

After configuring the auth, create a test ticket (manual, from the web app or
via SDK) on a project with valid git credentials and watch the AI job timeline
in the ticket detail: you should see the triage start. If the CLI isn't
authenticated, the job fails with an authentication error visible in the job
log.
