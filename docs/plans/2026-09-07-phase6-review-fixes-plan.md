---
title: Fase 6 — fix di review prima del merge
date: 2026-09-07
design: 2026-09-07-phase6-google-mail-calendar-design.md
plan: 2026-09-07-phase6-google-mail-calendar-plan.md
stubwise:
  project: stubwise
  backlog: a03a1621-6a9f-44d8-b0ec-631ee3d21cbf
---

# Fase 6 — fix di review prima del merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> Lavora nel worktree esistente `.worktrees/phase6-google-mail-calendar`
> (branch `feature/phase6-google-mail-calendar`, PR #12, HEAD `85ddd5f`).
> **Non** mergiare e **non** deployare. Alla fine: push, CI verde (incluso
> E2E), report con HEAD e link al run. Le posizioni `file:riga` sono di HEAD
> `85ddd5f`.

**Goal:** chiudere i findings della review indipendente (quattro revisori:
deploy/compatibilità, sicurezza OAuth, poller/classificazione,
proposte/regressioni). Tre sono difetti certi (build del worker, perdita di
messaggi, messaggio orfano), due toccano la privacy dichiarata dal design.

**Convenzioni**: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
typecheck` prima dell'ultimo commit.

---

### Task 1: Dockerfile del worker — `packages/google` nel layer dell'install (blocca il deploy)

**Finding**: `apps/worker/Dockerfile:33-38` copia i `package.json` di db,
shared, git, sdk, notifications, i18n ma **non** `packages/google`, mentre
`apps/server/Dockerfile:42` e `Dockerfile.caddy:41` sì. Il worker importa
`@stubwise/google` (`apps/worker/package.json:21`), che ha deps proprie
(`drizzle-orm`, `zod`): il build dell'immagine worker fallisce in `tsc` su
`@stubwise/google` senza `node_modules`. Verificato da due revisori.

**Files:** `apps/worker/Dockerfile:38` (aggiungi `COPY packages/google/package.json packages/google/package.json`).

**Verifica**: `docker build -f apps/worker/Dockerfile -t stubwise-worker-test .` dalla radice del worktree deve riuscire (se Docker non è disponibile sulla tua macchina, dillo esplicitamente nel report: il maintainer lo verificherà al deploy, ma il fix è comunque obbligatorio). Controlla anche che `apps/worker/Dockerfile` copi tutti gli altri package workspace da cui il worker dipende (confronta `apps/worker/package.json` con la lista dei COPY).

**Commit** `fix(worker): packages/google nel layer di install del Dockerfile`.

### Task 2: poller Gmail — il cursore non deve superare messaggi non processati

**Finding**: `apps/worker/src/google/poller.ts:500-510`: nel percorso
incrementale il loop su `history.list` si ferma a `GMAIL_RESYNC_MAX_MESSAGES`
(200) e fa `ids.slice(0, 200)`, ma salva come cursore `page.historyId` (l'id
corrente della casella, non l'ultimo consumato): con più di 200 messaggi
nuovi fra due tick, quelli oltre il 200° non vengono mai più elencati.
Stesso meccanismo a `:578`: `if (deps.signal?.aborted) break` a metà lotto,
poi `runAccountTick:1171` scrive `applyGmailCursor` con `batch.historyId` →
un riavvio del worker durante un lotto salta i messaggi non letti.
`seenHistoryId` (max dei messaggi letti) è già calcolato a `:597`.

**Files:** `apps/worker/src/google/poller.ts:500-510,578,597,1171`; test `poller.test.ts`.

**Step 1: test rosso** — (a) 250 messaggi nuovi in history con
`GMAIL_RESYNC_MAX_MESSAGES = 200`: dopo il tick il cursore è lo `historyId`
del 200° messaggio letto, e il tick successivo elenca i 50 restanti; (b)
abort a metà lotto: il cursore resta quello dell'ultimo messaggio
effettivamente inserito e il tick successivo riprende da lì senza
duplicati (`filterAlreadyIngested`).
**Step 2–4**: rosso → fix (cursore = `seenHistoryId` quando il lotto è
troncato o interrotto; `page.historyId` solo se tutte le pagine sono state
consumate fino in fondo) → verde.
**Commit** `fix(worker): il cursore Gmail avanza solo sui messaggi processati`.

### Task 3: `choose_project` — il messaggio deve poter essere riproposto

**Finding**: `apps/server/src/services/google-proposal.ts:463-466` riassegna
`projectId` e mette `status: "new"` ma NON azzera `proposalNotificationId`
(resta l'id della notifica appena chiusa). La riclassificazione porta la
riga a `classified`, ma la selezione delle righe da proporre
(`apps/worker/src/google/poller.ts:1022-1026`) e il claim di
`publishProposal` (`proposal.ts:565-572`) esigono `proposal_notification_id
IS NULL` → il messaggio resta `classified` per sempre, senza card né
«Riproponi» (ammesso solo su `failed`/`ignored`).

**Files:** `apps/server/src/services/google-proposal.ts:463-466`; test `google-proposal.test.ts:648-680`.

**Step 1: test rosso** — dopo `choose_project`: `proposalNotificationId === null`; e un test di integrazione leggero: riclassificazione + `publishProposal` sullo stesso messaggio riesce (nuova notifica).
**Step 2–4**: rosso → fix → verde.
**Commit** `fix(proposals): choose_project azzera la notifica precedente, il messaggio viene riproposto`.

### Task 4: privacy — nessun webhook d'istanza per le proposte `mailbox_owner`

**Finding**: `packages/notifications/src/publish.ts:87,143-147`: per
`google.proposal` nasce una delivery `webhook` se `shouldSendWebhook` è
vero, e `notify_google_proposal` ha default `true`. Il payload porta
`from`, `subject`, `question`, `options` all'URL webhook d'istanza (in prod
ne esiste uno: un canale Slack/Discord condiviso leggerebbe oggetto e
mittente della casella di un collega). Nasce anche con 0 destinatari.
Contraddice l'invariante «solo il proprietario della casella».

**Decisione**: il webhook d'istanza **non riceve mai** eventi con audience
`mailbox_owner`, indipendentemente dal toggle. Il toggle
`notifyGoogleProposal` viene **rimosso** da UI, schema di risposta e body
delle impostazioni (la colonna resta, innocua; niente migrazione).

**Files:** `packages/notifications/src/publish.ts:143-147` (guardia su `audienceFor(kind) === "mailbox_owner"` → nessuna delivery webhook), `dispatch.ts` (`shouldSendWebhook` → false per quell'audience, così anche `sendWebhookEvent` diretto non lo manda; `TOGGLE_FOR_KIND` può restare mappato ma inerte con commento), `apps/server/src/routes/settings.ts:102,150` e `apps/web/src/components/notifications-section.tsx:45` (rimozione del toggle), i18n, `CLAUDE.md` (invariante: «un evento `mailbox_owner` non esce mai dal perimetro del proprietario: inbox, DM Slack e push suoi; mai webhook d'istanza»).
**Test**: `publish.test.ts` (proposta con webhook configurato → 0 delivery webhook; con 0 destinatari → 0 delivery in assoluto), `dispatch.test.ts`, `settings.test.ts`.
**Commit** `fix(notifications): le proposte della casella non escono mai sul webhook d'istanza`.

### Task 5: sicurezza OAuth — tre ritocchi

**Findings**:
- (a) `apps/server/src/index.ts:25` `logger: true`: il serializer `req` logga l'URL con la query, quindi `GET /api/me/google/callback?code=…&state=…` scrive il codice OAuth nei log di prod (valido ~10' se lo scambio fallisce).
- (b) `services/google-oauth.ts:335-338` usa `userinfo.email` senza controllare `emailVerified` (`packages/google/src/oauth.ts:229` lo espone).
- (c) `google-oauth.ts:362-371`: upsert su `email` con `user_id` nel SET: se l'utente B collega una casella già collegata da A, la riga (e la storia di `email_messages`/`calendar_events`) passa a B in silenzio.

