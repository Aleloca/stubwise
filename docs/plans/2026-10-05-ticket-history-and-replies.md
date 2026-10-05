# Storia del ticket e risposte ai commenti — piano

Data: 5 ott 2026. Design: `2026-10-05-ticket-history-and-replies-design.md`
(corretto nello stesso commit di questo piano: vedi §2).
Branch: `feat/ticket-history-replies`, worktree
`.worktrees/ticket-history-replies`.

Ogni task segue lo stesso schema: **file**, **test PRIMA** (rosso prima del
codice), **mutazione** (cosa rompere per vedere il test diventare rosso, e
perché quel rosso prova qualcosa), **done**. Dopo ogni task di un package
condiviso (`shared`, `db`, `notifications`, `api-client`): ribuild di quel
package prima dei test di chi lo usa (i consumatori leggono `dist/`, memoria
«dist stantio»). Prima del merge: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## 1. Premesse del design, verificate sul codice (HEAD 85c16c44)

| # | Premessa | Esito | Dove |
|---|---|---|---|
| P1 | La storia nell'app mostra sempre sei passi fissi, calcolati dall'ULTIMO job | **Vera** | `apps/mobile/src/lib/timeline.ts:165-185` (`WORK_STEP_ORDER.map`, `const latestJob = jobs[0]`) |
| P2 | I giri di correzione non compaiono | **Vera** | `buildTimeline` non riceve né `pr_corrections` né i job delle correzioni; il passo `prReview` porta solo l'ultimo verdetto (`verdictFor`, `timeline.ts:183,216`) |
| P3 | Chi ha chiesto una correzione e da dove «non arriva a nessun client» | **FALSA in parte** | `derivePrCycle` restituisce `lastRequest: { via, platform, name, at }` (`packages/notifications/src/pr-correction-cycle.ts:1272`), e l'app lo mostra (`apps/mobile/src/lib/pr-cycle.ts:79-90`, `requester(cycle.lastRequest)`). Arriva l'ULTIMA richiesta umana; la serie no |
| P4 | Una correzione non apre una PR nuova: aggiunge commit alla stessa | **Vera** | `correction.ts:1026` `mirrors.pushBranch(mirrorProject, branch)` senza `force`; il job chiude `status: "pr_opened"` con lo stesso `prUrl` (`correction.ts:1230`) |
| P5 | `comments` non ha un legame fra commenti | **Vera** | `packages/db/src/schema.ts:748-763`: `id, ticket_id, author_type, author_id, body, created_at` |
| P6 | I commenti non si modificano né si cancellano (nessuna rotta) | **Vera** | `apps/server/src/routes/comments.ts:58,83`: solo `app.post("/")` e `app.get("/")`; nessun `delete(comments)`/`update(comments)` in `apps/` e `packages/` |
| P7 | Un commento sparisce solo col suo ticket | **Vera** | `schema.ts:752-754` `ticket_id … onDelete: "cascade"` |
| P8 | `/activity` è letto dall'app con uno schema piatto e permissivo | **Vera** | `packages/shared/src/schemas/ticket.ts:285` `ticketActivityEntrySchema` (`kind: z.string()`, i campi di autore e corpo non dichiarati) |
| P9 | `ticketCommentSchema` sta in `packages/shared` | **Vera** | `ticket.ts:319-326`, ri-esportato come `commentSchema` in `comments.ts:24` |
| P10 | `autoRoundsInCurrentSeries` è il contatore dei giri da usare per `round` | **FALSA** | `pr-correction-cycle.ts:76`: conta le sole `trigger='review'` DOPO l'ultima richiesta umana. Sul ticket #1 (tre correzioni tutte umane) vale 0. Non è una numerazione per PR |
| P11 | Il web mostra i commenti in un feed sulla pagina del ticket | **Vera, ma dal feed `/activity`, non da `/comments`** | `apps/web/src/components/activity-feed.tsx:58` (`useSuspenseQuery(activityQueryOptions)`), variante `activityCommentSchema` in `apps/server/src/routes/tickets.ts:188`; `/comments` sul web serve solo a `hasUserComment` (`routes/tickets/$id.tsx:93,436`) |
| P12 | `GET /:id/history` «stessa autorizzazione di `/activity`» | **Vera** | `tickets.ts:655-661`: `preHandler: requireAuth`, nessun controllo di progetto |
| P13 | Nessun kind di notifica per i commenti | **Vera** | (dal design delle tab; non toccato qui) |

## 2. Correzioni al design (nello stesso commit)

1. **§1, P3**: «non arriva a nessun client» → arriva solo l'ultima richiesta
   umana, via `cycle.lastRequest`.
2. **§1, P11**: aggiunto dove il web legge i commenti.
3. **§3, `round`**: non è `autoRoundsInCurrentSeries`, è il numero d'ordine
   della correzione sulla PR (le non `cancelled`, per `created_at`, da 1).
4. **§3, tabella**: fonti scelte per `plan_approved`/`plan_rejected`,
   `pr_opened`, `review_completed`, `correction_*`; `pr_merged`/`pr_closed`
   tolti; quattro limiti dichiarati (rifiuto senza istruzioni, merge senza
   data, job riciclati, PR secondarie dei ticket multi-repo).
