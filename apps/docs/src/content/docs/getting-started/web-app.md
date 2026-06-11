---
title: La web app
description: Setup admin, inviti, progetti, board Kanban e dettaglio ticket con la timeline dei job AI.
---

La web app è una SPA React servita da Caddy. Questa guida la percorre dal primo
accesso ai ticket.

## Primo accesso: l'admin

Alla prima apertura, finché non esiste nessun utente, Stubwise mostra la pagina
di **setup**: il primo utente che si registra diventa **admin**. Una volta
creato l'admin, la pagina di setup sparisce e ci si autentica dal **login**.

## Invitare altri membri

Solo gli admin possono invitare. Da **Settings → Inviti**:

1. inserisci l'email della persona da invitare e crea l'invito;
2. Stubwise genera un **link di registrazione** con un token, nella forma
   `https://DOMAIN/register?token=...`;
3. **copia il link e consegnalo tu** (email, chat, fuori banda): il token
   compare **una sola volta**, qui.

Chi apre il link arriva alla pagina di registrazione già associata
all'invito e completa l'iscrizione. Gli utenti invitati hanno ruolo **member**
(non admin): vedono la configurazione dei progetti in sola lettura e non possono
crearne di nuovi.

## Creare un progetto

Un progetto lega Stubwise a **un repository git**. Dal menu **Progetti → Nuovo**
(solo admin) imposti:

- **nome** e **slug** (lo slug entra nel DSN dell'SDK);
- **provider** git: `github` o `bitbucket`;
- **URL del repository** e **branch di default**;
- le **credenziali git** (username/token) che il worker userà per clonare e
  aprire le PR. Vengono **cifrate a riposo** con `ENCRYPTION_KEY` e non sono mai
  rimostrate in chiaro.

Nella pagina del progetto, la sezione **Integrazione** (visibile anche ai
member, perché integrare l'SDK non richiede privilegi) mostra **chiave di
ingestion**, **DSN** e uno **snippet `init()`** pronto da copiare. Per gli admin
compare anche la sezione **Webhook** con URL e secret HMAC da configurare sul
provider git: alla merge della PR il ticket passa a `done`.

## La board Kanban

La board mostra una colonna per ogni stato del ciclo di vita di un ticket, in
ordine:

`open` → `triaged` → `in_progress` → `in_review` → `done` → `closed`

Trascini una card da una colonna all'altra (drag-and-drop) per cambiarne lo
stato; un click sulla card apre il dettaglio. Un filtro per progetto vive nei
parametri dell'URL, così la vista è condivisibile.

## Creare un ticket a mano

Il pulsante **Nuovo ticket** apre un dialog con:

- **titolo** (obbligatorio);
- **progetto** di destinazione;
- **tipo**: `bug`, `feature`, `task` o `feedback`;
- **priorità**: `low`, `medium`, `high` o `urgent`;
- **descrizione** (body, opzionale).

I ticket creati a mano hanno source `manual`. Quelli che arrivano dall'SDK
hanno source `sdk_error` o `sdk_feedback`; quelli creati via API `api`.

## Il dettaglio del ticket

La pagina di dettaglio raccoglie tutto ciò che riguarda un ticket:

- il **payload tecnico** dell'errore (messaggio, stack trace, URL, release,
  breadcrumb), quando il ticket viene da un errore catturato dall'SDK;
- i **commenti**, sia umani sia dell'AI (un commento `ai` annota le decisioni
  della pipeline: skip, duplicato, oppure il link alla PR aperta);
- la **timeline dei job AI**: ogni job mostra stato e log, così segui triage e
  fix passo per passo.

Quando la pipeline AI apre una pull request, il ticket passa a `in_review` e nel
dettaglio compare un commento `ai` con il link alla PR e il report. Alla merge
della PR — se il webhook git è configurato — il ticket passa automaticamente a
`done`.
