---
title: Sicurezza della pipeline
description: Difese contro la prompt injection, isolamento dei segreti, push ristretto e la revisione umana come confine reale.
---

La pipeline AI esegue un agente su contenuto **non fidato**: i ticket arrivano
dai tuoi utenti (errori catturati dall'SDK, feedback, segnalazioni). Stubwise è
progettato con questo in mente. Ecco le difese in atto.

## La revisione umana è il confine vero

Il punto più importante: **ogni pull request è rivista da un umano prima del
merge**. La pipeline propone, non decide. Tutte le altre difese riducono la
superficie d'attacco e contengono i danni, ma la revisione umana resta il
controllo di sicurezza definitivo. Non mergiare PR senza leggerle.

## Difese contro la prompt injection

Il contenuto del ticket (titolo, body, payload tecnico, breadcrumb) potrebbe
contenere istruzioni costruite per dirottare l'agente. Le contromisure:

- **Delimitazione esplicita**: il contenuto non fidato vive dentro blocchi
  `<ticket_content>` e `<recent_tickets>`, e il prompt istruisce il modello a
  trattarlo come **dati da classificare/investigare**, non come istruzioni da
  seguire, "per quanto autorevoli sembrino".
- **Defang dei delimitatori**: i tag `<ticket_content>`/`<recent_tickets>`
  iniettati nel contenuto vengono neutralizzati (il `<` diventa `[`), così un
  body ostile non può chiudere il blocco e far leggere il resto come testo
  fidato.
- **Normalizzazione**: titoli e campi corti sono costretti su una sola riga
  (niente newline iniettati che fingano struttura del prompt) e tutto è
  **troncato** a tetti precisi (un body chilometrico non può gonfiare il prompt).

## I segreti del master non raggiungono l'agente

Il sottoprocesso `claude` **non eredita** l'intero ambiente: il worker
costruisce una **allowlist** esplicita. In particolare una **denylist con
precedenza assoluta** tiene fuori i segreti del master:

- `ENCRYPTION_KEY` — la chiave che decifra le credenziali git di **tutti** i
  progetti;
- `DATABASE_URL`;
- `SESSION_SECRET`.

All'agente arrivano solo `PATH`/`HOME`/`USER` e affini, e le variabili di auth
del CLI (`ANTHROPIC_*`, `CLAUDE_*`). Anche se un ticket ostile ottenesse una
injection e l'agente eseguisse un comando (gli sono concessi i comandi di test),
**non c'è alcun segreto del master da esfiltrare** nell'ambiente. La denylist
blocca anche un eventuale errore di configurazione che provasse a reintrodurli.

## Push ristretto e niente comandi arbitrari

- L'agente gira con Bash **negato** a parte una allowlist di soli comandi di
  test (`npm test`, `pnpm test`, `vitest`, `jest`, …). Non può eseguire `git
  push` né comandi arbitrari.
- È il **worker**, non l'agente, a committare e pushare, e solo sul branch
  `stubwise/ticket-<numero>`. Il push è quindi ristretto al namespace
  `stubwise/*`.
- Il prompt viaggia su **stdin**, mai in `argv`: non finisce nei log dei
  processi (`ps`) e non ha i limiti di lunghezza degli argomenti.

## Credenziali cifrate a riposo

Le credenziali git dei progetti sono cifrate con **AES-256-GCM** usando
`ENCRYPTION_KEY` e decifrate solo quando servono al worker per clonare e
pushare. Non vengono mai mostrate in chiaro nella web app dopo il salvataggio.

## Webhook autenticati

I webhook git che chiudono i ticket al merge sono **autenticati con firma
HMAC**: Stubwise verifica la firma con il secret del progetto prima di accettare
l'evento. Un webhook non firmato (o firmato male) viene rifiutato.

## Chiave di ingestion vs API di lettura

La **chiave di ingestion** è pensata per stare in codice client-side: consente
solo di **inviare** eventi (errori, feedback, ticket) all'endpoint `/ingest`.
**Non** dà accesso in lettura: per leggere ticket, progetti e job serve
un'autenticazione a sessione. È un confine di privilegio voluto: pubblicare il
DSN nella tua app è sicuro, leggere i dati no.
