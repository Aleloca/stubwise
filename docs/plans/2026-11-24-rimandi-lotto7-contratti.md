# Rimandi, lotto 7: i contratti per il server

*24 nov 2026, 94 (renderer), su richiesta di 46.* Per ogni voce: cosa fa il
prototipo (la specifica), cosa c'è oggi nell'adattatore e nel server, la
forma che il renderer si aspetta e i «da decidere» con la raccomandazione.

Le voci vengono da `docs/plans/integrazione-registro-rimandi.md`, ritrovate
per contenuto (i numeri «r.» della richiesta non corrispondono più al file):

| § | Area | Voce | Registro |
|---|---|---|---|
| 1 | Chat (A10) | L'esito delle azioni della pagina salvato dal server | «Esito delle azioni della pagina salvato dal server», r.118 |
| 2 | A5 | Lo streaming della chat dei Docs | «Chat dei Docs senza streaming», r.252 |
| 3 | A7 | Il blocco Home delle automazioni; i segnali alla chiusura di un traguardo e alla conversione | Area 7, r.666-668 |

Regole comuni, come nel lotto 4: verso i client solo cambi ADDITIVI (ogni
campo nuovo nasce `.default()`/`.optional()`/`.nullable()`, e il renderer ha
un test con una fixture senza il campo); il client legge i permessi calcolati
dal server, non li deduce.

## I «da decidere», tutti insieme

| § | Domanda | Raccomandazione |
|---|---|---|
| 1.a | Un'azione della pagina letta dalla storia (ricaricamento, altra scheda) riparte da sola? | **No.** Resta «non applicata · Apply», come oggi; il server ricorda solo gli esiti DECISI (`done`, `undone`, `changed_after`, `failed`). |
| 1.b | Il renderer scrive `failed` quando legge dalla storia un'azione mai partita? | **No.** Non è un fallimento: resta `pending` sul server, e la riga lo dice «non applicata». Scrive `failed` solo un tentativo vero andato male. |
| 1.c | Vale anche per le bozze (`fillField`)? | **Sì**, stessa rotta e stesse mosse delle loro: sono l'altra metà di `RENDERER_FNS`. |
| 2.a | Lo streaming cambia cosa si vede (testo parziale) o solo il trasporto? | **Solo il trasporto, per ora**: la risposta compare intera quando è finita, come nel prototipo; il testo che cresce è un cambio di prodotto a parte (scelta del maintainer). |
| 3.a | Le due voci di A7 restano nel registro? | **No, si chiudono**: il blocco c'è già nell'app (test 96b22b5f5), e i segnali li manda il server dalla 0169. |

## 1. Chat — L'esito delle azioni della pagina salvato dal server

### Cosa fa il prototipo

- `PageAction` (`apps/desktop/src/renderer/data/model.ts:1083`): `language`,
  `theme` o `filter { route, search }`. Nella conversazione è un evento
  `{ id, at, type: "pageAction", action, status }` con `status` in
  `pending | done | undone | changed_after | failed` (`model.ts:1555-1564`).
- `settlePageEvent(conversationId, eventId, status)`
  (`data/api-mutations.ts:3692`): solo il proprietario della conversazione,
  con le mosse di `PAGE_EVENT_MOVES` (`:3677`): `pending → done | failed`,
  `done → undone | changed_after`. Le bozze (`fillField`) passano dalla
  stessa funzione con le loro mosse.
- Il runner (`layout/claudePanel/pageActions.ts:172`) gira solo per il
  proprietario, una volta per evento. La riga
  (`pages/claude/conversation/PageActionRow.tsx:73`) dice l'esito; un
  `failed` del proprietario con l'azione ancora applicabile mostra «not
  applied · …» col gesto «Apply» (`:101-122`).

### Cosa c'è oggi

