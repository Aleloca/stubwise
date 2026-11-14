# Integrazione area 8, fetta 3 «Support» — parità col prototipo (14 nov 2026)

Cosa di Support del prototipo arriva sul server vero nella fetta 3
dell'area 8. Piano: `docs/plans/2026-11-14-integrazione-area8-fetta3-plan.md`
(su `docs/area8-f3-plan`), con le decisioni del maintainer (F3-1 … F3-6, G-1
e «Not concluded» su una `answered`). Server, worker, widget e
`@stubwise/api-client` sono di stubwise-72 (`feat/area8-f3`); qui il renderer
(`feat/area8-f3-renderer`).

Nella build app sono ACCESE la sezione `support` e le funzioni `support`
(letture e scritture), `support-email` (S9), `support-home` (S8) e
`support-widgets`, con le loro chiamate in `INTEGRATED_CALLS` (regola I3).
Restano SPENTE, ciascuna con la sua funzione: la bozza di Claude
(`support-draft`, il lavoro del worker è fermo su un [DECIDE] di 46) e la
ricerca ⌘K (`support-search`, fuori dalla F3).

## Renderer (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Lo stato della conversazione (R7) | una regola sola in `@stubwise/shared` (`supportState`, `waitingSince`, `SUPPORT_STATE_ORDER`), con l'ingresso neutro del server: esito (richiesta legata o ticket del widget), giudizio dopo il silenzio, messaggi. Il prototipo la legge dai suoi oggetti; `answered` è nuovo anche lì, in fondo all'elenco | `domain/support/state.test.ts` (anche: la funzione è quella di shared) | fatto |
| Lo stato per il cliente | `customerStatus` di shared, letto dal prototipo con un adattatore | `domain/support/state.test.ts`, `domain/releases/customerStatus.test.ts` | fatto |
| «Not concluded» su una `answered` | decisione del maintainer: con `support.reply` la rimette fra quelle che aspettano il team; il giudizio porta il nome di chi l'ha deciso; il blocco dice dopo quanti minuti di silenzio (`SUPPORT_TRIAGE_IDLE_MINUTES`) | `data/support/support.test.ts`, `pages/support/Support.test.tsx` | fatto |
| Elenco, dettaglio, anteprima, «Clienti in attesa» | `real/support.ts` su `client.support`: la richiesta legata dà `requestId`, la task dell'esito e il giudizio passano com'erano, un cliente senza nome è «Anonymous visitor», 404 = `null` o elenco vuoto (R-G5), da un server più nuovo uno stato o un mittente sconosciuto non si mostra | `real/support.test.ts`, `real/supportPage.test.tsx` | fatto |
| «Send to customer», «Segui», «Apri la richiesta», «Not concluded» | sulle rotte di 72, con la vista che rispondono; l'invio porta il `clientId` dell'invio (il compositore lo genera: un doppio invio è uno solo); gli errori nelle parole del prototipo | `real/support.test.ts`, `pages/support/replyStore.test.ts` | fatto |
| L'esito che è un ticket del widget (F3-1) | il blocco mostra la task (codice, titolo, cosa vede il cliente); nel prototipo AUD-S1 con esito AUD-6 | `data/support/support.test.ts`, `real/supportPage.test.tsx` | fatto |
| La provenienza di una richiesta (R3) | per codice in entrambe le build (`conversationCode`), i messaggi dal dettaglio | `real/requests.test.ts`, `pages/support/Support.test.tsx` | fatto |
| «View conversation» sulle task del widget (R3, S-9) | il codice della conversazione derivato a lettura (server: `supportConversationCode`), solo con Support acceso | `pages/task/TaskDetailSections.test.tsx`, `real/tasks.test.ts` | fatto |
| «Write to them by email» (R5, S9) | la bozza dal server, aperta nella Posta nel suo slot; il server non salva né invia | `pages/ComingSoon.test.tsx`, `real/support.test.ts` | fatto |
| «Clienti in attesa» nella Home (R4, S8) | nel catalogo di chi ha `support.reply`, mai nelle Home di default ([A 17]) | `pages/ComingSoon.test.tsx`, `real/homePage.test.tsx` | fatto |
| Gli avvisi `support.*` (R4, S7) | le righe nelle Preferenze (dal catalogo condiviso); le card aprono la conversazione e la richiesta nell'app | `real/session.test.ts` | fatto |
| Il ritmo (R8) | nessuno stream: dettaglio ogni 15 s, elenco e «Clienti in attesa» ogni 30 s | `data/supportRefresh.test.ts` | fatto |
| La bozza di Claude (R6) | «Ask Claude» aspetta la bozza accodata (`claudeDraftPending`, rilegge ogni 2 s, al più 90 s); «Claude is preparing a draft…» per quella automatica | `data/queries/supportDraft.test.tsx`, `real/supportPage.test.tsx` | pronto, spento (`support-draft`) |
| I widget (R1, R2) | sulle rotte di oggi (`client.widgets`): i nomi del web tradotti, la PUT col corpo intero e i filtri dei repository ancora accesi; la sezione solo con `widget.manage`; lo snippet con l'indirizzo vero dell'istanza e la chiave pubblica; nessun campo «siti ammessi» (il server non lo ha) | `real/supportWidgets.test.ts`, `pages/support/widgetSnippet.test.ts`, `pages/ComingSoon.test.tsx` | fatto |
| `support.reply` | dal registro condiviso, nel gruppo «Support» (non più locale del prototipo) | `data/access/whoCan.test.ts`, `domain/access/access.test.ts` | fatto |

### Differenze dichiarate

- I widget non hanno i «siti ammessi»: il server non ha il campo (registro).
- Il triage rifatto nel widget (domande, desiderio riscritto e confermato) è
  fuori dalla F3: `rewrittenWish` e `confirmedAt` arrivano `null` dal server.
- Una card `support.*` non rilegge Support da sé: aprirla legge la
  conversazione, e il ritmo di R8 copre il resto.
