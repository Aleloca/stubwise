# Integrazione area 6, fetta 1: la lettura che c'è, il cassetto Google, il riconsenso (piano)

> Design: `docs/plans/2026-11-12-integrazione-area6-design.md` (decisioni del
> 12 nov 2026). Esecutori: stubwise-72 (server, worker, api-client),
> stubwise-94 (renderer). Branch: `feat/area6-f1`, da `feat/integrazione-area6`
> (16f9a05b). Invarianti: `docs/invariants/mail-calendar.md` (tutte; questa
> fetta non ne cambia la dottrina), `permissions.md`.

## Cosa fa

Porta nell'app nuova ciò che il server sa già fare, più ciò che serve per
non dover chiedere due volte il consenso a Google:

1. **Il riconsenso unico (D1)**: gli scope dell'area intera, chiesti adesso.
2. **Il cassetto Google** (Drive, Posta, Calendario, Preferenze → Account):
   collegare, ricollegare, scollegare, proposte sì/no, «cosa manca».
3. **«Aggiorna ora»** per casella.
4. **Letto / non letto sincronizzato con Gmail (D5)**.
5. Posta e Calendario in lettura come oggi (la posta TRATTATA, le proposte
   per casella), più l'evento per id e la ricerca nella pagina; il blocco
   «Eventi in arrivo» della Home.

Fuori (fette dopo): l'importanza e «Posta importante», la classificazione di
ogni email, le proposte condivise e di tipo task (F2); scrivere (F3); scrivere
sul calendario e la disponibilità (F4); Gemini, la scheda di preparazione e
Google Drive (F5).

## Il contratto per il renderer

| Domanda di stubwise-94 | Risposta |
|---|---|
| Gruppo `google` nell'api-client | `client.google.workspaces()`, `connect(workspaceId)` → `{ authorizeUrl }`, `accounts()`, `setProposals(id, enabled)`, `disconnect(id)`, `sync(id)`. Ricollegare = `connect` con lo stesso Workspace: la casella esistente prende gli scope nuovi (nessuna riga doppia). |
| Ritorno OAuth al desktop | Nessun deep link (decisione di 94/46): il callback resta quello del web, che dice l'esito; il renderer rilegge `accounts()` al ritorno in primo piano e mentre il dialogo «Collega» è aperto. Il rimando `stubwise://google` va nel registro. |
| «Aggiorna ora» | `POST /api/me/google/accounts/:id/sync` → 202 `{ status: "queued" }`, o `{ status: "already_queued" }` se ce n'è già una in attesa; 429 `sync_too_soon` con `retryAfterSeconds` se l'ultima richiesta è di meno di 60 s fa; 404 una casella non tua; 409 `account_disabled` per una casella scaduta («Ricollega»). La fine si vede sulla riga della casella: `syncRequestedAt` torna null e `lastSyncAt` avanza (un giro FALLITO: `syncRequestedAt` torna null e `lastSyncAt` resta). In più (F1.2): 409 `proposals_disabled` per una casella con le proposte spente, che il poller non sincronizza; spegnerle toglie la richiesta in attesa. |
| Letto / non letto | `unread: boolean` (default `false`) su ogni thread di `/threads` (vero se un messaggio è non letto) e su ogni messaggio di `/threads/:threadId`. `POST /api/me/mail/threads/:threadId/read` con `{ account, read: boolean }` → 200 col thread. Una casella senza `gmail.modify` → 409 `google_scope_missing` con `missing: [...]` («Ricollega»). |
| Evento per id | `GET /api/me/calendar/events/:id` (nuova), la stessa forma di una riga di `/range`; 404 se non è tuo. «Eventi in arrivo»: `range` da adesso a +7 giorni va bene. |
| Riconsenso | `missingScopes: string[]` (default `[]`) su ogni casella di `accounts()`: gli scope dell'area che la casella non ha concesso. Una casella vecchia continua a LEGGERE come oggi. |
| Ricerca della posta | Nella pagina: `client.mail.threads({ q })`, parametro nuovo (oggetto, mittente, estratto). Quella globale resta `/api/search` con la tipologia posta. |
| Scheda di preparazione | Nessuna rotta la compone oggi: tutta alla F5. |

Ogni campo nuovo è additivo con default; gli stati nuovi passano da
`readerSchema`.

## Il modello (tecnico)

- **Scope** (`packages/google/src/oauth.ts`): `openid`, `email`,
  `gmail.modify`, `calendar.readonly`, `calendar.events`, `drive.readonly`.
  `gmail.modify` sostituisce `gmail.readonly` nella richiesta; una casella
  che ha `gmail.readonly` legge come prima. `missingScopes` si calcola a
  lettura (gli scope richiesti meno quelli concessi), mai salvato.
