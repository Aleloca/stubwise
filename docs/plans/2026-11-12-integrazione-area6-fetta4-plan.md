# Area 6, fetta 4 — scrivere sul Calendario

> BOZZA di 94, 12 nov 2026, su richiesta di 46: 72 la prende quando chiude
> la F3b, la corregge e la fa sua. I task del SERVER sono scritti come
> interfacce e test: l'implementazione e le scelte interne restano a 72. I
> task del RENDERER sono dettagliati. Design:
> `docs/plans/2026-11-12-integrazione-area6-design.md` (§ Fette, F4; D1, D8).
> Inventario delle forme: il messaggio di 94 a 72 per la F4 (riportato qui
> sotto) e il registro, area 6. Branch proposti: `feat/area6-f4` (server, 72)
> e `feat/area6-f4-renderer` (94), sopra `feat/integrazione-area6`.

## Cosa cambia

Oggi il Calendario della build app LEGGE soltanto (F1, F3b) e configura le
serie. Dopo questa fetta si scrive su Google, sempre con un gesto della
persona, come nel prototipo (`data/calendar/writes.ts`, `save.ts`):

- **Nuova riunione**: titolo, orari o tutto il giorno, invitati (persone del
  team o indirizzi), Google Meet, descrizione, luogo, progetto (uno dei miei),
  la casella da cui parte, i promemoria; gli inviti li manda Google;
- **rispondere** Sì / Forse / No con una nota, anche a tutta la serie;
- **modificare, spostare, ridimensionare, eliminare**: solo l'organizzatore,
  con «solo questo» o «tutta la serie»;
- **il progetto dell'evento corretto a mano** (`projectBy: "manual"`);
- **la disponibilità dei colleghi** (D8 = b) e «Trova un orario».

## Decisioni già prese

- **D1 = a**: lo scope `calendar.events` è già nel riconsenso unico della F1
  (`googleOauthScopes`); una casella che non l'ha concesso risponde
  `google_scope_missing` con `missing`, e il cassetto Google lo dice con
  `scopesMissing` (la funzione nuova «calendar»).
- **D8 = b**: la disponibilità solo dei colleghi che hanno il calendario
  COLLEGATO in Stubwise, solo libero/occupato, mai i dettagli. La freeBusy di
  Google sul Workspace (D8 = a) è scartata.
- **Chi vede il libero/occupato** *(O, 46)*: chiunque nell'istanza organizzi
  una riunione, solo gli intervalli.
- **Nessuna scrittura verso Google senza un gesto della persona** (design,
  vincolo «sempre»).
- **La risposta del server arriva DOPO il sì di Google** (sincrona): il
  client mostra «Saving…» mentre aspetta, poi salvato o non riuscito.
- **`changed_on_google`** sull'etag: una scrittura su un evento cambiato su
  Google nel frattempo è rifiutata con 409, non vince l'ultimo.
- **Il libero non si segna sui tutto il giorno** *(O, 46)*, e un tutto il
  giorno non occupa il libero/occupato (prototipo).

## Le forme per il renderer (dall'inventario di 94, tutte additive)

