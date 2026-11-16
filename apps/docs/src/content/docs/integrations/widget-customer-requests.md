---
title: Show customers their requests
description: Let the customers of your site follow, on your own pages, the requests and tickets they opened from the widget, with an identity your backend signs.
---

Your customers open requests and report problems through the
[customer service widget](/docs/integrations/widget/). With a **signed
identity** they can also follow them **on your site**: a "My requests" page
that reads, from Stubwise, the requests and tickets **that customer** opened,
with their status in plain words.

Stubwise never writes to your customers here. Your team does not answer inside
the widget. What your page shows is:

- the customer's **own words** (the first message of the conversation);
- the **conversation code**, for example `SHOP-S12`;
- the **status**, in the widget's language: *Received → In evaluation →
  Planned → In progress → Released*, or *We're not going ahead*;
- the date the conversation was opened.

It never shows team names, estimates, comments or internal titles.

## How it works

1. In the widget's settings you generate an **identity secret**. It is shown
   **once**: copy it into your backend's configuration.
2. When a customer is logged in on your site, your **backend** signs a short
   token that says who they are (a standard JWT, HS256).
3. Your page passes the token to the widget, and uses it to call the
   requests API.

The widget's public key is not enough to read anything. Reading always needs a
token signed with the secret, and the secret only lives on your server.

## 1. Generate the identity secret

