---
title: Tickets via API
description: Create structured tickets directly with createTicket, from the browser or Node SDK.
---

Sometimes you don't want to capture an error or feedback, but to create a
**structured ticket** directly: a report your app generates programmatically.
That's what `createTicket` does.

## `createTicket`

Available in the browser and in Node:

```js
import { createTicket } from "@stubwise/sdk/browser";

createTicket({
  title: "PDF export failed for orders > 1000 rows",
  body: "Happens only on orders with many rows. Investigate the renderer timeout.",
  type: "bug",        // "bug" | "feature" | "task" | "feedback"
  priority: "high",   // "low" | "medium" | "high" | "urgent" (default: "medium")
});
```

| Field      | Type     | Required | Values                                          |
| ---------- | -------- | -------- | ----------------------------------------------- |
| `title`    | `string` | Yes      | The ticket title. An empty title is discarded (with a warning). |
| `body`     | `string` | No       | The description.                                |
| `type`     | `TicketType` | Yes  | `bug`, `feature`, `task` or `feedback`.         |
| `priority` | `TicketPriority` | No | `low`, `medium`, `high`, `urgent`. Default `medium`. |

Tickets created this way have source `api`.

## When to use it

- an **automatic report** from your app or a batch job (e.g. "the nightly
  reconciler found N inconsistent records");
- a **"report a problem"** point where the user chooses type and priority;
- the integration with an internal flow of yours that wants to open tickets
  without going through the web app.

If instead you just want to log a crash, use
[`captureError`](/docs/sdk/error-capture/); for a free-form message from a user,
[`captureFeedback`](/docs/sdk/feedback/).

## Robustness

Like the other methods, `createTicket` **never throws** in the host app and
enqueues the event for the next flush. If the SDK hasn't been initialized yet
with `init()`, the call is a no-op with a single warning.

## And the "real" HTTP API?

`createTicket` goes through the **ingestion endpoint** (`/ingest/:slug`,
authenticated with the ingestion key): it's the path meant for clients. There's
also a complete, session-authenticated HTTP API to manage tickets, projects,
comments and jobs from the web app or from privileged scripts: it's documented
in the [API reference](/docs/reference/api/).
