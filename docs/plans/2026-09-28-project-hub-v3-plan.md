# Dettaglio progetto v3 — piano

Design: `2026-09-28-project-hub-v3-design.md`. Riferimento visivo:
`docs/design/project-detail/Dettaglio Progetto v3.dc.html`, da ricreare
fedelmente coi token di `theme/tokens.ts`. Branch `feature/project-hub-v3`,
worktree `.worktrees/project-hub-v3`, base main 477ba31d. Un commit per task
e TDD. Al doppio del client si aggiunge il metodo PRIMA del test, e un test
che passa al primo colpo si fa fallire apposta.

## Task 1 — Server e client (design §2)
- `repositoryId`/`repositoryName` `.optional()` in
  `pulseWaitingForMergeItemSchema`, con un test di parse senza i due campi.
- Join su `repositories` nella query del polso e test in
  `project-pulse-summary.test.ts`.
- `tickets.release` in `api-client`, col suo test.

## Task 2 — Logica pura dell'app
In `lib/`:
- le righe di «Tocca a te» (domande, piani, PR con `canMerge`), il loro
  bottone e la sua destinazione;
- «Aspetta altri · fermi» nell'ordine del §4;
- il conteggio del badge;
- «server giù» dal monitor;
- il conteggio delle automazioni: elenca nel docblock i campi di
  `projectSchema` contati, verificati sul codice;
- il riassunto del backlog.

Test puri per ciascuna.

## Task 3 — La struttura a tab (§3)
`ProjectDetailScreen` con le tre tab, badge e pallino. Si apre su Adesso, e
la tab resta al ritorno da una schermata. Pull-to-refresh su ogni tab.

## Task 4 — Adesso (§4)
Banner, i tre blocchi, i bottoni con le destinazioni e la frase del polso a
tab vuota. Test: ogni bottone porta dove deve; Mergia non c'è senza
`repositoryId` né senza `canMerge`; il banner porta alla tab Progetto.

## Task 5 — Il merge (§6)
Il pannello di conferma e `useRelease` con l'invalidazione di polso e
ticket. Test su successo, `checks_failed`, `already_closed` ed errore di
rete: messaggio mostrato e pannello aperto.

## Task 6 — Lavoro (§5)
I tre blocchi. Verifica da dove viene il totale del backlog aperto, cioè se
`backlog.list` porta un totale. Se non c'è, fermati e dimmelo invece di
contare una pagina sola.

## Task 7 — Progetto (§7)
La scheda con le cinque righe, le letture accessorie fuori dai gate e «—»
se falliscono. Togli le sezioni lunghe (`Hub*Section`) e i loro test,
tenendo le schermate di destinazione.

## Task 8 — CLAUDE.md
Una voce di deploy breve: solo server, i due campi additivi e il merge
dall'app, che passa dalla stessa rotta e dallo stesso cancello del web.

## Verifica finale
`pnpm lint`, `pnpm typecheck`, e i test di shared, notifications,
api-client, server e app. Pusha e scrivimi: la prova la fa il maintainer
sul telefono, con le etichette di `en.json`.
