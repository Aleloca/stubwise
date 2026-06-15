---
title: Come funziona la pipeline
description: "Dal ticket creato alla pull request: triage, fix in un worktree effimero e chiusura al merge."
---

Quando un ticket entra in Stubwise, la pipeline AI può provare a risolverlo da
sola, aprendo una pull request che un umano rivede prima di mergiare. Ecco il
percorso completo.

## Dal ticket al job

1. Un **ticket viene creato** — a mano, dall'SDK (errore o feedback) o via API.
2. Per ogni nuovo ticket viene accodato un **job AI** in stato `queued` nella
   coda su Postgres.
3. Il **worker reclama** atomicamente il job più vecchio (`FOR UPDATE SKIP
   LOCKED`: due worker non prendono mai lo stesso job) e lo porta in `triaging`.

## Fase 1 — Triage

Il triage è la fase **economica**: usa il modello **haiku** e pochi turni, e
**non tocca il repository** (gira in una directory vuota). Decide se vale la
pena spendere quota sul fix. Riceve il ticket e la lista degli ultimi ticket del
progetto, e produce una di tre decisioni:

- **`fix`** — il ticket è un bug azionabile o una piccola feature ben definita,
  con abbastanza contesto: il job avanza a `fixing`.
- **`skip`** — il ticket è vago, non azionabile o richiede giudizio umano: il
  job si chiude con un commento `ai` che spiega il motivo.
- **`duplicate`** — stessa causa radice di un ticket recente: il ticket viene
  chiuso come duplicato, con un commento che lo annota.

Se il modello non emette una decisione valida, il triage **ritenta una volta**;
poi il job fallisce, con entrambi gli output nel log.

:::note[Non tutti i `fix` partono da soli]
Sulla decisione `fix`, il fix avanza in automatico solo se le regole per tipo di
ticket lo consentono (auto-fix attivo ed effort entro la soglia). Altrimenti il
job resta **in attesa** e lo avvii a mano. Vedi
[Automazione AI](/docs/ai-pipeline/automation/).
:::

## Fase 2 — Fix

Sulla decisione `fix`, parte la fase **costosa**. L'agente lavora in un
**worktree effimero** creato su un **mirror git locale** del repository, sul
branch `stubwise/ticket-<numero>`. La procedura che il prompt chiede all'agente:

1. esplorare il codice e **localizzare la causa radice**;
2. se il repo lo consente (framework di test presente), **scrivere un test** che
   dimostra il bug;
3. applicare la **fix minimale**, senza refactoring non correlati;
4. **eseguire i test esistenti** del repo;
5. scrivere un report in **`STUBWISE_REPORT.md`** alla radice, con quattro
   sezioni fisse: *Processo di indagine*, *Causa radice*, *Soluzione*,
   *Motivazione*.

Poi il **worker** (non l'agente) chiude il giro:

- legge `STUBWISE_REPORT.md` come corpo della PR e **lo esclude dal commit**;
- **committa** le modifiche con autore `Stubwise AI <ai@stubwise>`;
- **pusha** il branch `stubwise/ticket-<numero>`;
- **apre la pull request** con il report come descrizione;
- aggiunge un commento `ai` al ticket con il link alla PR e porta il ticket in
  **`in_review`**.

:::note[L'agente non committa e non pusha]
Il prompt vieta esplicitamente all'agente di fare commit o push: lo fa il
worker. L'agente, in modalità headless, può modificare i file ma ha Bash negato
a parte una allowlist di comandi di test. Vedi
[Sicurezza](/docs/ai-pipeline/security/) e
[Configurazione](/docs/ai-pipeline/configuration/).
:::

## Chiusura al merge

Quando un umano **mergia la PR**, il provider git invia un webhook a Stubwise
(se l'hai configurato sul progetto). Stubwise ne **verifica la firma HMAC** e
porta automaticamente il ticket a **`done`**. Se il webhook non è configurato,
sposti tu il ticket dalla board.

## Deduplicazione

Gli errori identici **non** generano un ticket nuovo ogni volta. L'ingestion
calcola un **fingerprint** dell'errore (tipo più i primi frame normalizzati
dello stack, oppure tipo più messaggio normalizzato quando lo stack non è
utilizzabile): errori con lo stesso fingerprint nello stesso progetto
collassano in un unico `ErrorGroup` legato a un solo ticket, e ogni nuova
occorrenza ne **incrementa il contatore** `occurrences` senza accodare un nuovo
job. Così la pipeline lavora una volta sola su un bug ricorrente.

## Serializzazione per progetto

I job di **progetti diversi** procedono in parallelo (fino a
`WORKER_CONCURRENCY`), ma i job dello **stesso progetto** sono **serializzati**:
un secondo fix concorrente sullo stesso repo cancellerebbe i ref non ancora
pushati dell'altro durante il `fetch --prune` del mirror. Il worker accoda le
esecuzioni per `projectId` in una catena di promise. (L'assunzione di deploy è
quindi un **singolo worker**.)
