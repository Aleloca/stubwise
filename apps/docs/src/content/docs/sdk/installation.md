---
title: Installazione dell'SDK
description: Installa @stubwise/sdk e inizializzalo con il DSN del progetto, in browser o in Node.
---

L'SDK di Stubwise cattura errori e feedback dalla tua applicazione e li invia
all'endpoint di ingestion della tua istanza, dove vengono raggruppati in
ticket. Ha due entry point: uno per il **browser** e uno per **Node**.

:::note[Pubblicazione]
L'SDK vive nel monorepo come `@stubwise/sdk`. Le istruzioni qui sotto usano il
nome del pacchetto pubblicato su npm.
:::

## Installazione

```bash
npm install @stubwise/sdk
# oppure: pnpm add @stubwise/sdk / yarn add @stubwise/sdk
```

Il pacchetto espone due sotto-percorsi:

- `@stubwise/sdk/browser` — strumentazione automatica per le app web;
- `@stubwise/sdk/node` — cattura dei crash di processo e middleware per Express
  e Fastify.

## Il DSN

Tutto parte dal **DSN**, che trovi nella sezione **Integrazione** della pagina
del progetto nella web app. Ha questa forma:

```
https://INGESTION_KEY@host/p/slug
```

- `INGESTION_KEY` è la chiave di ingestion del progetto;
- `host` è l'host della tua istanza;
- `slug` è lo slug del progetto.

L'SDK mappa internamente il path `/p/slug` del DSN sull'endpoint `/ingest/slug`
sul filo e invia la chiave nell'header `X-Stubwise-Key`.

:::tip[La chiave di ingestion è pubblicabile]
La chiave di ingestion è pensata per stare in codice **client-side**: consente
solo di *inviare* eventi, non di leggere i ticket. Le API di lettura richiedono
autenticazione. Resta comunque buona norma tenere il DSN in una variabile
d'ambiente o di build.
:::

## Inizializzazione: browser

```js
import { init } from "@stubwise/sdk/browser";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",        // opzionale: allegato a ogni evento
  environment: "production", // opzionale
});
```

Una volta chiamata `init()`, l'SDK installa da solo la cattura automatica degli
errori globali e raccoglie breadcrumb. Vedi
[Cattura degli errori](/docs/sdk/error-capture/).

## Inizializzazione: Node

```js
import { init } from "@stubwise/sdk/node";

init({
  dsn: "https://INGESTION_KEY@host/p/slug",
  release: "1.4.2",
  environment: "production",
  registerProcessHandlers: true, // default: true
});
```

In Node, `init()` registra di default i listener su `uncaughtException` e
`unhandledRejection`. Per disattivarli (es. dentro una test suite, o se vuoi il
pieno controllo del ciclo di vita del processo) passa
`registerProcessHandlers: false`.

## Garanzie di robustezza

L'SDK è progettato per **non rompere mai l'app ospite**. Con un'unica eccezione
voluta: `init()` con un **DSN malformato** lancia subito, perché è un errore di
configurazione che deve emergere all'avvio. Tutto il resto — cattura, breadcrumb,
flush, errori di rete verso l'ingestion — è blindato e non propaga mai
eccezioni nel tuo codice. Una seconda chiamata a `init()` viene ignorata con un
warning, senza duplicare i listener.

## Opzioni di `init()`

| Opzione                   | Tipo      | Default          | Note                                                      |
| ------------------------- | --------- | ---------------- | --------------------------------------------------------- |
| `dsn`                     | `string`  | —                | Obbligatorio. `https://KEY@host/p/slug`.                  |
| `release`                 | `string`  | —                | Allegato a ogni evento.                                   |
| `environment`             | `string`  | —                | Allegato a ogni evento.                                   |
| `flushIntervalMs`         | `number`  | `3000`           | Intervallo di flush automatico.                           |
| `registerProcessHandlers` | `boolean` | `true` (solo Node) | Listener su `uncaughtException`/`unhandledRejection`.   |
