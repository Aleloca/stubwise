---
title: HTTP API
description: The server's HTTP surface, generated from the routes' Zod schemas.
---

The server exposes a complete HTTP API, used by the web app and available for
privileged scripts. The **OpenAPI 3.1** spec is **automatically derived from the
routes' Zod schemas**: it's always aligned with the code.

## Generated reference pages

The detailed endpoint pages, grouped by tag, are generated from the OpenAPI spec
and appear in the sidebar under this group (**HTTP API**). There you find, for
each endpoint, the method, path, parameters, request schema and response schema.

## The OpenAPI spec

The server publishes the spec as a plain JSON document at:

```
GET /api/openapi.json
```

This route doesn't require a database and responds even on a freshly started
server. The documentation you're reading generates the spec **at build time**,
importing `buildApp()` from the server and dumping `app.swagger()` to a file, so
the API pages stay in sync with the code on every build.

## Authentication

The API under `/api/*` is **session**-authenticated (signed cookie), like the
web app. The public surfaces for the SDKs and the git providers are outside
`/api`:

- **`/ingest/:slug`** — event ingestion from the SDKs, authenticated with the
  **ingestion key** in the `X-Stubwise-Key` header (see
  [SDK installation](/docs/sdk/installation/));
- **`/webhooks/*`** — git webhooks from the providers, authenticated with an
  **HMAC signature**.

## Rate limiting

Two surfaces have a default rate limit (in-memory store, suitable for a
single-instance deploy):

- **login/register**: 10 requests per minute per IP (argon2 is deliberately
  expensive; without a limit it would be a DoS vector);
- **ingestion**: 300 requests per minute per ingestion key.
