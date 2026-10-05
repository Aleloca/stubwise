# Storia vera del ticket e risposte ai commenti

Data: 5 ott 2026. Stato: design approvato dal maintainer (decisioni 1–5 prese
una alla volta, 5 ott). Nato dalla prova sul telefono della pagina del ticket a
tab (PR #78).

## 1. Il problema, verificato sul codice di oggi

**La storia.** «Story of the work» nell'app (`Timeline.tsx`, `buildTimeline`
in `apps/mobile/src/lib/timeline.ts`) mostra SEMPRE sei passi fissi
(Proposed → Question answered → Plan approved → Running → PR & review →
Release), calcolati dal solo ULTIMO job. I giri di correzione post-PR non
compaiono. Il ticket #1 di Stubwise Test, ricostruito dal DB:

```
02/10 09:06  fix dell'AI → PR #4 aperta
02/10 09:09  review: approvata
02/10 09:13  correzione chiesta da Stubwise → pushata sulla PR #4
02/10 09:16  review: approvata
02/10 09:29  correzione chiesta da Bitbucket («Request changes») → pushata
02/10 09:34  review: approvata
02/10 11:48  correzione chiesta dall'app → pushata
02/10 11:51  review: approvata
```

Nell'app se ne vede un pallino «PR & review · approved». Il dato su CHI ha
chiesto una correzione e DA DOVE (`pr_corrections.trigger`,
`requested_by_user_id`, `requested_by_provider_login`) arriva ai client solo
per l'ULTIMA richiesta umana di ogni PR (`cycle.lastRequest`, derivato da
`derivePrCycle` in `packages/notifications/src/pr-correction-cycle.ts`, letto
da `apps/mobile/src/lib/pr-cycle.ts`): la SERIE delle richieste, i giri
automatici e gli esiti di ogni giro non arrivano a nessun client. Una
correzione NON apre una PR nuova: aggiunge commit alla stessa.

> **Corretto dal piano (5 ott 2026).** La prima stesura diceva «oggi non
> arriva a nessun client»: è falso per l'ultima richiesta umana, che il ciclo
> della PR già mostra («chiesta da X»). Resta vero per tutto il resto.

**Le risposte.** `comments` (`packages/db/src/schema.ts`) non ha un legame fra
commenti; i commenti non si modificano né si cancellano (nessuna rotta), quindi
un commento sparisce solo con il suo ticket.

**Dove il web legge i commenti** (aggiunto dal piano). Il web NON mostra i
commenti da `GET /api/tickets/:id/comments`: li mostra dal feed
`GET /api/tickets/:id/activity` (`ActivityFeed`,
`apps/web/src/components/activity-feed.tsx`), la cui risposta lato server è
una union con una variante `comment` sua (`activityCommentSchema` in
`apps/server/src/routes/tickets.ts`). `/comments` sul web serve solo a
`hasUserComment`. L'app invece legge `/comments`.

## 2. Decisioni del maintainer

1. La storia diventa una **cronologia vera**, un evento per riga, al posto dei
   sei passi fissi.
2. La calcola il **server**; la disegna **solo l'app** per ora. Il web resta
   com'è e potrà usarla più avanti.
3. **Dal più recente**, come i commenti.
4. **Gli ultimi 8 eventi** più «Show all (N)».
5. Risposte ai commenti con **parità web/app**: bottone «Rispondi» e riga «in
   risposta a» su entrambe.

Decisione presa senza domanda (detta al maintainer): le righe con un link (PR
aperta, correzione pushata) aprono la PR; le altre sono testo.

## 3. La cronologia (server)

**Rotta nuova** `GET /api/tickets/:id/history` → `{ events: HistoryEvent[]; total: number }`,
dal più recente. Stessa autorizzazione di `GET /api/tickets/:id/activity`.
Rotta nuova e non un campo di `/activity`: quella risposta l'app già
installata la parsa con uno schema piatto e permissivo
(`ticketActivityEntrySchema`), e cambiarne il significato è il genere di
cambio che non si ritira.