- Adattatore (`data/backend/real/claudeChatActions.ts:477-575`): l'esito sta
  in `pageStatusByPerson`, in memoria e per persona; `settlePageEvent`
  scrive solo lì. Gli eventi li deriva dalle `claude_proposals` confermate
  le cui azioni sono tutte in `RENDERER_FNS` (id `page:<proposalId>:<index>`).
  Nella build app ogni evento letto dalla storia al primo sguardo
  (`readNotLive`, `pageActions.ts:224-232`) finisce `failed` in locale.
- Server: `RENDERER_FNS = {"pageAction", "fillField"}`
  (`packages/shared/src/schemas/claude-actions.ts:243`); la proposta nasce
  `confirmed` (classe A) o, dopo una lettura non fidata, `open` (B) e
  `/confirm` la chiude senza eseguire niente
  (`apps/server/src/claude-actions/proposals.ts:202-239, 545`).
  `claude_proposals` non ha un esito per azione, e nessuna rotta lo scrive.

### Contratto

**Scrittura.** `POST /api/claude/proposals/:id/actions/:index/outcome`
- corpo `{ status: "done" | "undone" | "changed_after" | "failed" }`;
- `config.access`: chi ha chiesto la proposta (il proprietario della
  conversazione), come `confirm`/`cancel`;
- l'azione `index` deve essere una `pageAction` o una `fillField` di una
  proposta `confirmed`, altrimenti 422 `not_a_page_action`;
- mosse ammesse, dall'esito salvato (assente = `pending`):
  `pending → done | failed`, `done → undone | changed_after`. Una mossa
  fuori elenco è 409 `invalid_move` col `current`; la stessa mossa
  ripetuta (`done` su `done`) è 200 e non cambia niente (idempotente: due
  schede che applicano insieme);
- 404 se la proposta non si vede, 403 se non è di chi chiama;
- risposta 200: `{ index, status, at }`.

**Lettura.** La vista della proposta (`claudeProposalViewSchema`) porta
`pageOutcomes: { index: number; status: "done" | "undone" | "changed_after" | "failed"; at: string }[]`,
`.default([])`. Un indice assente è `pending`. Vale ovunque la vista esce
(la conversazione, gli eventi del flusso dal vivo).

**Dove sta.** Una tabella `claude_page_outcomes (proposal_id, action_index,
status, at)`, chiave `(proposal_id, action_index)`, `ON DELETE CASCADE`
sulla proposta. Niente persona: l'esito è del proprietario, l'unico che lo
può scrivere.

### Cosa farà il renderer

- `settlePageEvent` chiama la rotta (poi aggiorna la mappa locale, che
  resta come cache del dal vivo); gli eventi derivati leggono
  `pageOutcomes`;
- un evento letto dalla storia SENZA esito resta `pending` e la riga dice
  «non applicata · Apply» (1.a, 1.b): il `failed` locale di `readNotLive`
  non si scrive sul server;
- un 409 `invalid_move` rilegge la proposta e mostra l'esito del server.

### Test che il renderer scriverà

- adattatore: `settlePageEvent` → corpo e percorso; `pageOutcomes` →
  stato dell'evento; una vista SENZA `pageOutcomes` (server di prima) →
  tutto `pending`;
- pagina: un ricaricamento con un `done` salvato mostra «applicata», non
  «Apply».

## 2. A5 — Lo streaming della chat dei Docs

### Cosa fa il prototipo

- `askDocs({ projectId, repositoryId?, question }): Promise<DocsAnswer>`
  (`data/docs/chat.ts:33`): una promessa sola, niente testo parziale.
  `DocsAnswer = { answeredAt, text, refs, sources }` (`model.ts:2002-2020`).
- Pagina: `useDocsChat` / `DocsChatPanel` (`pages/docs/DocsChat.tsx:54,118`),
  turni locali con `status: pending | done | error | unavailable`.

### Cosa c'è oggi

- Server: GIÀ in streaming. `routes/docs-chat.ts` (`POST
  /api/repositories/:id/docs/chat`, `POST /api/projects/:id/docs/chat`,
  corpo `{ sessionId?, message }`) risponde SSE per default
  (`stream=true`): `{ type: "delta", text }`, poi `{ type: "done", sessionId,
  citations, productSources }` o `{ type: "error", message }`; una risposta
  interrotta si salva con `TRUNCATION_MARKER`. Con `stream=false` dà
  `docsChatAnswerSchema`.
