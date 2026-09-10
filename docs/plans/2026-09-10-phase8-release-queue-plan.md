---
title: Fase 8 — Ambienti e coda di rilascio — piano di implementazione
date: 2026-09-10
design: 2026-09-10-phase8-release-queue-design.md
stubwise:
  project: stubwise
---

# Fase 8 — Ambienti e coda di rilascio: piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.
>
> Worktree nuovo `.worktrees/phase8-release-queue`, branch
> `feature/phase8-release-queue` da `main`. **Non** mergiare e **non**
> deployare: entrambe restano al maintainer. Alla fine: push, CI verde
> (incluso E2E), report con HEAD e link al run.
>
> Convenzioni: TDD, commit piccoli in italiano, `pnpm lint` e `pnpm -r
> typecheck` prima dell'ultimo commit di ogni fase; `pnpm -r test` con
> `--workspace-concurrency=1` (flaky con troppi testcontainer).
> Il design è la fonte: dove piano e design divergono, vince il design — e
> segnalalo.

**Questa fase costruisce la capacità di mergiare**, che oggi non esiste. Leggi
il design §2 prima di cominciare: il secondo divieto della fase 7 («gli
operatori non mandano niente in produzione») finora era vero *per assenza di
funzionalità*, e da qui in poi deve essere un cancello.

---

## Fase A — gli ambienti (Task 1-3)

### Task 1: `project_environments` e la dimensione ambiente sulle variabili

**Files:**
- Modify: `packages/db/src/schema.ts` — tabella `project_environments`
  (`project_id` FK cascade, `name`, `kind` CHECK `test|staging|production`,
  `url` NULL, `server_id` FK `servers.id` set null NULL, timestamps; unique
  `(project_id, name)`); colonna `environment_id` su `project_env_files`, FK
  cascade; l'unique diventa `(repository_id, environment_id, path)`
- Create: `packages/db/drizzle/0074_project_environments.sql` — **additiva, un
  solo batch, nessun `ALTER TYPE`**, CON BACKFILL: un ambiente `test` per ogni
  progetto esistente, e ogni riga di `project_env_files` collegata a quello del
  progetto del proprio repository
- Test: `packages/db` — la migrazione applica **e il backfill è corretto** su
  dati realistici (più progetti, più repository per progetto, righe esistenti)

⚠️ **Il backfill non è cosmetico**: in produzione ci sono 20 repository con
`.env` popolati che la pipeline di fix legge a ogni run. Se restassero senza
ambiente, il fix non li troverebbe più e i test dei fix inizierebbero a fallire
per variabili mancanti. Provalo come una migrazione con dati.

**Commit** `feat(db): gli ambienti di progetto e le variabili per ambiente (migrazione 0074)`.

### Task 2: solo l'ambiente `test` entra in un worktree

**L'invariante della fase** (design §3). Non una nota: reso impossibile per
costruzione.

**Files:**
- Modify: `apps/worker/src/pipeline/env-files.ts` — `loadProjectEnvFiles`
  prende l'ambiente come parametro **obbligatorio** e rifiuta qualunque tipo
  diverso da `test`. Il perché va scritto lì: il safeguard esistente
  (`fix.ts:1441`, esclusione da ogni `git add`) protegge dal commit, non da un
  log, da un prompt o da una variabile d'ambiente del sottoprocesso
- Modify: `apps/worker/src/pipeline/fix.ts:1439` (il call site)
- Test: la pipeline chiede `test` e ottiene le variabili; **un tentativo di
  chiedere `staging` o `production` fallisce**, e il test lo prova

**Commit** `feat(worker): solo l'ambiente di test entra in un worktree`.

### Task 3: le rotte e la UI degli ambienti

**Files:**
- Create/Modify: `apps/server/src/routes/` — CRUD degli ambienti di un
  progetto (scritture `requireAdmin`, come le altre configurazioni di progetto);
  `project-env-files.ts` guadagna la dimensione ambiente. **I valori non escono
  mai in chiaro**, come oggi (`project-env-files.ts:55-58`: si listano le
  chiavi)
- Modify: `packages/shared` (schemi; ogni campo nuovo
  `.optional()`/`.nullable()`/`.default()` con un test che parsa senza)
- Modify: `apps/web` — la sezione variabili del progetto si organizza per
  ambiente; la copy dice **esplicitamente** che solo le variabili di `test`
  vengono usate dalla pipeline e che le altre sono conservate per essere lette
- Test: server (testcontainers) e web; parità i18n

**Commit** `feat(projects): ambienti, con le variabili separate per ambiente`.

---

## Fase B — cosa c'è su (Task 4)

### Task 4: l'agente riporta immagine e commit

**Files:**
- Modify: `packages/agent/src/collectors/docker.ts:33-37` e `:162-193` — il
  `ContainerSummary` tiene anche `Image` e `Labels`; il payload riporta
  l'immagine e, se presente, `org.opencontainers.image.revision`.
  **Il socket resta `:ro` e in sole GET**: non aggiungere nessuna chiamata di
  scrittura, e non introdurre `exec`
- Modify: `packages/shared/src/schemas/server.ts:55-63`
  (`discoveredServiceSchema`): i due campi nuovi sono **opzionali**. Gli host
  **non si auto-aggiornano** (CLAUDE.md): un agente vecchio che non li manda
  deve continuare a funzionare, e serve il test che lo prova
- Modify: dove si legge il campione, per mostrare la versione sull'ambiente
  collegato al server
- Test: `packages/agent`, `packages/shared`, server

**Commit** `feat(agent): l'agente dice quale immagine e quale commit girano`.

---

## Fase C — i prerequisiti della coda (Task 5-7)

### Task 5: i check del provider si leggono

