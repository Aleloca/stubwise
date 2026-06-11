---
title: API HTTP
description: La superficie HTTP del server, generata dagli schemi Zod delle route.
---

Il server espone un'API HTTP completa, usata dalla web app e disponibile per
script con privilegi. La spec **OpenAPI 3.1** è **derivata automaticamente dagli
schemi Zod** delle route: è sempre allineata al codice.

## Pagine di riferimento generate

Le pagine dettagliate degli endpoint, raggruppate per tag, sono generate dalla
spec OpenAPI e compaiono nella sidebar sotto questo gruppo (**API HTTP**). Lì
trovi, per ogni endpoint, metodo, path, parametri, schema di richiesta e di
risposta.

## La spec OpenAPI

Il server pubblica la spec come documento JSON puro su:

```
GET /api/openapi.json
```

Questa rotta non richiede un database e risponde anche a server appena avviato.
La documentazione che stai leggendo genera la spec **a build time**, importando
`buildApp()` dal server e dumpando `app.swagger()` su file, così le pagine
dell'API restano sincronizzate con il codice ad ogni build.

## Autenticazione

L'API sotto `/api/*` è autenticata **a sessione** (cookie firmato), come la web
app. Le superfici pubbliche per gli SDK e i provider git sono fuori da `/api`:

- **`/ingest/:slug`** — ingestion degli eventi dagli SDK, autenticata con la
  **chiave di ingestion** nell'header `X-Stubwise-Key` (vedi
  [Installazione SDK](/docs/sdk/installation/));
- **`/webhooks/*`** — webhook git dei provider, autenticati con **firma HMAC**.

## Rate limiting

Due superfici hanno un rate limit di default (store in-memory, adatto a un
deploy a singola istanza):

- **login/register**: 10 richieste al minuto per IP (argon2 è deliberatamente
  costoso; senza limite sarebbe un vettore di DoS);
- **ingestion**: 300 richieste al minuto per chiave di ingestion.
