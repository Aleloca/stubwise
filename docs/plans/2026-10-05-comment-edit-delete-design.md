# Modificare e cancellare i commenti

Data: 5 ott 2026. Stato: design approvato dal maintainer (decisioni 1–4,
una alla volta, 5 ott). Nato dalla prova sul telefono delle risposte ai
commenti (PR #79 e commit successivi su main).

## 1. Il problema, verificato sul codice di oggi

Un commento, una volta scritto, non si tocca più: nessuna rotta server
(`apps/server/src/routes/tickets.ts` ha solo `GET`/`POST
/api/tickets/:id/comments`), niente nel web, niente nell'app. La tabella
`comments` (`packages/db/src/schema.ts`) non ha né `edited_at` né
`deleted_at`. Dalla 0083 un commento può avere risposte
(`reply_to_comment_id`, FK self `ON DELETE SET NULL`), e `replyTo` (nome +
estratto dell'originale) si DERIVA a lettura.

Da verificare nel piano (premesse da non dare per scontate): chi altro LEGGE
il corpo dei commenti — ricerca (`/api/search`, gruppo ticket), feed
`/activity`, fotografia del feedback di una correzione, `hasUserComment`,
`isDroppedRequestNotice` (solo commenti di sistema), backlog, brief, Slack —
e cosa deve succedere lì con un commento modificato o cancellato.

## 2. Decisioni del maintainer

1. **Chi**: ognuno modifica e cancella i PROPRI commenti (`authorType =
   'user'` e `authorId` = chi agisce). Un maintainer (`admin`) può in più
   CANCELLARE i commenti di chiunque, mai MODIFICARLI. I commenti dell'AI e
   di sistema non si toccano, per nessun ruolo (raccontano cosa ha fatto il
   sistema; alcuni servono al funzionamento, es. `isDroppedRequestNotice`).
2. **Cancellare lascia un segnaposto**: la riga resta, il TESTO sparisce
   davvero dal database (non nascosto), e al suo posto si legge «Commento
   eliminato» con chi e quando. Le risposte mantengono «In risposta a…», che
   porta al segnaposto.
3. **Modificare** mostra «modificato» accanto all'orario (con l'ora
   dell'ultima modifica); nessuna cronologia delle versioni. L'estratto
   «In risposta a…» delle risposte si aggiorna da solo (è derivato).
4. **App**: un bottone «⋯» accanto a «↩ Reply», solo sui commenti che chi
   guarda può toccare; apre un pannello (`SheetModal`) con «Modifica» ed
   «Elimina». «Modifica» apre il campo SOTTO il commento, come la risposta,
   già riempito; «Elimina» chiede conferma. **Web**: «Modifica» ed «Elimina»
   come link accanto a «Rispondi», stesse regole.

## 3. Server

**Migrazione 0084** — additiva, un batch, nessun `ALTER TYPE`, nessun
backfill: `comments.edited_at timestamptz NULL`, `comments.deleted_at
timestamptz NULL`, `comments.deleted_by_user_id uuid NULL REFERENCES
users(id) ON DELETE SET NULL`.

**Rotte** (stessa autorizzazione di lettura del ticket, più le regole qui):
- `PATCH /api/tickets/:id/comments/:commentId` `{ body }` — solo l'autore,
  solo `authorType='user'`, mai un commento eliminato; scrive `body` e
  `edited_at = now()`. Stesso tetto di lunghezza del POST.
- `DELETE /api/tickets/:id/comments/:commentId` — l'autore o un admin; mai
  `ai`/`system`; idempotente su un commento già eliminato. Scrive
  `body = ''`, `deleted_at`, `deleted_by_user_id`. La riga NON si cancella
  (le risposte la puntano).
- Il commento deve essere di QUEL ticket (404 altrimenti, come per
  `replyToCommentId`), e l'esito si verifica in DB, non solo dallo status.
- Codici: 403 `forbidden` (non tuo / non admin per la cancellazione / AI o
  sistema), 409 `comment_deleted` (modifica di un eliminato), 404.

**Risposta** (`ticketCommentSchema`, campi additivi, tutti `.nullable()
.default(null)` o `.default(false)`): `editedAt`, `deletedAt`, `deletedBy {
name } | null`, e **`canEdit`/`canDelete` calcolati dal SERVER col ruolo e
l'identità di chi guarda** (stesso criterio di `canMerge`: il client li legge,
non li deduce). Un eliminato arriva con `body: ""`. `replyTo` di una risposta
a un eliminato: `deleted: true` e nessun estratto (campo additivo
`.default(false)`). Anche il feed `/activity` (che il web usa per i commenti)
porta gli stessi campi.

Ordine di deploy come 0082/0083: **server prima del worker** (il worker
nuovo nominerebbe le colonne nuove negli `insert(comments)`).

## 4. App

- «⋯» accanto a «↩ Reply» solo se `canEdit || canDelete`; il pannello
  mostra solo le voci permesse.
- «Modifica»: il campo sotto il commento (lo stesso `CommentComposer` della
  risposta, in un terzo modo), riempito col testo, «Salva»/«Annulla»; mai
  insieme a una risposta aperta sullo stesso commento.
- «Elimina»: conferma esplicita; a buon fine la riga diventa il segnaposto.
- Segnaposto: «Commento eliminato · da {nome} · {quando}», senza «Reply» né
  «⋯»; le card delle risposte sotto restano.
- «modificato» accanto all'orario.
- ⚠️ Un pannello che, chiuso, apre il campo o cambia la pagina segue la regola
  dei fogli nativi di CLAUDE.md (chiudere, smontare in `onDidDismiss`, POI
  agire). Il mock Jest non la verifica: va provata sul telefono.
- Letture difese con `??` (cache persistita: CLAUDE.md, e `c14aa526`).

## 5. Web

Nel feed d'attività: «Modifica»/«Elimina» accanto a «Rispondi» con le stesse
regole (`canEdit`/`canDelete` letti, `?? false`), modifica in linea, conferma
per la cancellazione, segnaposto e «modificato». Fixture senza i campi nuovi.

## 6. Test

Server: negativi a più ruoli sugli stessi dati (autore / altro member /
admin / commento AI e di sistema), con asserzioni sulla riga in DB; commento
di un altro ticket; modifica di un eliminato; idempotenza della
cancellazione; `replyTo` verso un eliminato; `canEdit`/`canDelete` per ruolo.
App e web: le trappole di CLAUDE.md (fixture complete e senza i campi nuovi,
doppio `makeClient()` completo prima, `await render`).

## 7. Deploy e rollback

Server + caddy (worker solo dopo il server, quando lo si ribuilda); l'app
dagli store. Rollback: server vecchio → niente rotte nuove (404), i campi
nuovi spariscono (app dal `.default`, web dal `??`); i commenti eliminati
restano con `body` vuoto (un server vecchio li mostra vuoti — accettato).