**La colonna che conta** (design §4): ciò che decide se una PR è mergiabile
sono le Actions/pipeline del provider, non il test interno.

**Files:**
- Modify: `packages/git/src/provider.ts` (interfaccia), `github.ts`,
  `bitbucket.ts` — `getPullRequestChecks(prNumber | headSha)`, **sola lettura**
- Test: entrambi i provider con `fetch` finto (tutti verdi; uno rosso; nessun
  check configurato — che è diverso da «rossi» e non va confuso)

**Commit** `feat(git): leggere lo stato dei check di una PR`.

### Task 6: l'esito del test interno diventa un dato

Oggi è testo nel log del job (`fix.ts:1653-1660`).

**Files:**
- Modify: `packages/db/src/schema.ts` (colonne sull'entità giusta — valuta
  `ticket_repositories`, che è già la fonte di verità di `pr_url`/`pr_state`,
  `schema.ts:645-646`), e la migrazione 0074
- Modify: `apps/worker/src/pipeline/fix.ts` (scrive l'esito dove i test già
  girano)
- Test: worker

**Commit** `feat(pipeline): l'esito dei test del fix è un dato, non una riga di log`.

### Task 7: il rischio

Regola, non giudizio (design §4): **alto** se tocca migrazioni, file
d'ambiente/segreti, lockfile o configurazione di CI/deploy; **medio** se tocca
più di un repository; **basso** il resto.

**Files:**
- Create: una funzione **pura** che dato l'elenco dei file cambiati ritorna il
  livello **e la ragione** (la UI deve poter dire *perché*, in una riga)
- Modify: dove si calcola, e la persistenza
- Test: tabella di casi, uno per ciascuna regola, più un caso che ne combina due

⚠️ Non chiamare un modello per questo, e non «migliorarlo» con l'AI: un rischio
generato è narrativa travestita da fatto (CLAUDE.md, l'invariante del registro
decisioni).

**Commit** `feat(release): il rischio di una PR è una regola spiegabile`.

---

## Fase D — la coda (Task 8-10)

### Task 8: mergiare

**Files:**
- Modify: `packages/git/src/{provider,github,bitbucket}.ts` —
  `mergePullRequest`. Gestisci gli errori veri, non solo il caso felice: PR non
  mergiabile, conflitti, check obbligatori non passati, permesso mancante —
  ciascuno con un errore distinto e leggibile
- Modify: `validateCredentials` (`github.ts:251-330` e l'analogo Bitbucket) —
  **verifica anche il permesso di merge**: oggi controlla push, PR e webhook, e
  senza questo la mancanza si scopre al primo tentativo
- Test: entrambi i provider, tutti i rami d'errore

**Commit** `feat(git): mergiare una PR, col permesso verificato in anticipo`.

### Task 9: la rotta di rilascio e il cancello

**Files:**
- Create: la rotta che rilascia una PR — **`requireAdmin`**, come
  `approve-plan`. È il cancello che rende vero il secondo divieto della fase 7
  (design §2)
- Test: **un member riceve 403**, con l'asserzione sullo status E sul fatto che
  nessun merge sia partito; un admin merge; una PR con check rossi non si
  rilascia; una PR già chiusa risponde in modo pulito

**Commit** `feat(release): rilasciare una PR è riservato al maintainer`.

### Task 10: la pagina, la card e l'app

**Files:**
- Create: `apps/web/src/routes/release.tsx` (o il nome che scegli) — tutte le
  PR aperte sui repository collegati, **di qualunque origine** (design §4), con
  le sei colonne. Check del provider e test interno **separati e con nomi
  diversi**, mai fusi in un semaforo solo
- Modify: `app-layout.tsx` (`NAV_ITEMS`, `memberVisible` — decidi e motiva se un
  operatore vede la coda in sola lettura), `router.tsx`, i18n `en`+`it`
- Modify: `inbox-item.tsx` e l'app mobile — l'azione «Rilascia» sulla card.
  ⚠️ È un valore nuovo in `inboxActionTypeSchema`
  (`packages/shared/src/schemas/notification.ts:65-73`): introducilo **dietro
  una lettura tollerante** (`safeParse` con degrado, come `readGoogle` in
  `apps/server/src/services/inbox.ts:874-877`) e **verifica leggendo il codice**
  che un binario precedente degradi la card invece di far saltare `/api/inbox`.
  Se non riesci a garantirlo, dillo invece di procedere
- Test: web, mobile, parità i18n

**Commit** `feat(web): la coda di rilascio`.

---

## Fase E — chiusura (Task 11-12)

### Task 11: documentazione

- `CLAUDE.md`: voce «Fase 8» (rebuild, migrazione 0074 **con backfill**, env,
  rollback) e due invarianti nuovi: **solo l'ambiente `test` entra in un
  worktree**, e **Stubwise non fa deploy: il merge è il confine** — quest'ultimo
  va scritto perché non lo si superi «tanto manca poco»
- `apps/docs`: guida utente — gli ambienti, la coda, cosa significa rilasciare
- ⚠️ Verifica ogni affermazione contro il codice, non contro il piano

**Commit** `docs(fase8): CLAUDE.md e guida utente`.

### Task 12: verifica finale

1. `pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test` → verde.
2. `graphify update .`; `git merge origin/main`.
3. Push; `gh run watch` finché la CI (incluso E2E) è verde.
4. Report: HEAD, link al run, i task, eventuali flaky con i nomi, e **ogni
   punto in cui il design ti è sembrato sbagliato**.

---

## Fuori da questo piano

Design §6: eseguire o rilasciare ambienti, auto-merge e livelli di autonomia,
comandare l'agente, le anteprime per PR, la potatura di mirror e grafi.
