# Modificare e cancellare i commenti — piano

Data: 5 ott 2026. Design: `2026-10-05-comment-edit-delete-design.md`
(approvato, decisioni 1–4). Branch `feat/comment-edit-delete`, base
`89a63a0a` (= main `3b2e4a96` + il design).

Tre fasi: **A server** (db, shared, rotte, worker), **B app**, **C web**.
Ogni task: file, test PRIMA, mutazione, criterio di done.

## 1. Premesse del design, verificate sul codice (HEAD 89a63a0a)

| # | Premessa | Esito | Dove |
|---|---|---|---|
| P1 | Nessuna rotta modifica/cancella un commento | **vera** | `apps/server/src/routes/comments.ts:92` (`app.post("/")`) e `:145` (`app.get("/")`), nient'altro |
| P2 | …e queste rotte stanno in `tickets.ts` | **FALSA** | stanno in `routes/comments.ts`, registrato con `prefix: "/api/tickets/:ticketId/comments"` (`app.ts:590`); `tickets.ts` ha solo `/:id/activity` (`:699`) |
| P3 | Niente nel web né nell'app | **vera** | `grep editComment\|deleteComment\|updateComment` → zero |
| P4 | `comments` senza `edited_at`/`deleted_at` | **vera** | `packages/db/src/schema.ts:748-774` |
| P5 | `reply_to_comment_id`, FK self `ON DELETE SET NULL` | **vera** | `packages/db/drizzle/0083_comment_replies.sql`; nello schema drizzle la colonna è senza `.references()` (`schema.ts:766`) |
| P6 | `replyTo` (nome + estratto) derivato a lettura | **vera** | `loadReplyTargets`, `apps/server/src/services/comments.ts:95-121` (`excerpt: plainExcerpt(r.body, …)` a `:118`) |
| P7 | Un commento di un altro ticket dà «404, come per `replyToCommentId`» | **FALSA** | `replyToCommentId` di un altro ticket dà **422** `reply_target_invalid` (`comments.ts:120`, `:136`). Per PATCH/DELETE il 404 resta giusto, col codice `comment_not_found` già usato da `attachments.ts:166` |
| P8 | Lettori da verificare: ricerca, `/activity`, «fotografia del feedback di una correzione», `hasUserComment`, `isDroppedRequestNotice`, backlog, brief, Slack | **in parte FALSA** | vedi il censimento §2: backlog, brief e Slack **non** leggono i commenti; la «fotografia» (`provider_feedback`) è dei commenti della PR sul provider; mancavano i due prompt dell'agente, la ricerca della lista ticket, gli allegati e la copia nel registro decisioni |
| P9 | Server prima del worker, perché il worker nomina le colonne negli `insert(comments)` | **vera** | 14 `insert(comments)` in `apps/worker/src` (conteggio rifatto oggi, invariato dalla 0083) |
| P10 | Il worker non va ribuildato (§7: «quando lo si ribuilda») | **FALSA** | il worker CAMBIA: `fix.ts:853` e `correction.ts:689` devono escludere gli eliminati (vedi §2, riga 6-7) |
| P11 | `/activity` è ciò che il web usa per disegnare i commenti | **vera** | `activity-feed.tsx` (`useSuspenseQuery(activityQueryOptions)`); il web usa `/comments` solo per `hasUserComment` (`routes/tickets/$id.tsx:93`, `:437`) |
| P12 | L'app non legge corpo/autore dal feed `/activity` | **vera** | `ticketActivityEntrySchema` li spoglia (`packages/shared/src/schemas/ticket.ts:282-285`): l'app li legge solo da `/comments` |
| P13 | `CommentComposer` della risposta riusabile in un terzo modo | **vera** | `CommentsSection.tsx`, prop `replyingTo`, testID `work-reply-*`; lo stato `replyingTo` vive in `WorkScreen.tsx:372` |
| P14 | 0084 libera | **vera** | ultima `0083_comment_replies` (`_journal.json` idx 83, `when` 1791158400000); migrazioni scritte a mano (snapshot fermi alla 0060) |
| P15 | Permessi: chi è l'autore lo dice `author_id` + `author_type` | **vera** | `authorType` `user`/`ai`/`system`, `authorId` nullo per AI/sistema e per autore eliminato (`schema.ts:755-757`); `request.user` porta `id` e `role` (`auth/session.ts`) |
| P16 | `SheetModal` + regola dei fogli nativi | **vera** | `components/SheetModal.tsx` (`onDidDismiss={onClose}`), pattern in `ScreenHeader.tsx:90-96`; mock Jest sincrono (CLAUDE.md, «Un foglio nativo…») |
| P17 | La cache persistita richiede `??` anche con `.default` | **vera** | `app/providers.tsx:113-118` (`persistQueryClient`), fix `c14aa526` |

## 2. Censimento di chi legge il corpo dei commenti

Fatto con `grep` su `comments.body`, `from(comments)`, `${comments}`,
`insert(comments)`, `ticketCommentSchema`, `activityComment`, e su tutti i
file che nominano la tabella (`grep -rlw comments`, test esclusi), più un
controllo mirato dei candidati del compito.

