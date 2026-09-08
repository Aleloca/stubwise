---
title: Fase 6c — Ammissione della posta — piano di implementazione
date: 2026-09-08
design: 2026-09-08-phase6c-mail-admission-design.md
stubwise:
  project: stubwise
  backlog: 868cdecc-a4ed-4d87-9b4e-94a7dd9a1faa
---

# Fase 6c — Ammissione della posta: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Prima del Task 1**: `/stubwise:start` sulla voce di backlog nel
> frontmatter del design doc. Worktree `feature/phase6c-mail-admission`.
> Alla fine: `git merge origin/main`, push, CI verde (incluso E2E), PR verso
> main; merge e deploy li fa il maintainer. **Le fasi 6 e 6b sono in
> produzione con quattro caselle collegate**: nessun cambiamento può rompere
> le proposte già pubblicate.

**Goal:** separare l'ammissione (è lavoro?) dall'attribuzione (di quale
progetto?), così che i domini dei propri Workspace ammettano la posta senza
essere replicati su ogni progetto; gestire il caso nuovo dell'email ammessa
ma non attribuita con una proposta di smistamento; aggiungere le difese di
costo che oggi mancano.

**Architecture:** una funzione pura `admit` accanto a `matchRoutes`, che resta
la sola attribuzione; configurazione d'istanza su `instance_settings` (nessuna
tabella nuova); la proposta di smistamento riusa
`email_messages.proposal_notification_id`, libero dopo il fan-out, e l'azione
`choose_project` deprecata in 6b; tre difese di costo nel poller.

**Tech Stack:** Drizzle + Postgres, worker (poller e classificazione),
Fastify, React SPA, `packages/notifications`, `packages/google`,
`packages/shared`.

**Convenzioni (ereditate)**: TDD; commit piccoli in italiano; migrazioni SQL a
mano + journal; campi nuovi negli schemi di risposta sempre opzionali con un
test che parsa senza il campo; i18n en+it con parità; `pnpm -r build` dopo
`packages/*`; `pnpm lint` prima del merge; il modulo che scrive nel registro
decisioni non importa mai esecutori AI.

---

## Fase A — Ammissione

### Task 1: migrazione 0071 e configurazione d'istanza

**Files:**
- Create: `packages/db/drizzle/0071_mail_admission.sql`; Modify: `meta/_journal.json` (idx 71)
- Modify: `packages/db/src/schema.ts` (`instanceSettings`: `emailAdmitWorkspaceDomains bool NOT NULL DEFAULT true`, `emailAdmissionDenyLabels text[] NOT NULL DEFAULT '{CATEGORY_PROMOTIONS,CATEGORY_SOCIAL,SPAM}'`, `emailAdmissionDenyAutomated bool NOT NULL DEFAULT true`)
- Modify: `packages/shared/src/schemas/google.ts` o `settings` (schema di lettura e patch, campi **opzionali** nel body)
- Modify: `apps/server/src/routes/settings.ts` (esposizione e PATCH, `requireAdmin` per la scrittura, lettura a tutti gli autenticati come per le regole di progetto)
- Test: `packages/db`, `apps/server/src/routes/settings.test.ts`

Nessun enum, nessuna tabella: un solo batch.

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(db): migrazione 0071 — configurazione dell'ammissione della posta`.

### Task 2: `admit` separata da `matchRoutes`

**Files:**
- Modify: `packages/notifications/src/email-routing.ts` (nuova `admit(message, config): AdmissionResult` con `admitted` + `reason` (`workspace_domain` | `project_rule`) oppure `rejected` + `reason` (`denied_label` | `automated` | `no_match`); le esclusioni vincono sempre; `matchRoutes` resta invariata e diventa **solo** attribuzione — `inScope` va deprecato con un commento, non rimosso, per non rompere il calendario)
- Modify: `packages/notifications/src/email-routing.ts` (`EmailForRouting` += `headers?: Record<string,string>` per gli header della posta automatica)
- Test: `email-routing.test.ts` (mittente di un dominio Workspace → ammesso `workspace_domain`; dominio Workspace **in copia** → ammesso; regola di progetto senza dominio Workspace → ammesso `project_rule`; etichetta esclusa → rifiutato anche se una regola combacia; `List-Unsubscribe` presente → rifiutato; `Precedence: bulk` → rifiutato; `Auto-Submitted: no` → **non** rifiutato; interruttore spento → si comporta esattamente come `inScope` di oggi)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(routing): ammissione separata dall'attribuzione`.

