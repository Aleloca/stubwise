---
title: Ticket via API
description: Crea ticket strutturati direttamente con createTicket, dall'SDK browser o Node.
---

A volte non vuoi catturare un errore né un feedback, ma creare un **ticket
strutturato** direttamente: una segnalazione che la tua app genera in modo
programmatico. È quello che fa `createTicket`.

## `createTicket`

Disponibile in browser e in Node:

```js
import { createTicket } from "@stubwise/sdk/browser";

createTicket({
  title: "Export PDF fallito per ordini > 1000 righe",
  body: "Si verifica solo sugli ordini con molte righe. Da indagare il timeout del renderer.",
  type: "bug",        // "bug" | "feature" | "task" | "feedback"
  priority: "high",   // "low" | "medium" | "high" | "urgent" (default: "medium")
});
```

| Campo      | Tipo     | Obbligatorio | Valori                                          |
| ---------- | -------- | ------------ | ----------------------------------------------- |
| `title`    | `string` | Sì           | Il titolo del ticket. Un titolo vuoto è scartato (con un warning). |
| `body`     | `string` | No           | La descrizione.                                 |
| `type`     | `TicketType` | Sì       | `bug`, `feature`, `task` o `feedback`.          |
| `priority` | `TicketPriority` | No   | `low`, `medium`, `high`, `urgent`. Default `medium`. |

I ticket creati così hanno source `api`.

## Quando usarlo

- una **segnalazione automatica** dalla tua app o da un job batch (es. "il
  riconciliatore notturno ha trovato N record incoerenti");
- un punto di **"segnala un problema"** in cui l'utente sceglie tipo e priorità;
- l'integrazione con un tuo flusso interno che vuole aprire ticket senza passare
  dalla web app.

Se invece vuoi solo registrare un crash, usa
[`captureError`](/docs/sdk/error-capture/); per un messaggio libero di un utente,
[`captureFeedback`](/docs/sdk/feedback/).

## Robustezza

Come gli altri metodi, `createTicket` **non lancia mai** nell'app ospite e
accoda l'evento per il prossimo flush. Se l'SDK non è ancora stato inizializzato
con `init()`, la chiamata è un no-op con un singolo warning.

## E l'API HTTP "vera"?

`createTicket` passa per l'**endpoint di ingestion** (`/ingest/:slug`,
autenticato con la chiave di ingestion): è la via pensata per i client. Esiste
anche un'API HTTP completa e autenticata a sessione per gestire ticket,
progetti, commenti e job dalla web app o da script con privilegi: è documentata
nella [reference dell'API](/docs/reference/api/).
