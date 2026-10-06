# Modificare e cancellare i commenti

Data: 5 ott 2026. Stato: design approvato dal maintainer (decisioni 1–4,
una alla volta, 5 ott). Nato dalla prova sul telefono delle risposte ai
commenti (PR #79 e commit successivi su main).

## 1. Il problema, verificato sul codice di oggi

Un commento, una volta scritto, non si tocca più: nessuna rotta server
(`apps/server/src/routes/comments.ts`, registrato con prefisso
`/api/tickets/:ticketId/comments` in `app.ts:590`, ha solo `POST /` e `GET
/`; `tickets.ts` ospita il feed `/activity`), niente nel web, niente
nell'app. *(Corretto dal piano: il design diceva `tickets.ts`.)* La tabella
`comments` (`packages/db/src/schema.ts`) non ha né `edited_at` né
`deleted_at`. Dalla 0083 un commento può avere risposte
(`reply_to_comment_id`, FK self `ON DELETE SET NULL`), e `replyTo` (nome +
estratto dell'originale) si DERIVA a lettura.

Chi altro LEGGE il corpo dei commenti — **verificato dal piano**
(`2026-10-05-comment-edit-delete.md` §2, censimento completo): le due
ricerche (`/api/search` gruppo ticket e `GET /api/tickets?q=`, entrambe con
`to_tsvector(c.body)`), `/activity`, `GET /comments` e il `replyTo` derivato,
i prompt dell'agente (`fix.ts` e `correction.ts`, «indicazioni del team», i
soli `authorType='user'`), `hasUserComment` (web e app), i due dedup dei
commenti di SISTEMA (`webhooks.ts` merged, `isDroppedRequestNotice`).
**Non** lo leggono — premesse del design rivelatesi false: backlog, brief
(la timeline non contiene commenti), Slack/inbox/push/webhook (non esiste
un kind di notifica per i commenti), embeddings/RAG, MCP (`get_ticket` non
restituisce commenti), daily report. La «fotografia del feedback di una
correzione» (`provider_feedback`) è dei commenti della PR sul PROVIDER, non
di quelli di Stubwise. Due COPIE del testo fuori dalla tabella, che la
cancellazione non raggiunge (limite dichiarato): le istruzioni di un
rifiuto del piano sono scritte sia come commento `user` sia nel registro
decisioni (`jobs.ts:470` e `:512`), e la cache TanStack persistita sui
telefoni tiene il vecchio testo finché quel ticket non viene riletto. Il
registro non si riscrive, ma **la UI lo dice** (decisione del maintainer, 5
ott): il commento porta `inDecisionLog`, derivato dal server, e la conferma
di «Elimina» avverte che il testo resta nel registro decisioni (piano, L1).
Gli allegati possono essere legati a un commento (`attachments.comment_id`,
`ON DELETE CASCADE`), ma la riga non si cancella: vedi il piano, D3.

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
users(id) ON DELETE SET NULL`. *Aggiunti dal piano*: due CHECK che rendono
il segnaposto una garanzia del database e non del codice —
`deleted_at IS NULL OR body = ''` e `deleted_by_user_id IS NULL OR
deleted_at IS NOT NULL`.

**Rotte** (stessa autorizzazione di lettura del ticket, più le regole qui):
- `PATCH /api/tickets/:id/comments/:commentId` `{ body }` — solo l'autore,
  solo `authorType='user'`, mai un commento eliminato; scrive `body` e
  `edited_at = now()`. Stesso tetto di lunghezza del POST.
- `DELETE /api/tickets/:id/comments/:commentId` — l'autore o un admin; mai
  `ai`/`system`; idempotente su un commento già eliminato. Scrive
  `body = ''`, `deleted_at`, `deleted_by_user_id`. La riga NON si cancella
  (le risposte la puntano).
- Il commento deve essere di QUEL ticket (404 `comment_not_found`
  altrimenti — il codice che `attachments.ts:166` usa già per lo stesso
  caso; *corretto dal piano*: il design diceva «come per
  `replyToCommentId`», che invece risponde **422** `reply_target_invalid`),
  e l'esito si verifica in DB, non solo dallo status.
- Codici: 403 `forbidden` (non tuo / non admin per la cancellazione / AI o
  sistema), 409 `comment_deleted` (modifica di un eliminato), 404.

**Risposta** (`ticketCommentSchema`, campi additivi, tutti `.nullable()
.default(null)` o `.default(false)`): `editedAt`, `deletedAt`, `deletedBy {
name } | null`, `inDecisionLog` (`.default(false)`: il commento è il testo
di un rifiuto del piano, copiato nel registro decisioni — derivato a lettura,
piano L1), e **`canEdit`/`canDelete` calcolati dal SERVER col ruolo e
l'identità di chi guarda** (stesso criterio di `canMerge`: il client li legge,
non li deduce). Un eliminato arriva con `body: ""`. `replyTo` di una risposta
a un eliminato: `deleted: true` e nessun estratto (campo additivo
`.default(false)`). Anche il feed `/activity` (che il web usa per i commenti)
porta gli stessi campi.

Ordine di deploy come 0082/0083: **server prima del worker** (il worker
nuovo nominerebbe le colonne nuove nei 14 `insert(comments)`). *Corretto
dal piano*: questa volta il worker **cambia** — i due prompt che leggono le
indicazioni del team escludono i commenti eliminati (altrimenti un
eliminato entra come voce vuota `[N] ` e occupa uno dei 10 posti).

## 4. App

- «⋯» accanto a «↩ Reply» solo se `canEdit || canDelete`; il pannello
  mostra solo le voci permesse.
- «Modifica»: il campo sotto il commento (lo stesso `CommentComposer` della
  risposta, in un terzo modo), riempito col testo, «Salva»/«Annulla»; mai
  insieme a una risposta aperta sullo stesso commento.
- «Elimina»: conferma esplicita; a buon fine la riga diventa il segnaposto.
  Se `inDecisionLog ?? false`, la conferma aggiunge che il testo resta nel
  registro decisioni (vale anche per il web).
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

Server, poi caddy e worker (il worker cambia: vedi §3, corretto dal
piano); l'app dagli store. Dettaglio nel piano, «Deploy e rollback». Rollback: server vecchio → niente rotte nuove (404), i campi
nuovi spariscono (app dal `.default`, web dal `??`); i commenti eliminati
restano con `body` vuoto (un server vecchio li mostra vuoti — accettato).
