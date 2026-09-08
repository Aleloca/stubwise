---
title: Fase 6b — Un'email, più progetti — piano di implementazione
date: 2026-09-08
design: 2026-09-08-phase6b-multi-project-email-design.md
stubwise:
  project: stubwise
  backlog: 7053e669-10f0-4f61-8895-929e560024f4
---

# Fase 6b — Un'email, più progetti: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: `/stubwise:start` sulla voce di backlog nel
> frontmatter del design doc. Worktree `feature/phase6b-multi-project-email`.
> Alla fine: `git merge origin/main`, push, CI verde (incluso E2E), PR verso
> main; merge e deploy li fa il maintainer. **La fase 6 è già in produzione**:
> ogni cambiamento deve reggere righe già esistenti (oggi zero messaggi
> ingeriti, ma la migrazione deve essere corretta comunque).

**Goal:** un'email che parla di più progetti genera **una proposta per
progetto**, ciascuna con opzioni e ciclo di conferma indipendenti. Oggi ne
genera al massimo una, su un progetto solo, e il resto va perso in silenzio.

**Architecture:** tabella figlia `email_proposals` con stato e claim per riga
(pattern di `notification_deliveries`) e unique sulla coppia con stato del
padre derivato (pattern di `ticket_repositories`); il perimetro dei progetti
sostituisce il singolo vincitore nell'insieme ammesso della classificazione;
la partizione per progetto si fa nel codice, non chiedendola al modello. Il
calendario resta uno a uno.

**Tech Stack:** Drizzle + Postgres, worker (poller Gmail e classificazione),
Fastify, React SPA, `packages/notifications`, `packages/shared`.

**Convenzioni (ereditate)**: TDD; commit piccoli in italiano; `pnpm --filter
@stubwise/<pkg> exec vitest run <pattern>`; migrazioni SQL a mano + journal;
i18n backend en+it con parità; `pnpm -r build` dopo `packages/*`; `pnpm lint`
prima del merge; campi nuovi negli schemi di risposta sempre opzionali con un
test che parsa senza il campo; il modulo che scrive nel registro decisioni non
importa mai esecutori AI (`decisions-never-ai.test.ts`).

---

## Fase A — Schema e routing

### Task 1: migrazione 0070 e schema

**Files:**
- Create: `packages/db/drizzle/0070_email_proposals.sql`; Modify: `meta/_journal.json` (idx 70)
- Modify: `packages/db/src/schema.ts` (tabella `emailProposals` come da design §3; `emailMessages.scopeProjectIds uuid[] NOT NULL default '{}'`)
- Test: `packages/db/src/email-proposals.test.ts` (unique sulla coppia; CHECK dello stato; cascade dal messaggio e dal progetto; indice parziale usato dal claim)

SQL: nessun valore di enum nuovo, quindi un solo batch. Ordine: `ALTER TABLE
email_messages ADD COLUMN scope_project_ids uuid[] NOT NULL DEFAULT '{}'` →
`CREATE TABLE email_proposals (…)` → FK → unique → indice parziale →
**backfill**: per ogni `email_messages` con `status IN ('classified',
'proposed')` e `project_id IS NOT NULL`, una riga figlia che eredita
`classification`, `status` e `proposal_notification_id`; e
`scope_project_ids = array_remove(ARRAY[project_id] || candidate_project_ids,
NULL)` per tutte le righe.

**Step 1: test rosso** → **Step 2–4**: schema → PASS (`pnpm --filter @stubwise/db test`, `pnpm -r build`).
**Step 5: Commit** `feat(db): migrazione 0070 — proposte email per progetto`.

### Task 2: routing con perimetro completo

