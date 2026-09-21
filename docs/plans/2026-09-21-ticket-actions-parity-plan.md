# Piano — Tutto ciò che si fa su un ticket, anche dall'app (21 set 2026)

Design: `2026-09-21-ticket-actions-parity-design.md`. Sei task. **Nessuna
modifica al server**: le rotte ci sono tutte, i permessi non cambiano.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

## Task 1 — I quattro metodi mancanti nel client condiviso

`packages/api-client/src/endpoints/tickets.ts` guadagna `patch`, `comment`,
`deleteDesign`, `deletePlan`. Le rotte esistono; il web le chiama da
`apps/web/src/lib/api.ts`, che non passa di qui.

⚠️ **Il web NON va migrato a usarli in questo batch.** È un refactor a sé, e
mescolarlo a un lavoro sull'app significa che un rosso non dice più quale dei
due l'ha causato. Se vale la pena, è una PR dopo.

Ogni metodo parsa la risposta con lo schema condiviso, come i suoi vicini.

## Task 2 — Avviare il lavoro, e rispondere a una domanda

Le due che **non richiedono nulla di nuovo**: `runAi` e `answerQuestion` sono
già nel client, mancano solo nella UI.

⚠️ **La risposta a una domanda è la più urgente dei sei** (design §1): oggi le
domande si vedono nella cronologia dell'app ma non si possono rispondere, e un
job fermo lì resta fermo finché qualcuno non apre il web. Va messa **dove la
domanda si vede**, non in un menu: chi la legge deve poter rispondere lì.

`runAi` accetta istruzioni facoltative, come sul web.

## Task 3 — Modificare i campi

Titolo, stato, priorità, tipo, assegnatario, milestone, effort. Una `PATCH`
parziale: i campi non toccati non si mandano — è la forma che il server si
aspetta e l'unica sicura verso un'app che si aggiorna dagli store.

Assegnatario e milestone hanno bisogno di elenchi (persone del progetto,
milestone aperte): se le rotte ci sono si usano, **altrimenti quei due campi
restano fuori da questo batch** e si dice nel design. Non inventare rotte
nuove per riempire un menu a tendina.

## Task 4 — Commentare

Campo di testo più invio, sotto la cronologia. Il commento **compare nella
cronologia** come sul web: se dopo l'invio non si vede, chi scrive non sa se
è andato.

## Task 5 — Le due cancellazioni, con conferma

Design e piano. ⚠️ **Conferma esplicita a due passi** e **mai** in un punto
dove il dito passa scorrendo: sono irreversibili, e su un telefono si tocca
per sbaglio più che su un computer. Il resto delle azioni non chiede conferma.

## Task 6 — I test

1. **Ogni azione chiama il metodo giusto coi parametri giusti** — asserire la
   chiamata, non che il bottone esista.
2. ⚠️ **Nessun controllo di ruolo dove il server non ne ha** (design §3): un
   test verifica che un `member` veda e possa usare le sei azioni. Aggiungere
   una guardia di ruolo qui sarebbe una seconda copia della regola, e la copia
   sbagliata starebbe nel client.
3. **Le quattro azioni sul piano restano riservate a un admin**, come oggi:
   un test che lo conferma, perché questo batch passa vicino a quel codice.
4. **La conferma delle cancellazioni**: un solo tocco non cancella niente.
5. **La risposta a una domanda**: dopo l'invio la domanda non è più in attesa.

⚠️ Nei test dell'app il client è un doppio, quindi `readerSchema` non gira e i
`.default()` non riempiono nulla: le fixture vanno **complete**, o falliscono
tutti i test della schermata con un errore che non nomina il campo mancante
(CLAUDE.md, lezione del 21 set).

⚠️ `render` di RNTL va `await`ato.

---

## Fuori perimetro

- Il server (nessuna rotta, nessun permesso).
- Il web, e la migrazione di `lib/api.ts` al client condiviso (Task 1).
- Azioni che il web non ha: la parità vale in entrambe le direzioni.