`HistoryEvent` — forma piatta, `kind` stringa aperta (stessa scelta e stesso
motivo di `ticketActivityEntrySchema`: `readerSchema` non attraversa le
union):

```ts
{
  id: string;            // stabile: `${kind}:${idDellaRiga}`
  kind: string;          // vedi tabella
  at: string;            // ISO
  actor: { type: "user" | "ai" | "system" | "provider"; name: string | null } | null;
  prNumber: number | null;
  prUrl: string | null;
  round: number | null;  // giro di correzione sulla PR, da 1
  detail: string | null; // es. verdetto, stato di arrivo
  fromStatus: string | null; // solo `status_changed`: lo stato di partenza
}
```

Ogni campo opzionale nasce `.nullable().default(null)` (regola dell'app).

| `kind` | Da | Note |
|---|---|---|
| `run_started` | `ai_jobs` senza `correction_id` | `actor` = chi l'ha avviato |
| `question_asked` / `question_answered` | `agent_questions` | answered: `actor` = chi ha risposto |
| `plan_approved` / `plan_rejected` | `project_decisions` con `source = 'plan_review'` e `ticket_id` del ticket | approvato: `source_ref.mode = 'execute'`, oppure la pre-approvazione (`source_ref.digest`, `detail = "pre_approved"`); rifiutato: `source_ref.mode = 'fix'`. ⚠️ Un rifiuto SENZA istruzioni non scrive una decisione (`resolvePlan`, `jobs.ts`) e resta fuori: vedi sotto |
| `pr_opened` | `ai_jobs` SENZA `correction_id`, `pr_url` valorizzato, stato `pr_opened`/`pr_merged`/`pr_closed` | `at` = `finished_at`; link alla PR (la PR primaria del job) |
| `review_completed` | `pr_reviews` del ticket (`ticket_id`), `status = 'completed'`, PARTITE (`started_at IS NOT NULL`) | `detail` = verdetto |
| `changes_requested` | `pr_corrections` del ticket | `actor`: utente Stubwise (trigger `stubwise`), login della piattaforma (`provider`), ciclo automatico (`review`); `round`; una `cancelled` resta, con `detail = "cancelled"` |
| `correction_pushed` / `correction_failed` | `ai_jobs` con `correction_id`: pushata = `pr_opened`/`pr_merged`/`pr_closed` (il webhook di merge/chiusura sposta TUTTI i job `pr_opened` del ticket), fallita = `failed` | link alla PR, `round` della sua correzione; una `skipped` non è un evento |
| ~~`pr_merged` / `pr_closed`~~ | — | **fuori** (piano): nessuna colonna ne porta la data, vedi sotto |
| `ticket_closed` | `ticket_events.status_changed` verso `done` o `closed` | `detail` = `done`/`closed`; niente `fromStatus` (vedi D3 qui sotto) |
| `status_changed` | ogni altro `ticket_events.status_changed` | `detail` = stato di arrivo, `fromStatus` = stato di partenza |

**Corretto dal piano — le fonti che la prima stesura lasciava aperte.**

- *Approvazione e rifiuto del piano.* Non esiste un evento di audit: il gate
  scrive un commento di sistema (testo tradotto, non un dato) e una riga di
  `project_decisions`. La riga c'è per ogni approvazione e per ogni
  pre-approvazione, ma **non per un rifiuto senza istruzioni** (scelta della
  fase 5: «rifiutato e basta non è una decisione da tramandare»). Quindi
  `plan_rejected` compare solo per i rifiuti CON istruzioni. Dedurlo dai
  commenti di sistema vorrebbe dire confrontare testi in tutte le lingue del
  catalogo: non si fa. Il ripianificare che segue un rifiuto nudo resta
  comunque visibile come `run_started`/`question_asked` successivi.
- *Merge e chiusura della PR.* `ticket_repositories.pr_state` non ha un
  timestamp, `ai_jobs.finished_at` resta quello del push (`coalesce`), e una
  PR chiusa prima del resync dei webhook (o con il ticket già fuori da
  `in_review`) cambia solo `pr_state`, senza data. L'unica traccia datata è
  `status_changed` (`→ done` con attore nullo al merge, `in_review → triaged`
  alla chiusura senza merge), che entra già. Un evento `pr_merged` datato
  male sarebbe peggio di nessuno.

> **D3, decisa dal maintainer (5 ott 2026, in fase A).** La chiusura si deve
> leggere da sola come chiusura, non come uno «status changed» generico:
> `→ done`/`→ closed` diventa un `kind` suo, **`ticket_closed`** (`detail` =
> `done`/`closed`), e i client scrivono «Ticket chiuso (done)». La regola
> «done e closed chiudono» sta UNA volta nel modulo puro; i client mettono
> solo in parole. Non porta `fromStatus`: non serve a dirla, e per le
> chiusure ricostruite dal backfill della fase 5
> (`backfill-ticket-done-events.ts`) lo stato di partenza è PRESUNTO
> (`in_review` scritto a mano).
>
> **`in_review → triaged` NON si legge «PR chiusa senza merge»**, perché il
> dato non lo permette: la stessa riga — attore nullo, stessi due stati — la
> scrive anche il triage che parcheggia (HOLD) un rilancio su un ticket in
> revisione (`apps/worker/src/pipeline/triage.ts`; `startRun` non guarda lo
> stato del ticket). Resta un `status_changed` con `fromStatus` e `detail`, e
> i client dicono il cambio di stato con parole chiare («Stato: in revisione
> → da fare»).
>
> **`actor: null` non è «automatico».** Le colonne d'autore sono `ON DELETE
> SET NULL`: un utente eliminato è indistinguibile da una transizione di
> sistema. `null` vuol dire «nessuna persona registrata», e il client non
> mostra un nome né scrive «(automatico)».
- *I job si riciclano.* `startRun` riusa il job terminale di un fix
  (`jobs.ts`, ramo `latest.correctionId === null`: azzera `started_at` e
  `finished_at`). La storia vede quindi UN `run_started` per riga di
  `ai_jobs`, con la data dell'ultimo avvio: i rilanci precedenti dello stesso
  job non hanno traccia propria. Limite dichiarato, non ricostruibile.
- *Ticket su più repository.* `ai_jobs.pr_url` è la PR PRIMARIA del job
  (`openedPrs[0]` in `fix.ts`): le PR degli altri repository non hanno un
  `pr_opened` proprio, ma le loro review e correzioni compaiono.

**Limiti aggiunti in review (fase A).**

- *Richiedente eliminato* (M6): una correzione chiesta da Stubwise da un
  utente poi cancellato ha `actor: { type: "user", name: null }`; il client
  scrive «qualcuno» (una persona c'era), non la tratta come `actor: null`.
- *La data di una richiesta si sposta* (M7): una correzione `pending` vale
  `updated_at` (le richieste che vi si fondono la rinnovano), promossa torna a
  `created_at`. La riga può cambiare posto fra due letture.
- *Pre-approvazione revocata e rifatta* (M8): compare una volta sola, alla
  prima data. La decisione è chiavata su ticket + digest del piano con
  `onConflictDoNothing`, e la revoca non lascia traccia nel registro.
- *Un fix rilanciato e non ancora ripartito* (I1) non ha `run_started`: la
  riga riciclata ha `started_at` azzerato e `created_at` vecchio, e un «run
  avviato» datato settimane fa sarebbe falso. Ricompare quando il worker lo
  riprende.

I commenti NON entrano nella cronologia: hanno il loro elenco sotto. Neanche i
commenti automatici («Fix automatico pronto…»), che raccontano gli stessi fatti
due volte.

`round` è il **numero d'ordine della correzione sulla sua PR**: le
correzioni non `cancelled` di `(repository_id, pr_number)` in ordine di
`created_at` (spareggio `id`), da 1. **NON è** `autoRoundsInCurrentSeries`
(`packages/notifications/src/pr-correction-cycle.ts`), né `cycle.round`:
quello conta i soli giri AUTOMATICI dopo l'ultima richiesta umana e si
azzera a ogni richiesta di una persona. Sul ticket #1 qui sopra le tre
correzioni sono tutte umane: `cycle.round` vale 0, la storia le numera 1, 2,
3. Una `cancelled` non ha `round` (`null`).

> **Corretto dal piano.** La prima stesura diceva «si deriva come il contatore
> dei giri»: i due numeri rispondono a domande diverse e coincidono solo
> quando nessuna persona ha mai chiesto niente. Vedi la deviazione D2 nel
> piano sull'etichetta («giro» o «correzione»).

La costruzione sta in un modulo PURO in `packages/notifications`
(`ticket-history.ts`, accanto a `project-timeline.ts`): righe già lette →
eventi ordinati. Le query stanno nel server
(`apps/server/src/services/ticket-history.ts`): un solo consumatore, e la
regola di `notifications` («moduli condivisi fra server e worker») vale per la
parte che un domani il brief o il worker vorranno, cioè la regola, non l'I/O.

Tetto: la rotta restituisce al più 200 eventi (dichiarato nel docblock), i più
recenti, più `total` (il numero prima del taglio, `.default(0)` lato client)
così «Show all (N)» non mente su un ticket lunghissimo.

Autorizzazione: come `/activity`, cioè `requireAuth` e basta (oggi nessun
controllo di progetto sulle rotte di lettura del ticket). Registrata PRIMA di
`GET /:id`, con un commento (regola uniforme di CLAUDE.md sulle rotte con una
parte letterale). Le suffisse esistenti di `tickets.ts` (`/:id/activity`,
`/:id/questions`…) stanno DOPO e funzionano lo stesso — il router distingue
`/:id` da `/:id/x` per numero di segmenti, la trappola vera è un letterale
NUDO come `/pulse` — e non si spostano in questo lavoro.

## 4. La cronologia (app)

`Timeline.tsx` viene sostituito da `TicketHistory`: una riga per evento — ora
relativa (`relativeTimeCompact`, il server manda la data), testo da i18n per
`kind` (un `kind` ignoto: riga generica «Aggiornamento», mai scartata), chi,
`PR #N · giro K`. Primi 8, poi «Show all (N)» espande sul posto. Le righe con
`prUrl` sono premibili e aprono la PR. Query nuova `tickets.history` in
`packages/api-client`; fallita o server vecchio (404) → la sezione dice che la
storia non è disponibile, il resto della tab resta intero. `buildTimeline` e
`Timeline.tsx` si rimuovono se non hanno altri consumatori (verificarlo).

> **Verificato dal piano.** `buildTimeline` e `Timeline` hanno un solo
> consumatore, `WorkScreen.tsx`, e il web non li usa (il web ha
> `ai-job-timeline.tsx` e `project-timeline.tsx`, codice suo). Ma
> `lib/timeline.ts` esporta anche `resolveWorkState`, che regge lo
> `StatusBadge` della testata: si SPOSTA (in `lib/work-state.ts`, coi suoi
> test), non si cancella. E con la timeline spariscono gli unici lettori di
> due query di `WorkScreen` — il feed `/activity` e le review del progetto —,
> che quindi escono dalla schermata (il metodo `tickets.activity` del client
> resta: è API pubblica del package).

## 5. Risposte ai commenti

**DB** — migrazione 0083, additiva, un batch, nessun backfill:
`comments.reply_to_comment_id uuid NULL REFERENCES comments(id) ON DELETE SET
NULL`. Un solo livello di riferimento: una risposta a una risposta punta al suo
genitore diretto, e l'elenco resta piatto. La FK è una self-reference: come
`project_decisions.superseded_by_id` e `doc_pages.parent_id` sta SOLO nello
SQL della migrazione, mentre lo schema drizzle dichiara la colonna senza
`.references()` (convenzione del repo). Più un indice su
`reply_to_comment_id`: il `SET NULL` di una FK senza indice scandisce la
tabella.

**Server** — `POST /api/tickets/:id/comments` accetta `replyToCommentId?`
(opzionale: le app vecchie non lo mandano). Validazione: il commento esiste ed
è dello STESSO ticket, altrimenti 422 `reply_target_invalid`. Si può
rispondere a QUALUNQUE commento del ticket, anche dell'AI o di sistema (sono
quelli a cui più spesso si vuole replicare: «Fix automatico pronto…»).
Le risposte dei
commenti portano `replyTo: { id, authorType, authorName, excerpt } | null`
(`.nullable().default(null)`), DERIVATO a lettura (estratto ~120 caratteri del
corpo, senza markdown). Su `ticketCommentSchema` in `packages/shared` (app,
`GET`/`POST /comments`) **e** sulla variante `comment` del feed
`/activity` lato server (`activityCommentSchema`, che il web legge).
`ticketActivityEntrySchema` in `packages/shared` NON cambia: l'app non legge
più i commenti da lì.