- **Migrazione** (il primo numero libero, oggi 0149, da ricontrollare):
  - `google_accounts.sync_requested_at` (null quando non c'è una richiesta);
  - `email_messages.unread` (boolean null: null = non ancora saputo, letto
    come `false`).
- **«Aggiorna ora»**: la rotta scrive `sync_requested_at` e fa un
  `pg_notify`; il worker, oltre al giro ogni `GMAIL_POLL_MINUTES`, ascolta il
  canale (con un ripiego ogni 15 s) e fa SUBITO il giro di quella casella,
  poi azzera la richiesta. Il tetto dei 60 s è sulla richiesta, per persona e
  casella.
  Come è fatto (F1.2): la rotta porta anche `next_sync_at` a adesso, quindi è
  il claim di sempre a prendere la casella (prima delle altre dovute: `ORDER
  BY sync_requested_at IS NULL, next_sync_at`), con `SKIP LOCKED` e nessun
  percorso a parte; il NOTIFY sveglia soltanto, e il worker non legge il
  payload per decidere chi sincronizzare. A fine giro si azzera la richiesta
  VISTA al claim; una scritta a giro in corso resta e la casella torna dovuta;
  una casella disabilitata non tiene richieste. Una sveglia a giro in corso fa
  ripartire il giro appena finisce. L'ultima richiesta resta in
  `sync_last_requested_at`, per il tetto. Con `GMAIL_POLL_MINUTES=0` (poller
  spento) una richiesta non viene servita: è il rollback della funzione.
- **Letto / non letto**:
  - all'ingestione `unread` viene dall'etichetta `UNREAD` del messaggio;
  - a ogni giro della casella, i cambi di `UNREAD` fatti su Gmail si
    rileggono dalla history (`labelsAdded`/`labelsRemoved` dal `historyId`
    salvato) per i messaggi che Stubwise ha; il dettaglio di come il poller
    oggi avanza (history o query) lo verifico in F1.2 e lo scrivo qui;
  - la rotta chiama `users.threads.modify` (togli o aggiungi `UNREAD`) col
    token della casella, e scrive lo stato locale SOLO dopo il sì di Google;
    è un gesto della persona (la regola dell'area: nessuna scrittura verso
    Google senza un gesto).
- **Evento per id** e **ricerca nella pagina**: letture con l'id di chi
  guarda nella WHERE (`mailbox_owner` resta com'è in questa fetta).
- **Impostazioni → Google** (web, la configurazione d'istanza): un testo
  d'aiuto dice che gli scope sono ristretti e che un client External deve
  passare la verifica di Google prima di aggiornare; Internal no.

## Fette

- **F1.1 — scope e cassetto**: gli scope, `missingScopes`, ricollegare sulla
  stessa riga, il gruppo `google` nell'api-client, il testo d'aiuto.
- **F1.2 — «Aggiorna ora»**: la migrazione, la rotta coi suoi esiti, il
  worker che risponde alla richiesta.
- **F1.3 — letto / non letto**: `unread` all'ingestione e dalla history, la
  rotta con Google, il 409 senza scope.
- **F1.4 — calendario e ricerca**: l'evento per id, `q` su `/threads`.
- **F1.5 — chiusura**: deploy-log (il riconsenso: cosa vede chi ha una
  casella collegata; l'ordine server, poi worker), invariante, registro.

## Test

- Scope: la richiesta OAuth porta l'elenco nuovo; una casella con gli scope
  vecchi ha `missingScopes` giusti e legge ancora; ricollegare aggiorna la
  stessa riga.
- «Aggiorna ora»: 202 e la notifica; il secondo entro 60 s 429 col tempo; un
  altro utente 404; il worker fa il giro e azzera la richiesta.
- Letto / non letto: ingestione da `UNREAD`; la history che toglie e mette
  `UNREAD`; la rotta chiama Google col token giusto e scrive dopo il sì; un
  rifiuto di Google non cambia lo stato locale; senza `gmail.modify` 409 e
  nessuna chiamata a Google; una casella altrui 404.
- Evento per id: il proprio sì, uno altrui 404. `q`: trova per oggetto e
  mittente, mai nei thread altrui (test negativo, come l'invariante della
  ricerca della posta).
- Nessuna rete vera nei test (la guardia del server): Google è un `fetch`
  iniettato.

## Global Constraints

- Posta e Calendario personali: l'id di chi guarda nella WHERE, anche per
  gli admin; una riga altrui è 404.
- Nessuna scrittura verso Google senza un gesto della persona.
- Verso i client solo campi additivi con default.
- Test filtrati; mutazioni sui test verdi al primo colpo.

## Review Focus

- Il riconsenso: una casella vecchia continua a leggere e dice cosa le manca.
- `threads.modify`: idempotente, e lo stato locale mai prima del sì di Google.
- Il canale di «Aggiorna ora»: nessuna richiesta altrui, nessun giro doppio.
