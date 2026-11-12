# Integrazione area 6 «Posta e Calendario», fetta 4: scrivere sul Calendario — parità col prototipo (12 nov 2026)

Cosa della scrittura del Calendario del prototipo (`data/calendar/writes.ts`,
`save.ts`, `pages/calendar/*`) arriva sul server vero. Piano:
`docs/plans/2026-11-12-integrazione-area6-fetta4-plan.md` (bozza di 94, fatta
sua da 72 su `feat/area6-f4`); le rotte e gli schemi sono di stubwise-72, qui
il renderer. Decisioni: D1 (`calendar.events` nel riconsenso), D8 = b con la
fonte di Q3 = a *(M)*, Q1 *(M)*, Q6 *(M)*, Q2/Q4/Q5 *(O, 46)*.

⚠️ Il ramo `feat/area6-f4-renderer` accende `calendar-write` nella build app:
va unito INSIEME (o dopo) il server della F4, altrimenti i gesti rispondono
`not_found`.

## Renderer (stubwise-94)

Il livello dati è `data/backend/real/{calendarWrites,calendarSave,calendarView}.ts`
(le scritture, il salvataggio in memoria, le viste di evento e serie); la regola
di «Trova un orario» è `domain/calendar/freeSlot.ts`, una sola per le due build.

| Voce del prototipo | Build app | Test |
|---|---|---|
| Nuova riunione (Meet, progetto, invitati, promemoria) | `POST /api/me/calendar/events` dalla prima casella collegata; gli inviti li manda Google, anche agli esterni (Q6) | `real/calendarWrites.test.ts` |
| Modificare, spostare, ridimensionare («solo questo» / «tutta la serie») | `PATCH /events/:id`, `POST /events/:id/move` con lo scope e l'etag della riga (letta cruda finché lo schema non lo porta) | idem |
| Eliminare | `DELETE /events/:id?scope&etag`; le proposte aperte se ne vanno con l'evento (Q5) | idem |
| Rispondere Sì / Forse / No con la nota | `POST /events/:id/respond`; «Going?» solo a chi il server dice `canRespond` | `real/calendarWrites.test.ts`, `real/calendarPage.test.tsx` |
| Il progetto a mano | `PUT /events/:id/project`, `projectBy: "manual"`; vale per tutti quelli che vedono lo stesso evento (Q1) | idem |
| Chi modifica, chi risponde | `canEdit` e `canRespond` dal SERVER, col ripiego dell'organizzatore e dell'invito per un server di prima (`canEditEvent`, `canRespondTo`) | `real/calendar.test.ts`, `real/calendarPage.test.tsx` |
| «Saving…», «Couldn't save», «Retry», «Undo the change» | richiesta sincrona (Q2): l'evento è subito al posto nuovo con «Saving…» (`calendarSave.ts`, sopra `listEvents` e `getEvent`), poi salvato o non salvato; «Retry» rimanda la stessa richiesta, «Undo» toglie la sovrapposizione senza chiamare il server; un rifiuto del gesto (fuori finestra, non organizzatore) si dice subito | `real/calendarWrites.test.ts`, `real/calendarPage.test.tsx` |
| Cambiato su Google nel frattempo | `changed_on_google` → «This meeting changed in Google Calendar. Reload it and try again.» con solo «Reload» (Q4) | idem |
| La disponibilità dei colleghi e «Trova un orario» | `GET /freebusy` (le righe salvate, D8 cambiata da Q3): SOLO intervalli, qualunque cosa arrivi; «Trova un orario» calcolato qui con la regola del prototipo | `real/calendarWrites.test.ts` |
| Il cassetto Google | senza `calendar.events`: «Until you reconnect, Stubwise can't create or change your meetings» | `real/google.test.ts` |

### Differenze dichiarate

- **Il test di `canEdit: false`** (un organizzatore a cui il server non lo
  permette) si accende da sé quando lo schema condiviso porta il campo
  (`it.skipIf`): oggi il client lo toglie al parse e vale il ripiego.
- **Creare ed eliminare** sono sincroni senza «Saving…» (il prototipo li
  mostra in salvataggio): il compositore aspetta la risposta e dice
  l'errore.
- **Una serie spostata** mostra in salvataggio solo l'occorrenza toccata;
  le altre si aggiornano alla rilettura.