**Files:** `apps/server/src/index.ts` o `app.ts` (serializer `req` che tronca la query per il path del callback, oppure `config.disableRequestLogging` sulla sola rotta + un log applicativo senza `code`), `services/google-oauth.ts` (esito `email_not_verified`; su email già collegata da un ALTRO utente → esito `mailbox_owned_by_other` senza scrittura, nessun trasferimento silenzioso), `apps/web` (testi dei due esiti nuovi), i18n.
**Test**: il log della richiesta al callback non contiene `code=` (spia sul logger); `emailVerified: false` → redirect con l'esito e nessuna riga; casella di A ricollegata da B → esito `mailbox_owned_by_other`, riga invariata; da A stesso → riattivata.
**Commit** `fix(oauth): niente codice nei log, email verificata obbligatoria, casella altrui non trasferibile`.

### Task 6: rifiniture

- `packages/notifications/src/email-routing.ts:189`: keyword come substring (`api` combacia con «capitale»). Validazione lato server: lunghezza minima 3 e match su **confine di parola** (Unicode-aware) per le keyword; test.
- `packages/shared/src/reader.test.ts`: test dedicato a `.catch()` (un enum sotto `.catch()` viene aperto a `UNKNOWN` e il valore di catch si riapplica), accanto a quello di `.default()` (riga 106).
- `apps/worker/src/google/poller.ts:764-770`: dopo un 410 il resync gira con `showDeleted: false`: righe aperte su eventi cancellati nel frattempo restano candidate. Nel resync passare `showDeleted: true` e marcare `cancelled` le righe corrispondenti; test.

**Commit** `chore(google): keyword su confine di parola, test del catch nel reader, cancellazioni nel resync`.

### Task 7: push, CI verde, report

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` nel worktree → verde.
2. `graphify update .` e commit del grafo se serve; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report al maintainer: HEAD finale, link al run, conferma dei sette task, esito del build Docker del worker (riuscito, o «Docker non disponibile»), eventuali test flaky con i nomi.

---

## Fuori da questo piano (backlog, non ora)

- Dashboard Usage: i costi della classificazione email (e della PR review, gap preesistente) non compaiono: 4 query in `usage-costs.ts` da rivedere (segnalato dall'agente).
- Batch API Gmail per ridurre le chiamate per tick (oggi 1 `metadata` per messaggio nuovo + 1 `full` per messaggio in perimetro, sequenziali; sotto la quota ma lento sul primo giro).
- `domain_mismatch` esatto: `mail.thecove.it` non passa se il registro ha `thecove.it`; valutare i sottodomini o l'uso dell'`hd` di `userinfo`.
- `settings.ts:102` espone campi obbligatori nello schema di risposta admin: innocuo (server e caddy si ribuildano insieme), ma la regola dei campi opzionali vale anche lì.
