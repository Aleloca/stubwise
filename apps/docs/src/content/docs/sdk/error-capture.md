---
title: Cattura degli errori
description: Cattura automatica e manuale degli errori, breadcrumb e crash di processo in browser e Node.
---

Una volta chiamata `init()`, l'SDK cattura gli errori. La maggior parte del
lavoro è automatica; per il resto c'è `captureError`.

## Browser: cattura automatica

In browser, `init()` installa da solo:

- un listener su `window` per l'evento **`error`** (errori non gestiti);
- un listener su `window` per **`unhandledrejection`** (promise rifiutate senza
  catch).

Ogni errore catturato viene allegato all'URL e allo user agent correnti, più lo
snapshot dei **breadcrumb** (vedi sotto). Non devi fare nulla: gli errori
diventano eventi `error` inviati all'ingestion.

### Breadcrumb automatici

L'SDK browser registra automaticamente una scia di breadcrumb che accompagna
ogni errore:

- **click** sugli elementi (descritti come `tag#id` o `tag.classe`, con throttle
  sui click ripetuti identici);
- **navigazioni** (`pushState`/`replaceState`, `popstate`, `hashchange`);
- **fetch fallite**: solo le risposte `>= 400` o gli errori di rete (le richieste
  riuscite non sporcano la scia; le POST verso l'endpoint di ingestion stesso
  sono escluse per evitare loop).

I breadcrumb vivono in un ring buffer e vengono inclusi nello snapshot allegato a
ogni errore.

### Flush a fine pagina

Quando la pagina viene nascosta o scaricata (`pagehide`, `visibilitychange`),
l'SDK fa un flush con `keepalive` per non perdere gli ultimi eventi.

## Cattura manuale

In qualunque punto del codice puoi catturare un errore a mano:

```js
import { captureError } from "@stubwise/sdk/browser"; // o "@stubwise/sdk/node"

try {
  rischioso();
} catch (err) {
  captureError(err);
}
```

`captureError` accetta qualunque valore (un `Error`, una stringa, un oggetto) e
lo normalizza in modo sicuro. In browser allega URL e user agent correnti; puoi
sovrascriverli con il secondo argomento:

```js
captureError(err, { url: "/checkout", userAgent: navigator.userAgent });
```

In Node non esistono un URL o uno user agent "correnti": `extra` è interamente
a carico del chiamante.

## Node: crash di processo

In Node, con `registerProcessHandlers: true` (il default), `init()` registra i
listener su `uncaughtException` e `unhandledRejection`:

- **`uncaughtException`**: l'errore viene catturato e flushato (best effort, con
  un tetto di 2 secondi); poi, **se il listener dell'SDK è l'unico**, viene
  stampato lo stack e il processo esce con codice 1, esattamente come avrebbe
  fatto Node. Se la tua app ha già un suo listener, l'esito del processo resta
  una sua decisione.
- **`unhandledRejection`**: viene catturato e flushato, senza mai terminare il
  processo (lo stesso compromesso degli SDK di error tracking più diffusi).

## Middleware per Express e Fastify

L'SDK Node espone error handler pronti per i due framework più comuni. Entrambi
**ripropagano** sempre l'errore originale: la gestione degli errori resta
quella della tua app.

### Express

```js
import { expressErrorHandler } from "@stubwise/sdk/node";

// PRIMA dei tuoi error handler:
app.use(expressErrorHandler());
```

Cattura l'errore e lo propaga con `next(err)`, così la catena di gestione resta
intatta.

### Fastify

```js
import { fastifyErrorHandler } from "@stubwise/sdk/node";

app.setErrorHandler(fastifyErrorHandler());
```

Cattura l'errore e lo **rilancia**, così Fastify ripiega sul proprio default
error handler e la risposta HTTP resta quella di sempre.

## Breadcrumb manuali

Puoi aggiungere breadcrumb tuoi (in browser e in Node):

```js
import { addBreadcrumb } from "@stubwise/sdk/browser";

addBreadcrumb({ type: "log", message: "checkout avviato" });
```

I tipi ammessi sono `click`, `navigation`, `fetch`, `log`. Il `timestamp` è
opzionale (default: adesso). Vengono accodati al ring buffer e inclusi nel
prossimo errore catturato.

## Flush manuale

```js
import { flush } from "@stubwise/sdk/browser";

await flush(); // invia subito la coda; si risolve sempre, non rigetta mai
```

Normalmente non serve: l'SDK flusha da solo a intervalli (`flushIntervalMs`,
default 3 s) e, in browser, a fine pagina.