**Files:**
- Modify: `packages/notifications/src/email-routing.ts` (`matchRoutes` restituisce anche `scopeProjectIds`: tutti i progetti con `matchedRuleCount > 0`, ordinati per conteggio decrescente e poi per id per determinismo; `projectId` vincitore e `candidateProjectIds` invariati)
- Modify: `apps/worker/src/google/poller.ts` (persiste `scope_project_ids` all'insert del messaggio)
- Test: `email-routing.test.ts` (tre progetti in perimetro con conteggi 2/1/1 → vincitore il primo, `scopeProjectIds` tutti e tre; nessuna regola → perimetro vuoto e messaggio fuori; parità invariata), `poller.test.ts`

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(routing): il perimetro elenca tutti i progetti che combaciano`.

## Fase B — Classificazione per progetto

### Task 3: contesto e insieme ammesso per progetto

**Files:**
- Modify: `apps/worker/src/google/classify.ts`: `allowed` (riga ~385) = `scopeProjectIds` con fallback a `[projectId]`/`candidateProjectIds` per le righe vecchie; `loadContext` (~381-469) carica ticket aperti e titoli di backlog **per ciascun** progetto del perimetro (una query per tipo con `IN`, non N query), mappa dei ticket chiavata `(projectId, number)`; `revalidateProposal` (~494-553) valida il ticket contro il progetto **della proposta**, non contro il risolto; cap `CLASSIFY_MAX_PROPOSALS` per progetto, `CLASSIFY_CONTEXT_ROWS` ridotto a 10, nuovo `GMAIL_MAX_PROJECTS_PER_MESSAGE` (default 5, da `apps/worker/src/config.ts`) applicato dopo la partizione, tenendo i progetti con più proposte valide
- Modify: `apps/worker/src/google/classify.ts` `buildEmailSignalsPrompt` (~295-338): elenco dei progetti con il **loro** contesto sotto intestazioni separate; `OUTPUT_SHAPE` invariato (la partizione è nel codice)
- Modify: `packages/i18n/src/catalog.ts` se le istruzioni cambiano (en+it)
- Test: `classify.test.ts` (perimetro di 3 progetti → proposte partizionate; `#3` che esiste in due progetti va a quello giusto; proposta su un progetto fuori perimetro scartata; cap per progetto; tetto sul fan-out con 7 progetti → 5)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(classify): contesto e proposte per progetto, tetto sul fan-out`.

### Task 4: scrittura sui figli e riclassificazione sicura

**Files:**
- Modify: `apps/worker/src/google/classify.ts` (la scrittura finale, ~683-691, diventa: upsert per progetto su `email_proposals` con `ON CONFLICT (email_message_id, project_id) DO UPDATE … WHERE email_proposals.status = 'classified'`; `DELETE` dei soli figli `classified` non più presenti nella nuova partizione; padre: `signal`, `status = 'classified'` se almeno un figlio, `'ignored'` altrimenti, `error: null`; tutto in una transazione)
- Test: `classify.test.ts` (riclassificazione: figlio `proposed` intatto, figlio `classified` obsoleto rimosso, figlio nuovo creato; nessun `DELETE` totale; padre coerente)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(classify): le proposte vivono sui figli, la riclassificazione non tocca le card aperte`.

## Fase C — Pubblicazione ed esecuzione

### Task 5: una card per progetto

**Files:**
- Modify: `packages/notifications/src/format.ts` (`GoogleProposalEvent` += `projectId?: string` **opzionale**; la `question` da template i18n che nomina il progetto), `packages/i18n/src/catalog.ts` (`google.proposal.question.withProject` en+it)
- Modify: `apps/worker/src/google/proposal.ts` (`buildEmailProposalEvent` riceve la riga figlia: progetto certo, niente ramo `choose_project` in generazione — l'azione resta nell'unione e nell'esecutore per le card storiche, con commento di deprecazione; `publishProposal` claima il **figlio**, ordine publish → id → UPDATE guardato invariato; stato del padre calcolato in lettura, non persistito)
- Modify: `apps/worker/src/google/poller.ts` (selezione: join figli `classified` senza notifica con il padre, per casella; il tetto per tick conta proposte; il fallback «evento nullo → ignorato» agisce sul figlio; `projectNamesOf` legge i progetti dei figli)
- Test: `proposal.test.ts` (due figli dello stesso messaggio → due notifiche distinte, `proposalId` diversi, domanda con nomi di progetto diversi; claim del figlio; pubblicazione parallela dei due senza contesa sul padre), `poller.test.ts`, `format.test.ts` (evento senza `projectId` continua a parsare: card storiche)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(proposals): una card per progetto, claim sulla riga figlia`.

### Task 6: esecuzione che chiude solo la propria proposta

**Files:**
- Modify: `apps/server/src/services/google-proposal.ts` (`findSourceRow` cerca prima in `email_proposals` per `proposal_notification_id`, poi in `calendar_events`; `ProposalSource` += `emailMessageId`, `projectId`; `markSourceOutcome`/`markSourceFailed` scrivono sul **figlio** e toccano `updated_at` del padre nella stessa transazione; `choose_project` per le card storiche agisce sul figlio (lo sposta di progetto) e **non** rimette il padre a `new`; `record_decision` invariato)
- Test: `google-proposal.test.ts` (confermare una proposta NON chiude le sorelle né il messaggio; fallimento di una lascia le altre aperte; `updated_at` del padre aggiornato; `choose_project` storica non azzera le sorelle; ogni azione con claim prima e stato dopo)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `fix(proposals): confermare una proposta non chiude le sorelle`.

## Fase D — Retention, pagina Posta, consegna

### Task 7: retention consapevole dei figli

**Files:** `apps/worker/src/google/poller.ts` (`pruneOldEmails`: pota solo i messaggi con **tutti** i figli terminali e nessuna notifica collegata `open`, soglia su `updated_at` del padre), `apps/worker/src/google/sync.ts` se la lista degli stati terminali vive lì.
**Test:** messaggio vecchio con un figlio `classified` → non potato; con un figlio terminale ma notifica aperta → non potato; tutti terminali e nessuna notifica → potato con i figli in cascata.
**Commit** `fix(google): la potatura rispetta le proposte ancora aperte`.

### Task 8: pagina Posta per proposta

**Files:** `packages/shared/src/schemas/google.ts` (`mailItemSchema` += `projectId`/`projectName` già presenti; `id` diventa l'id della proposta per le righe di posta — documentare nel commento), `apps/server/src/routes/me-mail.ts` (query sui figli con join al padre; `repropose` agisce sul figlio, 409 se non `failed`/`ignored`; riepilogo che conta i figli), `apps/web/src/routes/mail.tsx` (badge del progetto sulla riga, mittente e oggetto ripetuti, filtro per progetto sui figli), i18n.
**Test:** un messaggio con tre proposte → tre righe con progetti diversi; «Riproponi» su una non tocca le altre; filtro per progetto; il calendario resta invariato; ACL per utente.
**Commit** `feat(mail): una riga per proposta, con il progetto in evidenza`.

### Task 9: documentazione e consegna

- `CLAUDE.md`: aggiorna la sezione della fase 6 (un'email genera N proposte, una per progetto; il calendario resta uno a uno; `GMAIL_MAX_PROJECTS_PER_MESSAGE`; la potatura rispetta le proposte aperte), invariante nuova: «confermare una proposta non chiude le sorelle».
- `apps/docs`: aggiorna la guida «Collegare Gmail e Calendar» spiegando che un'email di recap multi-progetto genera più proposte, e che mettere lo stesso dominio su più progetti è ora una scelta sensata.
- Suite completa, `graphify update .`, `git merge origin/main`, push, CI verde, PR, report (HEAD, run, eventuali flaky con i nomi).

---

## Rischi e decisioni prese nel piano

- **Tabella figlia, non una riga per progetto in `email_messages`**: cambiare
  l'unique `(account_id, gmail_message_id)` toccherebbe l'idempotenza
  dell'ingest, duplicherebbe il testo per progetto e renderebbe ambigua la
  chiave del registro decisioni.
- **Partizione nel codice, non nel protocollo del modello**: ogni proposta
  porta già il suo `projectId` e viene rivalidata; chiedere al modello di
  raggruppare aggiungerebbe superficie senza garanzie.
- **`choose_project` deprecata**: il fan-out risponde già alla domanda.
  Resta eseguibile per le card pubblicate prima di questa fase.
- **Stato del padre calcolato in lettura**: persistere l'aggregato
  renderebbe la riga padre il nuovo punto di contesa fra due pubblicazioni
  parallele.
- **Cap sul fan-out**: senza, una mail in copia a dieci progetti genera dieci
  card. Cinque è un tetto arbitrario ma dichiarato, configurabile.