### Task 3: il poller ammette invece di attribuire

**Files:**
- Modify: `packages/google/src/credentials.ts:83-96` e il tipo `GoogleAccountCredentials:37-52` (aggiungi `domains: googleWorkspaces.domains` — il join esiste già, **zero query nuove**)
- Modify: `packages/google/src/gmail.ts:29` (`DEFAULT_METADATA_HEADERS` += `List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`)
- Modify: `apps/worker/src/google/sync.ts` (`messageToRouting` porta gli header)
- Modify: `apps/worker/src/google/poller.ts:645-646` (`admit` al posto di `preFilter.inScope`; la configurazione d'istanza letta una volta per tick accanto a `loadAllRoutes`; `matchRoutes` resta dopo il download per l'attribuzione; `scope_project_ids` può ora essere vuoto su una riga ammessa)
- Test: `poller.test.ts` (messaggio da dominio Workspace senza nessuna regola → ingerito con `scope_project_ids` vuoto; messaggio con etichetta esclusa → **nessun download** (verifica che `getMessageFull` non sia chiamato); header nuovi richiesti senza chiamate in più; interruttore spento → comportamento della fase 6)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): la posta dei domini dei Workspace entra senza regole di progetto`.

## Fase B — Attribuzione e smistamento

### Task 4: classificazione con perimetro vuoto

**Files:**
- Modify: `apps/worker/src/google/classify.ts:862-871` (perimetro vuoto non è più `ignored`: i candidati diventano **tutti i progetti** dell'istanza), `loadContext:436-449` (accetta l'insieme calcolato), `revalidateProposal` (valida contro l'insieme allargato)
- Test: `classify.test.ts` (perimetro vuoto → tutti i progetti nel prompt; proposta su un progetto qualsiasi accettata; nessun segnale → `ignored` come prima; il contesto resta capato a dieci righe per progetto)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(classify): senza regole decide l'analisi, su tutti i progetti`.

### Task 5: proposta di smistamento