**Letture che servono alle scritture**, su ogni riga di `range` (anche
leggera) e di `event(id)`:
- `canEdit: boolean` (sono l'organizzatore: modifico, sposto, elimino) e
  `canRespond: boolean` (invitato, non organizzatore), calcolati dal SERVER;
- `etag: string | null` (la versione di Google, per `changed_on_google`);
- `myNote: string | null` (la nota della mia risposta);
- solo su `event(id)`: `attendees[].name` (se Google lo dà), `personId`
  (la persona di Stubwise riconosciuta dall'indirizzo, lato server) e
  `organizer: boolean`.

**Scritture** (`/api/me/calendar/...`, tutte `{ kind: "user" }`, solo sulle
caselle di chi chiede; un evento altrui è 404 come oggi):

| Gesto | Rotta proposta | Corpo | Risposta |
|---|---|---|---|
| Nuova riunione | `POST /events` | `{ accountId, title, startsAt, endsAt, allDay, guests: [{ personId } \| { email, name? }], addMeet, description, location, projectId \| null, reminders: [{ minutes, method: "popup" \| "email" }] \| "default" }` | la riga dell'evento (col link Meet se chiesto) |
| Modificare | `PATCH /events/:id` | `{ scope: "one" \| "series", etag, patch: { title?, guests?, addMeet?, description?, location?, reminders? } }` | la riga |
| Spostare / ridimensionare | `POST /events/:id/move` | `{ scope, etag, startsAt, endsAt, allDay? }` | la riga (o le righe della serie) |
| Eliminare | `DELETE /events/:id?scope=one\|series&etag=` | — | 204 |
| Rispondere | `POST /events/:id/respond` | `{ scope, response: "accepted" \| "tentative" \| "declined", note? }` | la riga |
| Progetto a mano | `PUT /events/:id/project` | `{ projectId \| null }` | la riga (`projectBy: "manual"`) |
| Libero/occupato | `GET /freebusy?personIds=…&from=…&to=…` | — | `[{ personId, availability: "connected" \| "not_connected" \| "expired", busy: [{ startsAt, endsAt }] }]` |

**Errori** (nelle parole che il renderer mappa): 400 `outside_window`
(fuori dalla finestra letta), 400 `all_day_series` (una serie fra «tutto il
giorno» e con orario), 400 `organizer` / `not_invited` (rispondere), 403
`not_organizer` (modificare, spostare, eliminare), 404 `not_found` (anche un
progetto di cui non sono membro), 409 `changed_on_google`, 409
`google_scope_missing` con `missing`, 409 `account_disabled` /
`token_expired`, 502 `google_unavailable`, 422 `google_rejected` con un
`reason` breve quando Google rifiuta (un invitato non valido, …).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

1. **Letture per scrivere.** `canEdit`, `canRespond`, `etag`, `myNote` su
   `range` ed `event`; su `event(id)` `attendees[].name`, `personId`,
   `organizer`. *Test*: l'organizzatore ha `canEdit` e non `canRespond`; un
   invitato il contrario; un evento senza invitati (mio) `canEdit`; una riga
   di prima (senza etag) `etag: null`; i campi hanno default (test di parse
   SENZA i campi, regola dei cambi additivi).
2. **`@stubwise/google`, le scritture di Calendar.** insert, patch, delete,
   le istanze di una serie, la risposta di un invitato, Meet
   (`conferenceData.createRequest`), `sendUpdates: "all"`, `If-Match`
   sull'etag. *Test*: col `fetch` iniettato, le richieste esatte a Google;
   un 412 di Google diventa `changed_on_google`; uno scope mancante
   `insufficient_scope`.
3. **Le rotte di scrittura** della tabella sopra, con la riga di
   `calendar_events` aggiornata nella STESSA richiesta dopo il sì di Google
   (così `range` la mostra subito, senza aspettare il poller). *Test*:
   - ogni rotta solo sulle caselle di chi chiede (un evento altrui 404,
     anche per un admin);
   - `not_organizer` e `organizer`/`not_invited` negativi: risposta E nessuna
     chiamata a Google;
   - `changed_on_google` con un etag vecchio, senza scrivere;
   - `outside_window`, `all_day_series`;
   - il progetto solo fra quelli di cui sono membro (404);
   - «tutta la serie» tocca la serie su Google, «solo questo» l'istanza;
   - eliminare toglie le proposte aperte nate da quelle date e, con la
     serie, la sua configurazione (`calendar_series`);
   - nessun job AI, nessuna notifica nuova.
4. **Progetto a mano.** `PUT /events/:id/project`: `projectBy = "manual"`;
   la regola del prototipo — lo fa chi vede l'evento, se è membro del
   progetto scelto; un progetto attuale che non vede non lo cambia (403); la
   proposta aperta della scadenza segue il progetto, quella di una data di
   serie no. Lo scopo (la mia riga o tutte le righe dello stesso evento) è
   la domanda Q1. *Test*: i quattro casi della regola, negativi compresi.
5. **Libero/occupato (D8 = b).** `GET /freebusy`. Proposta: dalle righe di
   `calendar_events` dei colleghi (con la F3b ci sono TUTTI gli eventi
   della finestra), senza chiamare Google; occupa un evento `opaque`, non
   rifiutato, non tutto il giorno (un `outOfOffice` occupa); solo dentro la
   finestra; `not_connected` senza casella, `expired` con la casella
   scaduta. La fonte è la domanda Q3. *Test*: SOLO intervalli (il test
   controlla le chiavi esatte della risposta: nessun titolo, luogo,
   invitato, id); chiunque nell'istanza lo legge *(O)*; un rifiutato, un
   libero e un tutto il giorno non occupano; un collega senza casella
   `not_connected`.
6. **Chiusura**: invarianti (`docs/invariants/mail-calendar.md`: «nessuna
   scrittura verso Google senza un gesto», il libero/occupato solo
   intervalli), deploy-log (nessuna migrazione d'enum nuova se non serve;
   rollback), registro, `@stubwise/api-client` (i metodi di
   `client.calendar` per ogni rotta).

## Task del RENDERER (94)

Tutti su `feat/area6-f4-renderer`, TDD con un test rosso prima,
`ComingSoon.test.tsx` nel giro (la funzione `calendar-write` si accende), il
server finto che risponde come quello vero.

1. **Il livello dati** (`data/backend/real/calendar.ts`, sopra
   `client.calendar`): `createEvent`, `updateEvent`, `moveEvent`,
   `deleteEvent`, `respond`, `setEventProject`, `freeBusy`, con la firma del
   prototipo (`data/api.ts`); la casella dell'evento dalla chiave
   (`accountId`), l'etag dalla riga letta; gli errori nelle parole del
   prototipo (`outside_window` → `invalid: window`, `all_day_series`,
   `changed_on_google`, `google_scope_missing`, `google_unavailable`).
   *File*: `calendar.ts`, `calendar.test.ts`, `fakeServer.ts` (le rotte).
   *Test*: il corpo esatto di ogni richiesta; ogni errore mappato; un evento
   altrui `not_found`.
2. **Il salvataggio** (`save.ts` del prototipo, in memoria): ogni scrittura
   mostra subito «Saving…» sull'evento (ottimistico), poi salvato o «Couldn't
   save» con «Retry» e «Undo the change»; per gruppo (una serie intera);
   «Retry» rimanda la stessa richiesta, «Undo» rimette la riga di prima.
   *File*: `data/backend/real/calendarSave.ts` (nuovo), `calendar.ts`.
   *Test*: salvataggio riuscito; fallito con Retry e Undo; un evento cambiato
   su Google (`changed_on_google`) dice «Changed in Google Calendar» e offre
   «Reload» (Q4); due scritture sullo stesso evento in fila, mai insieme.
3. **«Trova un orario»** (`findFirstFreeSlot`): calcolato nel client dal
   libero/occupato, con la regola del prototipo (8–20, passi di 15′, non
   prima di adesso, solo chi ha il calendario collegato). *File*:
   `calendar.ts`. *Test*: il primo spazio libero per tutti; nessuno →
   `null`; un collega `not_connected` non blocca.
4. **Le pagine**: `featureIntegrated("calendar-write")` acceso nella build
   app (`data/integration.ts`), quindi tornano Nuova riunione
   (`EventEditor.tsx`), sposta e ridimensiona (`useBlockMove.ts`), modifica,
   elimina con «solo questo / tutta la serie» (`SeriesScopeDialog.tsx`),
   rispondi con la nota (`RsvpBar.tsx`), il progetto a mano
   (`EventDetail.tsx`), la disponibilità nell'editor. Usano `canEdit` e
   `canRespond` del server al posto di `isOrganizer` dedotto
   (`calendarWrites.ts` `canEditEvent`). *Test* (`calendarPage.test.tsx`):
   ogni gesto dalla pagina fino alla richiesta esatta; senza `canEdit` niente
   sposta, modifica, elimina; senza `canRespond` niente «Andrai?»; lo
   «Saving…» e il «Couldn't save» sul blocco.
5. **Il cassetto Google**: `scopesMissing` con la funzione «calendar»
   («Until you reconnect, Stubwise can't create or change your meetings.»)
   quando manca `calendar.events`; i gesti che scrivono spiegano il motivo
   invece di fallire. *Test*: `GoogleAccountCard.app.test.tsx`.
6. **Parità** (`apps/desktop/docs/integration-area6-f4.md`) e registro.

## Global Constraints

- **Nessuna scrittura verso Google senza un gesto della persona**: nessun
  job, poller o azione di Claude scrive sul calendario in questa fetta.
- **Posta e Calendario restano PERSONALI**: si scrive solo sulle proprie
  caselle; un evento altrui è 404, anche per un admin.
- **Il libero/occupato è SOLO intervalli** (`startsAt`, `endsAt`): mai un
  titolo, un luogo, un invitato o un id, verificato sulle chiavi della
  risposta.
- **Verso i client solo campi additivi con default** (e un test che parsa
  una risposta senza); il web legge con `?? default`.
- Test filtrati, mutazioni sui controlli di permesso.

## Review Focus

- Un invitato che NON è l'organizzatore non può modificare, spostare o
  eliminare: il controllo è sul server e la risposta negativa non chiama
  Google.
- `changed_on_google`: nessuna scrittura parte con un etag vecchio, e il
  client non sovrascrive in silenzio.
- Il libero/occupato non lascia uscire nulla oltre gli intervalli, nemmeno
  in un errore o in un campo di debug.
- «Tutta la serie»: lo spostamento di una serie con lo stesso scarto per
  ogni data, e nessuna data fuori dalla finestra.
- Eliminare un evento con una proposta aperta: la proposta se ne va (o la
  regola di Q5), mai una card che punta a un evento che non c'è.

## Domande aperte per il maintainer

Q1. **Il progetto messo a mano vale per chi?**
- (a) *(consigliata)* Per tutti quelli che vedono quell'evento (lo stesso
  evento Google, l'iCalUID), come nel prototipo, se chi lo mette è membro
  del progetto: correggere una volta basta per tutto il team.
- (b) Solo per la mia riga (la mia casella): gli altri tengono il loro.

Q2. **Il salvataggio verso Google.**
- (a) *(consigliata)* Sincrono: la risposta arriva dopo il sì di Google, il
  client tiene in memoria il «non riuscito» con Riprova e Annulla.
- (b) Una coda sul server col suo stato (come gli invii della Posta):
  sopravvive a un ricaricamento, ma è un sistema in più.

Q3. **La fonte del libero/occupato dei colleghi collegati (D8 = b).**
- (a) *(consigliata)* Le righe di `calendar_events` già salvate (con la F3b
  ci sono tutti gli eventi della finestra): nessuna chiamata a Google, al
  ritardo del poller.
- (b) La freeBusy di Google con il token di ogni collega, al momento:
  fresca, ma una chiamata per collega a ogni apertura dell'editor.

Q4. **Un evento cambiato su Google mentre lo modifico** (`changed_on_google`).
- (a) *(consigliata)* «Reload»: si rilegge l'evento e si rifà il gesto.
- (b) Anche «Keep mine» (sovrascrive), come le bozze della Posta.

Q5. **Eliminare un evento con proposte aperte nate da lui.**
- (a) *(consigliata)* Le proposte se ne vanno con lui, come nel prototipo.
- (b) Restano, chiuse come «evento eliminato», nella storia di chi le aveva.

Q6. **Gli invitati fuori dal team** (un indirizzo qualunque).
- (a) *(consigliata)* Sì, e gli inviti li manda Google (`sendUpdates: all`),
  come nel prototipo.
- (b) Sì, ma senza inviti da Google: li avvisa chi organizza.
- (c) Solo persone del team.

## Rimandi (dal registro)

- La freeBusy di Google sul Workspace (D8 = a, scartata).
- La scheda di preparazione completa (F5).
- La «Quale progetto?» del calendario e le proposte condivise fra gli
  invitati (F3b, registro).