- Adattatore (`data/backend/real/docs.ts:728`): chiama `?stream=false`, quindi
  il main (`api:request`, `main/apiProxy.ts:161`) aspetta l'intera risposta
  dentro `fetch` (undici). Il limite dei 300 s del registro non è scritto
  nel codice: è il `headersTimeout`/`bodyTimeout` predefinito di undici, che
  con `stream=false` scatta prima dell'intestazione.
- I flussi del desktop passano da `api:stream-open` (`main/apiStream.ts`), con
  un'allowlist; un precedente di SSE in POST col corpo validato c'è già:
  `POST /api/me/mail/drafts/claude` (`apiStream.ts:86-100`).

### Contratto

**Il server ha quasi tutto**: le rotte e i frame ci sono. Due fermi, perché
il renderer ci conta:
- i frame restano quelli di oggi (`delta`, `done`, `error`), e `done` porta
  le stesse `citations`/`productSources` che la risposta JSON dà in
  `sources`/`productSources`;
- un frame almeno ogni 30 s anche se il modello tace (un commento SSE
  `: ping`), così né undici né il ping di 60 s del main chiudono un flusso
  lento. Oggi non c'è (né in `routes/docs-chat.ts` né nel suo nucleo): è
  l'unica cosa di server da aggiungere.

### Cosa farà il renderer

- main: la chat dei Docs entra nell'allowlist di `apiStream.ts` (le due POST,
  corpo validato: `message` 1..8000, `sessionId` uuid opzionale);
- adattatore: `askDocs` apre il flusso, raccoglie i `delta` e risolve con
  `done` (`DocsAnswer` come oggi); `error` → l'errore di oggi;
- pagina: invariata (2.a).

### Test che il renderer scriverà

- adattatore: i frame `delta` + `done` → la stessa `DocsAnswer` del JSON; un
  `error` a metà → errore; il percorso nell'allowlist del main.

## 3. A7 — Il blocco Home e i segnali alle automazioni

### Il blocco Home delle automazioni

**Già nell'app.** `AutomationsBlock` (`pages/home/blocks/AutomationsBlock.tsx`)
legge `listMyRuns`, che l'adattatore ha (`real/automationDecisions.ts:108`,
`GET /api/me/automation-runs`), sotto la funzione `automations` accesa dalla
fetta 1 dell'area 7. Mancava solo un test sull'adattatore: c'è da 96b22b5f5
(`real/homePage.test.tsx`, «Automations»). Nessun lavoro del server.

### I segnali alla chiusura di un traguardo e alla conversione

**Già sul server.** Nel prototipo li manda `signalAutomations`:
`milestone_reached` da `updateMilestone` (`api-mutations.ts:1809-1821`,
`closed` da falso a vero) e `request_converted` da `convertRequestAs`
(`:1243-1266`, prima di `task_created`). La voce del registro (10 nov) è di
prima della migrazione 0169 (13 nov), che li manda dal database:
- `milestones_automation_reached` (AFTER UPDATE su `milestones`, `status` che
  va a `closed`);
- `backlog_item_tickets_automation_converted` (AFTER INSERT su
  `backlog_item_tickets` con `role = 'converted_to'`), che `task-writes.ts:247`
  scrive quando una task nasce con `requestId`, cioè proprio la conversione
  dell'app (`real/requests.ts:54`);
- coperti da `packages/db/src/migration-0169.test.ts` e dal consumatore
  (`apps/worker/src/automations/consumer.test.ts`, che ordina
  `request_converted` prima della task).

Gli adattatori non devono chiamare niente: il segnale nasce dalla scrittura.
Rispetto al prototipo al server manca solo la sorgente `deal_won`, che è
un'altra voce.

### Da decidere

3.a, sopra: chiudere le due voci (lo fa questo commit nel registro).