**Files:**
- Modify: `apps/worker/src/google/classify.ts` (se ci sono segnali ma nessuna proposta con un progetto valido, scrive sul padre l'esito «da smistare» con i progetti suggeriti, senza creare figli)
- Modify: `apps/worker/src/google/proposal.ts` (nuovo ramo: proposta di smistamento **sul messaggio**, che usa `email_messages.proposal_notification_id`; opzioni = fino a tre progetti suggeriti con azione `choose_project`, più «nessuno di questi» che archivia; la domanda riassume il segnale; claim sul padre come faceva la fase 6)
- Modify: `apps/worker/src/google/poller.ts` (la selezione dei messaggi da proporre include i messaggi «da smistare»)
- Modify: `apps/server/src/services/google-proposal.ts` (`choose_project` **sul padre** attribuisce il messaggio, azzera la notifica e lo rimette in coda di classificazione — è il comportamento della fase 6, che resta valido qui; sui **figli** resta deprecata come deciso in 6b; «nessuno di questi» → `ignored` con esito registrato)
- Modify: `packages/i18n/src/catalog.ts` (domanda e opzioni, en+it)
- Test: `proposal.test.ts`, `google-proposal.test.ts` (smistamento creato solo con segnale; scegliere un progetto riaccoda e poi nascono i figli; «nessuno di questi» archivia con esito; una proposta di smistamento non interferisce con i figli di un altro messaggio; un messaggio con figli non riceve mai una proposta di smistamento)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(mail): proposta di smistamento quando nessuno attribuisce il progetto`.

## Fase C — Difese di costo

### Task 6: tetto giornaliero, gate di budget, cooldown per conversazione

**Files:**
- Modify: `apps/worker/src/config.ts` (`GMAIL_MAX_PER_DAY` default 200, 0 = nessun tetto; `GMAIL_THREAD_COOLDOWN_MINUTES` default 60, 0 = disattivato), `docker-compose.yml`, `.env.example`
- Modify: `apps/worker/src/google/classify.ts` (prima di classificare: conteggio dei run di classificazione delle ultime 24 ore per quella casella, join fra `agent_runs` e `email_messages`; gate del budget mensile con la stessa verifica dei fix; salto dei messaggi il cui thread ha già avuto una classificazione nella finestra, il messaggio resta `new`)
- Test: `classify.test.ts` (tetto raggiunto → nessun run e riga di log, i messaggi restano `new`; tetto a 0 → nessun limite; budget superato → nessun run con motivo esplicito; due messaggi dello stesso thread nella finestra → una sola classificazione, il secondo resta `new`; finestra a 0 → entrambi classificati; il cooldown non blocca la coda: un thread in cooldown viene saltato e si passa al successivo)

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(worker): tetto giornaliero, gate di budget e una analisi per conversazione`.

## Fase D — Interfaccia, documentazione, consegna

### Task 7: sezione «Posta ammessa» e copy onesta

**Files:**
- Create: `apps/web/src/components/mail-admission-section.tsx` (interruttore dei domini dei Workspace con l'elenco dei domini ammessi ricavato dai Workspace registrati, esclusioni per etichetta con picker sulle etichette osservate, interruttore della posta automatica, tetti; scrittura admin, lettura a tutti), montata in `apps/web/src/routes/settings/google.tsx`
- Modify: `apps/web/src/components/project-email-routes-section.tsx:17-22,111-113` (**riscrivi la copy**: queste regole decidono a quale progetto va un'email **già ammessa**; l'ammissione si configura in Impostazioni → Google; togli la frase che promette che un messaggio non riconosciuto non viene scaricato, perché non è più vera)
- Modify: i18n `apps/web/src/i18n/locales/{en,it}.json` (parità)
- Test: web

**Step 1–4**: rosso → implementa → PASS. **Step 5: Commit** `feat(settings): sezione della posta ammessa e copy che dice il vero`.

### Task 8: documentazione e consegna

- `CLAUDE.md`: ammissione d'istanza separata dall'attribuzione, la proposta di smistamento, i tre tetti, il gate di budget che ora copre anche la posta, e la nota che `choose_project` è viva sul padre e deprecata sui figli.
- `apps/docs`: aggiorna la guida «Collegare Gmail e Calendar» con la nuova divisione dei compiti e con ciò che viene effettivamente scaricato.
- Suite completa, `graphify update .`, `git merge origin/main`, push, CI verde, PR, report (HEAD, run, eventuali flaky con i nomi).

---

## Rischi e decisioni prese nel piano

- **Niente pre-selezione semantica**: col volume dichiarato (una quarantina
  di email al giorno) sarebbe ottimizzazione prematura e richiederebbe
  descrizioni di progetto scritte apposta. Se il volume crescesse di un
  ordine di grandezza, è il primo intervento da riprendere.
- **Nessuna tabella nuova**: la configurazione sta su `instance_settings`, la
  proposta di smistamento riusa un campo rimasto libero dopo il fan-out.
- **`choose_project` viva sul padre, deprecata sui figli**: due semantiche
  diverse per la stessa azione, e va scritto nel codice perché è
  esattamente il tipo di dettaglio che si dimentica.
- **Il gate di budget sulla posta chiude un difetto preesistente**, non è una
  richiesta di questa fase: senza, la posta continuerebbe a consumare il
  budget dei fix senza esserne frenata.
- **La copy in UI è parte del lavoro, non un contorno**: la promessa attuale
  diventerebbe falsa, e questa fase la rende falsa di proposito.
