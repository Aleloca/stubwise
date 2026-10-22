# Invarianti e trappole — Review, correzioni post-PR, revisore e adozione

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

- **Il ciclo di correzione non si innesca da sé, e la difesa è fail-closed
  (1 ott 2026).** L'account revisore mette «Request changes» → il provider
  manda il webhook → senza difesa Stubwise lo leggerebbe come una richiesta
  UMANA, azzererebbe il contatore e ripartirebbe per sempre. Quindi un evento
  dal provider il cui autore è l'account principale **o** il revisore
  EFFETTIVO della repository — l'esplicito, altrimenti il predefinito del suo
  ambito, risolto da `resolveReviewAccountWithCredentials` (vedi «Il revisore
  effettivo si risolve in UN posto» qui sotto); mai la sola colonna
  `review_git_account_id`, mai ogni predefinito dell'istanza — si **scarta prima di qualunque scrittura in
  `pr_corrections`/`ai_jobs`**
  (`apps/server/src/services/pr-correction-webhook.ts`, esito `own_account`;
  prima può solo salvarsi `git_accounts.provider_user_id`, che
  `resolveProviderUserId` mette in cache),
  e gli stessi due account sono esclusi dalla fotografia dei commenti
  (`provider_feedback`: la review l'AI la riceve già dal DB). Se
  `provider_user_id` non è risolvibile per uno dei due (`identity_unresolved`,
  tipicamente un token Bitbucket senza `read:user:bitbucket`), l'evento
  **non** fa partire niente: resta una riga nel log e un **commento di sistema
  sul ticket** che dice chi ha chiesto, su quale PR e perché non è partito
  (template i18n `comment.changesRequestDropped.*`, mai AI; deduplicato per PR
  con `isDroppedRequestNotice`, che riconosce la PRIMA riga del commento —
  niente dati variabili lì dentro oltre al numero della PR, o il dedup si
  rompe per sempre; best-effort, mai un job né una riga in `pr_corrections`).
  Stessa forma per chi NON ha il permesso di chiedere modifiche
  (`isAuthorPermitted`: su GitHub `author_association` è solo una scorciatoia,
  poi decide il permesso reale sulla repository, `write`/`maintain`/`admin`;
  esiti `untrusted_author` e `permission_unverifiable`, ciascuno col suo
  avviso): una verifica che fallisce esclude, non ammette. Un ciclo infinito —
  o un estraneo che scrive nel prompt e spende il budget — costa più di una
  richiesta persa, che si ripete dal bottone. Chi tocca il webhook non
  trasformi quel «non so chi è» in un «allora è umano». Il test che la
  presidia è NEGATIVO e asserisce sulle righe in DB, non sulla risposta (che è
  204 in ogni caso): lo stesso evento da un terzo crea la correzione, dai due
  account propri no — e dal 1 ott 2026 anche dal predefinito
  (`apps/server/src/routes/webhooks.corrections.test.ts`, «webhook "Request
  changes" — il revisore predefinito è un account proprio»).
- **Il revisore effettivo si risolve in UN posto (1 ott 2026).** Quale
  account fa da revisore su una repository lo decide SOLO
  `pickReviewAccount` (regola pura) attraverso `resolveReviewAccount(s)` /
  `resolveReviewAccount(s)WithCredentials`
  (`packages/notifications/src/review-account.ts`): l'esplicito
  (`repositories.review_git_account_id`) se c'è, altrimenti il predefinito
  (`git_accounts.is_default_reviewer`) dello stesso ambito del principale,
  **scartato se è il principale stesso** (`skippedDefault`: esiste per dirlo
  all'utente, mai per usarlo); mai il principale. I consumatori, tutti: la
  pubblicazione del verdetto (`loadReviewerProject`,
  `apps/worker/src/review/cycle.ts`), la fotografia dei commenti di una
  correzione (`apps/worker/src/pipeline/correction.ts`), gli account propri
  del webhook (`handleChangesRequested`,
  `apps/server/src/services/pr-correction-webhook.ts`), la proiezione della
  repository e l'avviso del form (`apps/server/src/routes/repositories.ts`),
  gli avvisi del PUT del predefinito e il ruolo di Validate
  (`defaultReviewerWarnings`/`accountReviewRole`,
  `apps/server/src/routes/git-accounts.ts`). **Nessuno legge
  `review_git_account_id` per decidere chi pubblica o chi è «proprio»**: la
  colonna la leggono solo `review-account.ts` stesso, le rotte che la
  SCRIVONO (form della repository, `checkReviewAccount` in
  `apps/server/src/services/review-account-check.ts`, che valida l'esplicito
  scelto) e la proiezione che la espone così com'è. Chi la rilegge da sé fa
  valere il predefinito in un posto e non in un altro — e se quel posto è il
  webhook, riapre l'auto-innesco qui sopra. Il web non deduce niente: legge
  `effectiveReviewAccount`/`skippedDefaultReviewAccount` dal server (stesso
  criterio di `canMerge`).
  **La proiezione di default è SENZA credenziali.** `resolveReviewAccounts`
  restituisce le sole colonne di `REVIEW_ACCOUNT_VIEW_KEYS` (id, nome,
  provider, workspace, identità in cache, flag), mai
  `encrypted_credentials`; le varianti `…WithCredentials` restituiscono le
  righe intere e servono SOLO a chi si autentica con l'account — il worker che
  pubblica, la fotografia e il webhook, che decifrano le credenziali per
  risolvere un'identità non ancora salvata (`resolveProviderUserId`). Il
  risultato di una `…WithCredentials` non si serializza mai. Chi aggiunge un
  consumatore che deve solo LEGGERE usa la proiezione.
  **`reviewScopeKey` è una regola sola, gemella dell'indice della 0082.**
  L'ambito di un account — `(provider, workspace se Bitbucket altrimenti
  '')`, con un workspace NULL uguale a `''` — sta in
  `packages/shared/src/review-scope.ts` (in shared e non in notifications
  perché la usa anche la SPA, per chiedere conferma prima di sostituire il
  predefinito dello stesso ambito; notifications la ri-esporta) e nell'indice
  `git_accounts_default_reviewer_scope_uq`
  (`packages/db/drizzle/0082_default_reviewer.sql`). Su GitHub il workspace
  non conta, come in `checkReviewAccount`. Il test di accordo è
  `packages/notifications/src/review-account.test.ts` («7. indice e
  reviewScopeKey d'accordo»): contro un Postgres vero, l'indice rifiuta due
  predefiniti ESATTAMENTE quando la funzione li mette nello stesso ambito. Chi
  cambia l'una cambia l'altro, e anche le due gemelle SQL che filtrano per
  ambito (`defaultsInScopeOf` in `review-account.ts`, `sameReviewScope` in
  `git-accounts.ts`).
  **Account propri = principale + revisore EFFETTIVO, e c'è una FINESTRA nota
  (D6 del piano `docs/plans/2026-10-01-default-reviewer-and-scopes.md`).** La
  regola si valuta all'arrivo del webhook, non alla pubblicazione della review:
  se qualcuno cambia il predefinito fra le due, l'evento viene valutato con la
  configurazione NUOVA e l'account che ha pubblicato può non risultare più
  proprio. È accettata perché il cambio è raro, lo fa chi ha `git_accounts.manage`, e nel caso
  peggiore parte UNA correzione, sotto tetto e budget. **Non va chiusa
  allargando gli account propri a tutti i predefiniti dell'istanza**: cambia
  la semantica — un account che su quella repository non pubblica niente
  entrerebbe nel fail-closed (una sua identità non risolvibile scarterebbe
  ogni «Request changes» della repository) senza chiudere nessun ciclo, perché
  il ciclo nasce solo dall'account con cui Stubwise pubblica su QUELLA
  repository. Il ragionamento esteso è nel docblock di
  `resolveReviewAccounts`. La restringe la firma, qui sotto.
  ⚠️ Rollback: questa regola vive nel server E nel worker, e devono essere
  della stessa versione finché esiste un predefinito — vedi la voce di deploy
  «Revisore predefinito e scope di Validate».
- **Le review di Stubwise sono FIRMATE, e la firma esclude a prescindere
  dall'autore (1 ott 2026).** `packages/shared/src/review-signature.ts`
  genera (`signReviewBody`, usata da `publishReview` nel worker) e riconosce
  (`hasStubwiseReviewSignature`) la riga `_— Stubwise PR Review ·
  \`<sha7>\`_`, una accanto all'altra perché non divergano. Il
  riconoscimento è STRETTO: firma intera, su una riga sua, ancorata in fondo
  al corpo, sha esadecimale di 7 caratteri — non una parola chiave, così un
  commento umano che nomina Stubwise o cita la firma in mezzo resta feedback.
  Due punti la guardano, qualunque sia l'autore: la fotografia dei commenti
  (`selectProviderFeedback`, `packages/notifications/src/pr-correction-feedback.ts`),
  che così chiude anche il caso del PASSATO della finestra qui sopra (una
  review di un predefinito precedente nella prima correzione di una PR, che
  non ha taglio), e il webhook (`handleChangesRequested`, passo 2a, PRIMA
  degli account propri e senza rete), dove restringe la finestra **solo su
  GitHub**: l'evento Bitbucket non porta il testo della review (`reviewBody:
  null`). **È il verso sicuro**: un errore di riconoscimento può solo
  TOGLIERE. Chi incolla la firma in fondo al proprio «Request changes» su
  GitHub viene scartato come `own_account` **senza commento di sistema sul
  ticket** — a differenza di `identity_unresolved`, questo scarto è muto — e
  perde la sua richiesta; nessuno può far ENTRARE niente per via della firma.
  Chi allenta il riconoscimento (una parola chiave, la firma ovunque nel
  testo) trasforma un commento umano qualunque in uno scarto silenzioso.
- **Validate chiede gli scope del RUOLO, e il ruolo lo calcola il server (1 ott
  2026).** Su Bitbucket `POST /api/git-accounts/:id/validate` confronta gli
  scope CONCESSI (header `x-oauth-scopes` della chiamata che già fa) con
  `bitbucketRequiredScopes({ primary, reviewer })`
  (`packages/git/src/bitbucket-scopes.ts`): `primary` = principale di almeno
  una repository, `reviewer` = revisore EFFETTIVO di almeno una (via
  `resolveReviewAccounts`) **oppure** marcato predefinito anche senza
  repository nel suo ambito (`accountReviewRole`); nessuno dei due → l'insieme
  del principale, il più esigente. Un revisore non si vede chiedere i webhook.
  Una credenziale che non dichiara gli scope (header `x-oauth-scopes` assente
  o VUOTO, o `x-credential-type` diverso da `api_token`: tipicamente un'app
  password legacy) dà un check
  «Scope del token» **`ok: true`** col testo «non verificabili…»: `ok: false`
  la lascerebbe rossa per sempre per un fatto che nessuna azione dell'utente
  cambia. Il check non afferma che gli scope ci siano: lo dice nel testo. Chi
  lo trasforma in un ko «per prudenza» rompe Validate per ogni app password.
- **Una correzione non forza MAI il push.** `runCorrection`
  (`apps/worker/src/pipeline/correction.ts`) chiama `mirrors.pushBranch` SENZA
  `{ force: true }` — l'opzione esiste, ma la usa solo la PR di setup del
  grafo, su un branch tutto suo. Il push sul branch della PR è sempre in
  avanti: se qualcuno ha pushato nel frattempo il push è rifiutato
  (`PushRejectedError`) e la correzione fallisce dicendolo — la prossima
  riparte dal branch aggiornato; mai un `--force`, mai un rebase automatico.
  Stubwise corregge solo la PR che ha aperto per QUEL ticket (branch
  `stubwise/ticket-<numero del ticket>` e stesso numero di PR), mai il branch
  di una PR scritta da una persona **se non dopo un'ADOZIONE esplicita di un
  maintainer** (6 ott 2026, vedi «Adottare una PR aperta da altri» qui
  sotto) — e il push resta SEMPRE in avanti anche lì. Prima del push lo stato
  della PR si ricontrolla: chiusa o mergiata, niente push e job `skipped`
  (errore dell'API → si pusha comunque, fail-open: il push è in avanti e sul
  branch della PR, perdere il lavoro per un errore transitorio costa di più;
  su una PR adottata la stessa lettura dice anche dove sta il branch, e un
  fork o un branch cambiato fermano il push). E
  se l'agente ha committato da sé (la head del worktree non è più quella di
  partenza), niente push: quei commit non sono passati dalle esclusioni di
  `commitAsStubwise` (env, report).
- **Il contatore dei giri si DERIVA, non si salva.** È il numero di
  correzioni `trigger = 'review'` (non `cancelled`) sulla PR create dopo
  l'ultima richiesta umana (`stubwise`/`provider`, anche se ancora `pending`:
  la tornata nuova comincia quando una persona CHIEDE), ed è scritto in UN
  posto solo, `autoRoundsInCurrentSeries`
  (`packages/notifications/src/pr-correction-cycle.ts`), che server e worker
  condividono. Una colonna «giro corrente» andrebbe fuori sincrono al primo
  crash. Allo stesso modo lo stato mostrato sul ticket (`cycle`,
  `derivePrCycle`) lo calcola il SERVER: web e app lo mettono solo in parole,
  il bottone lo accende `canRequestCorrection` e «Riprendi» `canResume` +
  `heldJobId` — mai una regola ricopiata nel client (stessa ragione di
  `canMerge`).
- **Una correzione non è un piano nuovo, e per questo non passa dal gate.**
  La chiede chiunque possa lanciare un run sul ticket, operatore compreso
  (`planApprovalRequired: false` sempre), e «I due divieti dell'operatore»
  restano veri: la riga del gate in `jobs.ts` e `resolvePlan`/
  `preApprovePlan`/`revokePlanApproval` non sono stati toccati. L'unico ramo
  nuovo di `startRun` che non passa dal gate è la forzatura del job `held` di
  una correzione (stesso job, `correction_id` intatto): riprende una
  correzione, non esegue un piano. Il job TERMINALE di una correzione invece
  non si ricicla mai: un rilancio crea un fix nuovo. Il limite va saputo: una
  nota ampia la contiene il prompt della correzione («applica il feedback su
  questa PR, non riprogettare»), non un permesso — la stessa esposizione che
  chiunque ha già con «Request changes» sulla piattaforma, e la verificano
  solo gli scenari golden (`correction`). **Il dispatch passa da
  `ai_jobs.correction_id`, non da un valore di `resume_mode`**: un valore
  dimenticato in `resolveFixMode` degrada in silenzio a un fix completo che
  riparte dal default. Chi aggiunge un tipo di run «che lavora su una PR
  esistente» lo faccia passare da lì.
- **Il budget di una correzione lo scavalca solo chi ha `plans.approve`, e il
  client non lo deduce (1 ott 2026, sui permessi dal 22 ott 2026).**
  `manualTrigger` scavalca gate di automazione E budget mensile: è una
  decisione di SPESA, come l'approvazione del piano. Una sola regola,
  `correctionManualTrigger(actorPermissions)`
  (`packages/notifications/src/pr-correction-cycle.ts`), vera SOLO con
  `plans.approve` nel progetto del ticket (un full admin ce l'ha ovunque) — la
  decide CHI AGISCE ORA, non il trigger della riga né chi l'aveva avviata: il
  bottone di chi non ha il permesso (`Legacy Member`, `Developer`), il ciclo
  automatico, il «Request changes» della piattaforma e ogni promozione senza
  attore danno `false` e si fermano al budget (`held`, col commento
  `comment.correctionBudgetHeld`). La stessa regola decide il budget dei turni
  di refinement (ruling R41). Il divieto vale **anche in lettura**: chi può
  riprendere una correzione ferma lo dice `cycle.canResume`, calcolato dal
  SERVER coi permessi di chi guarda (`canResumeCorrection`: con
  `plans.approve` sempre, senza solo se il motivo non è `budget`), e
  `startRun` (`apps/server/src/services/jobs.ts`) applica la stessa funzione
  prima di scrivere (`needs_maintainer`). Test a due utenti sugli stessi dati
  in `pr-correction-cycle.test.ts` (e `correctionManualTrigger: vero SOLO con
  plans.approve`), come per `canMerge`.
- **Job e correzione si chiudono INSIEME.** `completeJob`/`failJob` e
  `completeCorrection` stanno in UNA transazione (`closeJobAndCorrection`,
  `pipeline/correction.ts`), e la correzione passa a `done` solo se il job era
  ancora nostro (il booleano di ownership). Ciò che segue una chiusura —
  promozione della `pending`, review riaccodata, notifiche — parte solo se la
  chiusura è avvenuta. Chi «semplifica» in due statement riapre il caso di una
  correzione `queued` con il job già terminale: l'indice unico blocca la PR.
  Per i percorsi che chiudono un job da fuori (un'eccezione nel handler, il
  recovery degli stantii, un rollback a mano) c'è comunque la rete:
  `reconcileOrphanCorrections` chiude nel tick le `queued` il cui job è
  terminale o sparito.
- **Un lavoro per ticket, richieste in fila per PR — e una `pending` ha
  sempre un punto di promozione.** Il job che blocca è UNO per ticket
  (`jobBlocksCorrection`: in volo, o `held` di QUALUNQUE tipo — una correzione
  parcheggiata sulla PR A ferma anche la B, e un fix `held` le ferma tutte),
  mentre le richieste in fila sono per PR (indici unici parziali). Per
  QUALUNQUE verdetto di una review (`review/cycle.ts`, anche una review
  fallita) si promuove la pending di QUESTA PR; quelle di altre PR del ticket
  partono dopo il giro automatico o dal tick. La fine di un lavoro sul ticket
  — fix aperto, fix `failed`/`skipped` nel handler, correzione chiusa — chiama
  `promotePendingForTicket` (per ticket, non per PR); la chiusura della PR
  (webhook) annulla la coda e poi chiama anch'essa `promotePendingForTicket`,
  fuori dalla transazione. Il tick del worker (`apps/worker/src/queue.ts`,
  sulla cadenza di `requeueStale`) fa da rete con DUE passi in quest'ordine:
  `reconcileOrphanCorrections` (le `queued` orfane del loro job → `done`),
  poi `promoteStalePendings` (le `pending` dei ticket su cui nessun job blocca
  più). Un giro automatico bloccato dal lavoro su un'altra PR del ticket non
  si perde: diventa una `pending` `trigger='review'`, che conta come giro. Chi
  aggiunge un esito terminale nuovo lo faccia passare da
  `promotePendingForTicket`; chi toglie il tick lascia ferme le pending di
  altre PR dopo un'approvazione, e le correzioni orfane `correcting` per
  sempre.
- **Il rilancio generico non tocca una correzione ferma (1 ott 2026).** «Avvia
  fix»/«Rilancia con istruzioni» sul web (`latestJobIsHeldCorrection`,
  `routes/tickets/$id.tsx`) e il bottone di run dell'app (`RunWorkButton`,
  `isHeldCorrectionJob` in `apps/mobile/src/lib/pr-cycle.ts`) **spariscono**
  quando l'ultimo job è quello che un ciclo dichiara fermo (`heldJobId`):
  l'unica azione è il «Riprendi» della riga della PR, che manda
  `resumeCorrectionJobId`. Il motivo: un run-ai SENZA quel campo da una
  schermata vecchia — correzione nel frattempo annullata o riconciliata —
  avvierebbe un FIX COMPLETO NUOVO, che per chi ha `plans.approve` supera il budget; con il
  campo il server risponde 409 `correction_not_held` senza scrivere niente.
  ⚠️ **Rischio residuo accettato**: «Rilancia» dall'inbox e da Slack chiama
  ancora `startRun` senza `resumeCorrectionJobId`, quindi lì quella porta resta
  aperta. Se un giorno servirà chiuderla, la strada è NON offrire l'azione o
  passare l'intento derivato a lettura, non un codice d'errore nuovo.
- **La review «in attesa» esiste dal claim, e si riaccoda all'avvio perché il
  worker è UN processo.** Il poller reclama il job (`DELETE … RETURNING` su
  `pr_review_jobs`) e nella STESSA transazione crea la riga `pr_reviews`
  `running` con `started_at` NULL; `runPrReview` la marca partita quando
  parte davvero. Senza, per tutta l'attesa nel serializer di progetto (fino a
  ~139' dietro un fix) il ciclo della PR si leggeva `idle`, col bottone della
  correzione acceso. Il recovery degli stantii guarda solo le PARTITE (una in
  attesa non ha heartbeat); una riga in attesa la cancella il poller dopo il
  run (`dropIfNeverStarted`) o, all'avvio del worker,
  `requeueWaitingReviews` la rimette in `pr_review_jobs` e la cancella nella
  stessa transazione — se ha `source_branch`/`target_branch`; senza quei
  metadati (una riga non nata dal claim nuovo) la chiude `failed`. ⚠️ Quel riaccodamento presuppone che **nessun altro
  processo** abbia quella review nella sua catena in memoria — la stessa
  assunzione del serializer (`handler.ts`). Con due processi worker, l'avvio
  del secondo farebbe girare due volte le review in attesa del primo: va
  rivisto INSIEME al serializer, il giorno in cui il worker diventasse
  multi-processo. E chi legge `pr_reviews` per un verdetto filtri
  `started_at IS NOT NULL` come fa `listReleaseQueue`: una riga in attesa non
  deve nascondere la review precedente.
- **Una sola regola di correggibilità** (era «una sola regex dei branch dei
  fix», fino al 6 ott 2026): `isCorrectablePr` di `@stubwise/shared`
  (`packages/shared/src/stubwise-branch.ts`) — il branch `stubwise/ticket-<N>`
  del ticket stesso (`STUBWISE_BRANCH_RE`/`stubwiseTicketNumber`, accanto),
  OPPURE una riga `ticket_repositories` adottata e non rilasciata. La usano
  `derivePrCycle`, `enqueueCorrection` (riletta SOTTO il lock:
  `pr_not_correctable`, così un «Smetti di correggere» e un «Request changes»
  in volo non lasciano una correzione su una PR restituita), la rotta delle
  correzioni, il webhook «Request changes» (che trova la riga per repository e
  branch, poi applica la regola), la review (giro automatico, promozione dopo
  una review fallita, avviso del ciclo fermo) e `runCorrection`. La regex da
  sola resta solo dove si cerca il ticket DEL FIX (`resolveTicket`, il ramo di
  chiusura dei ticket del fix nel webhook) o si nomina il branch di un fix
  (`fix.ts`). Una copia locale è come `derivePrCycle` arrivò a mostrare il
  bottone su `stubwise/graphify-setup` mentre la rotta rispondeva 409.
- **Adottare una PR aperta da altri (6 ott 2026) — chi, quale, dove.** Solo
  chi ha `prs.adopt` nel progetto (escluso da `Legacy Member`, ruling R3):
  `config.access` con `prs.adopt` sulla rotta E `if
  (!actor.permissions.has("prs.adopt")) return { ok: false, error:
  "forbidden" }` dentro `adoptPullRequest`/`releaseAdoption`
  (`apps/server/src/services/pr-adoption.ts`), test negativi che asseriscono
  sulle righe (`apps/server/src/routes/adoption.test.ts`); il bottone lo
  accende `prAdoption.canManage` (`prs.adopt` di chi guarda), calcolato dal
  server — mai dedotto dal client. Mai una PR su cui Stubwise non può scrivere in
  sicurezza, verificato DAL PROVIDER all'adozione (`getPullRequestInfo`),
  fail-closed: un fork, un fork NON VERIFICABILE (repository sorgente assente:
  il nome del branch, da solo, non dice DOVE sta — una PR da fork su `main`
  porterebbe il push sul `main` del repository), un branch `stubwise/…`, il
  branch di default o il target della PR, e un **branch PROTETTO** della
  repository (7 ott 2026: elenco configurato nel form della repository da
  chi ha `repos.manage`, nomi esatti o `*` finale come prefisso — `develop`,
  `release/*`). La regola dei protetti è UNA, `isProtectedBranch`
  (`packages/shared/src/protected-branches.ts`, con
  `protectedBranchesInputSchema` che normalizza e valida l'input): la usano il
  rifiuto dell'adozione (422 `protected_branch`), il motivo del bottone spento
  (`loadPrAdoption`) e il worker PRIMA del worktree e PRIMA del push,
  rileggendo l'elenco dal database (fail-closed: un branch diventato protetto
  dopo l'adozione, anche a correzione in corso, la ferma senza push). La
  conferma dell'adozione (web e app) mostra IN EVIDENZA il branch su cui
  andranno i commit, col nome dato dal server (`prAdoption.branch`); se non è
  noto lo dice in modo neutro, e il server rifiuta comunque i casi vietati.
  **Chi fa cosa su una PR adottata**: adotta e rilascia solo chi ha
  `prs.adopt`; anche «Chiedi modifiche» in Stubwise e la ripresa di una
  correzione ferma chiedono `prs.adopt` (7 ott 2026, ruling R16) — una
  regola, `correctionActionAllowed(actorPermissions, row)`
  (`packages/notifications/src/pr-correction-cycle.ts`: su una PR adottata e
  non rilasciata vuole `prs.adopt`), usata da `derivePrCycle`
  (`canRequestCorrection`/`canResume`, letti dai client), da
  `requestCorrection` (403 `adopted_pr_admin_only`: il codice ha tenuto il
  nome storico, il controllo è sul permesso), da `enqueueCorrection` sotto il
  lock e da `startRun` (`needs_maintainer` sulla ripresa). Invariati: le PR
  che Stubwise apre per i suoi ticket (chiede modifiche chi ha
  `corrections.request`, come i member di prima), il «Request changes» della piattaforma (filtrato dal permesso di
  scrittura lassù), il ciclo automatico, tetto e budget.
  **Branch diventato protetto DOPO l'adozione (7 ott 2026)**: una regola sola,
  `isAdoptedBranchProtected` (`packages/shared/src/protected-branches.ts`:
  adottata, non rilasciata, branch fra i protetti della sua repository).
  `enqueueCorrection` la applica SOTTO il lock a OGNI trigger — click, giro
  automatico, «Request changes» della piattaforma — e rifiuta
  `adopted_branch_protected` senza scrivere niente; `requestCorrection` la
  anticipa (409 `adopted_branch_protected`), `startRun` la applica alla
  ripresa di una correzione ferma (409, PRIMA del controllo sul permesso:
  nessuno può riprenderla, e «la riprende un maintainer» sarebbe falso), il webhook
  della piattaforma scrive l'avviso deduplicato sul ticket
  (`comment.changesRequestBranchProtected.*`, quarto motivo di
  `postDroppedRequestNotice`, il branch nella riga del motivo e mai nel
  titolo) e `derivePrCycle` spegne `canRequestCorrection`/`canResume` con
  `cycle.blockedReason = "adopted_branch_protected"` (`.default(null)`, web
  `?? null`), che web e app mostrano. Il worker resta la difesa in profondità
  (rilettura prima del worktree e prima del push) e fallisce col messaggio
  SUO, `AdoptedBranchProtectedError` («il branch `<nome>` è protetto in questa
  repository: Stubwise non ci pusha…»): non è un mismatch — la PR è ancora su
  quel branch, e dire «non è più sul branch» era falso. Una `pending` nata
  PRIMA della protezione può ancora essere promossa: la ferma il worker, che
  la annulla come per il mismatch. Il mirror lo ripete per
  costruzione: `MirrorManager` accetta un branch fuori da `stubwise/` SOLO con
  l'opzione esplicita `adopted` (`apps/worker/src/git/mirrors.ts`), e con lei
  rifiuta `force` e il default branch e apre il worktree solo dalla head del
  branch. Chi tocca quel controllo sappia che la protezione di
  `pushBranch(..., { force: true })` è il namespace `stubwise/`. Il commento
  sulla PR all'adozione e al rilascio è un template i18n
  (`prComment.adopted`/`prComment.adoptionReleased`), scritto con l'account
  PRINCIPALE: un «Request changes» di quell'account è `own_account`, e la
  fotografia dei commenti lo esclude — l'adozione non si auto-innesca
  (`webhooks.corrections.test.ts`). **Un ticket `review` non avvia un fix**:
  `startRun` risponde `review_ticket_not_runnable` salvo la forzatura di una
  correzione ferma, perché con l'adozione un ticket review ha job di
  correzione e il «Rilancia» di un `job.failed` (inbox, Slack, MCP)
  avvierebbe un fix dal default; il web toglie il rilancio sui ticket review.
  **La chiusura della PR (mergiata o no) RILASCIA l'adozione**
  (`releaseAdoptionsOnPrClose`, nel webhook prima dell'annullamento della
  coda, con un commento di sistema `comment.prAdoptionReleasedOnClose`): una
  PR riaperta torna a chi l'ha aperta e va affidata di nuovo — mai il ciclo
  che riparte da solo su un ticket review chiuso. Per difesa in profondità
  `reopenPrRows` salta le righe adottate e non rilasciate, e `loadPrAdoption`
  non dice mai `adopted` per una PR non aperta. Se l'ultima review APPROVA,
  l'adozione non accoda nessuna correzione (`reviewApproved` nella risposta,
  e web/app lo dicono): il ciclo partirà alla prossima richiesta di modifiche.
  Il rilascio non cancella la riga: la marca, annulla la coda
  (`cancelOpenCorrections` con la sua riga di log) e lascia i commit già
  pushati; una correzione in volo si ferma prima del push e rimette lo
  status `stubwise-review` com'era (`restoreStatus`); la riga resta finché la PR esiste, quindi la PR compare ancora fra
  quelle che aspettano il merge nel polso e nella coda di rilascio (con
  `origin: external`).
- **Il webhook «Request changes» non legge i commenti della PR, e scarta le
  riconsegne.** La fotografia la rifà il worker all'avvio della correzione
  (`refreshProviderFeedback`); il webhook salva solo il testo della review e
  risponde subito. Le ritrasmissioni del provider (stesso
  `X-GitHub-Delivery`/`X-Request-UUID`) si scartano in memoria per 5 minuti
  (`createDeliveryDedupe`); dietro c'è la difesa per PR di `enqueueCorrection`
  (stessa richiesta dallo stesso autore entro `REDELIVERY_WINDOW_MINUTES`,
  30': nessuna riga nuova). Senza, diventerebbero una seconda correzione
  identica. Chi ci rimette la lettura dei commenti rende il webhook lento
  quanto basta a farle arrivare. E una lettura dei commenti FALLITA non fa da
  taglio: solo una fotografia con `feedback_complete = true` sposta il punto
  da cui si leggono i commenti nuovi, altrimenti quelli mai letti verrebbero
  saltati per sempre.
- **Staleness: la correzione non sposta `WORKER_STALE_MINUTES`, ma ha DUE
  heartbeat.** I 3 punti della voce `WORKER_STALE_MINUTES` qui sopra restano
  150 / invariante > 149 (139' più i 10' del tetto della pausa, «Sessioni
  degli agenti» qui sotto): la correzione è un sottoinsieme stretto dei termini
  del fix sugli stessi parametri (niente triage né piano, un solo run +
  install + self-repair: 110' coi default), conto scritto nel docblock di
  `assertStaleInvariant` (`apps/worker/src/index.ts`). Ma a differenza del fix
  ha un tratto PRIMA del worktree — la rilettura dei commenti della PR:
  identità, pagine, fino a 20 verifiche di permesso
  (`MAX_PERMISSION_LOOKUPS_PER_SNAPSHOT`), chiamate HTTP del provider — e quel
  tratto ha un heartbeat suo (attorno a `refreshProviderFeedback`), perché
  nessun conto sui timeout potrebbe dargli un tetto. Chi sposta altro lavoro
  di rete prima del worktree lo metta dentro un heartbeat, non nel margine.
  La review usa la stessa soglia ma solo sulle review PARTITE: l'attesa nel
  serializer non entra nel conto.