> **Corretto dal piano.** La prima stesura metteva `replyTo` solo su
> `ticketCommentSchema`: il web non l'avrebbe mai visto, perché i commenti li
> disegna dal feed `/activity`.

*Originale cancellato.* Oggi non succede: nessuna rotta cancella un commento,
e la cascata dal ticket porta via anche le risposte. Il `SET NULL` esiste per
il giorno in cui una cancellazione arriverà, e allora la risposta perde la
riga «in risposta a» (`replyTo: null`) invece di indicare un commento che non
c'è. Il caso «riga che resta, non premibile» qui sotto è difensivo: copre un
client che non trova l'originale nell'elenco che ha in mano.

*L'agente.* Una risposta è un commento `user` come gli altri: entra nelle
indicazioni del team dei run di fix e di correzione, SENZA il commento a cui
risponde. Non cambia niente di ciò che l'agente legge oggi.

**App** — su ogni commento un «Reply». Lo tocchi: il campo in cima riceve il
fuoco con sopra «Replying to {nome}: “estratto” ✕»; inviato, la risposta
compare in cima all'elenco (dal più recente) con la riga «in risposta a {nome}:
“estratto”»; toccarla scorre al commento originale. Originale non più nella
lista: la riga resta, non premibile.

**Web** — stessa cosa nel feed d'attività della pagina del ticket: «Reply» sul
commento, riga «in risposta a» sopra la risposta, link all'originale. Campo
letto con `?? null` (il web fa un cast).

