---
title: Notifiche
description: "Un webhook in uscita (Slack, Discord o JSON generico) avvisa sugli eventi chiave: nuovo ticket, PR aperta, job in attesa, fix fallito."
---

Stubwise può inviare una notifica a un **webhook in uscita** sugli eventi chiave
della piattaforma. È un'unica configurazione (Impostazioni → Notifiche, solo
admin): scegli il formato, incolla l'URL del webhook e decidi su quali eventi
ricevere il messaggio.

## I quattro eventi

| Evento           | Quando scatta                                                              |
| ---------------- | -------------------------------------------------------------------------- |
| `ticket.created` | Un nuovo ticket arriva dall'SDK (errore o feedback).                       |
| `job.pr_opened`  | La pipeline AI ha aperto una pull request per un ticket.                   |
| `job.held`       | Un job è in attesa di revisione umana (gate di automazione / soglia effort). |
| `job.failed`     | Il fix AI è fallito.                                                        |

Ogni evento ha un toggle dedicato: puoi abilitare solo quelli che ti interessano.
L'interruttore generale **Abilitate** sospende tutte le notifiche senza perdere
la configurazione.

## Configurazione in-app (Impostazioni → Notifiche)

Tutta la configurazione vive in **Impostazioni → Notifiche** (solo admin). Il
flusso è:

1. **Abilita** le notifiche con l'interruttore **Abilitate** (lo stesso che le
   sospende tutte senza cancellare nulla).
2. **Incolla l'URL del webhook** nel campo dedicato.
3. **Scegli il formato**: **Slack**, **Discord** o **JSON generico** (vedi le
   guide per provider più sotto). Il formato determina sia la forma del payload
   sia l'anteprima.
4. **Attiva i toggle per-evento** che ti interessano tra i
   [quattro eventi](#i-quattro-eventi).
5. Controlla l'**anteprima dal vivo**: mostra il messaggio o il payload esatto
   che verrà inviato per il formato scelto, generato con la stessa funzione del
   dispatch reale (testo *mrkdwn* per Slack, markdown per Discord, JSON pretty
   per il generico).
6. Premi **Invia notifica di test** per verificare il webhook: invia un evento
   `ticket.created` fittizio all'URL configurato. A differenza del dispatch
   reale (best-effort, silenzioso), questo percorso **riporta gli errori**, così
   capisci subito se l'URL o il formato sono sbagliati.

## Caratteristiche del recapito

- Richiesta **`POST`** con header **`Content-Type: application/json`**.
- **Best-effort**: una notifica mancata non rompe mai l'ingestion né un job. In
  caso di errore di rete o risposta non-2xx **non ci sono ritentativi**.
- Timeout di circa **10 secondi** per richiesta.

## Slack

1. Vai su [api.slack.com/apps](https://api.slack.com/apps).
2. Premi **Create New App** → *From scratch*, scegli nome e workspace.
3. Nel menu laterale apri **Incoming Webhooks** e attivalo (*Activate Incoming
   Webhooks*).
4. Premi **Add New Webhook to Workspace** e scegli il canale di destinazione.
5. Copia l'URL generato (`https://hooks.slack.com/services/...`) e incollalo nel
   campo **URL webhook** in Stubwise, con formato **Slack**.

Il messaggio Slack è un `{ "text": "…" }` in *mrkdwn*, con i link in stile
`<url|etichetta>`.

## Discord

1. Apri le **Impostazioni del canale** (l'icona dell'ingranaggio accanto al nome
   del canale).
2. Vai su **Integrazioni** → **Webhook**.
3. Premi **Nuovo webhook** (puoi rinominarlo, es. "Stubwise").
4. Premi **Copia URL del webhook**.
5. Incolla l'URL in Stubwise, con formato **Discord**.

Il messaggio Discord è un `{ "content": "…" }` in markdown, con i link in stile
`[etichetta](url)`.

## Webhook generico: contratto del payload

Con formato **JSON generico** il tuo endpoint riceve una richiesta `POST` con
`Content-Type: application/json`. Il corpo è un oggetto piatto, machine-readable.

### Campi

| Campo          | Tipo             | Presenza                | Descrizione                                              |
| -------------- | ---------------- | ----------------------- | ------------------------------------------------------- |
| `event`        | string           | sempre                  | Tipo di evento: uno tra i quattro `kind`.               |
| `ticketNumber` | number           | sempre                  | Numero del ticket.                                      |
| `title`        | string           | sempre                  | Titolo del ticket.                                      |
| `projectName`  | string           | sempre                  | Nome del progetto.                                      |
| `message`      | string           | sempre                  | Riepilogo leggibile dell'evento (italiano, senza markup). |
| `ticketUrl`    | string           | sempre                  | Link al ticket in Stubwise.                             |
| `source`       | string           | solo `ticket.created`   | Sorgente SDK: `sdk_error` o `sdk_feedback`.             |
| `prUrl`        | string           | solo `job.pr_opened`    | URL della pull request aperta.                          |
| `costUsd`      | number \| null   | solo `job.pr_opened`    | Costo USD del run di fix (`null` se non noto).          |
| `type`         | string           | solo `job.held`         | Tipo del ticket (ri)classificato dal triage.            |
| `effort`       | number           | solo `job.held`         | Sforzo stimato, da 1 a 5.                               |
| `error`        | string           | solo `job.failed`       | Messaggio d'errore del fix fallito.                     |

### Esempi per evento

`ticket.created`:

```json
{
  "event": "ticket.created",
  "ticketNumber": 128,
  "title": "TypeError: cannot read 'id' of undefined al checkout",
  "projectName": "negozio-web",
  "message": "Nuovo ticket #128 — TypeError: cannot read 'id' of undefined al checkout (negozio-web, sdk_error).",
  "ticketUrl": "https://stubwise.example.com/tickets/128",
  "source": "sdk_error"
}
```

`job.pr_opened`:

```json
{
  "event": "job.pr_opened",
  "ticketNumber": 128,
  "title": "TypeError: cannot read 'id' of undefined al checkout",
  "projectName": "negozio-web",
  "message": "PR aperta per #128 — TypeError: cannot read 'id' of undefined al checkout.",
  "ticketUrl": "https://stubwise.example.com/tickets/128",
  "prUrl": "https://github.com/acme/negozio-web/pull/342",
  "costUsd": 0.18
}
```

`job.held`:

```json
{
  "event": "job.held",
  "ticketNumber": 131,
  "title": "Aggiungere export CSV allo storico ordini",
  "projectName": "negozio-web",
  "message": "#131 in attesa di revisione — Aggiungere export CSV allo storico ordini (feature, effort 4/5).",
  "ticketUrl": "https://stubwise.example.com/tickets/131",
  "type": "feature",
  "effort": 4
}
```

`job.failed`:

```json
{
  "event": "job.failed",
  "ticketNumber": 129,
  "title": "Pagamento non confermato dopo il redirect",
  "projectName": "negozio-web",
  "message": "Fix AI fallito su #129 — Pagamento non confermato dopo il redirect: test suite fallita dopo il fix (3 test rossi).",
  "ticketUrl": "https://stubwise.example.com/tickets/129",
  "error": "test suite fallita dopo il fix (3 test rossi)"
}
```
