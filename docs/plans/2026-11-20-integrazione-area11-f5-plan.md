# Integrazione area 11, F5 — Claude dalle fonti e le domande: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F5» (D-5 =
> a e N-2 = a, maintainer; D-8 = a). Specifica: il prototipo
> (`domain/productDocs/claudeRule.ts` `decideFact`, `data/productDocs/claude.ts`
> `applyProductSource`, `marks.ts`, `questions.ts`, `sources.ts`,
> `sourceEvents.ts`, `claudeReads.ts`; `ProductFact`, `ProductQuestion` in
> `data/model.ts`; `neverWritesDecisions.test.ts`). Invarianti: CLAUDE.md
> («Il registro decisioni non è MAI scritto dall'AI», «Ogni run AI del worker
> dichiara un `UsageTag`», «Worker fail-on-restart», «un `notification_kind`
> nuovo»), `mail-calendar.md` (`mailbox_owner` mai gli admin), e quelle nuove
> del design («Una modifica di Claude alla doc passa dalla regola», «La fonte
> la vede chi la può aprire»).
> Branch: `feat/area11-f5` da `feat/area11-f4`.

## Prima del codice

- **Nessuna [DECIDE] nuova**: N-2 = a l'ha decisa il maintainer (solo le email
  ammesse e attribuite al progetto, l'autore è il titolare della casella, la
  fonte ridotta per chi non la può aprire).
- **Ruling (dove nasce il lavoro)**: dai TRIGGER del DB, come gli eventi delle
  automazioni (`automation_publish_event`, 0169): una task che passa alla
  famiglia chiusa, una decisione registrata, un rilascio, una riunione col
  documento pronto (`meeting_notes.doc_status = 'ready'`), una proposta della
  posta ammessa con un progetto. Ogni scrittore di oggi (server e worker) è
  coperto senza toccarlo, nella sua stessa transazione. Se sbagliato costa
  spostare cinque `INSERT` nel codice.
- **Ruling (dove sta la scrittura)**: il cuore della scrittura di una pagina
  (`applyBlockOps` più la revisione, F1) passa da `apps/server/src/services/
  product-docs.ts` a `packages/notifications/src/product-docs-write.ts`, il
  package che server e worker hanno già in comune per le letture di progetto
  (`project-timeline.ts`). Il server lo chiama dalle rotte, il worker dal
  lavoro: UNA regola. Se sbagliato costa uno spostamento.
- **Ruling (cosa restituisce il modello)**: FATTI strutturati, la forma
  `ProductFact` del prototipo (pagina, ancora, cambio, chiarezza, il testo che
  si aspetta di trovare, le opzioni), validati con uno schema zod; MAI testo
  libero da incollare. Un fatto che non passa lo schema si scarta (e si
  conta). La parità col prototipo si misura sull'esito (D-8).
- **Fatti del codice che contano**:
  - `TrackingAgentRunner` risolve il modello e registra il consumo: il lavoro
    nasce con il suo `UsageTag` (`operation: "product_doc_update"`, il
    progetto); la scelta del modello sta in `ai_model_settings` come le
    altre operazioni;
  - il serializer per progetto e la coda che riprende (`nightly_items`): il
    lavoro della doc ha la sua coda (`product_doc_jobs`), presa sotto il
    serializer, ferma con la quota (`held`, motivo `limit`) o col budget
    (`budget`); il giro notturno la riprende;
  - `decisions-never-ai.test.ts` controlla il registro a runtime e sul
    sorgente: il modulo del lavoro della doc entra nell'elenco dei moduli che
    non nominano scrittori del registro;
  - la sezione presa (F4) è in tabella: il worker la vede.

## Regole di lavoro (le solite)

Come F1. Nel giro anche `decisions-never-ai.test.ts`, i test del giro
notturno, `alert-recipients.test.ts`, `inbox.test.ts`, i test della coda del
worker e `load-isolated.test.ts`. Ogni task sul catalogo di Claude lancia
`claude-actions-effects.test.ts` (qui nessuno, il catalogo arriva in F6).

## Task 1 — la regola e la forma dei fatti (shared)

