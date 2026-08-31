---
title: Slack
description: Create tickets from Slack with the /stubwise slash command or the "Create Stubwise ticket" message action, and receive actionable notifications as direct messages.
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

:::note[This is not the same as the notification webhook]
The **group** notifications (PR opened, job failed, …) go to a channel through a
one-way [Slack incoming webhook](/docs/notifications/) — just a URL Stubwise
posts to. Everything else on this page needs a real Slack **app** with a
*Signing Secret*, a *Bot Token* and scopes, because Slack must be able to call
Stubwise and Stubwise must be able to call Slack: **creating tickets** (slash
command and modal) and the **personal DM notifications** described below. An
incoming webhook alone does **not** provide those. You can add this to an
existing Slack app or create a dedicated one — either works.
:::

:::note[Not enabled until configured]
Until an admin pastes the Slack credentials, the endpoints respond that the
integration is *not configured* — the slash command shows an ephemeral message
in Slack and nothing else happens.
:::

## Setup (admin)

Configure the Slack app first, then install it (installing is what mints the
Bot Token), then paste the credentials into Stubwise:

1. Use an existing Slack app or create one at
   [api.slack.com/apps](https://api.slack.com/apps) (**Create New App** →
   *From scratch*), then choose a name and the workspace.
2. **OAuth & Permissions** → add the bot token scopes `commands`, `users:read`,
   `users:read.email`, `chat:write` and `im:write`. The last two are what let
   Stubwise **open a DM** with a member and **post** (and later edit) the
   [actionable notifications](#actionable-dm-notifications) in it — without
   them the slash command still works, but no DM is ever delivered.
3. **Slash Commands** → create `/stubwise` with the request URL
   `{publicUrl}/api/slack/commands`.
4. **Interactivity & Shortcuts** → turn on *Interactivity* and set the request
   URL to `{publicUrl}/api/slack/interactions`; under the same page add a
   **message action** (shortcut on messages) named **"Create Stubwise ticket"**.
5. **Install** (or reinstall) the app to the workspace to apply the scopes.
   The same `users:read` scope also lets Stubwise list your workspace members
   (so admins can link them and invite them by name) and import their Slack
   avatars — no extra scope is required.
6. Copy the credentials: the **Bot Token** (`xoxb-…`) from **OAuth &
   Permissions**, and the **Signing Secret** from **Basic Information**.
7. In Stubwise open **Settings → Slack** (admin only) and paste the **Signing
   Secret** and **Bot Token**, then save. The badge turns to *enabled*. They are
   encrypted at rest and never shown again after saving.

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

## Slack identity for members

In **Team**, an admin can link each Stubwise member to a user from the Slack
workspace through a picker. Linking does two things:

- It imports the member's **Slack avatar** into Stubwise.
- It lets Slack-created tickets be attributed to that member automatically
  **even when the Slack email does not match** their Stubwise account — the link
  takes precedence over the email lookup described in
  [Attribution](#attribution).

There is also an **auto-link**: if a Slack ticket is attributed by email to a
member who is not linked yet, the link is saved automatically so future tickets
from that Slack user resolve straight away.

### Avatars

Once a member is linked, their Slack avatar is shown across Stubwise — in Team,
as the author on the ticket feed, and as the assignee. Members who are not
linked to Slack get an initials avatar instead.

## Actionable DM notifications

Besides the [group webhook](/docs/notifications/), Stubwise sends **personal**
notifications as a Slack **direct message** — and those DMs carry buttons, so
the usual decisions can be taken without opening Stubwise.

### What arrives in a DM

The same events that feed your Stubwise inbox, addressed to the people they
concern: a **plan awaiting approval**, a **job on hold** (including one held
because the monthly budget is exhausted), a **fix that failed**, a **PR opened**
or **closed without merge**, a **completed PR review**, a **new ticket**, a
**paused Docs generation**, a **monitoring alert**. Decision events go to
administrators; progress events also reach the ticket's people and the project's
followers.

### The buttons

Each DM shows only the actions *that recipient* can actually take right now —
they depend on the event, on the current state of the ticket's job and on the
reader's role:

- **Approve plan** / **Reject** — on a plan waiting at the approval gate
  (administrators). *Reject* opens a small modal where you can type the
  instructions the AI should use to replan; leaving it empty is fine.
- **Relaunch** — on a held, failed, or PR-closed-without-merge job: requeues the
  fix. Not offered while a job for that ticket is still running.
- **Open** — jumps to the place where you'd act: the pull request for
  PR events, the Docs page, the monitored server, otherwise the ticket.
- **Snooze…** — hides the notification for *1 hour*, *tomorrow* or *3 days*.
- **Mark as handled** — closes the notification for everyone.

Once someone decides, the message is **rewritten**: the buttons disappear and a
status line takes their place (`✅ Plan approved by …`, `🔁 Fix relaunched by …`,
and so on), on every recipient's copy — each in their own language. A second
person pressing a stale button gets an ephemeral "already handled by …" reply
instead of a duplicate action.

### Requirements

A DM is only delivered to a member who has **both**:

- a **linked Slack account** — see [Slack identity for
  members](#slack-identity-for-members); an admin links it from **Team**, and
  the [auto-link](#slack-identity-for-members) covers most people already;
- the **Slack DM notifications** preference turned on (in **Account**, on by
  default).

Members without a linked Slack account are not skipped silently as far as
Stubwise is concerned — the notification is still in their in-app inbox, which
is never disabled. Only the DM copy is dropped.

### Upgrading an existing Slack app

If you configured Slack before DM notifications existed, your app only has
`commands`, `users:read` and `users:read.email`, so no DM can be sent. Adding a
scope requires reinstalling the app, and reinstalling mints a **new bot token**:

1. **OAuth & Permissions** → add the bot token scopes `chat:write` and
   `im:write`.
2. **Install App** → *Reinstall to Workspace* and confirm the new permissions.
3. Copy the new **Bot Token** (`xoxb-…`) — reinstalling invalidates the previous
   one, so Stubwise keeps failing until you replace it.
4. In Stubwise open **Settings → Slack** and paste it into **Bot Token**, then
   save. The **Signing Secret** does not change: leave that field empty and the
   stored one is kept.

Nothing else changes — the slash command, the message action, the request URLs
and the notification webhook stay as they are.

## Inviting from the Slack workspace

In the invites section of **Team**, instead of typing an email an admin can pick
a member of the Slack workspace. The invite then **reserves** that person's Slack
identity and avatar, which are applied automatically as soon as the invitee signs
up. This uses the same `users:read` scope — no additional Slack scope is needed.

## Security

- Every request from Slack is verified with the **signing secret** (HMAC over
  the raw body, plus an anti-replay check on the request timestamp). A request
  that fails verification is rejected with `401`.
- The signing secret and bot token are **encrypted at rest** and never shown
  again after saving (you can only replace or remove them).
- If the credentials are missing or can't be decrypted, the integration is
  treated as not enabled: the endpoints never return a `5xx` to Slack.
