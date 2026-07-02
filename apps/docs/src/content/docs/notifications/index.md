---
title: Notifications
description: "An outgoing webhook (Slack, Discord or generic JSON) alerts on the key events: new ticket, PR opened, PR closed, held job, plan to approve, PR review completed, failed fix."
---

Stubwise can send a notification to an **outgoing webhook** on the platform's
key events. It's a single configuration (Settings → Notifications, admin only):
you choose the format, paste the webhook URL and decide which events to receive
the message for.

## The events

| Event              | When it fires                                                              |
| ------------------ | -------------------------------------------------------------------------- |
| `ticket.created`   | A new ticket arrives from the SDK (error or feedback).                     |
| `job.pr_opened`    | The AI pipeline has opened a pull request for a ticket.                    |
| `job.pr_closed`    | A PR opened by the AI was closed without merge: the ticket is reopened.    |
| `job.held`         | A job is awaiting human review (automation gate / effort threshold).       |
| `job.plan_review`  | Planning produced a plan awaiting human approval.                          |
| `job.budget_held`  | A job was held because it would exceed a cost budget (per ticket or monthly). |
| `review.completed` | An automatic [PR review](/docs/ai-pipeline/automation/#pr-review) completed, with its verdict. |
| `job.failed`       | The AI fix failed.                                                         |

Each event has a dedicated toggle: you can enable only the ones you care about.
The master **Enabled** switch suspends all notifications without losing the
configuration.

## In-app configuration (Settings → Notifications)

All the configuration lives in **Settings → Notifications** (admin only). The
flow is:

1. **Enable** notifications with the **Enabled** switch (the same one that
   suspends them all without deleting anything).
2. **Paste the webhook URL** in the dedicated field.
3. **Choose the format**: **Slack**, **Discord** or **generic JSON** (see the
   per-provider guides further down). The format determines both the shape of
   the payload and the preview.
4. **Turn on the per-event toggles** you care about among the
   [available events](#the-events).
5. Check the **live preview**: it shows the exact message or payload that will
   be sent for the chosen format, generated with the same function as the real
   dispatch (*mrkdwn* text for Slack, markdown for Discord, pretty JSON for the
   generic one).
6. Press **Send test notification** to verify the webhook: it sends a dummy
   `ticket.created` event to the configured URL. Unlike the real dispatch
   (best-effort, silent), this path **reports the errors**, so you immediately
   understand if the URL or the format are wrong.

## Delivery characteristics

- A **`POST`** request with the **`Content-Type: application/json`** header.
- **Best-effort**: a missed notification never breaks the ingestion nor a job.
  On a network error or a non-2xx response **there are no retries**.
- A timeout of about **10 seconds** per request.

## Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Press **Create New App** → *From scratch*, choose a name and workspace.
3. In the side menu open **Incoming Webhooks** and turn it on (*Activate Incoming
   Webhooks*).
4. Press **Add New Webhook to Workspace** and choose the destination channel.
5. Copy the generated URL (`https://hooks.slack.com/services/...`) and paste it
   into the **Webhook URL** field in Stubwise, with the **Slack** format.

The Slack message is a `{ "text": "…" }` in *mrkdwn*, with links in the
`<url|label>` style.

## Discord

1. Open the **Channel Settings** (the gear icon next to the channel name).
2. Go to **Integrations** → **Webhooks**.
3. Press **New Webhook** (you can rename it, e.g. "Stubwise").
4. Press **Copy Webhook URL**.
5. Paste the URL into Stubwise, with the **Discord** format.

The Discord message is a `{ "content": "…" }` in markdown, with links in the
`[label](url)` style.

## Generic webhook: payload contract

With the **generic JSON** format your endpoint receives a `POST` request with
`Content-Type: application/json`. The body is a flat, machine-readable object.

### Fields

| Field          | Type             | Presence                | Description                                              |
| -------------- | ---------------- | ----------------------- | ------------------------------------------------------- |
| `event`        | string           | always                  | Event type: one of the `kind`s listed above.            |
| `ticketNumber` | number           | always                  | The ticket number.                                      |
| `title`        | string           | always                  | The ticket title.                                       |
| `projectName`  | string           | always                  | The project name.                                       |
| `message`      | string           | always                  | Human-readable summary of the event, no markup. Rendered in the instance's [content language](/docs/ai-pipeline/configuration/#content-language) (not always English). |
| `ticketUrl`    | string           | always                  | Link to the ticket in Stubwise.                         |
| `source`       | string           | only `ticket.created`   | SDK source: `sdk_error` or `sdk_feedback`.              |
| `prUrl`        | string           | only `job.pr_opened` / `job.pr_closed` / `review.completed` | Pull request URL. |
| `costUsd`      | number \| null   | only `job.pr_opened`    | USD cost of the fix run (`null` if unknown).            |
| `type`         | string           | only `job.held`         | Ticket type (re)classified by triage.                   |
| `effort`       | number           | only `job.held`         | Estimated effort, from 1 to 5.                          |
| `scope`        | string           | only `job.budget_held`  | Which budget was hit: `ticket` or `monthly`.            |
| `limitUsd`     | number           | only `job.budget_held`  | The budget ceiling in USD.                              |
| `spentUsd`     | number           | only `job.budget_held`  | The cost already spent in USD.                          |
| `verdict`      | string           | only `review.completed` | Review verdict: `approve` or `request_changes`.         |
| `error`        | string           | only `job.failed`       | Error message of the failed fix.                        |

### Examples per event

`ticket.created`:

```json
{
  "event": "ticket.created",
  "ticketNumber": 128,
  "title": "TypeError: cannot read 'id' of undefined at checkout",
  "projectName": "web-shop",
  "message": "New ticket #128 — TypeError: cannot read 'id' of undefined at checkout (web-shop, sdk_error).",
  "ticketUrl": "https://stubwise.example.com/tickets/128",
  "source": "sdk_error"
}
```

`job.pr_opened`:

```json
{
  "event": "job.pr_opened",
  "ticketNumber": 128,
  "title": "TypeError: cannot read 'id' of undefined at checkout",
  "projectName": "web-shop",
  "message": "PR opened for #128 — TypeError: cannot read 'id' of undefined at checkout.",
  "ticketUrl": "https://stubwise.example.com/tickets/128",
  "prUrl": "https://github.com/acme/web-shop/pull/342",
  "costUsd": 0.18
}
```

`job.pr_closed`:

```json
{
  "event": "job.pr_closed",
  "ticketNumber": 128,
  "title": "TypeError: cannot read 'id' of undefined at checkout",
  "projectName": "web-shop",
  "message": "PR closed without merge — ticket reopened: #128 — TypeError: cannot read 'id' of undefined at checkout.",
  "ticketUrl": "https://stubwise.example.com/tickets/128",
  "prUrl": "https://github.com/acme/web-shop/pull/342"
}
```

`job.held`:

```json
{
  "event": "job.held",
  "ticketNumber": 131,
  "title": "Add CSV export to the order history",
  "projectName": "web-shop",
  "message": "#131 awaiting review — Add CSV export to the order history (feature, effort 4/5).",
  "ticketUrl": "https://stubwise.example.com/tickets/131",
  "type": "feature",
  "effort": 4
}
```

`job.plan_review`:

```json
{
  "event": "job.plan_review",
  "ticketNumber": 131,
  "title": "Add CSV export to the order history",
  "projectName": "web-shop",
  "message": "Plan awaiting approval — #131 — Add CSV export to the order history (web-shop).",
  "ticketUrl": "https://stubwise.example.com/tickets/131"
}
```

`job.budget_held`:

```json
{
  "event": "job.budget_held",
  "ticketNumber": 130,
  "title": "Refactor the checkout flow",
  "projectName": "web-shop",
  "message": "Budget exceeded (ticket) — #130 Refactor the checkout flow (web-shop): spent $2.34 of $2.00 limit. Job on hold; start it manually to override.",
  "ticketUrl": "https://stubwise.example.com/tickets/130",
  "scope": "ticket",
  "limitUsd": 2,
  "spentUsd": 2.34
}
```

`review.completed`:

```json
{
  "event": "review.completed",
  "ticketNumber": 133,
  "title": "Review PR #351 — cart refactor",
  "projectName": "web-shop",
  "message": "PR review completed for #133 — Review PR #351 — cart refactor (web-shop): approval suggested.",
  "ticketUrl": "https://stubwise.example.com/tickets/133",
  "prUrl": "https://github.com/acme/web-shop/pull/351",
  "verdict": "approve"
}
```

`job.failed`:

```json
{
  "event": "job.failed",
  "ticketNumber": 129,
  "title": "Payment not confirmed after the redirect",
  "projectName": "web-shop",
  "message": "AI fix failed on #129 — Payment not confirmed after the redirect: test suite failed after the fix (3 tests red).",
  "ticketUrl": "https://stubwise.example.com/tickets/129",
  "error": "test suite failed after the fix (3 tests red)"
}
```