5. **§3**: modulo puro in `notifications` + loader nel server; tetto con
   `total`; registrazione della rotta.
6. **§4**: `resolveWorkState` si sposta, non si cancella; le query `/activity`
   e review del progetto escono da `WorkScreen`.
7. **§5**: `replyTo` anche sulla variante `comment` di `/activity` (il web
   legge da lì); FK self-reference solo nello SQL; indice; risposta ammessa a
   commenti AI e di sistema; cosa succede all'originale cancellato; l'agente.
8. **§6**: il prossimo rebuild del worker porterà la colonna nel suo schema
   drizzle: server prima del worker.

## 3. I quattro punti che il design lasciava al piano

**(a) Fonte di `plan_approved` e `plan_rejected`.** Non c'è un evento in
`ticket_events` (l'enum `ticket_event_kind`, `schema.ts:149-160`, non ha
niente sul piano) né nel feed `/activity`. `resolvePlan`
(`apps/server/src/services/jobs.ts:449-515`) scrive due cose: un commento di
sistema (`comment.planApproved`/`comment.planRejected`, testo tradotto) e, nella
stessa transazione, una riga `project_decisions` con `source = 'plan_review'`,
`ticket_id`, `decided_by_user_id`, `decided_at`, `source_ref = { jobId, mode }`
— ma **solo se** `mode === "execute"` **o** ci sono istruzioni
(`jobs.ts:497`). La pre-approvazione (`preApprovePlan`, `jobs.ts:590-600`)
scrive anche lei una decisione, `source_ref = { ticketId, digest }`.
`tickets.plan_approved_at` è la sola pre-approvazione corrente (azzerata dalla
revoca): non è una storia.
→ **Fonte: `project_decisions`** (`source='plan_review'`, `ticket_id` del
ticket). Approvato = `source_ref->>'mode' = 'execute'` oppure
`source_ref ? 'digest'` (pre-approvazione, `detail: "pre_approved"`).
Rifiutato = `source_ref->>'mode' = 'fix'`. **Un rifiuto SENZA istruzioni non ha
una riga, e resta fuori**: dedurlo dal commento di sistema vorrebbe dire
confrontare testi in tutte le lingue del catalogo (come fa il webhook per
l'idempotenza del merge), e qui non serve a niente di sicuro.

**(b) Data di merge o chiusura della PR.** Non affidabile, quindi **fuori**.
- `ticket_repositories` (`schema.ts:689-740`) ha `pr_state` ma nessun
  timestamp oltre a `created_at` (scritto alla PRIMA apertura, non aggiornato
  dall'upsert del fix, `fix.ts:1700-1725`).
- `ai_jobs.finished_at` al merge è `coalesce(finished_at, now())`
  (`webhooks.ts:797-802`): resta quello del push.
- `markPrRowsClosed` (`webhooks.ts:503`) aggiorna solo `pr_state`, anche per
  le PR chiuse col ticket già fuori da `in_review`; il backfill
  `backfill-pr-states.js` idem, senza data.
- L'unica traccia DATATA è `ticket_events.status_changed`: `→ done` con
  `actor_id` null nella transazione del merge (`webhooks.ts:784`), e
  `in_review → triaged` alla chiusura senza merge (`webhooks.ts:905`). Ci
  sono anche il commento di sistema `comment.prMerged`/`comment.prClosed` e la
  notifica `job.pr_closed` (solo chiusura), ma sono testo e copie per persona.
→ Entra `status_changed` (già nella tabella); niente `pr_merged`/`pr_closed`.

**(c) Consumatori di `buildTimeline` e di `Timeline`.**
- `buildTimeline`: solo `apps/mobile/src/screens/work/WorkScreen.tsx:330` (+
  `lib/timeline.test.ts`). `Timeline`: solo `WorkScreen.tsx:559` (+
  `components/work/Timeline.test.tsx`). Il web non li usa.
- **Da non rompere**: `resolveWorkState` sta nello stesso file e regge lo
  `StatusBadge` della testata (`WorkScreen.tsx:329`) → si sposta in
  `lib/work-state.ts` coi suoi test.
- Con la timeline spariscono gli unici lettori di `activityQuery` e
  `reviewsQuery` in `WorkScreen` (`WorkScreen.tsx:123-150`, passate solo a
  `buildTimeline`): escono, insieme a `activity`/`reviews` di `makeClient`
  nei test. `client.tickets.activity` resta nel package.
- Test di `WorkScreen.test.tsx` che nominano la timeline: righe 354, 508,
  581, 796, 942, 1429, 1440 (testID `timeline`, ordine
  `["work-comment-composer", "timeline", "work-comments"]`).
- Commenti di codice che la citano: `QuestionBlock.tsx:27`,
  `lib/query-keys.ts:179`, `CommentsSection.tsx` (docblock).
- i18n: `mobile.work.timeline.*` usate solo da `Timeline.tsx`.
- Navigazione (riverificata dopo il rebase su a9ee1c79): `WorkScreen` è
  tipata su `TicketParamList` (`WorkScreen.tsx:89`) ed è registrata in DUE
  stack, Projects e Inbox (`app/navigation.tsx:339,350`). Nessun task qui la
  tocca: la storia e le risposte vivono dentro la schermata (righe PR →
  `Linking`, scorrimento all'originale → `ScrollView` della tab), quindi non
  aggiungono rotte né parametri. Le righe citate di `WorkScreen.tsx` (89,
  123-150, 329-330, 559) e di `WorkScreen.test.tsx` sono quelle DOPO il
  rebase.

**(d) Giri di correzione.** `pr_corrections` (`schema.ts:1655-1704`):
`trigger` (`review`|`stubwise`|`provider`, CHECK), `status`
(`pending`|`queued`|`done`|`cancelled`), `requested_by_user_id` (SET NULL),
`requested_by_provider_login`, `review_id`, `note`, `created_at`,
`updated_at` (si sposta con la fusione di una `pending` e con la chiusura).
**Nessuna colonna `round`.** Il legame col job è SOLO
`ai_jobs.correction_id` (UNIQUE): una correzione `pending` non ha ancora un
job. Esiti del job: `pr_opened` (pushata; il merge/chiusura lo porta a
`pr_merged`/`pr_closed` insieme a TUTTI i `pr_opened` del ticket,
`webhooks.ts:797-802` e `918-925`), `failed`, `skipped` (annullata).
Oggi il server deriva `cycle` in `derivePrCycle`
(`pr-correction-cycle.ts:1146-1290`): `round = autoRoundsInCurrentSeries`,
`lastRequest` = la richiesta umana più recente non annullata (nome: login o
email, ora: `created_at`, o `updated_at` se `pending`).
→ `round` della storia = ordinale per `(repository_id, pr_number)` delle non
`cancelled` per `created_at`, `id`. Nome del richiedente con la STESSA regola
di `lastRequest` (provider → login ?? email; stubwise → email ?? login).

**(e) Risposte.**
- Ultima migrazione: **0082** (`_journal.json` idx 82, `when`
  1790841600000). **0083 è libera** su tutti i branch locali e remoti
  (verificato con `git ls-tree` su ogni ref). Le migrazioni sono scritte a
  mano (gli snapshot drizzle-kit si fermano alla 0060): SQL + voce nel
  journal, `when` 1791158400000 (5 ott 2026 00:00 UTC).
- POST: `apps/server/src/routes/comments.ts:58-80` (body
  `{ body: z.string().min(1).max(20_000) }`, `addComment` in
  `services/comments.ts`). Web: `postComment(ticketId, body)`
  (`apps/web/src/lib/api.ts:634`), chiamato da `commentMutation`
  (`routes/tickets/$id.tsx:258`). App: `client.tickets.comment(ticketId, body)`
  (`packages/api-client/src/endpoints/tickets.ts:152`) via `useAddComment`
  (`apps/mobile/src/lib/work-mutations.ts:182`).
- `z.object` di zod SPOGLIA i campi ignoti: un server vecchio che riceve
  `replyToCommentId` crea il commento senza legame, senza errore.
- Visualizzazione: web `CommentItem` in `activity-feed.tsx` (ordine
  crescente, composer in fondo); app `CommentList`/`CommentRow` in
  `CommentsSection.tsx` (dal più recente, composer separato in cima, dopo
  2a137bfd).
- Chi può rispondere a chi: qualunque utente autenticato (la rotta è
  `requireAuth`), a qualunque commento DELLO STESSO ticket, anche AI o
  sistema. Commenti cancellati: non esistono. Altro ticket: 422.
- Originale cancellato: `ON DELETE SET NULL` → `replyTo: null`. Oggi
  irraggiungibile (nessuna cancellazione; la cascata dal ticket porta via
  entrambi).
- Convenzione del repo per una self-FK: solo nello SQL
  (`project_decisions.superseded_by_id`, 0068:110; `doc_pages.parent_id`).

## 4. Deviazioni proposte — da confermare col maintainer

- **D1 — `plan_rejected` incompleto.** Compare solo per i rifiuti CON
  istruzioni. Alternativa scartata: dedurlo dai commenti di sistema in tutte
  le lingue. Alternativa possibile ma fuori misura: scrivere da oggi una
  decisione anche per il rifiuto nudo (tocca la scelta della fase 5 sul
  registro).
- **D2 — L'etichetta di `round`.** Il design dice «PR #N · giro K». Ma
  «Giro N di M» è già il testo di `PrCycleSection` per i giri AUTOMATICI
  (`cycle.round`), e sul ticket #1 la stessa schermata direbbe «giro 3» nella
  storia e «Giro 0 di 3» sopra. Proposta: **«PR #4 · correzione 3»** nella
  storia (`mobile.work.history.correctionN`).
- **D3 — Niente `pr_merged`/`pr_closed`** (vedi 3b). **Decisa dal
  maintainer, con una richiesta (5 ott)**: la chiusura si legge da sola come
  chiusura. Realizzata con un `kind` dedicato, **`ticket_closed`** (`detail` =
  `done`/`closed`, testo client «Ticket chiuso (done)»), e non con i dettagli
  di `status_changed`: così la regola «done e closed chiudono» sta una volta
  nel modulo puro e i client non la ricopiano. `in_review → triaged` NON
  diventa «PR chiusa senza merge»: la stessa riga la scrive il triage che
  parcheggia un rilancio su un ticket in revisione (`triage.ts`, ramo HOLD),
  quindi resta un `status_changed` con il campo nuovo **`fromStatus`** e i
  client scrivono «Stato: in revisione → da fare». E `actor: null` non si
  scrive «(automatico)»: con un utente eliminato la colonna è nulla uguale.
  Dettaglio nel design §3.
- **D4 — `total` nella risposta** oltre a `events`, così «Show all (N)» dice
  il vero anche oltre il tetto di 200. Campo additivo, `.default(0)`; con
  `total > events.length` l'app scrive «ultimi 200 di N».
- **D5 — Un solo `run_started` per riga di `ai_jobs`** (i fix si riciclano,
  3c del design): limite accettato.
- **D6 — Ticket multi-repo**: solo la PR primaria ha `pr_opened`.
- **D7 — Si risponde anche ai commenti dell'AI e di sistema.**

## 5. Regole che valgono per tutti i task

- Verso l'app solo campi ADDITIVI: ogni campo nuovo di risposta nasce
  `.nullable().default(null)` / `.default(…)` / `.optional()`, con un test
  che parsa una risposta SENZA quel campo (`readerSchema(schema).parse`).
- Body che cresce: `replyToCommentId` è `.optional()`.
- Web: cast, non parse → `?? null` nel punto di lettura, e la fixture del
  test web lasciata SENZA il campo apposta.
- `readerSchema`: gli enum dentro `HistoryEvent.actor.type` e
  `replyTo.authorType` si aprono a `UNKNOWN`; il guardiano
  `packages/api-client/src/reader.test.ts` raccoglie da solo il nuovo
  endpoint (chiama ogni metodo): deve restare verde.
- Rotte: `/:id/history` registrata PRIMA di `GET /:id` in `tickets.ts`, con
  commento.
- Migrazione: un solo batch, nessun `ALTER TYPE`.
- App, le tre trappole dei test: (1) fixture COMPLETE in ogni test che
  costruisce un `TicketComment` o un `HistoryEvent`, comprese quelle dietro
  un `as`; (2) **metodo nel doppio `makeClient` PRIMA del test** che lo usa
  (`tickets.history`, e la firma nuova di `tickets.comment`), poi fallo
  fallire apposta togliendo il `mockResolvedValue`; (3) `await render(...)`.
- Test del server: niente rete (la guardia `network-guard.ts` è attiva).

## 6. Fase A — server, modulo puro, migrazione

### A1. Migrazione 0083 e schema drizzle

- **File**: `packages/db/drizzle/0083_comment_replies.sql`,
  `packages/db/drizzle/meta/_journal.json` (idx 83),
  `packages/db/src/schema.ts` (colonna `replyToCommentId:
  uuid("reply_to_comment_id")` SENZA `.references()`, commento che rimanda
  allo SQL; indice `comments_reply_to_comment_id_idx`),
  `packages/db/src/migration-0083.test.ts`.
- **SQL**:
  ```sql
  ALTER TABLE "comments" ADD COLUMN "reply_to_comment_id" uuid;--> statement-breakpoint
  ALTER TABLE "comments" ADD CONSTRAINT "comments_reply_to_comment_id_comments_id_fk" FOREIGN KEY ("reply_to_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
  CREATE INDEX "comments_reply_to_comment_id_idx" ON "comments" USING btree ("reply_to_comment_id");
  ```
- **Test prima** (stile `migration-0082.test.ts`: catena fino alla 0082,
  semina, poi lo SQL della 0083 in una transazione): (1) le righe esistenti
  hanno `reply_to_comment_id` NULL; (2) una risposta a un commento esistente
  si inserisce; (3) un id inesistente viola la FK (`expectSqlState 23503`);
  (4) cancellando l'originale la risposta resta con `reply_to_comment_id`
  NULL; (5) cancellando il TICKET spariscono entrambi.
- **Mutazione**: `ON DELETE cascade` al posto di `set null` → (4) rosso;
  togliere la FK → (3) rosso.
- **Done**: test verdi; `pnpm --filter @stubwise/db build`; `schema.test.ts`
  ed `enum-parity.test.ts` verdi.

### A2. Schemi condivisi

- **File**: `packages/shared/src/schemas/ticket.ts` (+ `ticket.test.ts` o il
  file di test accanto), `packages/shared/src/search-snippet.ts` (o un
  `plain-excerpt.ts` nuovo che riusa `stripMarkdown`, esportato).
- **Cosa**:
  - `commentReplyToSchema = z.object({ id: z.uuid(), authorType:
    z.enum(["user","ai","system"]), authorName: z.string().nullable(),
    excerpt: z.string() })`;
  - `ticketCommentSchema` + `replyTo: commentReplyToSchema.nullable().default(null)`;
  - `ticketHistoryEventSchema` (forma piatta del design §3: `kind:
    z.string()`, `actor: z.object({ type: z.enum(["user","ai","system",
    "provider"]), name: z.string().nullable() }).nullable().default(null)`,
    `prNumber`/`prUrl`/`round`/`detail`/`fromStatus` `.nullable().default(null)`) e
    `ticketHistorySchema = z.object({ events: z.array(…).default([]),
    total: z.number().int().nonnegative().default(0) })`;
  - `plainExcerpt(raw, maxChars)` = `stripMarkdown` + taglio a ~120 caratteri
    su confine di parola con «…».
- **Test prima**: un commento SENZA `replyTo` si parsa (via
  `readerSchema(ticketCommentSchema)`) e dà `replyTo: null`; un evento con
  SOLO `id`/`kind`/`at` si parsa con tutti i default; `actor.type`
  sconosciuto → `UNKNOWN` (non un errore); `kind` ignoto passa così com'è;
  `plainExcerpt` toglie link/grassetto/codice e taglia; lo schema dei file
  si carica da solo (`load-isolated.test.ts`, automatico).
- **Mutazione**: togliere `.default(null)` da `replyTo` → il test «senza
  campo» rosso; `actor.type` a `z.string()`… resta verde (non è un difetto),
  quindi mutare invece `plainExcerpt` per non togliere i link → rosso.
- **Done**: `pnpm --filter @stubwise/shared build` + i suoi test verdi.

### A3. Modulo puro della cronologia

- **File**: `packages/notifications/src/ticket-history.ts` (+ `.test.ts`),
  export in `packages/notifications/src/index.ts`.
- **Cosa**: `buildTicketHistory(input: TicketHistoryRows, opts: { limit })`
  → `{ events, total }`. Input = righe già lette (date come `Date`):
  `jobs` (id, status, correctionId, prUrl, createdAt, startedAt, finishedAt,
  requesterName), `questions` (id, askedAt, answeredAt, answeredByName),
  `decisions` (id, sourceRef, decidedAt, decidedByName), `reviews` (id,
  verdict, createdAt, startedAt, status), `corrections` (id, repositoryId,
  prNumber, trigger, status, createdAt, userEmail, providerLogin),
  `statusEvents` (id, to, actorName, actorId, createdAt), `prUrls` (mappa
  `(repositoryId, prNumber)` → url, da `ticket_repositories`).
  Regole: tabella del design §3 corretta; `round` = ordinale per PR delle non
  `cancelled` (una `cancelled` → `round: null`, `detail: "cancelled"`); il
  job di una correzione eredita `round` e PR dalla sua correzione; ordine
  decrescente per `at`, spareggio per `id` (deterministico); `total` =
  numero prima del taglio, `events` = i primi `limit`; `id` =
  `${kind}:${idRiga}`; review solo `status='completed'` e `startedAt !==
  null`; `pending` e `queued` compaiono come `changes_requested` (la
  richiesta c'è), il loro job non ancora. `status_changed` verso
  `done`/`closed` → `ticket_closed` (senza `fromStatus`), ogni altro →
  `status_changed` con `fromStatus` (D3).
- **Test prima** (fixture = ticket #1 del design, date del 02/10):
  - ordine e contenuto esatti delle otto righe (più `run_started`,
    `status_changed`), dal più recente;
  - `round` 1, 2, 3 per le tre correzioni umane — **test di accordo/negativo
    con il ciclo**: sulla stessa fixture `autoRoundsInCurrentSeries`
    (contro un Postgres vero, `pr-correction-cycle.test.ts` già ha
    l'harness) vale 0 mentre la storia numera 1..3: fissa che i due numeri
    NON sono lo stesso, così nessuno li «unifica»;
  - una correzione `cancelled` fra due altre non sposta la numerazione;
  - review in attesa (`startedAt: null`) esclusa; review `failed` esclusa;
  - correzione `trigger='provider'` → `actor: { type: "provider", name:
    login }`; `review` → `{ type: "ai" … }`; utente cancellato → `name: null`;
  - decisione `mode: 'fix'` → `plan_rejected`; `digest` → `plan_approved` con
    `detail: "pre_approved"`; nessuna decisione → nessuna riga;
  - tetto: 205 eventi → 200 in `events`, `total: 205`, i più recenti;
  - due eventi alla stessa data → ordine stabile per `id`.
- **Mutazione**: numerare `round` contando anche le `cancelled` → il test
  sulla cancellata rosso; ordinare crescente → rosso; dimenticare il filtro
  `startedAt` → rosso. Verificare che il test del ticket #1 non passi per
  caso: le date della fixture sono tutte DISTINTE (nessun `now()`), così
  l'ordine non viene dallo spareggio.
- **Done**: test verdi, `pnpm --filter @stubwise/notifications build`.

### A4. Loader e rotta `GET /api/tickets/:id/history`

- **File**: `apps/server/src/services/ticket-history.ts` (query, una per
  sorgente, `Promise.all`, come `/activity`), `apps/server/src/routes/tickets.ts`
  (rotta registrata PRIMA di `app.get("/:id")`, con commento; risposta
  `ticketHistorySchema` lato server), `apps/server/src/routes/tickets.test.ts`
  (o `ticket-history.test.ts`).
- **Query**: `ai_jobs` del ticket (left join `users` sul richiedente);
  `agent_questions` del ticket; `project_decisions` con `ticket_id = :id` e
  `source = 'plan_review'`; `pr_reviews` con `ticket_id = :id`,
  `status='completed'`, `started_at is not null`; `pr_corrections` del
  ticket (left join `users`); `ticket_events` `kind='status_changed'` (left
  join `users`); `ticket_repositories` per gli URL. Tetto 200 nel docblock.
- **Test prima**: 404 su un ticket inesistente; 401 senza sessione; un
  `member` vede la storia come vede `/activity` (stessa autorizzazione);
  scenario completo contro Postgres vero con la forma del ticket #1;
  **routing**: `GET /api/tickets/:id` risponde ancora il dettaglio dopo
  l'aggiunta, e `/:id/history` non viene catturata come altro; un evento di
  un ALTRO ticket (review con `ticket_id` diverso, correzione su altro
  ticket) non compare — test negativo che asserisce l'assenza della riga
  precisa, non il conteggio.
- **Mutazione**: togliere il filtro `ticket_id` dalle review → il negativo
  rosso; registrare la rotta senza `requireAuth` → 401 rosso.
- **Done**: test verdi; OpenAPI generata senza errori.

### A5. Risposte: POST e lettura derivata

- **File**: `apps/server/src/routes/comments.ts`, `apps/server/src/services/comments.ts`
  (`addComment` accetta `replyToCommentId?`), `apps/server/src/routes/tickets.ts`
  (`activityCommentSchema` + `replyTo` `.nullable().default(null)`, e il
  loader del feed), un helper condiviso `replyToByCommentId(db, rows)` (UNA
  query per elenco: join `comments` padre + `users`), test in
  `tickets.test.ts`/test dei commenti.
- **Cosa**: body `{ body, replyToCommentId: z.uuid().optional() }`; se
  presente, il padre deve esistere ed essere dello stesso ticket, altrimenti
  **422 `reply_target_invalid`** e nessuna riga; `GET /comments`, la risposta
  del `POST` e `/activity` portano `replyTo` derivato (`authorName` = email
  per `user`, `null` per AI/sistema o autore cancellato; `excerpt` =
  `plainExcerpt(body, 120)`).
- **Test prima**:
  - risposta a un commento dello stesso ticket → 201, `replyTo` valorizzato
    in POST, GET `/comments` e `/activity`;
  - **negativo**: risposta a un commento di un ALTRO ticket → 422 **e**
    nessuna riga nuova in `comments` (asserito sul DB, non solo sullo
    status); id inesistente → 422, nessuna riga;
  - body SENZA `replyToCommentId` → 201 come oggi, `replyTo: null`
    (compatibilità con l'app installata);
  - risposta a un commento `system` e a uno `ai` → 201 (D7);
  - `replyTo` derivato a lettura: cambiando il padre in DB (update diretto,
    solo nel test) l'estratto della risposta cambia — prova che non è
    copiato al momento della scrittura;
  - originale cancellato (delete diretto nel test) → la risposta resta,
    `replyTo: null`;
  - un'unica query per i padri: un elenco di 10 risposte non fa 10 query
    (spia su `db.select` o conteggio — facoltativo, se l'harness lo
    permette).
- **Mutazione**: togliere il controllo «stesso ticket» → il negativo rosso;
  scrivere `replyTo` nell'insert invece di derivarlo → il test «cambio del
  padre» rosso.
- **Done**: test del server verdi; `decisions-never-ai.test.ts` verde (non
  toccato).

## 7. Fase B — app

### B1. Client: `tickets.history` e `tickets.comment` con risposta

- **File**: `packages/api-client/src/endpoints/tickets.ts` (+ `tickets.test.ts`).
- **Cosa**: `history(ticketId): Promise<Reader<TicketHistory>>` verso
  `GET /api/tickets/:id/history` con `ticketHistorySchema`;
  `comment(ticketId, body, opts?: { replyToCommentId?: string })` — il campo
  va nel body SOLO se presente.
- **Test prima**: path e schema; `comment` senza opzioni manda `{ body }`
  esatto (nessuna chiave `replyToCommentId: undefined`); con l'opzione la
  manda; una risposta di `/history` senza `total` e un evento senza campi
  facoltativi si parsano; `reader.test.ts` resta verde.
- **Mutazione**: mandare sempre `replyToCommentId` → il primo test rosso.
- **Done**: `pnpm --filter @stubwise/api-client build` + test.

### B2. `resolveWorkState` si sposta

- **File**: `apps/mobile/src/lib/work-state.ts` (+ test, spostati da
  `timeline.test.ts` i tre casi di `resolveWorkState`), import in
  `WorkScreen.tsx`.
- **Test prima**: i tre casi esistenti, nel file nuovo.
- **Mutazione**: `UNKNOWN` → `null` → rosso.
- **Done**: nessun import di `lib/timeline` per `resolveWorkState`.

### B3. `TicketHistory` al posto di `Timeline`

- **File**: `apps/mobile/src/components/work/TicketHistory.tsx` (+ test),
  `apps/mobile/src/lib/ticket-history.ts` (testo per `kind`, puro, + test),
  `apps/mobile/src/lib/work-mutations.ts` (`workKeys.history`),
  `apps/mobile/src/screens/work/WorkScreen.tsx`,
  `apps/mobile/src/i18n/{en,it}.json` (`mobile.work.history.*`); si
  CANCELLANO `Timeline.tsx`, `Timeline.test.tsx`, `lib/timeline.ts`,
  `lib/timeline.test.ts` e le chiavi `mobile.work.timeline.*`; escono da
  `WorkScreen` `activityQuery` e `reviewsQuery` (e dal `retry`).
- **Cosa**: query `workKeys.history(id)` sotto `workKeys.all(id)` (così le
  invalidazioni esistenti la coprono), FUORI dai gate `isPending`/`isError`.
  Una riga per evento: ora (`relativeTimeCompact`), testo per `kind` (un
  `kind` ignoto → «Update»/«Aggiornamento», mai scartato; `ticket_closed`
  → «Ticket closed (done)»/«Ticket chiuso (done)»; `status_changed` →
  «Status: in review → triaged» da `fromStatus`/`detail`, mai «PR chiusa
  senza merge»), chi (un `actor.type` `UNKNOWN` → nessun nome inventato;
  `actor: null` → nessun nome e NIENTE «automatico»), «PR #N · correzione K»
  (D2). Primi 8, poi «Show all (N)» sul posto (N = `total`). Righe con
  `prUrl` premibili (`Linking.openURL` dietro la guardia http/https già
  usata da `SafeMarkdown`), le altre testo. Query fallita o 404 → «Story
  not available», il resto della tab intero.
- **Test prima** (`TicketHistory.test.tsx` + `WorkScreen.test.tsx`):
  - **doppio**: aggiungere `history` a `makeClient` (e a OGNI gemello di
    `makeClient` che monta `WorkScreen`) PRIMA del test; togliere
    `activity`/`reviews`. Verifica del doppio: un test fatto fallire apposta
    senza il `mockResolvedValue`;
  - 12 eventi → 8 righe e «Show all (12)»; premuto → 12;
  - `kind` sconosciuto → riga generica, non sparisce;
  - riga con `prUrl` premibile apre l'URL; senza `prUrl` non ha ruolo
    `button`;
  - fixture SENZA i campi facoltativi (solo `id`, `kind`, `at`) → la riga
    c'è;
  - `history` che rifiuta (404) → testo «non disponibile», composer ed
    elenco commenti presenti;
  - l'ordine della tab Attività diventa `["work-comment-composer",
    "work-history", "work-comments"]` (aggiorna il test della riga 1440);
  - `await render(...)` ovunque.
- **Mutazione**: scartare i `kind` ignoti → rosso; mostrare sempre tutti →
  rosso; togliere `history` dal doppio → la schermata NON deve restare
  verde sul test dello stato «non disponibile» per il motivo sbagliato:
  controllare che il test asserisca il testo, non l'assenza di righe.
- **Done**: suite mobile verde (`pnpm --filter @stubwise/mobile test`),
  `parity.test.ts` i18n verde, nessun riferimento rimasto a `lib/timeline`
  (grep).

### B4. Rispondere a un commento

- **File**: `CommentsSection.tsx` (`CommentList` riceve `onReply` e
  `onJumpTo`; `CommentRow` mostra «Reply» e la riga «in risposta a»;
  `CommentComposer` riceve `replyTo` + `onCancelReply` e un ref per il
  fuoco), `work-mutations.ts` (`useAddComment` →
  `{ body, replyToCommentId? }`), `WorkScreen.tsx` (stato `replyingTo`
  sollevato in `WorkTabs`; ref della `ScrollView` di Attività e posizioni dei
  commenti via `onLayout` per scorrere all'originale), i18n.
- **Cosa** (design §5): «Reply» su ogni commento → il campo in cima prende
  il fuoco con «Replying to {nome}: “estratto” ✕»; inviato, la bozza e lo
  stato di risposta si azzerano; la risposta mostra «in risposta a {nome}:
  “estratto”», premibile se l'originale è nell'elenco (scorre lì), altrimenti
  testo. Nome: `replyTo.authorName`, oppure l'etichetta per `authorType`
  (AI/sistema/ignoto) come `authorLabel`.
- **Test prima**:
  - «Reply» → il composer mostra la riga con nome ed estratto; ✕ la toglie;
  - invio → `client.tickets.comment` chiamato con `(id, body,
    { replyToCommentId })`; senza risposta, chiamato SENZA opzioni
    (asserire gli argomenti esatti);
  - **fixture complete**: OGNI fixture `TicketComment` dei test dell'app
    (`WorkScreen.test.tsx` `comment()` e qualunque altra, anche dietro un
    `as`) riceve `replyTo: null`. Nell'app il parse gira in produzione ma NON
    nei test (il client è un doppio): una fixture senza il campo farebbe
    saltare la schermata intera. Il caso «server vecchio senza `replyTo`» si
    prova in B1, sul parse vero;
  - risposta il cui originale è nell'elenco → premibile; originale assente
    → non premibile, riga presente;
  - `replyTo.authorType` `UNKNOWN` → etichetta «sconosciuto», nessun crash;
  - `await render`.
- **Mutazione**: non passare `replyToCommentId` → rosso; azzerare lo stato
  di risposta prima dell'invio → rosso sul test degli argomenti.
- **Done**: suite mobile verde; prova manuale sul telefono (un passo alla
  volta, etichette di `en.json`).

## 8. Fase C — web

### C1. Rispondere dal feed d'attività

- **File**: `apps/web/src/lib/api.ts` (`ActivityComment.replyTo?:
  CommentReplyTo | null`, `Comment.replyTo?`, `postComment(ticketId, body,
  replyToCommentId?)`), `apps/web/src/components/activity-feed.tsx`
  (`CommentItem` con «Rispondi» e la riga «in risposta a» con link
  `#comment-<id>`; `id="comment-<id>"` sull'`<li>`; stato `replyingTo` nel
  feed, banner sopra l'editor con ✕), `apps/web/src/routes/tickets/$id.tsx`
  (`commentMutation` passa il terzo argomento), i18n
  `apps/web/src/i18n/locales/{it,en}.json` (`tickets:comments.reply`,
  `replyingTo`, `inReplyTo`), test in `activity-feed.test.tsx` (nuovo) o
  `routes/tickets/$id.test.tsx`.
- **Cosa**: letto con `comment.replyTo ?? null` nel punto di lettura (il web
  fa un cast). Ordine del feed invariato (crescente): la risposta compare in
  fondo, dov'è nel tempo.
- **Test prima**:
  - fixture del feed **SENZA** `replyTo` (lasciata così apposta, con un
    commento che lo dice) → il commento si disegna, nessuna riga «in
    risposta a», nessun crash;
  - fixture con `replyTo` → riga con nome ed estratto, link verso
    `#comment-<id>`;
  - «Rispondi» → banner; invio → `postComment` chiamato con
    `(id, body, replyId)`; ✕ → chiamato senza;
  - 422 `reply_target_invalid` → errore mostrato, testo lasciato nel campo.
- **Mutazione**: togliere `?? null` e leggere `comment.replyTo.excerpt` →
  il test senza campo rosso (crash del render).
- **Done**: test web verdi; E2E `core-flows.spec.ts` lanciato a mano (UI
  rilevante: non gira in `pnpm -r test`).

## 9. Deploy e rollback

- **«Storia del ticket e risposte ai commenti» (ott 2026)**: rebuild
  **server + caddy**; il worker NON si ribuilda; l'app si aggiorna dagli
  store. Migrazione **0083** (`packages/db/drizzle/0083_comment_replies.sql`)
  all'avvio del server — additiva, **nessun `ALTER TYPE`**, un solo batch,
  **nessun backfill**: colonna `comments.reply_to_comment_id uuid` nullable
  con FK self-reference `ON DELETE SET NULL` e indice. **Nessuna env, nessun
  kind di notifica, nessun valore aggiunto a un enum esistente**: niente
  della famiglia del 500 su `/api/inbox`. **Rotta nuova**
  `GET /api/tickets/:id/history` (`{ events, total }`, tetto 200). **Campi
  additivi**: `replyTo` (`.nullable().default(null)`) su
  `ticketCommentSchema` e sulla variante `comment` di `/activity`; body del
  `POST /comments` con `replyToCommentId` **opzionale**. **Nessun passo
  manuale.**
  **Ordine**: `docker compose up -d --build server`, poi `caddy`. Il server
  migra PRIMA di ascoltare, quindi il bundle nuovo non trova mai uno schema
  vecchio. ⚠️ **Il worker non si ribuilda ORA, ma `packages/db` cambia**:
  al prossimo rebuild del worker (per qualunque altro motivo) il suo schema
  drizzle avrà la colonna, e drizzle la NOMINA in ogni
  `insert(comments)` (`handler.ts:257`, `correction.ts:1121` e `1216`) e in
  ogni `.returning()` senza argomenti. Contro un database senza la 0083
  quegli insert fallirebbero. Con la 0083 già applicata (questo deploy) non
  c'è niente da fare; su un'istanza self-hosted che aggiornasse il SOLO
  worker saltando questo server, sì: server prima, come per la 0082.
  **Rollback — innocuo, niente da ripulire.** Server vecchio: `history` →
  404 (l'app dice «storia non disponibile», il resto della tab intero);
  `replyTo` assente (app dal `.default(null)`, web dal `?? null`: le
  risposte si vedono come commenti normali); un'app nuova che manda
  `replyToCommentId` a un server vecchio crea un commento normale (zod
  spoglia il campo ignoto: niente 400). Le risposte già salvate restano,
  col legame in colonna, e tornano a mostrarsi tornando avanti; il migratore
  ignora la 0083 già applicata. Il caddy scende col server (il bundle nuovo
  chiamerebbe `postComment` col terzo argomento: innocuo, ma la riga «in
  risposta a» sparirebbe comunque). App VECCHIA davanti al server nuovo:
  riceve `replyTo` in più e lo scarta; non chiama `history`; continua a
  chiamare `/activity` e le review del progetto, che restano.
  **Post-merge**: changeset `@stubwise/shared` **minor** (schemi nuovi
  `ticketHistorySchema`, `commentReplyToSchema`, campo `replyTo`;
  `.changeset/shared-ticket-history-replies.md`).

## 10. Elenco dei task

| Fase | Task | Package |
|---|---|---|
| A | A1 Migrazione 0083 e schema | `db` |
| A | A2 Schemi condivisi + `plainExcerpt` | `shared` |
| A | A3 Modulo puro `buildTicketHistory` | `notifications` |
| A | A4 Loader + `GET /:id/history` | `server` |
| A | A5 Risposte: POST + `replyTo` derivato (anche su `/activity`) | `server` |
| B | B1 `tickets.history` + `comment(…, { replyToCommentId })` | `api-client` |
| B | B2 `resolveWorkState` in `lib/work-state.ts` | `mobile` |
| B | B3 `TicketHistory` al posto di `Timeline` | `mobile` |
| B | B4 Rispondere a un commento | `mobile` |
| C | C1 Rispondere dal feed d'attività | `web` |