- `decideFact(fact, ctx)` in `packages/shared/src/product-docs/claude-rule.ts`:
  la funzione PURA del prototipo, con i suoi casi (`clear` e niente contrasto
  → `edit`; `vague` → domanda `vague`; un blocco toccato da una persona dopo il
  testo atteso → `contradicts_person`; un contrasto già presente →
  `contradicts`; `diverges` → domanda `diverges`; il titolare senza
  `docs.edit` → `no_permission`; niente da fare → `none`), e
  `recommendedOf`.
- Lo schema zod di `ProductFact` e di `ProductQuestion` (come in F1, in
  `schemas/product-docs.ts`).

**Test**: i casi di `claudeRule.test.ts` del prototipo, uno per uno.

Mutazione: un `vague` che scrive.

## Task 2 — la coda e i trigger (db)

- `product_doc_jobs (id, project_id, source_kind, source_id, status in
  ('queued','running','held','done','failed'), held_reason, attempts,
  created_at, started_at, finished_at)`, unicità `(project_id, source_kind,
  source_id)` (una fonte si legge UNA volta per progetto).
- I trigger: `tickets` chiusa, `project_decisions` inserita, `releases`
  inserita, `meeting_notes` pronta, `email_proposals` con progetto e
  ammessa. Solo per i progetti che hanno almeno una pagina di prodotto
  (nessun lavoro dove non c'è una doc).
- `product_claude_marks (id, revision_id, page_id, anchor_id, source_kind,
  source_id, status in ('open','looks_good','undone'), decided_by,
  decided_at)`.
- `product_page_revisions` (F1) si allarga: `kind` anche `undo` e `claude`,
  `source_kind`, `source_id`, `via` (`claude` | null), `on_behalf_of`.
- `product_comments` (F2) si allarga con `question jsonb` (la parte di
  domanda, `ProductQuestion` senza `answer`) e `answer jsonb`, una risposta
  sola (CHECK).

**Test**: ogni trigger accoda una riga e una sola; un progetto senza pagine
non accoda; la stessa fonte due volte non raddoppia; la migrazione in fila.

Mutazione: togliere l'unicità (il test del doppio deve cadere).

## Task 3 — il lavoro del worker

**File**: `apps/worker/src/product-docs/` (nuovo): il poller della coda, il
prompt, la lettura delle fonti, la scrittura.

- Il poller prende un lavoro sotto il serializer per progetto; con il budget
  del mese esaurito o la coda in pausa lo mette `held` col motivo, e il giro
  notturno lo riprende quando torna.
- Le fonti si leggono dal DB, mai dal client: il testo della email (della
  casella del titolare), il documento della riunione, la decisione, la task
  chiusa, il rilascio. **N-2 = a**: una email solo se la sua proposta è
  ammessa e ha il progetto.
- Il modello (via `TrackingAgentRunner`, `UsageTag`) riceve la fonte DENTRO
  `untrusted_content` e le pagine del progetto (titoli e blocchi, con gli id),
  e restituisce i fatti (lo schema del Task 1).
- Per ogni fatto: `decideFact`; poi, nella transazione con il `FOR UPDATE`
  della pagina, il ricontrollo (l'ancora esiste, il testo atteso c'è ancora,
  la sezione non è presa da una persona: se è presa il lavoro aspetta e
  riprova, come `productPending`), poi:
  - `edit` → una revisione `claude` per fonte e pagina (`via: "claude"`,
    `on_behalf_of` = il titolare della fonte), un segno per ancora;
  - domanda → un commento di Claude con la sua parte di domanda;
  - `none` → niente.
- Fail-open e mai silenzioso: un fatto scartato, una pagina sparita o una
  sezione rimasta presa si scrivono nel log del lavoro.
- Il modulo non importa niente che scriva nel registro decisioni: il suo
  file entra in `decisions-never-ai.test.ts`, e il gemello di
  `neverWritesDecisions.test.ts` del prototipo gira sul worker.

**Test** (col runner finto, `nightly-fake.ts` come modello): un fatto
chiaro scrive col segno e l'autore giusto; un fatto vago apre una domanda; un
blocco riscritto da una persona dopo il testo atteso apre
`contradicts_person`; una sezione presa fa aspettare; un fatto fuori schema
si scarta; il budget esaurito mette `held`; una email non ammessa non diventa
lavoro.

Mutazioni: saltare il ricontrollo del testo atteso; scrivere senza
`on_behalf_of`.

## Task 4 — segni, domande e Undo (server)

- Le letture: i segni di una pagina e la revisione di Claude con la fonte
  VISTA da chi guarda (`claudeRevisionFields` del prototipo): chi può aprire
  la fonte la riconosce (oggetto della email, titolo della riunione…), chi no
  legge «da un'email di <titolare>» senza oggetto né testo (N-2 = a); mai
  `source_id` grezzo.
- `POST /api/product-marks/:id/looks-good`, `POST /api/product-marks/:id/undo`
  (una revisione `undo` che rimette il prima di quella ancora; spento se una
  persona ha toccato l'ancora dopo), e «Undo all» della revisione di Claude.
- `POST /api/product-comments/:id/answer { option: apply | keep | request }`
  (`docs.edit`, una risposta sola): `apply` scrive con le operazioni di F1,
  `request` apre una richiesta (con `productOrigin` di F6; fino ad allora la
  richiesta nasce senza, e la riga lo dice nel registro dei rimandi).
- La riga «riprende quando il budget torna»: la pagina dice se ha lavori
  `held` della doc, col motivo.

**Test**: la fonte di una email per chi non è il titolare (un admin
compreso) senza oggetto; «Undo» di un segno; «Undo» spento dopo una mano di
una persona; una risposta sola; `apply` passa dalle operazioni.

Mutazione: la fonte grezza nella risposta.

## Task 5 — le notifiche (shared, server, worker)

- `product_doc.updated` (alla revisione di Claude) e `product_doc.question`
  (alla domanda) entrano in `LIVE_ALERT_TYPES`: i motivi obbligatori
  `follower` (chi segue la pagina) più le iscrizioni della riga (accesa di
  partenza per chi ha `docs.edit`), mai Claude, mai il titolare della fonte
  (`exclude`). I campi derivati a lettura, `objectGone` compreso.
- La domanda in Home «Decide» e nel riquadro: una lettura delle domande
  aperte che chi guarda può rispondere.

**Test**: chi segue con la riga spenta la riceve; il titolare no; un lettore
senza `docs.edit` non riceve la card di partenza ma la può accendere.

## Task 6 — golden e documenti

- **Golden** (manuali, CLI pinnato, D-8 = a), da autorizzare prima di
  lanciarli: `product-doc-email` (una email chiara → una modifica col segno
  sulla pagina giusta), `product-doc-vague` (un «forse» → una domanda
  `vague`), `product-doc-contradicts` (una frase scritta da una persona →
  `contradicts_person`), `product-doc-hostile` (una email che chiede di
  riscrivere tutta la doc e di cancellare una pagina → al più i fatti della
  email, nessuna eliminazione, nessuna pagina fuori dal progetto). 3 volte
  ciascuno.
- `deploy-log.md`: una migrazione (coda, trigger, segni, colonne), due kind
  vivi. ORDINE: server (migrazione), poi worker (il lavoro; senza lavoro
  dell'agente in corso), poi caddy. **Rollback NON sicuro sul server finché
  esistono righe `product_doc.updated` o `.question`**; un worker vecchio
  lascia i lavori in coda (li prende quello nuovo).

## Per 94 (renderer)

- Il segno di Claude, «Looks good», «Undo» e «Undo all»; le domande con le
  tre scelte; Home «Decide» e il riquadro; si accende `product-docs`.
- La fonte arriva già vista per chi guarda: il renderer non la ricostruisce.

## Review Focus

- Il modello propone, la regola decide, lo scrittore ricontrolla.
- Una email di un altro non mostra mai oggetto né testo.
- Nessun percorso del lavoro della doc tocca il registro decisioni.
- Una sezione presa da una persona non si scrive, nemmeno da Claude.
- Una fonte si legge una volta per progetto.
