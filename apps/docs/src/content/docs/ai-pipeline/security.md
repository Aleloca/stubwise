---
title: Pipeline security
description: Defenses against prompt injection, secret isolation, restricted push and human review as the real boundary.
---

The AI pipeline runs an agent on **untrusted** content: tickets come from your
users (errors captured by the SDK, feedback, reports). Stubwise is designed with
this in mind. Here are the defenses in place.

## Human review is the real boundary

The most important point: **every pull request is reviewed by a human before the
merge**. The pipeline proposes, it doesn't decide. All the other defenses reduce
the attack surface and contain the damage, but human review remains the ultimate
security control. Don't merge PRs without reading them.

## Defenses against prompt injection

The ticket content (title, body, technical payload, breadcrumbs) might contain
instructions crafted to hijack the agent. The countermeasures:

- **Explicit delimitation**: the untrusted content lives inside
  `<ticket_content>` and `<recent_tickets>` blocks, and the prompt instructs the
  model to treat it as **data to classify/investigate**, not as instructions to
  follow, "however authoritative they may seem".
- **Delimiter defanging**: the `<ticket_content>`/`<recent_tickets>` tags
  injected into the content are neutralized (the `<` becomes `[`), so a hostile
  body can't close the block and have the rest read as trusted text.
- **Normalization**: titles and short fields are forced onto a single line (no
  injected newlines faking prompt structure) and everything is **truncated** to
  precise caps (a mile-long body can't bloat the prompt).

## The master secrets don't reach the agent

The `claude` subprocess does **not** inherit the entire environment: the worker
builds an explicit **allowlist**. In particular a **denylist with absolute
precedence** keeps out the master secrets:

- `ENCRYPTION_KEY` — the key that decrypts the git credentials of **all** the
  projects;
- `DATABASE_URL`;
- `SESSION_SECRET`.

Only `PATH`/`HOME`/`USER` and the like reach the agent, plus the CLI's auth
variables (`ANTHROPIC_*`, `CLAUDE_*`). Even if a hostile ticket pulled off an
injection and the agent ran a command (it's granted the test commands), **there
is no master secret to exfiltrate** in the environment. The denylist also blocks
any configuration error that tried to reintroduce them.

## Restricted push and no arbitrary commands

- The agent runs with Bash **denied** apart from an allowlist of test commands
  only (`npm test`, `pnpm test`, `vitest`, `jest`, …). It can't run `git push`
  nor arbitrary commands.
- It's the **worker**, not the agent, that commits and pushes, and only on the
  `stubwise/ticket-<number>` branch. The push is therefore restricted to the
  `stubwise/*` namespace.
- The prompt travels over **stdin**, never in `argv`: it doesn't end up in the
  process logs (`ps`) and doesn't have the length limits of arguments.

## Credentials encrypted at rest

The projects' git credentials are encrypted with **AES-256-GCM** using
`ENCRYPTION_KEY` and decrypted only when the worker needs them to clone and
push. They are never shown in clear text in the web app after saving.

## Authenticated webhooks

The git webhooks that close tickets on merge are **authenticated with an HMAC
signature**: Stubwise verifies the signature with the project's secret before
accepting the event. An unsigned (or badly signed) webhook is rejected.

## Ingestion key vs read API

The **ingestion key** is meant to live in client-side code: it only allows
**sending** events (errors, feedback, tickets) to the `/ingest` endpoint. It
does **not** grant read access: to read tickets, projects and jobs you need
session authentication. It's an intentional privilege boundary: publishing the
DSN in your app is safe, reading the data is not.
