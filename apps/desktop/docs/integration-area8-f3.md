# Integrazione area 8, fetta 3 «Support» — parità col prototipo (14 nov 2026)

Cosa di Support del prototipo arriva sul server vero nella fetta 3
dell'area 8. Piano: `docs/plans/2026-11-14-integrazione-area8-fetta3-plan.md`
(su `docs/area8-f3-plan`, rivisto il 14 nov 2026 con la premessa corretta del
maintainer). Server, worker, widget e `@stubwise/api-client` sono di
stubwise-72 (`feat/area8-f3`); qui il renderer (`feat/area8-f3-renderer`).

**La premessa corretta** (maintainer, 14 nov 2026, via 46): il team non
scrive MAI al cliente nel widget. Una conversazione con un esito (richiesta
legata o ticket del widget) è CHIUSA: un messaggio nuovo del cliente apre la
successiva. Il cliente segue le sue richieste sul sito che ospita il widget
(l'API per i siti: fetta a sé, registro). Il canale `mcp` (i collaboratori
interni) è l'eccezione: lì il team risponde. Il prototipo, che è la specifica,
è stato corretto con la stessa premessa.

Nella build app sono ACCESE la sezione `support` e le funzioni `support` e
`support-widgets`, con le loro chiamate in `INTEGRATED_CALLS` (regola I3).
Resta SPENTA la ricerca ⌘K
(`support-search`, fuori dalla F3). «Clienti in attesa» nella Home non è più
di Support: viene dalla posta delle caselle (piano di 72, `mail-waiting`).
Sono USCITE, dal prototipo e dall'app: la
risposta al cliente nel widget, la bozza di Claude («Ask Claude», la bozza
pronta, l'intento del riquadro e la riga di suggerimento), «Segui» e
`support.customer_replied`, «Scrivigli per email», gli stati `waiting_us` e
`reply_sent`.

## Renderer (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Lo stato della conversazione | una regola sola in `@stubwise/shared` (`supportState`, `SUPPORT_STATE_ORDER`): con un esito `request_open` (chiusa), senza esito il giudizio dopo il silenzio (`not_concluded` / `answered`) o `triage`. Ordine: non concluse, triage, richieste aperte, bastate | `domain/support/state.test.ts`, `data/support/support.test.ts` | fatto |
| Lo stato per il cliente | `customerStatus` di shared, letto dal prototipo con un adattatore | `domain/support/state.test.ts`, `domain/releases/customerStatus.test.ts` | fatto |
| «Not concluded» su una `answered`, «Apri la richiesta» su una non conclusa | con `support.manage` (e `backlog.create` per la richiesta); il giudizio porta il nome di chi l'ha deciso | `data/support/support.test.ts`, `pages/support/Support.test.tsx`, `real/support.test.ts` | fatto |
| Elenco, dettaglio, anteprima | `real/support.ts` su `client.support`: la richiesta legata dà `requestId`, la task dell'esito e il giudizio passano com'erano, un cliente senza nome è «Anonymous visitor», 404 = `null` o elenco vuoto (R-G5), uno stato o un mittente sconosciuto non si mostra | `real/support.test.ts`, `real/supportPage.test.tsx` | fatto |
| La risposta al collaboratore (canale `mcp`) | la casella solo con `canReplyToCollaborator`; `replyToCollaborator` col `clientId` dell'invio; sul widget nessuna casella, e il 409 `support_widget_no_reply` è `invalid: channel` come nel prototipo | `data/support/support.test.ts`, `pages/support/Support.test.tsx`, `real/support.test.ts`, `real/supportPage.test.tsx`, `pages/ComingSoon.test.tsx` | fatto |
| La conversazione chiusa e la successiva (S17) | «Continued in …» / «Follow-up of …» da `continuedIn`/`continuedFrom`; nel prototipo un messaggio su una chiusa apre (o raggiunge) la successiva, ACQ-S2 → ACQ-S9 nel seme | `data/support/support.test.ts`, `real/supportPage.test.tsx`, `data/seed.test.ts` | fatto |
| L'esito che è un ticket del widget (F3-1) | il blocco mostra la task (codice, titolo, cosa vede il cliente); nel prototipo AUD-S1 con esito AUD-6 | `data/support/support.test.ts`, `real/supportPage.test.tsx` | fatto |
| La provenienza di una richiesta | per codice in entrambe le build (`conversationCode`), i messaggi dal dettaglio | `real/requests.test.ts`, `pages/support/Support.test.tsx` | fatto |
| «View conversation» sulle task del widget (S-9) | il codice della conversazione derivato a lettura (server: `supportConversationCode`), solo con Support acceso | `pages/task/TaskDetailSections.test.tsx`, `real/tasks.test.ts` | fatto |
| L'avviso `support.request` | la riga nelle Preferenze (dal catalogo condiviso); la card apre la richiesta nel suo pannello. Nessuna card porta più a Support | `real/session.test.ts` | fatto |
| Il ritmo | nessuno stream: il dettaglio ogni 15 s finché la conversazione è senza esito, l'elenco ogni 30 s | `data/supportRefresh.test.ts` | fatto |
| I widget (R1, R2) | sulle rotte di oggi (`client.widgets`): i nomi del web tradotti, la PUT col corpo intero e i filtri dei repository ancora accesi; i siti ammessi (`origins`) mandati solo quando cambiano; a elenco vuoto «Any site can load this widget.»; la sezione solo con `widget.manage`; lo snippet con l'indirizzo vero dell'istanza e la chiave pubblica | `real/supportWidgets.test.ts`, `pages/support/widgetSnippet.test.ts`, `pages/support/Widgets.test.tsx`, `pages/ComingSoon.test.tsx` | fatto |
| `support.manage` | dal registro condiviso, nel gruppo «Support» con l'etichetta del maintainer; Claude non lo ha (mai un `*.manage`) | `data/access/whoCan.test.ts`, `data/access/effective.test.ts`, `domain/access/access.test.ts` | fatto |

### Differenze dichiarate

- Il triage rifatto nel widget (domande, desiderio riscritto e confermato) è
  fuori dalla F3: `rewrittenWish` e `confirmedAt` arrivano `null` dal server.
- «Clienti in attesa»: spento nell'app; nel prototipo vuoto finché la fetta
  delle email non ne dà la fonte (registro).
- La macchina degli slot della Posta (`?compose=support-…`) resta accettata
  ma inutilizzata, finché non si toglie (registro).
