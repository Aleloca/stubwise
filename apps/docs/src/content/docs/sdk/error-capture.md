---
title: Error capture
description: Automatic and manual error capture, breadcrumbs and process crashes in the browser and Node.
---

Once `init()` is called, the SDK captures errors. Most of the work is automatic;
for the rest there's `captureError`.

## Browser: automatic capture

In the browser, `init()` installs on its own:

- a listener on `window` for the **`error`** event (unhandled errors);
- a listener on `window` for **`unhandledrejection`** (promises rejected without
  a catch).

Each captured error is attached to the current URL and user agent, plus the
snapshot of the **breadcrumbs** (see below). You don't have to do anything: the
errors become `error` events sent to the ingestion.

### Automatic breadcrumbs

The browser SDK automatically records a trail of breadcrumbs that accompanies
every error:

- **clicks** on elements (described as `tag#id` or `tag.class`, with throttling
  on identical repeated clicks);
- **navigations** (`pushState`/`replaceState`, `popstate`, `hashchange`);
- **failed fetches**: only responses `>= 400` or network errors (successful
  requests don't pollute the trail; POSTs to the ingestion endpoint itself are
  excluded to avoid loops).

The breadcrumbs live in a ring buffer and are included in the snapshot attached
to every error.

### Flush at end of page

When the page is hidden or unloaded (`pagehide`, `visibilitychange`), the SDK
does a flush with `keepalive` so as not to lose the last events.

## Manual capture

Anywhere in the code you can capture an error by hand:

```js
import { captureError } from "@stubwise/sdk/browser"; // or "@stubwise/sdk/node"

try {
  risky();
} catch (err) {
  captureError(err);
}
```

`captureError` accepts any value (an `Error`, a string, an object) and
normalizes it safely. In the browser it attaches the current URL and user agent;
you can override them with the second argument:

```js
captureError(err, { url: "/checkout", userAgent: navigator.userAgent });
```

In Node there's no "current" URL or user agent: `extra` is entirely up to the
caller.

## Node: process crashes

In Node, with `registerProcessHandlers: true` (the default), `init()` registers
the listeners on `uncaughtException` and `unhandledRejection`:

- **`uncaughtException`**: the error is captured and flushed (best effort, with
  a 2-second cap); then, **if the SDK's listener is the only one**, the stack is
  printed and the process exits with code 1, exactly as Node would have done. If
  your app already has its own listener, the process's outcome stays its
  decision.
- **`unhandledRejection`**: it is captured and flushed, without ever terminating
  the process (the same trade-off as the most common error-tracking SDKs).

## Middleware for Express and Fastify

The Node SDK exposes error handlers ready for the two most common frameworks.
Both always **re-propagate** the original error: error handling stays your app's.

### Express

```js
import { expressErrorHandler } from "@stubwise/sdk/node";

// BEFORE your error handlers:
app.use(expressErrorHandler());
```

It captures the error and propagates it with `next(err)`, so the handling chain
stays intact.

### Fastify

```js
import { fastifyErrorHandler } from "@stubwise/sdk/node";

app.setErrorHandler(fastifyErrorHandler());
```

It captures the error and **rethrows** it, so Fastify falls back on its own
default error handler and the HTTP response stays as it always was.

## Manual breadcrumbs

You can add your own breadcrumbs (in the browser and in Node):

```js
import { addBreadcrumb } from "@stubwise/sdk/browser";

addBreadcrumb({ type: "log", message: "checkout started" });
```

The allowed types are `click`, `navigation`, `fetch`, `log`. The `timestamp` is
optional (default: now). They are appended to the ring buffer and included in
the next captured error.

## Manual flush

```js
import { flush } from "@stubwise/sdk/browser";

await flush(); // sends the queue immediately; always resolves, never rejects
```

Usually it's not needed: the SDK flushes on its own at intervals
(`flushIntervalMs`, default 3 s) and, in the browser, at end of page.
