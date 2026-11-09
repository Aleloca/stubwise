# Integrazione area 2, fetta 4 (Requests, Overview, traguardi, Tutti i progetti) — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Requests con codici R<n>, Overview, gestione dei traguardi, Tutti i progetti e Nuovo progetto con modelli e moduli funzionano contro il server vero su desktop e `/app`; il prototipo resta invariato.

**Spec:** `docs/plans/2026-11-09-integrazione-area2-fetta4-design.md`.

## Global Constraints

Quelli delle fette 1–3, più: branch `feat/integrazione-area2-fetta4` (parte dalla fetta 3). Test solo filtrati. Le scelte che si discostano dal prototipo (intake, fusione AI) sono decise dal maintainer: non «correggerle».

## Review Focus

1. **Richiesta fusa dall'intake mentre l'app aspetta**: l'app mostra «Unita a R12», mai una richiesta fantasma → test nel Task P.
2. **Fusione AI che fallisce**: nessuna delle due voci cambia; errore con «Riprova» → test nel Task P (server) e R (renderer).
3. **Ciclo di «superata da»**: rifiutato dal server → test nel Task O.
4. **Nuovo progetto con codice già usato**: 409 e niente creato (né stati né membri) → test nel Task N.
5. **Cronologia ai bordi della finestra**: un evento esattamente al limite di 28 giorni non compare due volte né sparisce fra due pagine → test nel Task O.

---

### Task N (backend): progetti — modello, moduli, cliente, creazione
Migrazione: `projects.client_name text null`, `projects.template text not null default 'software'` (CHECK software|marketing|client|empty), `projects.modules text[] not null default {docs,releases,support,servers}` (decisione del maintainer per gli esistenti). Shared: `templates.ts` (`TEMPLATE_STATUSES`, `TEMPLATE_MODULES`), `projectCode.ts` (proposta e validazione), spostati da `domain/` con adattatori. `POST /api/projects` accetta `code?`, `template`, `clientName?`, `modules?`; crea gli stati del modello nella stessa transazione (il trigger dei default si salta quando il modello li dà). `PATCH` accetta `clientName`, `modules`. Risposte con `kind` derivato, `template`, `modules`, `clientName` (opzionali). api-client `projects.create`, campi nuovi.

### Task O (backend): Overview — traguardi, decisioni, cronologia, brief
- Traguardi: verifica il permesso del prototipo; api-client `milestones.*` sulle rotte esistenti (`closed` ⇄ `status`).
- Registro decisioni: `supersedesId` alla creazione (in transazione), `wouldCycle` di shared lato server (400 `decision_cycle`).
- Cronologia: kind e forma del prototipo (`TimelineEvent`), `before` per pagina all'indietro di 28 giorni, traguardi futuri inclusi nella prima pagina; `GET /api/activity/portfolio?before=` trasversale sui progetti visibili. Mappatura documentata dei kind del server su quelli del prototipo.
- Brief: vista `WeeklyBrief` (`headline`, `summary` md) costruita dalle sezioni, etichettata come testo generato.
- Shared: `pulseOf` puro (open per famiglia, ferme, aspetta te, prossimo traguardo), `decisionLog.ts`.

### Task P (backend): Requests
Migrazione: `projects.next_request_number`, `backlog_items.number` (backfill per `created_at`, unico per progetto, mai riusato). Vista `ProjectRequest` del prototipo: `code`, richiedenti (tutti, da `backlog_item_requesters`), `taskIds` completi, taglia da `effort`, urgenza (`urgent` → `high` + `urgent: true`), simili, `mergedIntoCode`. Rotte: elenco/dettaglio per codice e per id, `POST` (intake come oggi; la risposta dice se la voce è nuova o fusa e in quale), `PATCH` metadati (`backlog.edit`; rifiutato su trasformata/archiviata), merge (AI come oggi; errore → nessuna modifica), archive/reopen/restore, conversione via `POST /api/tasks` con `requestId` (fetta 1). Shared: `requests.ts`, `requestNextStep.ts`. api-client `requests.*`.

### Task Q (renderer): superfici della fetta 4 nella build app
`integration.ts`: sezioni di progetto `overview`, `requests`; destinazione `projects` (portafoglio); atterraggio del progetto su Overview; moduli dei progetti dal server; refinement, task eliminate, archiviati, interruttori di brief/report, pausa della coda e effetti di chat/automazioni/doc di prodotto spenti; «Unita a R12» e attesa della fusione AI (testi en/it). Test nella build app con «nessuna chiamata fuori elenco».

### Task R (renderer): implementazione vera
`real/{requests,overview,projects,milestones,decisions,timeline}.ts`: `listRequests`, `getRequest(ByCode)`, `createRequest`, `updateRequest`, `mergeRequest`, `archiveRequest`, `reopenRequest`, `restoreRequest`, `convertRequest`, `listMilestones` + CRUD, `listDecisionLog`, `recordDecision`, `setDecisionSuperseded`, `getLatestBrief`, `listTimeline` (a pagine), `listPortfolioActivity`, `projectPulse`/`listProjectPulses` (con `pulseOf` condiviso), `createProject`. Test con client finto.

### Task S (chiusura)
Parità `apps/desktop/docs/integration-slice4.md` (e la riga «area 2 completa»), deploy-log, invarianti.
