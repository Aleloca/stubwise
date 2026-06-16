---
title: Feedback
description: Collect feedback from users with captureFeedback and turn it into tickets.
---

Beyond errors, the SDK can collect explicit user **feedback** — a message
written by a person, not a crash. Feedback becomes tickets with source
`sdk_feedback`.

## `captureFeedback`

Available both in the browser and in Node:

```js
import { captureFeedback } from "@stubwise/sdk/browser";

captureFeedback({
  message: "The payment button doesn't respond on mobile",
  email: "user@example.com", // optional
  url: "/checkout",          // optional
});
```

| Field     | Type     | Required | Notes                                               |
| --------- | -------- | -------- | --------------------------------------------------- |
| `message` | `string` | Yes      | The feedback text. An empty message is discarded (with a warning). |
| `email`   | `string` | No       | Email of the writer, validated as an email server-side. |
| `url`     | `string` | No       | The page the feedback comes from.                   |
| `screenshot` | `boolean` | No   | Browser only. When `true`, the SDK captures a screenshot of the page and attaches it to the ticket. |

If a `release` is set in `init()`, it is automatically attached to the feedback
event.

## Attaching a screenshot

In the **browser**, set `screenshot: true` to automatically capture a screenshot
of the current page and attach it to the feedback ticket:

```js
import { captureFeedback } from "@stubwise/sdk/browser";

captureFeedback({
  message: "The layout is broken on this page",
  screenshot: true,
});
```

The capture uses [`html2canvas`](https://html2canvas.hertzen.com/), loaded
**on-demand** at the moment of capture. It is not bundled by default, so the
feature has no cost for apps that don't use it: make sure `html2canvas` is
available at runtime (install it as a dependency of your app) when you enable
screenshots.

The screenshot is saved as an **attachment** of the feedback ticket, but only if
the instance has [storage configured](/docs/getting-started/web-app/#storage-s3-compatible).
The capture is entirely **best-effort**: if `html2canvas` is missing, the capture
fails, or storage is not configured, the feedback is still sent and the ticket is
still created — just without the screenshot. As with the rest of the SDK, this
never throws into your app.

## A minimal feedback widget

`captureFeedback` is the building block to construct a widget. Example in the
browser:

```js
import { captureFeedback } from "@stubwise/sdk/browser";

document.querySelector("#feedback-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  captureFeedback({
    message: form.message.value,
    email: form.email.value || undefined,
    url: location.pathname,
  });
  form.reset();
  // captureFeedback never throws: no try/catch necessary.
});
```

Like every SDK method (apart from `init()` with a malformed DSN),
`captureFeedback` **never propagates exceptions** into the host app: you can
call it without guards. The event is enqueued and sent at the next flush.

## Where feedback ends up

A piece of feedback becomes a ticket in the project identified by the DSN, with
type `feedback` and source `sdk_feedback`. You manage it from the web app like
any other ticket: in AI triage a vague piece of feedback will typically be
classified as `skip`, while an actionable one can enter the pipeline. See
[How the pipeline works](/docs/ai-pipeline/how-it-works/).