Nessuna notifica nuova: non esiste un kind per i commenti (verificato nel
design delle tab), e aggiungerlo è un'altra decisione.

## 6. Deploy e rollback

Rebuild **server + caddy**; il worker non c'entra; l'app si aggiorna dagli
store. Migrazione 0083 additiva, nessun enum, nessuna env, nessun kind di
notifica. Rollback innocuo: server vecchio → `history` 404 (l'app dice «non
disponibile»), `replyTo` assente (app dal `.default`, web dal `?? null`), il
body con `replyToCommentId` torna a essere ignorato; la colonna sopravvive.

> **Aggiunto dal piano.** Il worker non si ribuilda, ma `packages/db` cambia,
> e il PROSSIMO rebuild del worker porterà lo schema con la colonna: drizzle
> la nomina in ogni `insert(comments)` — il worker ne fa **15**, non tre
> (corretto in review: `handler.ts`, `fix.ts` ×3, `triage.ts` ×4,
> `job-outcomes.ts`, `correction.ts` ×2, `backlog/intake.ts`,
> `limit-resume-poller.ts`, `run-review.ts`) — e in ogni `returning()` senza
> argomenti. Davanti a uno schema senza la 0083 fallirebbero triage, fix,
> esiti dei job, correzioni, review, intake e riprese. L'ordine è quello della
> 0082 — il server (che migra all'avvio) prima, verificata la 0083, poi il
> resto —, scritto per esteso e «alla lettera» nel piano §9.

## 7. Test

Modulo della cronologia: il ticket #1 come fixture (4 review, 3 correzioni da
tre origini), ordine, `round`, review in attesa esclusa, `kind` ignoto lato
app. Rotta: autorizzazione come `/activity`. Risposte: risposta a un commento
di un altro ticket → 422 e nessuna riga; app e web con fixture SENZA i campi
nuovi; le tre trappole dei test dell'app (fixture complete, metodi nel doppio
`makeClient()` prima, `await render`).