In **Support → Widgets**, open your widget with **Edit …** and go to the
**Customer identity** section. Choose **Make a secret…**, then **Make secret**;
Stubwise asks you to confirm your second factor. The secret is shown only
then ("This secret is shown only now."): **Copy** it, store it like any other
credential (for example in an environment variable), and press **Done**. The
same section shows the **Widget id (the token's aud)**, with **Copy widget
id**: you need it to sign tokens.

:::caution[Regenerating replaces the secret immediately]
**Regenerate secret…** (then **Regenerate**) creates a new secret, and the old
one stops working at once.
Update your backend in the same moment, or the requests page and the verified
chat stop until you do.
:::

**Only verified customers** (same section, saved with **Save**) makes the
widget refuse a chat without a valid token. Turn it on once your site always
passes the token: from then on, nobody can chat while claiming to be another
customer. Without a secret the switch is disabled ("Make a secret first.").

In a conversation's detail, your team sees whether the customer is a
**Verified customer** or was **Declared by the site**.

## 2. Sign the token on your backend

The token is a JWT signed with **HS256** and the widget's secret. These are the
claims:

| Claim   | Required | Value |
| ------- | -------- | ----- |
| `sub`   | yes | Your stable id for the customer (1–200 characters). The same value you pass as `user.id`. |
| `aud`   | yes | The **widget id**, shown in **Customer identity** ("Widget id (the token's aud)"). A token for one widget is not valid on another. |
| `iat`   | yes | Issued at, in seconds. |
| `exp`   | yes | Expiry, in seconds. At most **24 hours** after `iat`; **1 hour** is a good choice. |
| `email` | no  | The customer's email. |
| `name`  | no  | The customer's display name. |

Any JWT library that produces a plain HS256 token works. The header must be
exactly `{"alg":"HS256","typ":"JWT"}` (or without `typ`): a token whose header
carries anything else, such as a `kid`, is refused. An empty or `null` `email`
or `name` counts as absent; a malformed email makes the token invalid. With no
library, it is a few lines.

**Node.js**

```js
import { createHmac } from "node:crypto";

function widgetToken({ secret, widgetId, customerId, email, name }) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: customerId, aud: widgetId, iat: now, exp: now + 3600, email, name });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
```

**PHP** (with `firebase/php-jwt`)

```php
use Firebase\JWT\JWT;

$now = time();
$token = JWT::encode([
  'sub' => (string) $customer->id,
  'aud' => $widgetId,
  'iat' => $now,
  'exp' => $now + 3600,
  'email' => $customer->email,
], $secret, 'HS256');
```

**Python** (with `PyJWT`)

```python
import time, jwt

now = int(time.time())
token = jwt.encode(
    {"sub": str(customer.id), "aud": widget_id, "iat": now, "exp": now + 3600},
    secret,
    algorithm="HS256",
)
```

:::danger[The secret never goes to the browser]
Sign the token on your server and send the browser only the token. If the
secret ever ends up in a page, anyone can sign in as any of your customers:
regenerate it at once.
:::

## 3. Pass the token to the widget

Add `identityToken` to `initWidget`. It takes the token itself, or a function
that fetches a fresh one from your backend. The widget calls the function
once, and calls it again only when Stubwise refuses the token
(`invalid_identity`: expired, or signed with a replaced secret).

```js
Stubwise.initWidget({
  dsn: "https://WIDGET_KEY@host/p/slug",
  user: { id: "user-123", email: "jane@acme.com" },
  identityToken: () => fetch("/api/stubwise-token").then((r) => r.text()),
});
```

`user.id` must be the token's `sub`. If they differ, the widget is refused.
With a token, the email and name in the token win over the ones in `user`.

Only conversations opened **with a token** appear on the requests page. The
ones opened before you added it stay in your team's Support view. A customer
who comes back signed, to a conversation the widget remembers from before,
continues in a new conversation: what they write signed is always on the
requests page.

## 4. Read the requests

Two endpoints, with the widget key and the token. You can call them from the
browser (the widget's **allowed sites** apply) or from your backend:

```
GET https://YOUR_INSTANCE/widget/<slug>/me/requests
GET https://YOUR_INSTANCE/widget/<slug>/me/requests/<code>

X-Stubwise-Key: WIDGET_KEY
Authorization: Bearer <token>
```

The list:

```json
{
  "items": [
    {
      "code": "SHOP-S12",
      "kind": "request",
      "label": "I'd like to export invoices as CSV.",
      "status": "planned",
      "statusLabel": "Planned",
      "openedAt": "2026-11-16T09:01:00.000Z"
    }
  ],
  "total": 1
}
```

- `kind` is `request` or `ticket`. `status` is one of `received`,
  `evaluating`, `planned`, `in_progress`, `released`, `not_proceeding`, and
  `statusLabel` is the same status in the widget's language.
- The list holds at most 50 items, newest first. `total` counts them all.

The detail adds the customer's conversation with the widget:

```json
{
  "code": "SHOP-S12",
  "kind": "request",
  "label": "I'd like to export invoices as CSV.",
  "status": "planned",
  "statusLabel": "Planned",
  "openedAt": "2026-11-16T09:01:00.000Z",
  "messages": [
    { "from": "customer", "body": "I'd like to export invoices as CSV.", "at": "…" },
    { "from": "assistant", "body": "I've opened a request for you.", "at": "…" }
  ]
}
```

If you use the npm package, `fetchMyRequests` and `fetchMyRequest` call these
endpoints for you:

```js
import { createIdentitySource, fetchMyRequest, fetchMyRequests, parseWidgetDsn } from "@stubwise/widget";

const base = { ...parseWidgetDsn("https://WIDGET_KEY@host/p/slug"), identity: createIdentitySource(getToken) };
const { items } = await fetchMyRequests(base);
const detail = await fetchMyRequest(base, items[0].code);
```

The `<script>` bundle exposes only `initWidget`: from a plain script, call the
endpoints with `fetch`.

:::caution[Render the text as text]
`label` and the message `body` are what your customer (and the AI) wrote.
Insert them as **text**, never as HTML.
:::

## Errors

| Status | Code | Meaning |
| ------ | ---- | ------- |
| 401 | `identity_required` | No token, or the widget requires verified customers. |
| 404 | `widget_disabled` | The widget is switched off: the requests page is off too. |
| 401 | `invalid_identity` | The token is not valid: wrong signature, expired, for another widget, or signed with a replaced secret. The widget asks your function for a new token once. |
| 401 | `identity_mismatch` | `user.id` is not the token's `sub`. |
| 404 | `not_found` | This customer has no request with that code. A code that does not exist and a code of another customer look the same. |
| 403 | `origin_not_allowed` | The page is not one of the widget's allowed sites. |
