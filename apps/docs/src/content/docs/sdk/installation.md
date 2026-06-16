---
title: SDK installation
description: Install @stubwise/sdk and initialize it with the project DSN, in the browser or in Node.
---

The Stubwise SDK captures errors and feedback from your application and sends
them to your instance's ingestion endpoint, where they get grouped into
tickets. It has two entry points: one for the **browser** and one for **Node**.

:::note[Publishing]
The SDK lives in the monorepo as `@stubwise/sdk`. The instructions below use the
name of the package published on npm.
:::

## Installation

```bash
npm install @stubwise/sdk
# or: pnpm add @stubwise/sdk / yarn add @stubwise/sdk
```

The package exposes two subpaths:

- `@stubwise/sdk/browser` — automatic instrumentation for web apps;
- `@stubwise/sdk/node` — process crash capture and middleware for Express and
  Fastify.

## The DSN

Everything starts from the **DSN**, which you find in the **Integration**
section of the project page in the web app. It has this form:

```
https://INGESTION_KEY@host/p/slug
```

- `INGESTION_KEY` is the project's ingestion key;
- `host` is your instance's host;
- `slug` is the project's slug.

The SDK internally maps the DSN's `/p/slug` path onto the `/ingest/slug`
endpoint on the wire and sends the key in the `X-Stubwise-Key` header.

:::tip[The ingestion key is publishable]
The ingestion key is meant to live in **client-side** code: it only allows
*sending* events, not reading the tickets. The read APIs require authentication.
It's still good practice to keep the DSN in an environment or build variable.
:::

## Initialization: browser

```js
import { init } from "@stubwise/sdk/browser";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",        // optional: attached to every event
  environment: "production", // optional
});
```

Once `init()` is called, the SDK installs the automatic capture of global errors
on its own and collects breadcrumbs. See
[Error capture](/docs/sdk/error-capture/).

## Initialization: Node

```js
import { init } from "@stubwise/sdk/node";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",
  environment: "production",
  registerProcessHandlers: true, // default: true
});
```

In Node, `init()` registers the listeners on `uncaughtException` and
`unhandledRejection` by default. To disable them (e.g. inside a test suite, or
if you want full control of the process lifecycle) pass
`registerProcessHandlers: false`.

## Robustness guarantees

The SDK is designed to **never break the host app**. With a single intentional
exception: `init()` with a **malformed DSN** throws immediately, because it's a
configuration error that must surface at startup. Everything else — capture,
breadcrumbs, flush, network errors toward the ingestion — is hardened and never
propagates exceptions into your code. A second call to `init()` is ignored with
a warning, without duplicating the listeners.

## `init()` options

| Option                    | Type      | Default          | Notes                                                     |
| ------------------------- | --------- | ---------------- | --------------------------------------------------------- |
| `dsn`                     | `string`  | —                | Required. `https://KEY@host/p/slug`.                      |
| `release`                 | `string`  | —                | Attached to every event.                                  |
| `environment`             | `string`  | —                | Attached to every event.                                  |
| `flushIntervalMs`         | `number`  | `3000`           | Automatic flush interval.                                 |
| `registerProcessHandlers` | `boolean` | `true` (Node only) | Listeners on `uncaughtException`/`unhandledRejection`.  |