**La scelta di fondo** (design D2): cancellare scrive `body = ''`. Con un
CHECK in DB (`deleted_at IS NULL OR body = ''`) il testo non esiste più in
nessuna riga viva, quindi **ogni lettore che legge `body` smette da solo di
vederlo**, senza toccarlo. Si toccano solo i lettori per cui un corpo VUOTO
fa danno (una voce vuota che occupa un posto) o che devono DIRE «eliminato».

| # | Lettore | Legge il corpo? | Con un ELIMINATO | Con un MODIFICATO | Si tocca? |
|---|---|---|---|---|---|
| 1 | `GET /comments` (`comments.ts:145`), POST | sì | `body: ""` + `deletedAt`/`deletedBy`, `canEdit/canDelete` false | testo nuovo + `editedAt` | **sì** (A4) |
| 2 | `/activity` (`tickets.ts:699`) | sì | come sopra | come sopra | **sì** (A4) |
| 3 | `replyTo` di una risposta (`loadReplyTargets`) | sì (estratto del padre) | `deleted: true`, `excerpt: ""` | estratto nuovo, da solo | **sì** (A4) |
| 4 | Ricerca globale `/api/search`, gruppo ticket (`search.ts:142`) | sì, `to_tsvector(c.body)` | `''` non combacia con niente: sparisce da solo | cercabile col testo nuovo | **no**; test negativo (A4) |
| 5 | Lista ticket `GET /api/tickets?q=` (`tickets.ts:558`) | sì, idem | idem | idem | **no**; test negativo (A4) |
| 6 | Prompt del fix, `<indicazioni_del_team>` (`apps/worker/src/pipeline/fix.ts:853`, ultimi 10 `user`) | sì | oggi entrerebbe come `[N] ` vuoto e ruberebbe uno dei 10 posti | il testo attuale: giusto | **sì**: `isNull(comments.deletedAt)` (A6) |
| 7 | Prompt della correzione (`correction.ts:689`, `user` dopo l'ultimo push) | sì | idem | oggi un commento scritto PRIMA del push e modificato DOPO resta fuori | **sì**: `isNull(deletedAt)` + D4 (A6) |
| 8 | `hasUserComment` web (`routes/tickets/$id.tsx:437`, suggerimento) e app (`WorkScreen.tsx:333` → `RunWorkButton.tsx:74`, «Rilancia con istruzioni») | no, solo `authorType` | un eliminato non è più un'indicazione: va escluso | invariato | **sì** (B3, C1) |
| 9 | Dedup del commento «PR mergiata» (`webhooks.ts:690`) | sì | solo `system`: intoccabili | — | no |
| 10 | `isDroppedRequestNotice` (`pr-correction-webhook.ts:602`) | sì | solo `system`: intoccabili | — | no |
| 11 | Storia del ticket (`buildTicketHistory`, `services/ticket-history.ts`) | **no** (non usa i commenti) | — | — | no |
| 12 | Notifiche (inbox, Slack, push, webhook) | **no**: nessun `notificationKind` per i commenti (`notification.ts:30-46`) | — | — | no |
| 13 | Brief settimanale / `project-timeline.ts` | **no** | — | — | no |
| 14 | Registro decisioni | **copia**: un rifiuto del piano con istruzioni scrive il commento `user` (`jobs.ts:470`) E le istruzioni nel testo della decisione (`:512`) | la decisione resta col testo | resta il testo originale | **no** — limite dichiarato (L1) |
| 15 | Daily report, backlog (intake/chat/deep dive), embeddings/RAG, graph-chat, widget | **no** (nessun riferimento alla tabella) | — | — | no |
| 16 | MCP (`get_ticket`) | **no** (`packages/mcp/src` non chiede i commenti) | — | — | no |
| 17 | Allegati di un commento (`attachments.comment_id`, `ON DELETE CASCADE`, `attachments.ts:150-168`) | non il corpo, ma CONTENUTO del commento | la cascata non scatta (la riga resta): l'allegato sopravvive | — | **sì**, D3 (A5) |
| 18 | Menzioni | **non esistono** | — | — | no |
| 19 | Cache TanStack persistita sui telefoni | sì, copia locale | il vecchio testo resta sul disco del telefono finché quel ticket non è riletto | idem | **no** — limite dichiarato (L2) |
| 20 | `apps/worker/scripts/smoke.ts:178` | sì (script di sviluppo) | — | — | no |

**Limiti dichiarati** (da scrivere anche nel docblock delle rotte):
- **L1** — Il testo che una persona ha scritto come istruzioni di un rifiuto
  del piano vive anche nel registro decisioni, che è un registro di FATTI
  (CLAUDE.md, «Il registro decisioni non è MAI scritto dall'AI»): cancellare
  il commento non riscrive la decisione. Stessa cosa per ciò che l'agente ne
  ha già tratto (piano, PR, log del job): sono derivati, non si riscrivono.
- **L2** — «Sparisce davvero dal database» vale per le righe vive. Le
  versioni morte della tupla (fino al vacuum), il WAL e i backup lo
  conservano; i telefoni lo conservano nella cache persistita fino al
  prossimo refetch del ticket.

## 3. Punti operativi

**Modello dati (0084).** `comments.edited_at timestamptz NULL`,
`comments.deleted_at timestamptz NULL`, `comments.deleted_by_user_id uuid
NULL` FK → `users(id)` `ON DELETE SET NULL`, più due CHECK:
`comments_deleted_body_empty_chk` (`deleted_at IS NULL OR body = ''`) e
`comments_deleted_by_requires_deleted_chk` (`deleted_by_user_id IS NULL OR
deleted_at IS NOT NULL`). Nessun backfill (il NULL È lo stato giusto di ogni
riga esistente), nessun `ALTER TYPE`, un batch. `when` del journal:
**1791244800000** (6 ott 2026 00:00 UTC, maggiore della 0083). Il CHECK
scandisce la tabella una volta all'avvio: `comments` è piccola.

**Permessi — UNA regola, lato server.** `commentPermissions(row, viewer)` in
`apps/server/src/services/comments.ts`, pura:
- `canEdit = authorType === 'user' && authorId === viewer.id && deletedAt === null`
- `canDelete = authorType === 'user' && deletedAt === null && (authorId === viewer.id || viewer.role === 'admin')`

Un commento `user` il cui autore è stato eliminato (`authorId` NULL) lo può
cancellare solo un admin, e nessuno modificarlo. La rotta e la proiezione
chiamano la STESSA funzione; il client legge i due booleani e non li deduce
(stesso criterio di `canMerge`).

**Rotte** (in `routes/comments.ts`, nello stesso plugin; nessun problema di
ordine: le rotte esistenti sono solo `/`, e PATCH/DELETE non collidono con
GET/POST):
- `PATCH /api/tickets/:ticketId/comments/:commentId` `{ body }` (stesso
  `z.string().min(1).max(20_000)` del POST) → **200** commento pubblico.
  **UN `UPDATE` guardato è l'autorità**: `WHERE id = :commentId AND
  ticket_id = :ticketId AND author_type = 'user' AND author_id = :actor AND
  deleted_at IS NULL RETURNING`. Solo se tocca 0 righe si rilegge la riga
  per scegliere l'errore: assente o di altro ticket → 404
  `comment_not_found`; `deleted_at` valorizzato → 409 `comment_deleted`;
  altro (AI/sistema, non tuo, anche se admin) → 403 `forbidden`. Corpo
  identico a quello salvato → 200 senza toccare `edited_at` (niente
  «modificato» per un salvataggio a vuoto).
- `DELETE /api/tickets/:ticketId/comments/:commentId` → **204**. UPDATE
  guardato: `SET body = '', deleted_at = now(), deleted_by_user_id = :actor
  WHERE id AND ticket_id AND author_type = 'user' AND deleted_at IS NULL AND
  (author_id = :actor OR :isAdmin)`. 0 righe → rilettura: assente → 404; già
  eliminato → **204 senza riscrivere** `deleted_at`/`deleted_by` (idempotente:
  resta il primo che l'ha eliminato); altrimenti 403. Allegati: D3.
- Concorrenza «modifica di un commento appena cancellato»: la risolve la
  guardia `deleted_at IS NULL` nell'UPDATE, non un controllo precedente.
  «Cancellazione durante una modifica»: l'ordine delle due UPDATE decide,
  e il CHECK impedisce comunque che resti un testo su una riga eliminata.

**Risposta** — campi additivi su `ticketCommentSchema` e su
`activityCommentSchema`:
`editedAt: z.iso.datetime().nullable().default(null)`,
`deletedAt: z.iso.datetime().nullable().default(null)`,
`deletedBy: z.object({ name: z.string().nullable() }).nullable().default(null)`
(non nullo se e solo se `deletedAt` lo è; `name` = email, `null` se quella
persona non esiste più), `canEdit: z.boolean().default(false)`,
`canDelete: z.boolean().default(false)`. Su `commentReplyToSchema`:
`deleted: z.boolean().default(false)` (con `excerpt: ""`; `authorName`
resta: dice di chi era).

**App** — vedi Fase B. **Web** — vedi Fase C.

## 4. Deviazioni proposte — da confermare col maintainer

- **D1 — Risposta a un commento eliminato: 422 `reply_target_invalid`.** Il
  design non lo dice. Il segnaposto non ha «Reply», ma un campo di risposta
  aperto prima della cancellazione (o un'app vecchia, che vede una riga
  vuota con «Reply») può ancora inviare. Riuso il codice esistente: niente
  valore nuovo, e il client mostra già l'errore lasciando bozza e testo.
- **D2 — DELETE risponde 204, non il commento.** Il client invalida comunque
  (`useTicketAction`), e un 204 rende l'idempotenza banale.
- **D3 — Gli allegati legati al commento si cancellano con lui** (righe nella
  stessa transazione dell'UPDATE, oggetti sullo storage dopo il commit,
  best-effort come `DELETE /attachments/:id`). Motivo: la cascata
  `ON DELETE CASCADE` esisteva proprio perché un allegato di commento non
  sopravvivesse al commento, e la cancellazione ora non toglie la riga.
  Oggi nessuna UI crea allegati di commento (il web chiama `AttachmentUpload`
  senza `commentId`, `$id.tsx:1088`; solo API/SDK possono): l'effetto pratico
  è quasi nullo. Alternativa: lasciarli (restano fra gli allegati del ticket).
- **D4 — La correzione rilegge un commento MODIFICATO dopo l'ultimo push**:
  in `correction.ts:689` il taglio diventa `coalesce(edited_at, created_at) >
  since`. Chi corregge un'indicazione dopo il push vuole che la prossima
  correzione la veda. Alternativa: lasciare `created_at` (la modifica di un
  commento vecchio non conta).
- **D5 — Un CHECK in DB sul segnaposto** (§3): non era nel design, ma rende
  «il testo sparisce davvero» una proprietà dello schema invece che di una
  rotta.

## 5. Regole che valgono per tutti i task

- Verso l'app solo campi ADDITIVI, ognuno `.default(...)`/`.nullable()`, con
  un test che parsa una risposta SENZA quel campo (`readerSchema(...).parse`).
  Body: PATCH è una rotta nuova, nessun body esistente cambia.
- **Le tre trappole dei test dell'app** (CLAUDE.md): (1) **fixture complete**
  — OGNI `TicketComment` costruito nei test dell'app (`comment()` in
  `WorkScreen.test.tsx` e ogni altro, anche dietro un `as`) riceve
  `editedAt/deletedAt/deletedBy: null`, `canEdit/canDelete: false`, e ogni
  `replyTo` riceve `deleted: false`; (2) **metodi nel doppio `makeClient`
  PRIMA del test** che li usa (`editComment`, `deleteComment`), poi far
  fallire apposta il test togliendo il `mockResolvedValue`; (3) `await
  render(...)`.
- **E le due nuove**: (4) **cache persistita** — ogni lettura dei campi nuovi
  nell'app passa da `??` (`comment.deletedAt ?? null`, `comment.canEdit ??
  false`, `replyTo.deleted ?? false`) ANCHE se lo schema ha il `.default`: un
  commento riletto da AsyncStorage non ripassa dallo schema (`c14aa526`); un
  test con un commento SENZA i campi nuovi lo prova; (5) **true-sheet** —
  il pannello «⋯» che apre il campo o la conferma: chiudere (`open` falso),
  smontare in `onDidDismiss`, POI agire in un `useEffect` dopo il commit
  (forma di `ScreenHeader.tsx:90-96`). Il mock Jest chiude in modo sincrono:
  il test verde non prova la sequenza, **la verifica è sul telefono**.
- Web: cast, non parse → `?? false`/`?? null` nel punto di lettura; la
  fixture del test web lasciata SENZA i campi nuovi apposta.
- Test del server: asserzioni sulla RIGA in DB, non solo sullo status; niente
  rete (`network-guard.ts`).
- Dopo ogni modifica a `packages/*`: rebuild del package prima dei test dei
  consumatori (il `dist/` stantio falsa i risultati).
- `pnpm lint` prima del merge.

## 6. Fase A — server

### A1. Migrazione 0084 e schema drizzle

- **File**: `packages/db/drizzle/0084_comment_edit_delete.sql`,
  `packages/db/drizzle/meta/_journal.json` (idx 84, `when` 1791244800000,
  tag `0084_comment_edit_delete`), `packages/db/src/schema.ts` (`editedAt`,
  `deletedAt`, `deletedByUserId` con `.references(() => users.id, {
  onDelete: "set null" })`, i due `check(...)` nella callback della tabella),
  `packages/db/src/migration-0084.test.ts`.
- **SQL**:
  ```sql
  ALTER TABLE "comments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
  ALTER TABLE "comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
  ALTER TABLE "comments" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
  ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
  ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_body_empty_chk" CHECK ("deleted_at" IS NULL OR "body" = '');--> statement-breakpoint
  ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_by_requires_deleted_chk" CHECK ("deleted_by_user_id" IS NULL OR "deleted_at" IS NOT NULL);
  ```
- **Test prima** (stile `migration-0083.test.ts`: catena fino alla 0083,
  semina, poi la 0084): (1) righe esistenti con le tre colonne NULL e il
  corpo intatto; (2) `deleted_at` valorizzato con `body` non vuoto →
  `expectSqlState 23514`; (3) `deleted_by_user_id` senza `deleted_at` →
  23514; (4) eliminazione regolare (`body=''`, entrambe valorizzate) passa;
  (5) cancellando l'utente che ha eliminato, `deleted_by_user_id` → NULL e
  la riga resta.
- **Mutazione**: togliere il primo CHECK → (2) rosso; `ON DELETE cascade`
  sulla FK → (5) rosso.
- **Done**: test verdi; `pnpm --filter @stubwise/db build`; `schema.test.ts`
  ed `enum-parity.test.ts` verdi.

### A2. Schemi condivisi

- **File**: `packages/shared/src/schemas/ticket.ts` e il suo test,
  `.changeset/shared-comment-edit-delete.md` (`@stubwise/shared` **minor**).
- **Cosa**: i campi di §3 su `ticketCommentSchema` e `deleted` su
  `commentReplyToSchema`, con docblock (additivi, `null`/`false` = «server
  che non li manda»: nessun permesso, mai eliminato).
- **Test prima**: un commento della forma della 0083 (senza nessun campo
  nuovo) si parsa con `readerSchema(ticketCommentSchema)` e dà `editedAt:
  null`, `deletedAt: null`, `deletedBy: null`, `canEdit: false`, `canDelete:
  false`, `replyTo.deleted: false`; un `replyTo` della 0083 si parsa;
  `load-isolated.test.ts` verde.
- **Mutazione**: `canEdit: z.boolean()` senza default → primo test rosso.
- **Done**: test verdi, `pnpm --filter @stubwise/shared build`, guardiano
  `packages/api-client/src/reader.test.ts` verde.

### A3. Proiezione e permessi

- **File**: `apps/server/src/services/comments.ts` (`commentPermissions`,
  `loadReplyTargets` con `deleted`, un loader `loadDeleterNames(db, rows)` —
  UNA query sugli `users` dei `deletedByUserId`, mai una per commento),
  `apps/server/src/services/comments.test.ts` (nuovo o esistente).
- **Cosa**: `commentPermissions` pura (§3); `loadReplyTargets` seleziona
  anche `deletedAt` e per un padre eliminato dà `deleted: true, excerpt: ""`.
- **Test prima** — **tabella a più ruoli sugli STESSI dati**: commento `user`
  di A; viewer A (member) → `canEdit` e `canDelete` true; viewer B member →
  entrambi false; viewer admin C → `canEdit` false, `canDelete` true; commento
  `ai` e `system` → entrambi false per A, B e C; commento `user` con
  `authorId` null → admin `canDelete` true, nessuno `canEdit`; commento
  eliminato → tutti false. Più: padre eliminato → `deleted: true`,
  `excerpt: ""`.
- **Mutazione**: togliere `authorType === 'user'` da `canDelete` → la riga
  admin-su-AI rossa; `||` al posto di `&&` sull'autore in `canEdit` → la riga
  admin rossa.
- **Done**: test verdi.

### A4. Letture: `/comments`, POST, `/activity`, ricerche

- **File**: `apps/server/src/routes/comments.ts` (`toPublicComment` riceve
  il viewer e i nomi; `isCommentOfTicket` → rifiuta anche un padre eliminato,
  D1), `apps/server/src/routes/tickets.ts` (`activityCommentSchema` + i
  cinque campi, loader del feed), test in
  `apps/server/src/routes/comment-edit-delete.test.ts` (nuovo, accanto a
  `comment-replies.test.ts`).
- **Test prima**:
  - `GET /comments` e `/activity` portano `editedAt`/`deletedAt`/`deletedBy`
    e `canEdit`/`canDelete` calcolati PER CHI GUARDA (stessa riga, due
    sessioni: autore e altro member → valori diversi);
  - POST → la risposta 201 ha `canEdit: true, canDelete: true`;
  - commento eliminato (scritto nel test via la rotta DELETE) → `body: ""`
    in entrambe le letture, `deletedBy.name` = email di chi l'ha eliminato;
  - risposta a un eliminato → `replyTo.deleted: true`, `excerpt: ""`;
  - **«sparisce davvero»**: una parola che esiste SOLO nel commento
    eliminato non trova più il ticket né in `GET /api/search` né in `GET
    /api/tickets?q=`; **verso opposto** nello stesso test, PRIMA della
    cancellazione la stessa parola lo trova (così un vuoto non può essere
    una query rotta); e una parola presente solo nel testo NUOVO di un
    commento modificato lo trova, quella del testo vecchio no;
  - D1: POST con `replyToCommentId` di un eliminato → 422
    `reply_target_invalid` **e** nessuna riga nuova in `comments`.
- **Mutazione**: lasciare `canEdit` costante `true` in `toPublicComment` →
  il test «due sessioni» rosso; togliere il controllo «eliminato» da
  `isCommentOfTicket` → D1 rosso.
- **Done**: test del server verdi, `openapi.test.ts` verde.

### A5. Rotte PATCH e DELETE

- **File**: `apps/server/src/routes/comments.ts` (le due rotte, docblock coi
  limiti L1/L2), `apps/server/src/services/comments.ts` (`editComment`,
  `deleteComment` con l'UPDATE guardato e la classificazione dell'errore),
  stesso file di test di A4.
- **Test prima** — negativi, **ognuno asserisce la riga in DB** (corpo,
  `edited_at`, `deleted_at`, `deleted_by_user_id` invariati) oltre allo
  status:
  - member B modifica il commento di A → 403, riga identica;
  - member B cancella il commento di A → 403, riga identica;
  - **admin C modifica** il commento di A → 403, riga identica;
  - admin C cancella il commento di A → 204, `body = ''`, `deleted_by = C`;
  - commento `ai` e commento `system`: PATCH e DELETE da A, B e da admin →
    403, righe identiche;
  - commento di un ALTRO ticket (id giusto, ticket sbagliato nell'URL) →
    404 `comment_not_found`, riga identica; id inesistente → 404;
  - PATCH di un eliminato → 409 `comment_deleted`, `body` resta `''`;
  - DELETE ripetuto → 204 e `deleted_at`/`deleted_by_user_id` del PRIMO
    invariati (il secondo è un admin diverso);
  - positivi: autore modifica → 200, `body` nuovo, `edited_at` valorizzato;
    stesso corpo → 200, `edited_at` resta NULL; autore cancella → 204;
  - PATCH con `body` vuoto o > 20 000 → 400, riga identica;
  - D3: un allegato col `comment_id` del commento eliminato non esiste più
    (riga), e `storage.deleteObject` è chiamato con la sua chiave (doppio
    dello storage); un allegato del ticket senza `comment_id` resta.
- **Mutazione**: togliere `deleted_at IS NULL` dalla WHERE del PATCH → il
  409 diventa 200 e `body` torna testo (il CHECK lo rifiuta: 500 → test
  rosso in ogni caso); togliere `author_type = 'user'` dal DELETE → il caso
  admin-su-AI rosso; nel DELETE scrivere `deleted_by` anche sul giro
  idempotente → il test «primo invariato» rosso.
- **Done**: test verdi; `decisions-never-ai.test.ts` verde (non toccato).

### A6. Worker: i prompt escludono gli eliminati

- **File**: `apps/worker/src/pipeline/fix.ts:853`,
  `apps/worker/src/pipeline/correction.ts:689`, test in
  `apps/worker/src/pipeline/fix.test.ts` e nei test della correzione che
  coprono `teamComments` (`correction-prompt.test.ts` per la resa; il
  caricamento dove `runCorrection` è già testato con un DB).
- **Cosa**: `isNull(comments.deletedAt)` in entrambe le WHERE (PRIMA del
  `limit`, così un eliminato non ruba un posto); D4 in `correction.ts`.
- **Test prima**: 11 commenti `user` di cui il più recente eliminato → il
  prompt del fix ne contiene 10, nessuna voce vuota, e c'è l'undicesimo;
  correzione: un commento creato prima di `since` e modificato dopo entra
  (D4), uno eliminato no.
- **Mutazione**: filtrare in memoria DOPO il `limit` → il test degli 11
  rosso (ne restano 9).
- **Done**: test del worker verdi.

## 7. Fase B — app

### B1. Client

- **File**: `packages/api-client/src/endpoints/tickets.ts` +
  test: `editComment(ticketId, commentId, body)` → `PATCH`, parse con
  `ticketCommentSchema`; `deleteComment(ticketId, commentId)` → `DELETE`,
  `undefined` sul 204.
- **Test prima**: metodo, URL e corpo esatti; il 204 risolve `undefined`;
  una risposta PATCH senza i campi nuovi (server più vecchio non esiste per
  una rotta nuova, ma la forma è la stessa) si parsa coi default; il
  guardiano `reader.test.ts` resta verde.
- **Mutazione**: `PUT` al posto di `PATCH` → rosso.
- **Done**: test verdi, `pnpm --filter @stubwise/api-client... build`.

### B2. Mutazioni

- **File**: `apps/mobile/src/lib/work-mutations.ts`: `useEditComment(ticketId)`
  e `useDeleteComment(ticketId)` via `useTicketAction` (invalidano
  `workKeys.all`).
- **Test prima** (accanto ai test esistenti delle mutazioni): chiamano il
  client con gli argomenti esatti; su 409 `comment_deleted` invalidano (la
  schermata mostra il segnaposto).
- **Done**: test verdi.

### B3. Segnaposto, «modificato», risposte a un eliminato

- **File**: `apps/mobile/src/components/work/CommentsSection.tsx`,
  `apps/mobile/src/screens/work/WorkScreen.tsx` (`hasUserComment` esclude gli
  eliminati: `(comment.deletedAt ?? null) === null`), i18n
  `apps/mobile/src/i18n/{en,it}.json`.
- **Cosa**: `deletedAt ?? null` non nullo → riga «Comment deleted · by {name}
  · {quando}» (`work-comment-deleted-<id>`), nessun corpo, né «Reply» né «⋯»;
  le card delle risposte sotto restano. `editedAt ?? null` → «· edited» accanto
  all'orario, con l'ora della modifica (accessibilityLabel). Card di una
  RISPOSTA eliminata sotto l'originale → «Comment deleted» al posto
  dell'anteprima. Riga «In risposta a» di una risposta a un eliminato
  (`replyTo.deleted ?? false`) → «In reply to a deleted comment», premibile
  verso il segnaposto come oggi.
- **Test prima**: fixture complete (regola 1); un eliminato mostra il
  segnaposto e NON il testo né «Reply»; un modificato mostra «edited»; una
  risposta a un eliminato dice «deleted comment»; **cache persistita**: un
  commento SENZA i campi nuovi (forma 0083, dietro un `as`) si disegna come
  oggi, senza crash e senza «⋯»; «Rilancia con istruzioni» sparisce se
  l'unico commento `user` è eliminato.
- **Mutazione**: leggere `comment.deletedAt !== null` senza `??` → il test
  della cache rosso (un `undefined` viene preso per eliminato); togliere il
  filtro da `hasUserComment` → l'ultimo test rosso.
- **Done**: suite mobile verde.

### B4. «⋯», Modifica, Elimina

- **File**: `CommentsSection.tsx` (bottone «⋯» `work-comment-more-<id>`
  accanto a «Reply», solo se `(canEdit ?? false) || (canDelete ?? false)`;
  `CommentComposer` in modo `editing`, testID `work-edit-*`, riempito col
  corpo, «Save»/«Cancel», `useEditComment`), un componente nuovo
  `apps/mobile/src/components/work/CommentActionsSheet.tsx` (pannello con le
  sole voci permesse) e la conferma (`SheetModal` `scrollable={false}`, stile
  `DestructiveActions.tsx`: «Cancel» per primo, esito FUORI dal pannello),
  `WorkScreen.tsx` (lo stato `replyingTo` diventa `composer: { mode:
  "reply" | "edit"; commentId } | null` — risposta e modifica si escludono
  per costruzione), i18n.
- **Sequenza del pannello** (regola 5): tocco su «Edit»/«Delete» → si salva
  l'azione in un `ref`, `open` falso; `onClose` (= `onDidDismiss`) smonta il
  pannello; un `useEffect` sul suo smontaggio esegue l'azione: apre il campo
  di modifica, oppure monta la conferma. Due fogli non sono MAI presentati
  insieme. Esito della cancellazione (errore compreso) sotto la riga del
  commento, `work-comment-action-error-<id>`.
- **Test prima**: «⋯» assente per `canEdit = canDelete = false`; con il solo
  `canDelete` (admin su commento altrui) il pannello mostra solo «Delete»;
  «Edit» → campo `work-edit-input` col testo del commento, «Save» chiama
  `client.tickets.editComment(id, commentId, testo)`, «Cancel» chiude senza
  chiamare; aprire «Reply» chiude la modifica e viceversa; «Delete» →
  conferma → «Delete» chiama `deleteComment(id, commentId)`, «Cancel» no;
  409 `comment_deleted` → messaggio, campo chiuso; doppio client completo
  PRIMA (regola 2), `await render` (regola 3).
- **Mutazione**: mostrare «⋯» a chiunque → primo test rosso; non passare
  `commentId` → rosso sugli argomenti.
- **Done**: suite mobile verde; **prova sul telefono, un passo alla volta,
  etichette di `en.json`**: (1) «⋯» → «Edit» apre il campo e il pannello
  sparisce davvero, la pagina scorre; (2) «⋯» → «Delete» → la conferma sale
  DOPO che il primo pannello è sceso; (3) dopo la conferma la pagina si
  scorre (il foglio non resta immobile); (4) segnaposto e «edited» visibili.

## 8. Fase C — web

### C1. Modifica, Elimina e segnaposto nel feed

- **File**: `apps/web/src/lib/api.ts` (`Comment` e `ActivityComment` con i
  campi nuovi OPZIONALI nel tipo, `CommentReplyTo.deleted?`;
  `patchComment(ticketId, commentId, body)`, `deleteComment(ticketId,
  commentId)`), `apps/web/src/components/activity-feed.tsx` (link
  «Modifica»/«Elimina» accanto a «Rispondi» con `comment.canEdit ?? false` /
  `comment.canDelete ?? false`; modifica in linea con `MarkdownEditor`;
  cancellazione con `ConfirmDeleteButton`; segnaposto; «modificato» con
  `title` = data della modifica; «in risposta a un commento eliminato»),
  `apps/web/src/routes/tickets/$id.tsx` (mutazioni che invalidano activity e
  comments; `hasUserComment` esclude `deletedAt ?? null` non nullo), i18n
  `apps/web/src/i18n/locales/{it,en}.json`, test in
  `apps/web/src/routes/tickets/$id.test.tsx`.
- **Test prima**: fixture del feed **SENZA** i campi nuovi (lasciata così
  apposta, con un commento che lo dice) → nessun link, nessun crash;
  `canEdit: true` → «Modifica» → editor col testo → salva →
  `patchComment(id, commentId, testo)`; `canDelete: true` → conferma →
  `deleteComment`; eliminato → segnaposto senza corpo né «Rispondi»;
  `replyTo.deleted` → testo «commento eliminato»; 409 → errore mostrato.
- **Mutazione**: leggere `comment.canEdit` senza `?? false` non cambia nulla
  a runtime (undefined è falsy) — la mutazione utile è leggere
  `comment.deletedBy.name` senza `?.`/`?? null` → test della fixture senza
  campi rosso (crash del render).
- **Done**: test web verdi; E2E `apps/web/e2e` lanciato a mano.

## 9. Deploy e rollback

- **«Modificare e cancellare i commenti» (ott 2026)**: rebuild **server +
  worker + caddy**; l'app si aggiorna dagli store. Migrazione **0084**
  (`packages/db/drizzle/0084_comment_edit_delete.sql`) all'avvio del server —
  additiva, **nessun `ALTER TYPE`**, un solo batch, **nessun backfill**:
  `comments.edited_at`, `comments.deleted_at` (timestamptz nullable),
  `comments.deleted_by_user_id` (FK `users` `ON DELETE SET NULL`) e due
  CHECK (`comments_deleted_body_empty_chk`, un eliminato ha `body = ''`;
  `comments_deleted_by_requires_deleted_chk`). **Rotte nuove**: `PATCH` e
  `DELETE /api/tickets/:ticketId/comments/:commentId`. **Campi additivi**
  (`.nullable().default(null)` / `.default(false)`): `editedAt`, `deletedAt`,
  `deletedBy`, `canEdit`, `canDelete` su `ticketCommentSchema` e sulla
  variante `comment` di `/activity`; `deleted` su `commentReplyToSchema`.
  **Nessuna env, nessun kind di notifica, nessun valore aggiunto a un enum**:
  niente della famiglia del 500 su `/api/inbox`. **Nessun passo manuale.**
  **ORDINE, alla lettera — prima il server**: (1) `docker compose up -d
  --build server`; (2) aspetta healthy (`docker inspect -f
  '{{.State.Health.Status}}' "$(docker compose ps -q server)"` → `healthy`) e
  verifica la **0084**: `docker compose exec postgres sh -c 'psql -U
  "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d comments"'` mostra `edited_at`,
  `deleted_at`, `deleted_by_user_id` e i due CHECK (oppure `select
  max(created_at) from drizzle.__drizzle_migrations` = `1791244800000`);
  (3) solo allora `docker compose up -d --build caddy worker`.
  **Perché**: lo schema drizzle del worker nuovo nomina le tre colonne in
  ognuno dei 14 `insert(comments)` (triage, fix, correzione, review, intake,
  esiti dei job, riprese dopo il limite) e nella WHERE dei due prompt;
  contro un DB senza la 0084 falliscono tutti. Il worker VECCHIO davanti allo
  schema nuovo è innocuo (colonne nullable che non nomina) — ma finché resta
  vecchio un commento eliminato entra nei prompt come voce vuota `[N] ` e
  occupa uno dei 10 posti: nessuna fuga di testo, solo un posto sprecato. Per
  questo il worker fa parte del deploy.
  **Rollback — innocuo per lo schema, con un effetto da sapere.** Server
  vecchio: PATCH/DELETE → 404 (il caddy scende col server: il bundle nuovo
  mostrerebbe link che rispondono 404); i campi nuovi spariscono (app dal
  `.default` e dal `??`, web dal `?? false`: nessun «⋯», nessun link). I
  commenti già eliminati restano con `body = ''`: un server vecchio li
  mostra come commenti **vuoti**, col nome dell'autore e «Rispondi»
  (accettato, design §7) — il testo NON ricompare, perché non esiste più.
  Il CHECK resta e non disturba: il server vecchio non scrive `deleted_at`.
  Worker vecchio: vedi sopra. App VECCHIA davanti al server nuovo: riceve i
  campi in più e li scarta; un eliminato le appare vuoto con «Reply», e una
  risposta lì riceve 422 `reply_target_invalid` (D1), che già sa mostrare. Il
  migratore ignora la 0084 già applicata.
  **Limiti dichiarati**: il testo delle istruzioni di un rifiuto del piano
  resta nel registro decisioni (L1); WAL, backup e la cache persistita dei
  telefoni conservano il testo finché non vengono riscritti (L2).
  **Post-merge**: mergiare la PR di versioning Changesets che pubblica
  `@stubwise/shared` **minor** (`.changeset/shared-comment-edit-delete.md`).

## 10. Elenco dei task

| Fase | Task | Package |
|---|---|---|
| A | A1 Migrazione 0084 e schema | `db` |
| A | A2 Schemi condivisi + changeset | `shared` |
| A | A3 Proiezione e `commentPermissions` | `server` |
| A | A4 Letture (`/comments`, POST, `/activity`, ricerche, D1) | `server` |
| A | A5 Rotte PATCH e DELETE (+ allegati, D3) | `server` |
| A | A6 Prompt del fix e della correzione | `worker` |
| B | B1 `editComment`/`deleteComment` | `api-client` |
| B | B2 Mutazioni | `mobile` |
| B | B3 Segnaposto, «edited», risposte a un eliminato | `mobile` |
| B | B4 «⋯», Modifica, Elimina (true-sheet) | `mobile` |
| C | C1 Modifica, Elimina e segnaposto nel feed | `web` |
