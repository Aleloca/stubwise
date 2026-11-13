# Integrazione area 6 «Posta e Calendario», fetta 5b: Google Drive nel Drive dei progetti — parità col prototipo (13 nov 2026)

Cosa di Google Drive del prototipo (`data/drive/{reads,writes}.ts`,
`pages/drive/*`, il cassetto Google) arriva sul server vero. Piano:
`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`, sezione «F5b — le
scelte di 72» (db43e0c2); le rotte, gli schemi e i metodi di `client.drive`
sono di stubwise-72 (64c8da77 su `feat/area6-f5b`), qui il renderer.
Decisioni: D9 = a (`drive.readonly`), Q3 = a *(M)* (collega chi ha
`drive.manage`), Q-B = 1 *(O, 46)* (il codice c'era già, dietro il flag),
QB1 = b *(M)* (anche una sincronizzazione al giorno) con la riga del dialogo
*(O, 46)*, B1–B7 di 72.

⚠️ Il ramo `feat/area6-f5b-renderer` accende `google` nella build app: va
unito INSIEME (o dopo) il server della F5b, altrimenti il Drive chiama rotte
che non ci sono (gli elenchi tornano vuoti, i gesti `not_found`).

## Renderer (stubwise-94)

Il livello dati è `data/backend/real/driveGoogle.ts` (e la riga in
`drive.ts`), sopra i metodi di `client.drive` di 72: le liste sono
`{ items }`, le risposte passano dal parse vero.

| Voce del prototipo | Build app | Test |
|---|---|---|
| «Add from Google Drive» (il mio Drive, con la ricerca, chi è già nel progetto) | `client.drive.googleFiles` col mio account (B7); aggiungere = `addGoogleFile`, un codice per progetto; `already_in_project` | `real/driveGoogle.test.ts`, `ComingSoon.test.tsx` |
| «Link a Google folder» (`drive.manage`) | `googleFolders` e `linkFolder`; la cartella si legge con l'account di chi l'ha collegata (B3). Percorso e conteggio non arrivano (Google non li dà senza una chiamata per cartella): il dialogo non li scrive | `real/driveGoogle.test.ts` |
| Le cartelle collegate, «Sync now», scollegare | `folderLinks`, `syncFolder`, `unlinkFolder`; «scaduta» e «accesso perso» li deriva il server (B4, `folderLinkOf` coi default: mai «scaduta» per sbaglio); la riga dice «synced …» (QB1 = b, anche la sincronizzazione di ogni giorno) e il dialogo «Stubwise checks the folder every day» | `real/driveGoogle.test.ts`, `pages/drive/DriveGoogle.test.tsx` |
| «Togli» e «Nascondi» | `remove` (409 `use_hide` su un file di cartella), `setHidden` col chi e quando | `real/driveGoogle.test.ts` |
| Un file non disponibile | `unavailable: "deleted" \| "access_lost"`; un motivo che il client non conosce resta non disponibile (fail-closed) | `real/driveGoogle.test.ts` |
| «Open in Google Drive» (un avviso nel prototipo) | sul web la rotta `open` (302 a Google, conta l'apertura `via: "google"`); sul desktop il file su Google (`googleOpenUrl`), perché la sessione sta nel main e la rotta non si apre da fuori | `real/drive.test.ts` |
| La ricerca fuori dai progetti | `googleOutside`, col mio account | `real/driveGoogle.test.ts` |
| Il contenuto (testo, riassunto, ricerca, Claude) | come un caricato (B2): lo estrae il worker, non fidato | (server) |
| Il cassetto Google | i testi del prototipo col Drive (il rimando della F1): intro, «Folders you linked don't update», scollegare con le cartelle che smettono di aggiornarsi; senza `drive.readonly` la funzione «drive» fra quelle che mancano | `pages/drive/GoogleAccountCard.app.test.tsx`, `real/google.test.ts` |
| Gli allegati della Posta come link | un file Google nella bozza è `as: "link"` (lo decide il server), fuori dai limiti | `real/mailDrafts.test.ts` |

### Differenze dichiarate

- Sul desktop «Open in Google Drive» non conta l'apertura (la rotta `open`
  vuole la sessione, che sta nel main). Da chiedere a 72 una rotta che la
  conti senza rimandare, se serve.
- «Link a Google folder»: niente briciole né conteggio dei file prima di
  collegare (Google, 72).
- Il cassetto, scaduto, dice delle cartelle e non più di Posta e Calendario:
  è il testo del prototipo col Drive acceso.
