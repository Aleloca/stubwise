---
title: Slack
description: Create tickets from Slack with the /stubwise slash command or the "Create Stubwise ticket" message action.
---

The Slack integration lets your team open Stubwise tickets without leaving
Slack. There are two entry points, and both open the same modal (project, title,
description, type):

- the **`/stubwise`** slash command;
- the **"Create Stubwise ticket"** message action, available from the `…` menu
  of any message.

Tickets created this way enter the [AI pipeline](/docs/ai-pipeline/how-it-works/)
and your [automation rules](/docs/ai-pipeline/automation/) like any other, and
carry the **Slack** source badge.

:::note[Not enabled until configured]
Until an admin pastes the Slack credentials, the endpoints respond that the
integration is *not configured* — the slash command shows an ephemeral message
in Slack and nothing else happens.
:::

## Setup (admin)

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
   (**Create New App** → *From scratch*), then choose a name and the workspace.
2. From the app's **Basic Information** page, copy the **Signing Secret**; from
   **OAuth & Permissions**, copy the **Bot Token** (`xoxb-…`).
3. In Stubwise open **Settings → Slack** (admin only) and paste the **Signing
   Secret** and **Bot Token**. They are encrypted at rest and never shown again
   after saving.
4. In the Slack app, configure the request URLs:
   - **Slash Commands** → create `/stubwise` with the request URL
     `{publicUrl}/api/slack/commands`;
   - **Interactivity & Shortcuts** → turn on *Interactivity* and set the request
     URL to `{publicUrl}/api/slack/interactions`.
5. Still under **Interactivity & Shortcuts**, add a **message action** (shortcut
   on messages) named **"Create Stubwise ticket"**.
6. Under **OAuth & Permissions** add the bot token scopes `commands`,
   `users:read` and `users:read.email`, then (re)install the app to the
   workspace.

`{publicUrl}` is your instance's public URL.

## Usage

- **Slash command** — type `/stubwise` in any channel to open the ticket modal,
  fill in project, title, description and type, then submit.
- **Message action** — open the `…` menu on a message and choose **"Create
  Stubwise ticket"**. The modal opens prefilled: the message's first line becomes
  the title and the full message text becomes the description.

## Attribution

When a ticket is submitted, Stubwise reads the Slack user's email through
`users.info`. If that email matches a Stubwise account, the ticket is
**assigned** to that user. Otherwise the ticket stays unassigned and the Slack
author is noted in the body. Either way the ticket carries the **Slack** source
badge.

## Security

- Every request from Slack is verified with the **signing secret** (HMAC over
  the raw body, plus an anti-replay check on the request timestamp). A request
  that fails verification is rejected with `401`.
- The signing secret and bot token are **encrypted at rest** and never shown
  again after saving (you can only replace or remove them).
- If the credentials are missing or can't be decrypted, the integration is
  treated as not enabled: the endpoints never return a `5xx` to Slack.
