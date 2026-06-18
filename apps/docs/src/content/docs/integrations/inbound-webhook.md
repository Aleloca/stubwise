---
title: Inbound webhook
description: Create a ticket from a single HTTP request, for integrations that don't use the SDK — Zapier, n8n or a script.
---

The **inbound webhook** turns a single HTTP request into a ticket. It's the path
for integrations that don't use the [SDK](/docs/sdk/installation/): a Zapier or
n8n workflow, a shell script, a cron job, or any tool that can do a `POST`.

Unlike [`createTicket`](/docs/sdk/api-tickets/) (which batches events through the
SDK), the inbound webhook is a plain HTTP endpoint authenticated with the
project's ingestion key. The resulting ticket enters the
[AI pipeline](/docs/ai-pipeline/how-it-works/) and your
[automation rules](/docs/ai-pipeline/automation/) exactly like any other.

## Endpoint

```
POST {publicUrl}/api/inbound/{slug}/ticket
```

- `{publicUrl}` is your instance's public URL.
- `{slug}` is the project slug (visible in the project settings).

## Authentication

Send the project's **ingestion key** in the `X-Stubwise-Key` header:

```
X-Stubwise-Key: <project ingestion key>
```

It's the same ingestion key the SDK uses, shown in the project settings
(**Settings → Projects**, *Copy ingestion key*). A missing header, an unknown
slug or a wrong key all return the same **`401`** — the responses are
indistinguishable, so the slugs can't be enumerated.

## Request body

The body is a JSON object with `Content-Type: application/json`.

| Field           | Type     | Required | Values                                                       |
| --------------- | -------- | -------- | ------------------------------------------------------------ |
| `title`         | `string` | Yes      | The ticket title (1–300 characters).                         |
| `body`          | `string` | No       | The description, in markdown.                                |
| `type`          | `string` | Yes      | One of `bug`, `feature`, `task`, `feedback`.                 |
| `priority`      | `string` | No       | One of `low`, `medium`, `high`, `urgent`. Default `medium`.  |
| `reporterEmail` | `string` | No       | The reporter's email address.                                |

## Attribution

If `reporterEmail` matches a Stubwise user, the ticket is **assigned** to that
user. Otherwise it stays unassigned and the reporter (with the email, when
provided) is noted in the ticket body. Either way the ticket carries the
**Webhook** source badge.

## Response

On success the endpoint returns **`201`** with the created ticket:

```json
{
  "id": "tkt_3f9a…",
  "number": 142,
  "url": "https://stubwise.example.com/tickets/tkt_3f9a…"
}
```

`url` is present when the instance has a public URL configured. An invalid
payload (missing `title`, unknown `type`, malformed `reporterEmail`, …) returns
**`422`**; an authentication failure returns **`401`** (see above).

## Example

```bash
curl -X POST "https://stubwise.example.com/api/inbound/web-shop/ticket" \
  -H "X-Stubwise-Key: $STUBWISE_INGESTION_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Checkout returns 500 on coupons",
    "body": "Reproduced on staging with coupon SUMMER25. Stack trace attached in the linked log.",
    "type": "bug",
    "priority": "high",
    "reporterEmail": "ops@acme.example"
  }'
```

A successful call replies with `201` and the `{ id, number, url }` payload above.

:::note[The ticket enters the pipeline]
A ticket created through the inbound webhook goes through triage, automation
rules and the AI pipeline like every other ticket. See
[How the pipeline works](/docs/ai-pipeline/how-it-works/) and
[Automation](/docs/ai-pipeline/automation/).
:::
