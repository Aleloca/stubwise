# Integrazione area 3, fetta 3a «Guardare» — parità col prototipo (10 nov 2026)

Cosa del prototipo dell'area 3 funziona sul server vero nella **build app**
(desktop e `/app`) con la fetta 3a: le **sessioni di lavoro** di Claude in
lettura, dal vivo. Design: `docs/plans/2026-11-10-integrazione-area3-claude-design.md`;
piano: `docs/plans/2026-11-10-integrazione-area3a-plan.md`. Convenzioni come
`integration-slice{1,2,3,4}.md` («real/» è `data/backend/real/`).

Il prototipo resta com'era: le funzioni nuove della build app sono accese in
`data/integration.ts` (destinazione `claude`, funzione `claude`); restano
spente `claude-chat` (chat libera), `claude-actions` (azioni, 3b) e
`claude-decisions` (le voci di Claude in «Da decidere», 3b).

## Superfici (3a.3, renderer)

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Pagina Claude: «Working now» e «Finished» (solo sessioni di lavoro), filtri per progetto, task e tipo | `pages/claude/ClaudePage.tsx`, `ClaudeColumn.tsx`, `ConversationList.tsx`; `real/claude.ts` (`listConversations`) | `GET /api/agent-sessions?projectId=&ticketId=&kind=` | `real/claude.test.ts`, `pages/ComingSoon.test.tsx` («fetta 3a») |
| Una sessione aperta (`/claude/:id`), in lettura | `pages/claude/conversation/Conversation.tsx`; `real/claude.ts` (`getConversation`) | `GET /api/agent-sessions/:id`, `…/events` (404 per una invisibile) | `real/claude.test.ts`, `pages/ComingSoon.test.tsx` |
| Flusso dal vivo | `data/queries.ts` (`useConversationStream`); `real/claudeStream.ts` (`subscribe`) | `GET /api/agent-sessions/:id/stream?after=` | `real/claudeStream.test.ts` |
| Sezione Claude della task intera, in lettura (stato, piano, domande, PR e correzioni, storia del lavoro) | `pages/task/ClaudeSection.tsx`, `WorkStory.tsx`; `real/claude.ts` (`getTaskWork`) | `GET /api/tasks/:id/work` più gli eventi di ogni sessione | `real/claude.test.ts`, `real/taskPanel.test.tsx`, `pages/ComingSoon.test.tsx` |
| «Follow here»: la sessione seguita nel pannello della task, col flusso dal vivo e senza casella | `pages/task/TaskDetail.tsx` (`FollowSession`) | come sopra | lo stesso componente di `/claude/:id` (nessun test dedicato nella build app: da provare a mano) |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Il riquadro di Claude come chat libera resta «in arrivo», con «New» e ⌘K → Ask Claude; una sessione di lavoro aperta con «Follow here» (dalla task) o da una riga di /claude si segue in lettura, dal vivo, senza casella. La casella e «Ferma» arrivano con la 3b | orchestratrice (coerente con la decisione del maintainer sulla chat) |
| /claude atterra su «Working now»: l'atterraggio con la casella, «Mine», «Public», «Recent» e il tasto «N» sono della chat libera; `?scope=mine|public` dice «in arrivo» | costruttore |
| Nella 3a la sezione Claude legge le azioni del server ma le mostra tutte «non disponibili» finché `claude-actions` non è accesa; i permessi del dettaglio sono spenti. **Dalla 3b** le azioni e i permessi sono accesi: vedi `integration-area3b.md` | orchestratrice (azioni nella 3b) |
| Stati del server nel prototipo: `queued` → al lavoro, `waiting_input` → aspetta una risposta, `held`/`idle` → ferma, `ended` → finita, `paused` del dettaglio → in pausa; esito `completed` → ok, `skipped` → fermata | costruttore |
| Il piano di una sessione viene dal lavoro della task (`runs[].plan`), non dagli eventi: entra nel flusso al suo istante; «pre-approvato» si legge approvato | design (adattatore condiviso) |
| Chi ha avviato una sessione: l'elenco del server non lo dice (`ownerId` vuoto nelle righe); nel lavoro della task `ownerId` null (sistema o utente eliminato) si legge «someone». Chi ha risposto a una domanda e quando non arrivano: ripiego senza nome | server |
| Stream: sul web `fetch` streaming col cookie; sul desktop `window.stubwise.openStream` del main (3a.2), che non riconnette; senza `openStream` un ripiego che rilegge eventi e dettaglio ogni 2 s. La ripresa riparte dal cursore `?after=` tenuto per persona e sessione; un 401, 403 o 404 chiude; le altre cadute riprovano col backoff condiviso (`streamBackoffMs`), azzerato da un frame vero; oltre 1 MiB la connessione si riapre dal cursore | design / costruttore |
| Al più 8 stream aperti per finestra anche sul web; gli altri aspettano un posto, e chiudere una vista libera il suo | design |
| Limite di costo: il lavoro di una task legge dettaglio ed eventi di OGNI sua sessione (tutte le pagine da 500). «Finished» mostra le concluse che il server tiene fra le recenti: il suo tetto vale anche con `includeOlder` | costruttore |
| Le citazioni e la riga «Claude can help you…» sono della chat libera: spente | costruttore |
| Consumi per task (`usage`) e blocco d'istanza (`blocked`) non arrivano ancora da `/work`: vuoti e `null` | server |

## Rimandate

| Voce | Fetta |
|---|---|
| Avvio, rilancio, «Riprendi la correzione», «Chiedi modifiche», piano, domande, scrivere e «Ferma», «Annulla il lavoro», le voci di Claude in «Da decidere» | 3b |
| Refinement delle richieste | 3c |
| Activity per persona | 3d |
| Claude assegnabile («Assign to Claude», Planning, carico) | 3e |
| Chat libera, riquadro come chat, citazioni, suggerimenti | fase dopo l'area 3 |
